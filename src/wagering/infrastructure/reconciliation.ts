import { Injectable } from "@nestjs/common";
import { TransactionContext } from "../../shared/application/unit-of-work";
import { Money } from "../../shared/domain/money";
import { managerFor } from "../../shared/infrastructure/unit-of-work";
import { ReconciliationRepository } from "../application/ports/repositories";

@Injectable()
export class SqlReconciliationRepository extends ReconciliationRepository {
  override async snapshot(tx: TransactionContext, walletId: string) {
    const [row] = await managerFor(tx).execute<
      { balance: string; calculated: string; currency: string; entries: number }[]
    >(
      `SELECT w.balance::text, w.currency, COALESCE(sum(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END),0.00)::text AS calculated, count(e.id)::int AS entries
       FROM wallets w LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id WHERE w.id = ? GROUP BY w.id`,
      [walletId],
    );
    return row
      ? {
          storedBalance: Money.from({ amount: row.balance, currency: row.currency }),
          calculatedBalance: Money.from({ amount: row.calculated, currency: row.currency }),
          checkedEntries: row.entries,
        }
      : null;
  }
}
