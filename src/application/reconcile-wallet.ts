import { Inject, Injectable } from '@nestjs/common';
import type { MoneyProps } from '../domain/money';
import { UNIT_OF_WORK, type UnitOfWork } from '../domain/ports/repositories';
import { NotFoundError } from './errors';
import { STRUCTURED_LOGGER, type StructuredLogger, WAGERING_METRICS, type WageringMetrics } from './ports';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Compares the materialised balance with the ledger reconstruction inside one
 * REPEATABLE READ snapshot (no lock, no write). Divergences are never fixed
 * silently: they are logged, counted and reported.
 */
@Injectable()
export class ReconcileWallet {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(WAGERING_METRICS) private readonly metrics: WageringMetrics,
    @Inject(STRUCTURED_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const { wallet, totals } = await this.uow.snapshot(async (s) => {
      const wallet = await s.wallets.findById(walletId);
      if (!wallet) throw new NotFoundError('WALLET_NOT_FOUND', `Wallet ${walletId} not found`);
      return { wallet, totals: await s.ledger.totals(walletId, wallet.currency) };
    });

    const difference = wallet.balance.subtract(totals.net);
    const report: ReconciliationReport = {
      walletId,
      storedBalance: wallet.balance.toJSON(),
      calculatedBalance: totals.net.toJSON(),
      difference: difference.toJSON(),
      consistent: difference.isZero(),
      checkedEntries: totals.entries,
    };
    if (!report.consistent) {
      this.metrics.reconciliationMismatch(walletId);
      this.logger.error('wallet reconciliation mismatch', {
        walletId,
        difference: report.difference.amount,
        checkedEntries: report.checkedEntries,
      });
    }
    return report;
  }
}
