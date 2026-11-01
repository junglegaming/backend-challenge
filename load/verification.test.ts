import { afterAll, expect, test } from "bun:test";
import { assertLedgerInvariant } from "../test/support/database";
import { wageringHarness } from "../test/support/wagering";
import { LoadFixtures, parallelEach } from "./model";

const runDir = process.env.LOAD_RUN_DIR;
if (!runDir || process.env.WAGERING_STACK_MANAGED !== "1") throw new Error("Use bun run test:load");
const partial = process.env.LOAD_VERIFY_PARTIAL === "1";
const fixtures: LoadFixtures | undefined = partial
  ? undefined
  : await Bun.file(`${runDir}/fixtures.json`).json();
const expected: { transactions: number; sqs: number } | undefined = partial
  ? undefined
  : await Bun.file(`${runDir}/expected.json`).json();
const h = wageringHarness();
afterAll(async () => {
  try {
    await assertLedgerInvariant(h.database);
  } finally {
    await h.database.onModuleDestroy();
  }
});

test("all load commands have one financial effect, atomic events, processed inbox and consistent wallets", async () => {
  const connection = (await h.database.orm).em.getConnection();
  const [counts] = await connection.execute<
    {
      transactions: number;
      processed: number;
      entries: number;
      outbox: number;
      unpublished: number;
      inbox: number;
      unfinished_inbox: number;
      duplicate_effects: number;
    }[]
  >(`SELECT
    (SELECT count(*)::int FROM wager_transactions) AS transactions,
    (SELECT count(*)::int FROM wager_transactions WHERE status = 'PROCESSED') AS processed,
    (SELECT count(*)::int FROM wallet_ledger_entries) AS entries,
    (SELECT count(*)::int FROM outbox_messages) AS outbox,
    (SELECT count(*)::int FROM outbox_messages WHERE published_at IS NULL) AS unpublished,
    (SELECT count(*)::int FROM inbox_messages) AS inbox,
    (SELECT count(*)::int FROM inbox_messages WHERE processed_at IS NULL) AS unfinished_inbox,
    (SELECT count(*)::int FROM (SELECT transaction_id FROM wallet_ledger_entries
      GROUP BY transaction_id HAVING count(*) <> 1) duplicates) AS duplicate_effects`);
  if (!counts) throw new Error("Missing load financial counts");
  if (expected) {
    expect(counts).toEqual({
      transactions: expected.transactions,
      processed: expected.transactions,
      entries: expected.transactions,
      outbox: expected.transactions * 2,
      unpublished: 0,
      inbox: expected.sqs,
      unfinished_inbox: 0,
      duplicate_effects: 0,
    });
  } else {
    expect(counts.processed).toBe(counts.transactions);
    expect(counts.entries).toBe(counts.transactions);
    expect(counts.outbox).toBe(counts.transactions * 2);
    expect(counts.unfinished_inbox).toBe(0);
    expect(counts.duplicate_effects).toBe(0);
  }
  const [invalidEvents] = await connection.execute<{ count: number }[]>(`
    SELECT count(*)::int AS count FROM wager_transactions t LEFT JOIN
      (SELECT payload->'data'->>'transactionId' AS transaction_id, count(*) AS events,
        count(DISTINCT event_type) AS event_types
       FROM outbox_messages GROUP BY payload->'data'->>'transactionId') e
      ON e.transaction_id = t.id::text WHERE e.events IS DISTINCT FROM 2::bigint
        OR e.event_types IS DISTINCT FROM 2::bigint`);
  expect(invalidEvents?.count).toBe(0);
  const wallets = await connection.execute<{ id: string }[]>("SELECT id FROM wallets");
  if (fixtures)
    expect(new Set(wallets.map((wallet) => wallet.id))).toEqual(
      new Set([fixtures.hot, ...fixtures.distributed].map((wallet) => wallet.id)),
    );
  await parallelEach(wallets, 10, async (wallet) => {
    expect((await h.reconcile.handle(wallet.id))?.consistent).toBe(true);
  });
  await assertLedgerInvariant(
    h.database,
    wallets.map((wallet) => wallet.id),
  );
  await Bun.write(
    `${runDir}/${partial ? "partial-verification" : "verification"}.json`,
    JSON.stringify(
      {
        runId: runDir.split("/").at(-1),
        partial,
        passed: true,
        wallets: wallets.length,
        ...counts,
      },
      null,
      2,
    ),
  );
}, 120_000);
