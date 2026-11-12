import { IsolationLevel } from "@mikro-orm/core";
import { Inject, Injectable } from "@nestjs/common";
import { TransactionRunner } from "../database/transaction-runner";
import { Money, type MoneyProps } from "../domain/money/money";
import { NotFoundError } from "../domain/shared/errors";
import { enrichContext } from "../observability/context";
import { logger } from "../observability/logger";
import { metrics } from "../observability/metrics";

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Verifies that the materialized wallet balance matches the sum of its
 * immutable ledger entries inside a REPEATABLE READ snapshot.
 *
 * Divergences are never fixed silently: they are logged, counted in metrics
 * and reported in the response.
 */
@Injectable()
export class ReconcileWalletUseCase {
  constructor(@Inject(TransactionRunner) private readonly txRunner: TransactionRunner) {}

  async execute(walletIdInput: string): Promise<ReconciliationResult> {
    const walletId = walletIdInput.toLowerCase();
    enrichContext({ walletId });

    const result = await this.txRunner.run(
      async (ctx) => {
        const wallet = await ctx.wallets.findById(walletId);
        if (!wallet) {
          throw new NotFoundError("WALLET_NOT_FOUND", `Wallet ${walletId} not found`);
        }

        const totals = await ctx.ledger.totals(wallet.id);
        const calculatedBalance = Money.fromPersistence(totals.netAmount, wallet.currency);
        const difference = wallet.balance.subtract(calculatedBalance);
        const consistent = difference.isZero();

        return {
          walletId: wallet.id,
          storedBalance: wallet.balance.toJSON(),
          calculatedBalance: calculatedBalance.toJSON(),
          difference: difference.toJSON(),
          consistent,
          checkedEntries: totals.count,
        };
      },
      { isolationLevel: IsolationLevel.REPEATABLE_READ },
    );

    if (!result.consistent) {
      metrics.reconciliationDivergences.inc();
      logger.error(
        { walletId: result.walletId, checkedEntries: result.checkedEntries },
        "Wallet reconciliation divergence detected",
      );
    }

    return result;
  }
}

