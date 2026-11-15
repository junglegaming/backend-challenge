import { Inject, Injectable } from '@nestjs/common';
import type { MoneyProps } from '../domain/money';
import { UNIT_OF_WORK, type UnitOfWork } from '../domain/ports/repositories';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { NotFoundError, ValidationError } from './errors';
import { toWalletView, type WalletView } from './open-wallet';

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPageView {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

export interface TransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode?: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  balance?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

const toLedgerView = (e: WalletLedgerEntry): LedgerEntryView => ({
  id: e.id,
  transactionId: e.transactionId,
  direction: e.direction,
  money: e.money.toJSON(),
  balanceBefore: e.balanceBefore.toJSON(),
  balanceAfter: e.balanceAfter.toJSON(),
  walletVersion: e.walletVersion,
  createdAt: e.createdAt.toISOString(),
});

export const toTransactionView = (tx: WagerTransaction): TransactionView => ({
  id: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  walletId: tx.walletId,
  playerId: tx.playerId,
  roundId: tx.roundId,
  gameId: tx.gameId,
  kind: tx.kind,
  money: tx.money.toJSON(),
  status: tx.status,
  ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
  ...(tx.referenceExternalTransactionId ? { referenceExternalTransactionId: tx.referenceExternalTransactionId } : {}),
  ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
  ...(tx.resultBalance ? { balance: tx.resultBalance.toJSON() } : {}),
  createdAt: tx.createdAt.toISOString(),
  ...(tx.processedAt ? { processedAt: tx.processedAt.toISOString() } : {}),
});

/**
 * Opaque, stable ledger cursor: base64url of the last seen ledger sequence.
 * The sequence is a monotonically increasing identity column, so new entries
 * never shift pages that were already served.
 */
export const LedgerCursor = {
  encode(sequence: string): string {
    return Buffer.from(JSON.stringify({ v: 1, s: sequence })).toString('base64url');
  },
  decode(cursor: string): string {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown; s?: unknown };
      if (parsed.v === 1 && typeof parsed.s === 'string' && /^\d{1,19}$/.test(parsed.s)) return parsed.s;
    } catch {
      // fall through
    }
    throw new ValidationError('Invalid cursor', { field: 'cursor' });
  },
};

@Injectable()
export class WageringQueries {
  constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

  async wallet(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.snapshot((s) => s.wallets.findById(walletId));
    if (!wallet) throw new NotFoundError('WALLET_NOT_FOUND', `Wallet ${walletId} not found`);
    return toWalletView(wallet);
  }

  async ledger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPageView> {
    const after = cursor ? LedgerCursor.decode(cursor) : undefined;
    const page = await this.uow.snapshot(async (s) => {
      const wallet = await s.wallets.findById(walletId);
      if (!wallet) throw new NotFoundError('WALLET_NOT_FOUND', `Wallet ${walletId} not found`);
      return s.ledger.page(walletId, after, limit);
    });
    return {
      items: page.entries.map(toLedgerView),
      nextCursor: page.nextAfterSequence ? LedgerCursor.encode(page.nextAfterSequence) : null,
    };
  }

  async transaction(transactionId: string): Promise<TransactionView> {
    return this.found(await this.uow.snapshot((s) => s.transactions.findById(transactionId)));
  }

  async transactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    return this.found(await this.uow.snapshot((s) => s.transactions.findByExternalId(providerId, externalTransactionId)));
  }

  private found(tx: WagerTransaction | undefined): TransactionView {
    if (!tx) throw new NotFoundError('TRANSACTION_NOT_FOUND', 'Transaction not found');
    return toTransactionView(tx);
  }
}
