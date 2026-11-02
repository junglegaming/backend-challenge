import { afterAll, expect, test } from "bun:test";
import { assertLedgerInvariant } from "../test/support/database";
import { wageringHarness } from "../test/support/wagering";
import { completeEventCoverage, eventCoverage } from "./event-verification";
import { LoadFixtures, parallelEach } from "./model";
import { remoteFixture } from "./target";
import { invalidLoadEventsSql } from "./verification-query";

const runDir = process.env.LOAD_RUN_DIR;
if (!runDir || process.env.WAGERING_STACK_MANAGED !== "1") throw new Error("Use bun run test:load");
const partial = process.env.LOAD_VERIFY_PARTIAL === "1";
const fixtures: LoadFixtures | undefined = partial
  ? undefined
  : await Bun.file(`${runDir}/fixtures.json`).json();
const expected: { transactions: number; sqs: number } | undefined = partial
  ? undefined
  : await Bun.file(`${runDir}/expected.json`).json();
const remote = process.env.LOAD_TARGET === "remote";
const h = remote ? wageringHarness(remoteFixture(process.env)) : wageringHarness();
afterAll(async () => {
  try {
    await assertLedgerInvariant(h.database);
  } finally {
    await h.database.onModuleDestroy();
  }
});

test("all load commands have one financial effect, atomic events, processed inbox and consistent wallets", async () => {
  const connection = (await h.database.orm).em.getConnection();
  const consumer = process.env.LOAD_EVENT_CONSUMER;
  const [row] = await connection.execute<
    {
      transactions: number;
      processed: number;
      entries: number;
      outbox: number;
      unpublished: number;
      inbox: number;
      unfinished_inbox: number;
      duplicate_effects: number;
      requests: number;
      events: number;
      unknown: number;
    }[]
  >(
    `SELECT
    (SELECT count(*)::int FROM wager_transactions) AS transactions,
    (SELECT count(*)::int FROM wager_transactions WHERE status = 'PROCESSED') AS processed,
    (SELECT count(*)::int FROM wallet_ledger_entries) AS entries,
    (SELECT count(*)::int FROM outbox_messages) AS outbox,
    (SELECT count(*)::int FROM outbox_messages WHERE published_at IS NULL) AS unpublished,
    (SELECT count(*)::int FROM inbox_messages) AS inbox,
    (SELECT count(*)::int FROM inbox_messages WHERE processed_at IS NULL) AS unfinished_inbox,
    (SELECT count(*)::int FROM (SELECT transaction_id FROM wallet_ledger_entries
      GROUP BY transaction_id HAVING count(*) <> 1) duplicates) AS duplicate_effects,
    (SELECT count(*)::int FROM inbox_messages
      WHERE consumer_name = 'wager-transactions-processor') AS requests,
    (SELECT count(*)::int FROM inbox_messages WHERE consumer_name = ?) AS events,
    (SELECT count(*)::int FROM inbox_messages
      WHERE consumer_name NOT IN ('wager-transactions-processor', ?)) AS unknown`,
    [consumer ?? null, consumer ?? null],
  );
  if (!row) throw new Error("Missing load financial counts");
  const { requests, events, unknown, ...counts } = row;
  let remoteInboxes:
    | { total: number; requests: number; events: number; unknown: number }
    | undefined;
  if (remote) {
    if (!consumer) throw new Error("Missing event consumer identity");
    const inbox = { requests, events, unknown };
    expect(inbox?.unknown).toBe(0);
    expect(counts.inbox).toBe((inbox?.requests ?? 0) + (inbox?.events ?? 0));
    if (inbox) remoteInboxes = { total: counts.inbox, ...inbox };
    const coverage = await eventCoverage(connection, consumer);
    if (!partial) expect(completeEventCoverage(coverage)).toBe(true);
    else {
      expect(coverage.extra).toBe(0);
      expect(coverage.invalid_inbox).toBe(0);
    }
    // Preserve the original exact request-inbox assertion independently of the observer.
    counts.inbox = inbox?.requests ?? -1;
  }
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
  const [invalidEvents] = await connection.execute<{ count: number }[]>(invalidLoadEventsSql);
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
        ...(remoteInboxes ? { remoteInboxes } : {}),
      },
      null,
      2,
    ),
  );
}, 120_000);
