import type { EntityManager } from "@mikro-orm/postgresql";
import { Money } from "../../domain/money/money";
import { type LedgerDirection, WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import { LedgerEntryRow } from "../entities";

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** Sequence of the last returned entry, or null when there are no more pages. */
  lastSeq: string | null;
}

export interface LedgerTotals {
  /** Sum of credits minus debits, as an exact decimal string. */
  netAmount: string;
  count: number;
}

/** Append-only access to the ledger: there is intentionally no update/delete. */
export class LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRow, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toString(),
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toString(),
      balanceAfter: entry.balanceAfter.toString(),
      walletVersion: entry.walletVersion,
      createdAt: entry.createdAt,
    });
  }

  /** Keyset pagination by `seq`: stable even while new entries are appended. */
  async page(walletId: string, afterSeq: string | null, limit: number): Promise<LedgerPage> {
    const rows = await this.em.find(
      LedgerEntryRow,
      afterSeq ? { walletId, seq: { $gt: afterSeq } } : { walletId },
      { orderBy: { seq: "asc" }, limit: limit + 1, disableIdentityMap: true },
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = pageRows.at(-1);
    return {
      entries: pageRows.map(toDomain),
      lastSeq: hasMore && lastRow?.seq !== undefined ? String(lastRow.seq) : null,
    };
  }

  /** Rebuilds the balance from the ledger with exact NUMERIC arithmetic in SQL. */
  async totals(walletId: string): Promise<LedgerTotals> {
    const [row] = await this.em.execute<{ net: string; count: number }[]>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS net,
              COUNT(*)::int AS count
         FROM wallet_ledger_entries
        WHERE wallet_id = ?`,
      [walletId],
    );
    return { netAmount: row?.net ?? "0", count: row?.count ?? 0 };
  }
}

function toDomain(row: LedgerEntryRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.walletId,
    transactionId: row.transactionId,
    direction: row.direction as LedgerDirection,
    money: Money.fromPersistence(row.amount, row.currency),
    balanceBefore: Money.fromPersistence(row.balanceBefore, row.currency),
    balanceAfter: Money.fromPersistence(row.balanceAfter, row.currency),
    walletVersion: row.walletVersion,
    createdAt: row.createdAt,
  });
}

