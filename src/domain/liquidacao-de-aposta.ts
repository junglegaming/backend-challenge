import { Wallet } from './wallet';
import { WalletLedgerEntry, LedgerDirection } from './ledger-entry';
import { FailureCode, WagerTransactionStatus, WagerTransactionKind, WagerTransaction } from './wager-transaction';

/** Quanto esperar por uma referência que ainda não chegou. */
export interface PoliticaDeEspera {
  esperaInicialMs: number; // atraso da 1ª verificação; dobra a cada tentativa
  esperaMaximaMs: number; // teto do atraso
  prazoMaximoMs: number; // tempo máximo esperando, desde a criação
  maxTentativas: number;
}

export type ResultadoDaLiquidacao =
  | { tipo: 'PROCESSADA'; lancamento?: WalletLedgerEntry }
  | { tipo: 'REJEITADA'; codigo: FailureCode }
  | { tipo: 'AGUARDANDO_REFERENCIA'; primeiraVez: boolean };

/**
 * Regras de negócio da aposta (seção 7 do desafio), sem acesso a banco.
 * Recebe a transação, a carteira JÁ travada e a referência (se houver), decide
 * o resultado e altera os dois objetos.
 */
export class LiquidacaoDeAposta {
  constructor(private readonly espera: PoliticaDeEspera) {}

  liquidar(entrada: {
    transacao: WagerTransaction;
    carteira: Wallet;
    referencia?: WagerTransaction; // buscada por (providerId, referenceExternalTransactionId)
    referenciaJaRevertida: boolean;
    ledgerEntryId: string;
    agora: Date;
  }): ResultadoDaLiquidacao {
    const { transacao, carteira, referencia, agora } = entrada;
    const rejeitar = (codigo: FailureCode): ResultadoDaLiquidacao => {
      transacao.reject(codigo, carteira.balance);
      return { tipo: 'REJEITADA', codigo };
    };

    if (carteira.playerId !== transacao.playerId) return rejeitar(FailureCode.WalletPlayerMismatch);
    if (carteira.currency !== transacao.money.currency) return rejeitar(FailureCode.CurrencyMismatch);

    if (transacao.referenceExternalTransactionId !== undefined) {
      // referência ainda não chegou (ou chegou, mas também está esperando)
      if (!referencia || referencia.status === WagerTransactionStatus.PendingReference) {
        return this.aguardarReferencia(transacao, agora, () =>
          rejeitar(referencia ? FailureCode.ReferenceNotProcessed : FailureCode.ReferenceNotFound),
        );
      }
      if (!transacao.canReference(referencia.kind)) return rejeitar(FailureCode.ReferenceKindNotAllowed);
      const mesmoContexto =
        referencia.walletId === transacao.walletId &&
        referencia.playerId === transacao.playerId &&
        referencia.roundId === transacao.roundId &&
        referencia.money.currency === transacao.money.currency;
      if (!mesmoContexto) return rejeitar(FailureCode.ReferenceMismatch);
      if (referencia.status !== WagerTransactionStatus.Processed) return rejeitar(FailureCode.ReferenceNotProcessed);
      if (transacao.requiresReference()) {
        if (!transacao.money.equals(referencia.money)) return rejeitar(FailureCode.ReversalAmountMismatch);
        if (entrada.referenciaJaRevertida) return rejeitar(FailureCode.ReferenceAlreadyReversed);
      }
    }

    // LOSS: registra o resultado sem mexer no saldo
    if (!transacao.affectsBalance()) {
      transacao.markProcessed(referencia?.id, agora, carteira.balance);
      return { tipo: 'PROCESSADA' };
    }

    const movimentacao = {
      entryId: entrada.ledgerEntryId,
      transactionId: transacao.id,
      money: transacao.money,
      at: agora,
    };
    let lancamento: WalletLedgerEntry;
    if (transacao.ledgerDirectionFor(referencia) === LedgerDirection.Debit) {
      if (!carteira.canAfford(transacao.money)) {
        // aposta sem saldo e reversão sem saldo são situações diferentes
        const ehAposta = transacao.kind === WagerTransactionKind.Bet;
        return rejeitar(ehAposta ? FailureCode.InsufficientFunds : FailureCode.ReversalInsufficientFunds);
      }
      lancamento = carteira.debit(movimentacao);
    } else {
      lancamento = carteira.credit(movimentacao);
    }
    transacao.markProcessed(referencia?.id, agora, carteira.balance);
    return { tipo: 'PROCESSADA', lancamento };
  }

  /** Backoff exponencial: base, 2×base, 4×base... até o teto. Esgotado o prazo ou as tentativas, rejeita. */
  private aguardarReferencia(
    transacao: WagerTransaction,
    agora: Date,
    rejeitarAgora: () => ResultadoDaLiquidacao,
  ): ResultadoDaLiquidacao {
    const primeiraVez = transacao.status === WagerTransactionStatus.Pending;
    const tentativa = primeiraVez ? 0 : transacao.referenceAttempts + 1;
    const expirou = agora.getTime() - transacao.createdAt.getTime() >= this.espera.prazoMaximoMs;
    if (!primeiraVez && (tentativa >= this.espera.maxTentativas || expirou)) return rejeitarAgora();

    const atraso = Math.min(this.espera.esperaInicialMs * 2 ** tentativa, this.espera.esperaMaximaMs);
    transacao.markPendingReference(new Date(agora.getTime() + atraso));
    return { tipo: 'AGUARDANDO_REFERENCIA', primeiraVez };
  }
}
