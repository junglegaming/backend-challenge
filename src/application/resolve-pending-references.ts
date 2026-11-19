import { config } from '../config';
import { FailureCode } from '../domain/errors';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import { logger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { UniqueViolationError } from './errors';
import { UnitOfWork } from './ports';
import { settle } from './settle';

/**
 * Reprocessa transações PENDING_REFERENCE cujo backoff venceu. A lista de candidatas é lida sem
 * lock; a decisão é tomada sob o lock da wallet e revalida o estado, então várias instâncias
 * podem pegar a mesma candidata sem efeito duplicado. Uma única ordem de lock (wallet) em todo o
 * sistema: sem deadlock entre worker e submissão.
 */
export class ResolvePendingReferences {
  constructor(private readonly uow: UnitOfWork) {}

  /** Devolve quantas foram de fato tratadas: se nada andou, o worker dorme em vez de girar em falso. */
  async runOnce(): Promise<number> {
    const due = await this.uow.run((store) => store.findDuePendingReferences(config.pendingReference.batchSize, new Date()));
    let handled = 0;
    for (const candidate of due) {
      try {
        await this.resolve(candidate.id, candidate.walletId);
        handled += 1;
      } catch (error) {
        logger.error({ transactionId: candidate.id, walletId: candidate.walletId, err: error }, 'pending reference resolution failed');
        // Violação de integridade (classe 23) não melhora com retry: erro permanente, auditável.
        // Qualquer outro erro (lock timeout, banco fora) é transitório: a candidata segue vencida.
        const permanent = error instanceof UniqueViolationError || (error as { code?: string }).code?.startsWith('23');
        if (permanent) await this.markFailed(candidate.id, candidate.walletId).catch((e) => logger.error({ err: e }, 'could not mark transaction as failed'));
      }
    }
    return handled;
  }

  private async resolve(transactionId: string, walletId: string): Promise<void> {
    const report = await this.uow.run(async (store) => {
      const now = new Date();
      const wallet = await store.lockWallet(walletId);
      const tx = await store.findTransactionById(transactionId);
      const stillDue = tx?.status === WagerTransactionStatus.PendingReference && tx.nextAttemptAt !== undefined && tx.nextAttemptAt <= now;
      if (!wallet || !tx || !stillDue) return undefined; // outra instância já tratou
      return settle(tx, wallet, store, now, { correlationId: tx.id }, config.pendingReference.maxAttempts);
    });
    if (report) {
      metrics.retries.inc({ source: 'pending_reference' });
      report();
    }
  }

  private markFailed(transactionId: string, walletId: string): Promise<void> {
    return this.uow.run(async (store) => {
      await store.lockWallet(walletId);
      const tx = await store.findTransactionById(transactionId);
      if (!tx || tx.isTerminal()) return;
      tx.fail(FailureCode.InternalError, new Date());
      store.saveTransaction(tx);
      metrics.transactions.inc({ kind: tx.kind, status: tx.status, failure_code: tx.failureCode ?? '' });
    });
  }
}
