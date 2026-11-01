import { expect } from "bun:test";
import { assertLedgerInvariant } from "../support/database";
import { wageringHarness } from "../support/wagering";

export async function reconcileAll(h: ReturnType<typeof wageringHarness>) {
  const connection = (await h.database.orm).em.getConnection();
  const ids = async () =>
    (await connection.execute<{ id: string }[]>("SELECT id FROM wallets ORDER BY id")).map(
      (row) => row.id,
    );
  const before = await ids();
  expect(before.length).toBeGreaterThan(0);
  expect(new Set(before).size).toBe(before.length);
  await assertLedgerInvariant(h.database);
  let reconciled = 0;
  for (const id of before) {
    const result = await h.reconcile.handle(id);
    expect(result).not.toBeNull();
    expect(result?.walletId).toBe(id);
    expect(result?.consistent).toBe(true);
    reconciled++;
  }
  expect(await ids()).toEqual(before);
  expect(reconciled).toBe(before.length);
  return { wallets: before.length, reconciled, stableWalletSet: true, ledgerInvariantPassed: true };
}
