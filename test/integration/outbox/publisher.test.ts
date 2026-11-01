import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SendMessageBatchCommandInput, SendMessageBatchCommandOutput } from "@aws-sdk/client-sqs";
import { OutboxPublisher } from "../../../src/messaging/application/outbox-publisher";
import { OutboxMessage } from "../../../src/messaging/domain/outbox-message";
import { SqsTransport } from "../../../src/messaging/infrastructure/sqs-transport";
import { QUEUES } from "../../../src/observability/health/dependencies";
import { NoopSyncPoint, SyncPointContext } from "../../../src/shared/application/sync-point";
import { managerFor } from "../../../src/shared/infrastructure/unit-of-work";
import { WagerTransactionKind as Kind } from "../../../src/wagering/domain/wager-transaction";
import { assertLedgerInvariant, scratchDatabase, seedOpening } from "../../support/database";
import { EventConsumer } from "../../support/event-consumer";
import { pollUntil } from "../../support/stack";
import { wagerCommand, wageringHarness } from "../../support/wagering";

const fixture = await scratchDatabase();
const h = wageringHarness(fixture);
const live = wageringHarness();
const transport = new SqsTransport({ values: h.values });
const consumer = new EventConsumer(h.uow, transport, `events-${randomUUID()}`);
const publisher = (sync = new NoopSyncPoint()) =>
  new OutboxPublisher({ values: h.values }, h.uow, h.outbox, transport, sync, h.telemetry);
beforeAll(() => consumer.initialize());
afterEach(async () => {
  await assertLedgerInvariant(h.database);
  await assertLedgerInvariant(live.database);
});
afterAll(async () => {
  transport.close();
  await fixture.cleanup();
  await live.database.onModuleDestroy();
});

async function seedEvents(count: number) {
  return h.uow.run(async (tx) => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const { event } = await seedOpening(tx);
      if (!event) throw new Error("Expected opening event");
      await h.outbox.append(tx, OutboxMessage.enqueue(event));
      ids.push(event.eventId);
    }
    return ids;
  });
}
async function outboxRows(ids: string[]) {
  const rows = await h.uow.run((tx) =>
    managerFor(tx).execute<
      { id: string; attempts: number; published_at: string | null; next_attempt_at: string }[]
    >(
      "SELECT id, attempts, published_at, next_attempt_at FROM outbox_messages WHERE id IN (" +
        ids.map(() => "?").join(",") +
        ")",
      ids,
    ),
  );
  return rows.map((row) => ({
    ...row,
    published_at: row.published_at ? new Date(row.published_at) : null,
    next_attempt_at: new Date(row.next_attempt_at),
  }));
}

test("an uncommitted outbox is invisible to the publisher, and rollback leaves no event to send", async () => {
  let id = "";
  await h.uow.run(async (tx) => {
    const { event } = await seedOpening(tx);
    if (!event) throw new Error("Expected event");
    id = event.eventId;
    await h.outbox.append(tx, OutboxMessage.enqueue(event));
    expect(await publisher().publishDue()).toBe(0);
    const deliveries = await transport.receive(QUEUES.events, new AbortController().signal, 1);
    for (const message of deliveries) {
      expect(JSON.parse(message.Body ?? "{}").eventId).not.toBe(id);
      await consumer.consume(message);
    }
  });
  expect(await publisher().publishDue()).toBe(1);
  expect((await consumer.waitFor([id]))[0]?.payload.eventId).toBe(id);
  let rolledBackId = "";
  await expect(
    h.uow.run(async (tx) => {
      const { event } = await seedOpening(tx);
      if (!event) throw new Error("Expected event");
      rolledBackId = event.eventId;
      await h.outbox.append(tx, OutboxMessage.enqueue(event));
      throw new Error("rollback fixture");
    }),
  ).rejects.toThrow("rollback fixture");
  expect(await outboxRows([rolledBackId])).toEqual([]);
  expect(await publisher().publishDue()).toBe(0);
  for (const message of await transport.receive(QUEUES.events, new AbortController().signal, 1)) {
    expect(JSON.parse(message.Body ?? "{}").eventId).not.toBe(rolledBackId);
    await consumer.consume(message);
  }
});

