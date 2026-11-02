// Uses real migrated scratch PostgreSQL; no broker, worker, HTTP traffic or sleeps.
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { assertLedgerInvariant, scratchDatabase, testDatabase } from "../support/database";

const candidatePath = new URL("../../load/verification.test.ts", import.meta.url);
// Historical negative-control statements from a98d1e6; never imported as current behavior.
const oldCountsSql = `SELECT
    (SELECT count(*)::int FROM wager_transactions) AS transactions,
    (SELECT count(*)::int FROM wager_transactions WHERE status = 'PROCESSED') AS processed,
    (SELECT count(*)::int FROM wallet_ledger_entries) AS entries,
    (SELECT count(*)::int FROM outbox_messages) AS outbox,
    (SELECT count(*)::int FROM outbox_messages WHERE published_at IS NULL) AS unpublished,
    (SELECT count(*)::int FROM inbox_messages) AS inbox,
    (SELECT count(*)::int FROM inbox_messages WHERE processed_at IS NULL) AS unfinished_inbox,
    (SELECT count(*)::int FROM (SELECT transaction_id FROM wallet_ledger_entries
      GROUP BY transaction_id HAVING count(*) <> 1) duplicates) AS duplicate_effects`;
const oldPartitionSql = `SELECT count(*) FILTER (WHERE consumer_name = 'wager-transactions-processor')::int AS requests,
       count(*) FILTER (WHERE consumer_name = ?)::int AS events,
       count(*) FILTER (WHERE consumer_name NOT IN ('wager-transactions-processor', ?))::int AS unknown
       FROM inbox_messages`;

function actualStatement(source: string, anchor: string, expectedParameters: number): string {
  // Read only the actual verifier's literal SQL; do not import/execute its module.
  expect(source.split(anchor)).toHaveLength(2);
  const at = source.indexOf(anchor);
  const start = source.indexOf("\x60", at) + 1;
  const end = source.indexOf("\x60", start);
  expect(start).toBeGreaterThan(at);
  expect(end).toBeGreaterThan(start);
  const sql = source.slice(start, end);
  expect(sql.includes("\x24{")).toBe(false);
  expect(sql.trimStart().startsWith("SELECT")).toBe(true);
  expect(sql.match(/\?/g)?.length ?? 0).toBe(expectedParameters);
  return sql;
}

test("financial inbox partition uses one statement snapshot across an intervening commit", async () => {
  const fixture = await scratchDatabase();
  let writer: ReturnType<typeof testDatabase> | undefined;
  try {
    writer = testDatabase({ dbName: fixture.values.database.dbName });
    const reader = (await fixture.database.orm).em.getConnection();
    const writeConnection = (await writer.database.orm).em.getConnection();
    const eventConsumer = "snapshot-regression-events";
    const candidate = await readFile(candidatePath, "utf8");
    const combinedSql = actualStatement(candidate, "const [row] = await connection.execute<", 2);
    const commitInbox = async (consumer: string) => {
      // One autocommitted real INSERT. Awaiting execute is the explicit commit barrier.
      await writeConnection.execute(
        "INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        [consumer, randomUUID(), "a".repeat(64)],
      );
    };
    const [isolation] = await reader.execute<{ transaction_isolation: string }[]>(
      "SHOW transaction_isolation",
    );
    expect(isolation?.transaction_isolation).toBe("read committed");
    const [readerPid] = await reader.execute<{ pid: number }[]>("SELECT pg_backend_pid() AS pid");
    const [writerPid] = await writeConnection.execute<{ pid: number }[]>(
      "SELECT pg_backend_pid() AS pid",
    );
    expect(readerPid?.pid).not.toBe(writerPid?.pid);

    // Original: force a committed request inbox strictly between its two statements.
    const [before] = await reader.execute<Record<string, number>[]>(oldCountsSql);
    await commitInbox("wager-transactions-processor");
    const [later] = await reader.execute<Record<string, number>[]>(oldPartitionSql, [
      eventConsumer,
      eventConsumer,
    ]);
    expect(before?.inbox).toBe(0);
    expect(later?.unknown).toBe(0);
    expect(later?.requests).toBe(1);
    // The production equality is deterministically false: 0 !== 1 + 0.
    expect(before?.inbox).not.toBe((later?.requests ?? 0) + (later?.events ?? 0));

    // Candidate: commit an event inbox after the combined statement but before comparison.
    const [snapshot] = await reader.execute<Record<string, number>[]>(combinedSql, [
      eventConsumer,
      eventConsumer,
    ]);
    await commitInbox(eventConsumer);
    expect(snapshot?.inbox).toBe(1);
    expect(snapshot?.requests).toBe(1);
    expect(snapshot?.events).toBe(0);
    expect(snapshot?.unknown).toBe(0);
    expect(snapshot?.inbox).toBe((snapshot?.requests ?? 0) + (snapshot?.events ?? 0));
    const [next] = await reader.execute<Record<string, number>[]>(combinedSql, [
      eventConsumer,
      eventConsumer,
    ]);
    expect(next?.inbox).toBe(2);
    expect(next?.requests).toBe(1);
    expect(next?.events).toBe(1);
    expect(next?.unknown).toBe(0);
    expect(next?.inbox).toBe((next?.requests ?? 0) + (next?.events ?? 0));

    // Local/null-consumer control: classification fields remain excluded from counts.
    const [localRow] = await reader.execute<Record<string, number>[]>(combinedSql, [null, null]);
    expect(localRow?.inbox).toBe(2);
    expect(localRow?.requests).toBe(1);
    expect(localRow?.events).toBe(0);
    expect(localRow?.unknown).toBe(0);
    if (!localRow) throw new Error("Missing local snapshot control");
    const { requests, events, unknown, ...localCounts } = localRow;
    expect(Object.keys(localCounts).sort()).toEqual([
      "duplicate_effects",
      "entries",
      "inbox",
      "outbox",
      "processed",
      "transactions",
      "unfinished_inbox",
      "unpublished",
    ]);
    expect(localCounts.inbox).toBe(2);
    // NULL is only a local-query control, never a valid remote event-consumer identity.

    // Negative control: one unknown consumer still violates the unchanged oracle.
    await commitInbox("snapshot-regression-unknown");
    const [invalid] = await reader.execute<Record<string, number>[]>(combinedSql, [
      eventConsumer,
      eventConsumer,
    ]);
    expect(invalid?.inbox).toBe(3);
    expect(invalid?.unknown).toBe(1);
    expect(invalid?.unknown).not.toBe(0);
    expect(invalid?.inbox).not.toBe((invalid?.requests ?? 0) + (invalid?.events ?? 0));
  } finally {
    try {
      await assertLedgerInvariant(fixture.database);
    } finally {
      try {
        await writer?.database.onModuleDestroy();
      } finally {
        await fixture.cleanup();
      }
    }
  }
}, 30000);
