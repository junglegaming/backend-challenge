import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SqsTransport } from "../../../src/messaging/infrastructure/sqs-transport";
import { Dependencies, QUEUES } from "../../../src/observability/health/dependencies";
import { MetricSampler } from "../../../src/observability/metric-sampler";
import { canonicalHash } from "../../../src/shared/application/canonical-json";
import { managerFor } from "../../../src/shared/infrastructure/unit-of-work";
import { WagerTransactionKind as Kind } from "../../../src/wagering/domain/wager-transaction";
import { assertLedgerInvariant, scratchDatabase } from "../../support/database";
import { pollUntil } from "../../support/stack";
import { wagerCommand, wageringHarness } from "../../support/wagering";

const fixture = await scratchDatabase();
const h = wageringHarness(fixture);
const dependencies = new Dependencies({ values: h.values }, h.database);
const sampler = new MetricSampler(h.database, dependencies, h.telemetry);
const transport = new SqsTransport({ values: h.values });
afterEach(() => assertLedgerInvariant(h.database));
afterAll(async () => {
  transport.close();
  await dependencies.onModuleDestroy();
  await fixture.cleanup();
});

test("committed outcomes, duplicate sources, conflict types and duration histograms follow real submissions", async () => {
  const wallet = await h.open.handle({
    playerId: randomUUID(),
    initialBalance: { amount: "100.00", currency: "BRL" },
    correlationId: randomUUID(),
  });
  const command = wagerCommand(wallet);
  const inbox = { messageId: randomUUID(), payloadHash: canonicalHash(command) };
  expect((await h.submit.handle(command, { inbox })).type).toBe("completed");
  expect((await h.submit.handle(command, { inbox })).type).toBe("duplicate_message");
  expect((await h.submit.handle(command)).type).toBe("completed");
  expect(
    (await h.submit.handle({ ...command, money: { amount: "11.00", currency: "BRL" } })).type,
  ).toBe("idempotency_conflict");
  expect((await h.submit.handle({ ...command, idempotencyKey: randomUUID() })).type).toBe(
    "external_transaction_conflict",
  );
  await expect(
    h.submit.handle(command, { inbox: { ...inbox, payloadHash: "f".repeat(64) } }),
  ).rejects.toThrow();
  const metrics = await h.telemetry.registry.metrics();
  for (const sample of [
    'wagering_transactions_total{status="PROCESSED",kind="BET",channel="sqs"} 1',
    'wagering_duplicates_total{source="inbox"} 1',
    'wagering_duplicates_total{source="idempotency"} 1',
    'wagering_idempotency_conflicts_total{type="idempotency_conflict"} 1',
    'wagering_idempotency_conflicts_total{type="external_transaction_conflict"} 1',
    'wagering_idempotency_conflicts_total{type="inbox_payload"} 1',
    'wagering_wallet_lock_wait_seconds_count{channel="sqs"} 1',
    'wagering_processing_duration_seconds_count{channel="sqs",status="PROCESSED"} 1',
  ])
    expect(metrics).toContain(sample);
  expect(metrics).not.toContain(wallet.id);
  expect(metrics).not.toContain(command.idempotencyKey);
});

test("real lock timeouts and deadlocks increment separate reasons, with no committed financial effect", async () => {
  const a = await h.open.handle({
    playerId: randomUUID(),
    initialBalance: { amount: "100.00", currency: "BRL" },
    correlationId: randomUUID(),
  });
  const b = await h.open.handle({
    playerId: randomUUID(),
    initialBalance: { amount: "100.00", currency: "BRL" },
    correlationId: randomUUID(),
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const hold = h.uow.run(async (tx) => {
    await h.wallets.lock(tx, a.id);
    entered.resolve();
    await release.promise;
  });
  try {
    await entered.promise;
    await expect(h.submit.handle(wagerCommand(a))).rejects.toThrow();
  } finally {
    release.resolve();
    await hold;
  }
  expect(
    (await h.telemetry.lockConflicts.get()).values.find((v) => v.labels.reason === "lock_timeout")
      ?.value,
  ).toBe(1);
  let ready = 0;
  const both = Promise.withResolvers<void>();
  const opposite = (first: string, second: string) =>
    h.uow.run(async (tx) => {
      await h.wallets.lock(tx, first);
      if (++ready === 2) both.resolve();
      await both.promise;
      await h.wallets.lock(tx, second);
    });
  const outcomes = await Promise.allSettled([opposite(a.id, b.id), opposite(b.id, a.id)]);
  const failed = outcomes.find((result) => result.status === "rejected");
  expect(failed?.status).toBe("rejected");
  if (failed?.status === "rejected") h.telemetry.databaseError(failed.reason);
  expect(
    (await h.telemetry.lockConflicts.get()).values.find((v) => v.labels.reason === "deadlock")
      ?.value,
  ).toBe(1);
});

test("sampler reads shared SQL and real queue state, and reference retries have a finite-label counter", async () => {
  const wallet = await h.open.handle({
    playerId: randomUUID(),
    initialBalance: { amount: "100.00", currency: "BRL" },
    correlationId: randomUUID(),
  });
  const pending = await h.submit.handle(
    wagerCommand(wallet, { kind: Kind.Refund, referenceExternalTransactionId: randomUUID() }),
  );
  if (pending.type !== "completed") throw new Error("Expected pending result");
  await h.resolve.handle(pending.transaction.transactionId);
  expect(
    (await h.telemetry.retries.get()).values.find((v) => v.labels.operation === "reference")?.value,
  ).toBeGreaterThan(0);
  await h.uow.run((tx) =>
    managerFor(tx).execute(
      "UPDATE outbox_messages SET occurred_at = now() - interval '20 seconds' WHERE published_at IS NULL",
    ),
  );
  const id = randomUUID();
  await transport.send(QUEUES.events, JSON.stringify({ eventId: id }), id, id);
  await pollUntil("queue sampler", async () => {
    await sampler.sample();
    return (await h.telemetry.queue.get()).values.some(
      (v) => v.labels.queue === "events" && v.labels.state === "visible" && v.value > 0,
    );
  });
  expect((await h.telemetry.outboxLag.get()).values[0]?.value).toBeGreaterThanOrEqual(20);
  expect((await h.telemetry.pending.get()).values[0]?.value).toBeGreaterThan(0);
  expect((await h.telemetry.queue.get()).values).toHaveLength(9);
});
