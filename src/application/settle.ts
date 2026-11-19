import { FailureCode, InsufficientFundsError } from '../domain/errors';
import {
  EventContext,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events';
import { LedgerDirection, WalletLedgerEntry } from '../domain/ledger-entry';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { logger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { TxStore } from './ports';

/**
 * Resolve uma transação não-terminal contra a wallet JÁ TRAVADA nesta transação SQL e grava tudo
 * que decorre disso: transação, saldo, lançamento e eventos. Usado pela submissão (HTTP e SQS) e
 * pelo worker de referências pendentes — um único lugar decide o destino de uma transação.
 *
 * Devolve uma função a ser chamada DEPOIS do commit: métrica e log só valem para o que foi confirmado.
 */
export async function settle(
  tx: WagerTransaction,
  wallet: Wallet,
  store: TxStore,
  now: Date,
  ctx: EventContext & { messageId?: string },
  maxReferenceAttempts: number,
): Promise<() => void> {
  const wasPendingReference = tx.status === WagerTransactionStatus.PendingReference;
  const entry = await decide(tx, wallet, store, now, maxReferenceAttempts);

  store.saveTransaction(tx);
  if (entry) {
    store.addLedgerEntry(entry);
    store.saveWallet(wallet);
    store.enqueue(WalletBalanceChanged.from(wallet, entry, ctx));
  }
  if (tx.status === WagerTransactionStatus.Processed) {
    store.enqueue(WagerTransactionProcessed.from(tx, wallet, now, ctx));
  } else if (tx.status === WagerTransactionStatus.Rejected) {
    store.enqueue(WagerTransactionRejected.from(tx, now, ctx));
  } else if (!wasPendingReference) {
    store.enqueue(WagerTransactionPendingReference.from(tx, now, ctx));
  }

  return () => {
    if (tx.isTerminal()) {
      metrics.transactions.inc({ kind: tx.kind, status: tx.status, failure_code: tx.failureCode ?? '' });
    }
    logger.info(
      {
        correlationId: ctx.correlationId,
        messageId: ctx.messageId,
        transactionId: tx.id,
        walletId: tx.walletId,
        providerId: tx.providerId,
        kind: tx.kind,
        status: tx.status,
        failureCode: tx.failureCode,
        attempts: tx.attempts,
      },
      'wager transaction settled',
    );
  };
}

/** Aplica as regras da seção 7. Devolve o lançamento de ledger quando o saldo muda. */
async function decide(
  tx: WagerTransaction,
  wallet: Wallet,
  store: TxStore,
  now: Date,
  maxReferenceAttempts: number,
): Promise<WalletLedgerEntry | undefined> {
  const reject = (code: FailureCode): undefined => {
    tx.reject(code, now, wallet.balance);
    return undefined;
  };

  if (tx.money.currency !== wallet.currency) return reject(FailureCode.CurrencyMismatch);

  let reference: WagerTransaction | undefined;
  if (tx.referenceExternalTransactionId) {
    reference = await store.findTransactionByProviderRef(tx.providerId, tx.referenceExternalTransactionId);
    // Ausente, ou ela própria ainda aguardando: espera com backoff até o limite de tentativas.
    if (!reference || !reference.isTerminal()) {
      if (tx.attempts >= maxReferenceAttempts) return reject(FailureCode.ReferenceNotFound);
      tx.markPendingReference(now);
      return undefined;
    }
    const failure = tx.checkReference(reference);
    if (failure) return reject(failure);
    // Uma transação só é revertida uma vez, por REFUND ou por ROLLBACK (o índice único parcial garante).
    if (tx.requiresReference() && (await store.hasProcessedReversal(reference.id))) {
      return reject(FailureCode.AlreadyReversed);
    }
  }

  let entry: WalletLedgerEntry | undefined;
  const direction = tx.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Credit) {
    entry = wallet.credit(tx.money, tx.id, now);
  } else if (direction === LedgerDirection.Debit) {
    try {
      entry = wallet.debit(tx.money, tx.id, now);
    } catch (error) {
      if (!(error instanceof InsufficientFundsError)) throw error;
      // Aposta sem saldo e reversão que negativaria são situações operacionalmente diferentes.
      return reject(tx.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalWouldOverdraw);
    }
  }
  tx.markProcessed(reference?.id, now, wallet.balance);
  return entry;
}
