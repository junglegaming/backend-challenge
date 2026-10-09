import { expect } from "bun:test";
import type { TestDatabase } from "./test-db";

/**
 * Final invariant of every test: wallet.balance == balance rebuilt from the ledger,
 * plus an unbroken version chain (each entry continues the previous one) ending at the wallet's version.
 */
export async function assertWalletConsistent(db: TestDatabase, walletId: string): Promise<void> {
  const [row] = await db.query<{
    stored: string;
    version: number;
    rebuilt: string;
    entries: string;
    max_version: number | null;
    chain_breaks: string;
    min_version: number | null;
  }>(
    `SELECT w.balance_amount::text AS stored,
            w.version,
            COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0)::numeric(20,2)::text AS rebuilt,
            COUNT(e.id)::text AS entries,
            MAX(e.wallet_version) AS max_version,
            MIN(e.wallet_version) AS min_version,
            COUNT(*) FILTER (WHERE e.prev_after IS NOT NULL AND e.prev_after <> e.balance_before)::text AS chain_breaks
       FROM wallets w
       LEFT JOIN (SELECT *, LAG(balance_after) OVER (PARTITION BY wallet_id ORDER BY wallet_version) AS prev_after
                    FROM wallet_ledger_entries) e ON e.wallet_id = w.id
      WHERE w.id = $1
      GROUP BY w.id`,
    [walletId],
  );
  expect(row).toBeDefined();
  if (!row) return;
  expect(row.rebuilt).toBe(row.stored);
  expect(row.chain_breaks).toBe("0");
  if (row.entries !== "0") {
    expect(row.max_version).toBe(row.version);
    // versions are contiguous
    const span = (row.max_version ?? 0) - (row.min_version ?? 0) + 1;
    expect(span).toBe(Number(row.entries));
  } else {
    expect(row.version).toBe(1);
  }
}

export async function assertAllWalletsConsistent(db: TestDatabase): Promise<number> {
  const wallets = await db.query<{ id: string }>("SELECT id FROM wallets");
  for (const w of wallets) await assertWalletConsistent(db, w.id);
  return wallets.length;
}
