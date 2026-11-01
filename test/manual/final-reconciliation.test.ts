import { test } from "bun:test";
import { wageringHarness } from "../support/wagering";
import { reconcileAll } from "./reconciliation";
import { save } from "./tools";

test("manual final reconciliation: every wallet has a valid ledger chain and rebuilt balance", async () => {
  const h = wageringHarness();
  try {
    await save("all-wallet-reconciliation", await reconcileAll(h));
  } finally {
    await h.database.onModuleDestroy();
  }
}, 90_000);