test("two publishers claim many rows once per lease, release SQL locks before send, and lose no event", async () => {
  const ids = await seedEvents(35);
  const claims = new Map<string, number>();
  class ObserveClaim extends NoopSyncPoint {
    override async reach(point: string, context: SyncPointContext) {
      if (point !== "publisher.after_claim_before_send") return;
      const row = (await outboxRows([context.operationId]))[0];
      expect(row?.attempts).toBe(1);
      expect(row?.published_at).toBeNull();
      expect(row?.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
      // NOWAIT succeeds only after the claim transaction has committed.
      await h.uow.run((tx) =>
        managerFor(tx).execute("SELECT id FROM outbox_messages WHERE id = ? FOR UPDATE NOWAIT", [
          context.operationId,
        ]),
      );
      claims.set(context.operationId, (claims.get(context.operationId) ?? 0) + 1);
    }
  }
  const a = publisher(new ObserveClaim());
  const b = publisher(new ObserveClaim());
  await pollUntil("all concurrent outbox publications", async () => {
    await Promise.all([a.publishDue(), b.publishDue()]);
    return (await outboxRows(ids)).every((row) => row.published_at !== null);
  });
  expect(ids.map((id) => claims.get(id))).toEqual(ids.map(() => 1));
  expect((await outboxRows(ids)).map((row) => row.attempts)).toEqual(ids.map(() => 1));
  expect(await consumer.waitFor(ids)).toHaveLength(ids.length);
});

test("a real partial SendMessageBatch failure publishes only confirmed IDs and retries the other entry", async () => {
  const failuresBefore = (await h.telemetry.publishFailures.get()).values[0]?.value ?? 0;
  const retriesBefore =
    (await h.telemetry.retries.get()).values.find((v) => v.labels.operation === "outbox")?.value ??
    0;
  const ids = await seedEvents(2);
  const failedId = ids[0];
  const goodId = ids[1];
  let response: SendMessageBatchCommandOutput | undefined;
  let injected = false;
  transport.client.middlewareStack.add(
    (next, context) => async (args) => {
      const input = args.input as SendMessageBatchCommandInput;
      if (
        context.commandName !== "SendMessageBatchCommand" ||
        injected ||
        !input.Entries?.some((entry) => entry.Id === failedId)
      )
        return next(args);
      injected = true;
      const result = await next({
        ...args,
        input: {
          ...input,
          Entries: input.Entries.map((entry) =>
            entry.Id === failedId ? { ...entry, MessageBody: "" } : entry,
          ),
        },
      });
      response = result.output as SendMessageBatchCommandOutput;
      return result;
    },
    { step: "initialize", name: "partialBatchFault" },
  );
  try {
    expect(await publisher().publishDue()).toBe(2);
  } finally {
    transport.client.middlewareStack.remove("partialBatchFault");
  }
  expect(injected).toBe(true);
  expect(response?.Successful?.map((entry) => entry.Id)).toEqual([goodId]);
  expect((await h.telemetry.publishFailures.get()).values[0]?.value).toBe(failuresBefore + 1);
  expect(response?.Failed?.map((entry) => ({ id: entry.Id, code: entry.Code }))).toEqual([
    { id: failedId, code: "MissingParameter" },
  ]);
  const rows = await outboxRows(ids);
  expect(rows.find((row) => row.id === goodId)?.published_at).toBeInstanceOf(Date);
  expect(rows.find((row) => row.id === failedId)?.published_at).toBeNull();
  expect(await publisher().publishDue()).toBe(0);
  await pollUntil(
    "failed entry lease and retry",
    async () => {
      await publisher().publishDue();
      return (await outboxRows(ids)).every((row) => row.published_at !== null);
    },
    15_000,
  );
  expect((await outboxRows(ids)).find((row) => row.id === goodId)?.attempts).toBe(1);
  expect(
    (await h.telemetry.retries.get()).values.find((v) => v.labels.operation === "outbox")?.value,
  ).toBe(retriesBefore + 1);
  expect(
    (await h.telemetry.published.get()).values.some(
      (v) => v.labels.event_type === "WalletBalanceChanged" && v.value > 0,
    ),
  ).toBe(true);
  expect((await outboxRows(ids)).find((row) => row.id === failedId)?.attempts).toBe(2);
  const deliveries = await consumer.waitFor(ids);
  const repeated = deliveries[0];
  if (!repeated) throw new Error("Expected published event");
  // A fresh broker dedup ID deliberately bypasses its five-minute cache.
  await transport.send(
    QUEUES.events,
    JSON.stringify(repeated.payload),
    repeated.payload.aggregateId,
    randomUUID(),
  );
  await consumer.waitFor([repeated.payload.eventId], 2);
  expect(await consumer.effectCount(repeated.payload.eventId)).toBe(1);
}, 30_000);

test("a SQL confirmation failure after successful send preserves every lease and recovers without duplicate effects", async () => {
  const ids = await seedEvents(3);
  const publishedBefore = (await h.telemetry.published.get()).values.reduce(
    (count, value) => count + value.value,
    0,
  );
  const accepted = new Set<string>();
  transport.client.middlewareStack.add(
    (next, context) => async (args) => {
      const result = await next(args);
      if (context.commandName === "SendMessageBatchCommand") {
        for (const entry of (result.output as SendMessageBatchCommandOutput).Successful ?? [])
          if (entry.Id && ids.includes(entry.Id)) accepted.add(entry.Id);
      }
      return result;
    },
    { step: "initialize", name: "observeSuccessfulConfirmationFault" },
  );
  await h.uow.run(async (tx) => {
    const em = managerFor(tx);
    await em.execute("CREATE TABLE test_confirmation_fault (event_id uuid PRIMARY KEY)");
    await em.execute("INSERT INTO test_confirmation_fault VALUES (?)", [ids[1]]);
    await em.execute(`CREATE FUNCTION fail_test_confirmation() RETURNS trigger AS $$
      BEGIN
        IF NEW.published_at IS NOT NULL AND EXISTS (
          SELECT 1 FROM test_confirmation_fault WHERE event_id = NEW.id
        ) THEN RAISE EXCEPTION 'confirmation fault fixture'; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await em.execute(`CREATE TRIGGER test_confirmation_fault BEFORE UPDATE OF published_at
      ON outbox_messages FOR EACH ROW EXECUTE FUNCTION fail_test_confirmation()`);
  });
  try {
    await expect(publisher().publishDue()).rejects.toThrow("confirmation fault fixture");
    expect(accepted).toEqual(new Set(ids));
    const rows = await outboxRows(ids);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.published_at === null && row.attempts === 1)).toBe(true);
    expect(rows.every((row) => row.next_attempt_at.getTime() > Date.now())).toBe(true);
    expect(
      (await h.telemetry.published.get()).values.reduce((count, value) => count + value.value, 0),
    ).toBe(publishedBefore);
    expect(await publisher().publishDue()).toBe(0);
    expect(await consumer.waitFor(ids)).toHaveLength(3);
  } finally {
    transport.client.middlewareStack.remove("observeSuccessfulConfirmationFault");
    await h.uow.run(async (tx) => {
      const em = managerFor(tx);
      await em.execute("DROP TRIGGER test_confirmation_fault ON outbox_messages");
      await em.execute("DROP FUNCTION fail_test_confirmation()");
      await em.execute("DROP TABLE test_confirmation_fault");
    });
  }
  await pollUntil(
    "recovery after SQL confirmation rollback",
    async () => {
      await publisher().publishDue();
      return (await outboxRows(ids)).every((row) => row.published_at !== null);
    },
    15_000,
  );
  expect((await outboxRows(ids)).map((row) => row.attempts)).toEqual(ids.map(() => 2));
  expect(
    (await h.telemetry.published.get()).values.reduce((count, value) => count + value.value, 0),
  ).toBe(publishedBefore + ids.length);
  for (const id of ids) expect(await consumer.effectCount(id)).toBe(1);
}, 30_000);

test("active stack workers publish all mandatory outcomes with stable identities and no balance event for LOSS", async () => {
  const wallet = await live.open.handle({
    playerId: randomUUID(),
    initialBalance: { amount: "100.00", currency: "BRL" },
    correlationId: randomUUID(),
  });
  const commands = [
    wagerCommand(wallet),
    wagerCommand(wallet, { kind: Kind.Win, money: { amount: "5.00", currency: "BRL" } }),
    wagerCommand(wallet, { kind: Kind.Loss, money: { amount: "0.00", currency: "BRL" } }),
  ];
  const bet = commands[0];
  const win = commands[1];
  if (!bet || !win) throw new Error("Missing commands");
  commands.push(
    wagerCommand(wallet, {
      kind: Kind.Refund,
      referenceExternalTransactionId: bet.externalTransactionId,
    }),
    wagerCommand(wallet, {
      kind: Kind.Rollback,
      money: win.money,
      referenceExternalTransactionId: win.externalTransactionId,
    }),
    wagerCommand(wallet, { money: { amount: "200.00", currency: "BRL" } }),
    wagerCommand(wallet, { kind: Kind.Win, referenceExternalTransactionId: randomUUID() }),
  );
  const statuses: string[] = [];
  for (const command of commands) {
    const result = await live.submit.handle(command);
    expect(result.type).toBe("completed");
    if (result.type === "completed") statuses.push(result.transaction.status);
  }
  expect(statuses).toEqual([
    "PROCESSED",
    "PROCESSED",
    "PROCESSED",
    "PROCESSED",
    "PROCESSED",
    "REJECTED",
    "PENDING_REFERENCE",
  ]);
  const full = await live.open.handle({
    playerId: randomUUID(),
    initialBalance: { amount: "9999999999999999.99", currency: "BRL" },
    correlationId: randomUUID(),
  });
  const failed = await live.submit.handle(
    wagerCommand(full, { kind: Kind.Win, money: { amount: "0.01", currency: "BRL" } }),
  );
  expect(failed.type === "completed" && failed.transaction.status).toBe("FAILED");
  const rows = await live.uow.run((tx) =>
    managerFor(tx).execute<
      { id: string; event_type: string; payload: { data: Record<string, unknown> } }[]
    >(
      "SELECT id, event_type, payload FROM outbox_messages WHERE payload->'data'->>'walletId' IN (?, ?)",
      [wallet.id, full.id],
    ),
  );
  const deliveries = await consumer.waitFor(rows.map((row) => row.id));
  expect(new Set(deliveries.map((event) => event.payload.eventType))).toEqual(
    new Set([
      "WagerTransactionProcessed",
      "WagerTransactionRejected",
      "WagerTransactionPendingReference",
      "WagerTransactionFailed",
      "WalletBalanceChanged",
    ]),
  );
  const loss = rows.find((row) => row.payload.data.kind === "LOSS");
  expect(loss?.event_type).toBe("WagerTransactionProcessed");
  expect(
    rows.filter((row) => row.payload.data.transactionId === loss?.payload.data.transactionId),
  ).toHaveLength(1);
  for (const { payload, message } of deliveries) {
    expect(payload.version).toBe(1);
    expect(message.Attributes?.MessageGroupId).toBe(payload.aggregateId);
    expect(message.Attributes?.MessageDeduplicationId).toBe(payload.eventId);
    expect(payload.aggregateId).toBe(
      payload.eventType === "WalletBalanceChanged"
        ? payload.data.walletId
        : payload.data.transactionId,
    );
  }
  const versions = deliveries
    .filter(
      (event) =>
        event.payload.eventType === "WalletBalanceChanged" &&
        event.payload.data.walletId === wallet.id,
    )
    .map((event) => event.payload.data.walletVersion)
    .sort();
  expect(versions).toEqual([1, 2, 3, 4, 5]);
  await pollUntil("published marks after broker confirmation", async () =>
    live.uow.run(
      async (tx) =>
        (
          await managerFor(tx).execute<{ count: number }[]>(
            "SELECT count(*)::int AS count FROM outbox_messages WHERE id IN (" +
              rows.map(() => "?").join(",") +
              ") AND published_at IS NULL",
            rows.map((row) => row.id),
          )
        )[0]?.count === 0,
    ),
  );
}, 45_000);
