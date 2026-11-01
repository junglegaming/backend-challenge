import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SqsTransport } from "../../src/messaging/infrastructure/sqs-transport";
import { managerFor } from "../../src/shared/infrastructure/unit-of-work";
import { assertLedgerInvariant, scratchDatabase } from "../support/database";
import { EventConsumer } from "../support/event-consumer";
import { apiRequest, httpWager, openHttpWallet, submissionBody, submitHttp } from "../support/http";
import {
  assertReplicas,
  changeContainer,
  configureRole,
  instanceContainer,
  restoreRole,
  runtimeEvent,
  runtimeLogs,
  waitForReplicas,
} from "../support/runtime";
import { sendWager, wagerMessage } from "../support/sqs";
import {
  command,
  compose,
  containersOf,
  killContainer,
  pollUntil,
  testEnvironment,
} from "../support/stack";
import { wageringHarness } from "../support/wagering";

const h = wageringHarness();
const transport = new SqsTransport({ values: h.values });
beforeEach(assertReplicas);
afterEach(async () => {
  await assertLedgerInvariant(h.database);
  await assertReplicas();
});
afterAll(async () => {
  transport.close();
  await h.database.onModuleDestroy();
});

async function sql<T extends object>(query: string, parameters: unknown[] = []) {
  return (await h.database.orm).em.getConnection().execute<T[]>(query, parameters);
}
async function transaction(externalId: string) {
  return pollUntil(
    "terminal transaction",
    async () => {
      const row = await h.queries.providerTransaction("provider-a", externalId);
      return row && row.status !== "PENDING_REFERENCE" ? row : undefined;
    },
    60_000,
  );
}
async function delivered(
  messageId: string,
  predicate: (r: Record<string, unknown>) => boolean = () => true,
) {
  return runtimeEvent(
    "consumer",
    (r) => r.event === "consumer_message_completed" && r.messageId === messageId && predicate(r),
    60_000,
  );
}
async function debitCount(walletId: string) {
  return (
    await sql<{ count: number }>(
      "SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
      [walletId],
    )
  )[0]?.count;
}
async function outboxDrained() {
  await pollUntil(
    "empty unpublished outbox",
    async () =>
      (
        await sql<{ count: number }>(
          "SELECT count(*)::int AS count FROM outbox_messages WHERE published_at IS NULL",
        )
      )[0]?.count === 0,
    90_000,
  );
}
async function correlatedSubmit(body: unknown, key = randomUUID()) {
  const correlationId = randomUUID();
  const response = await apiRequest("/wagering/transactions", {
    method: "POST",
    client: "provider-a",
    body,
    headers: { "Idempotency-Key": key, "X-Correlation-Id": correlationId },
  });
  return { response, correlationId, key, body: await submissionBody(response) };
}

test("scenario 1: fifty simultaneous HTTP retries through Nginx cause exactly one debit", async () => {
  const wallet = await openHttpWallet();
  const request = httpWager(wallet);
  const key = randomUUID();
  const responses = await Promise.all(Array.from({ length: 50 }, () => submitHttp(request, key)));
  expect(responses.every((r) => r.status === 200)).toBe(true);
  const bodies = await Promise.all(responses.map(submissionBody));
  expect(new Set(bodies.map((b) => b.transactionId)).size).toBe(1);
  expect(bodies.filter((b) => !b.idempotentReplay)).toHaveLength(1);
  expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("90.00");
  expect(await debitCount(wallet.id)).toBe(1);
});

for (const channel of ["http", "sqs", "mixed"] as const) {
  test(`scenario 2: two 80.00 bets against 100.00 via ${channel} serialize and remain safe on retry`, async () => {
    const wallet = await openHttpWallet();
    const envelopes = Array.from({ length: 2 }, () =>
      wagerMessage(wallet, { money: { amount: "80.00", currency: "BRL" } }),
    );
    async function submit(index: number) {
      const envelope = envelopes[index];
      if (!envelope) throw new Error("Missing fixture");
      if (channel === "sqs" || (channel === "mixed" && index === 1)) {
        const before = (await runtimeLogs("consumer")).filter(
          (r) => r.event === "consumer_message_completed" && r.messageId === envelope.messageId,
        ).length;
        await sendWager(transport, envelope);
        await pollUntil(
          "a new delivery acknowledged after the retry",
          async () =>
            (await runtimeLogs("consumer")).filter(
              (r) => r.event === "consumer_message_completed" && r.messageId === envelope.messageId,
            ).length > before,
          60_000,
        );
      } else {
        const { idempotencyKey, ...body } = envelope.data;
        const response = await submitHttp(body, idempotencyKey);
        expect([200, 422]).toContain(response.status);
      }
    }
    await Promise.all([submit(0), submit(1)]);
    const outcomes = await Promise.all(
      envelopes.map((e) => transaction(e.data.externalTransactionId)),
    );
    expect(outcomes.filter((t) => t.status === "PROCESSED")).toHaveLength(1);
    expect(
      outcomes.filter((t) => t.status === "REJECTED" && t.failureCode === "INSUFFICIENT_FUNDS"),
    ).toHaveLength(1);
    await Promise.all([submit(0), submit(1)]);
    expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("20.00");
    expect(await debitCount(wallet.id)).toBe(1);
  });
}

test("scenario 3: an independently locked wallet does not block another wallet's overlapping request", async () => {
  const [a, b] = await Promise.all([openHttpWallet(), openHttpWallet()]);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holder = h.uow.run(async (tx) => {
    await managerFor(tx).execute("SELECT id FROM wallets WHERE id = ? FOR UPDATE", [a.id]);
    started.resolve();
    await release.promise;
  });
  await started.promise;
  let aFinished = false;
  const requestA = submitHttp(httpWager(a)).finally(() => {
    aFinished = true;
  });
  try {
    await pollUntil(
      "first request waiting on its wallet row lock",
      async () =>
        (
          await sql<{ waiting: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%wallets%' AND pid <> pg_backend_pid()) AS waiting",
          )
        )[0]?.waiting,
      1500,
      10,
    );
    const responseB = await submitHttp(httpWager(b));
    expect(responseB.status).toBe(200);
    expect(aFinished).toBe(false);
  } finally {
    release.resolve();
    await holder;
  }
  expect((await requestA).status).toBe(200);
  expect(await debitCount(a.id)).toBe(1);
  expect(await debitCount(b.id)).toBe(1);
});

test("scenario 4: real mixed work is handled by three API and three consumer instance IDs", async () => {
  const apiCorrelations = new Set<string>();
  const messageIds = new Set<string>();
  const apiInstances = new Set<unknown>();
  const consumerInstances = new Set<unknown>();
  for (let batch = 0; batch < 4; batch++) {
    await Promise.all(
      Array.from({ length: 18 }, async () => {
        const wallet = await openHttpWallet();
        const envelope = wagerMessage(wallet);
        messageIds.add(envelope.messageId);
        const [http] = await Promise.all([
          correlatedSubmit(httpWager(wallet)),
          sendWager(transport, envelope),
        ]);
        expect(http.response.status).toBe(200);
        apiCorrelations.add(http.correlationId);
        await delivered(envelope.messageId);
        expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("80.00");
      }),
    );
    for (const record of await runtimeLogs("api"))
      if (
        record.event === "wager_submission_completed" &&
        apiCorrelations.has(String(record.correlationId))
      )
        apiInstances.add(record.instanceId);
    for (const record of await runtimeLogs("consumer"))
      if (record.event === "consumer_message_completed" && messageIds.has(String(record.messageId)))
        consumerInstances.add(record.instanceId);
    if (apiInstances.size >= 3 && consumerInstances.size >= 3) break;
  }
  expect(apiInstances.size).toBeGreaterThanOrEqual(3);
  expect(consumerInstances.size).toBeGreaterThanOrEqual(3);
});

for (const point of ["consumer.after_commit_before_ack", "consumer.before_commit"]) {
  test(`scenario ${point.endsWith("before_commit") ? "5b" : "5"}: killing the exact replica at ${point} recovers on a different consumer`, async () => {
    const wallet = await openHttpWallet();
    const envelope = wagerMessage(wallet);
    await configureRole("consumer", {
      TEST_SYNC_POINTS: point,
      TEST_SYNC_MATCH: envelope.messageId,
    });
    try {
      await sendWager(transport, envelope);
      const reached = await runtimeEvent(
        "consumer",
        (r) =>
          r.event === "sync_point_reached" &&
          r.point === point &&
          r.operationId === envelope.messageId,
      );
      const committed = point === "consumer.after_commit_before_ack";
      expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe(
        committed ? "90.00" : "100.00",
      );
      expect(
        await sql("SELECT message_id FROM inbox_messages WHERE message_id = ?", [
          envelope.messageId,
        ]),
      ).toHaveLength(committed ? 1 : 0);
      await killContainer(await instanceContainer("consumer", String(reached.instanceId)));
      const killedAt = Date.now();
      const completion = await delivered(
        envelope.messageId,
        (r) =>
          r.instanceId !== reached.instanceId &&
          Number(r.attempt) >= 2 &&
          Number(r.time) >= killedAt,
      );
      expect(completion.outcome).toBe(committed ? "duplicate_message" : "PROCESSED");
      expect((await transaction(envelope.data.externalTransactionId)).status).toBe("PROCESSED");
      expect(await debitCount(wallet.id)).toBe(1);
      expect(
        await sql(
          "SELECT message_id FROM inbox_messages WHERE message_id = ? AND processed_at IS NOT NULL",
          [envelope.messageId],
        ),
      ).toHaveLength(1);
      expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("90.00");
    } finally {
      await restoreRole("consumer");
    }
  }, 150_000);
}

test("race: HTTP refunds and SQS rollbacks compete on thirty bets with exactly one accepted reversal", async () => {
  await Promise.all(
    Array.from({ length: 30 }, async (_, index) => {
      const wallet = await openHttpWallet();
      const bet = httpWager(wallet);
      expect((await submitHttp(bet)).status).toBe(200);
      const httpKind = index % 2 ? "ROLLBACK" : "REFUND";
      const queueKind = index % 2 ? "REFUND" : "ROLLBACK";
      const http = httpWager(wallet, {
        kind: httpKind,
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      const queued = wagerMessage(wallet, {
        kind: queueKind,
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      const [response] = await Promise.all([submitHttp(http), sendWager(transport, queued)]);
      expect([200, 422]).toContain(response.status);
      await delivered(queued.messageId);
      const results = await Promise.all([
        transaction(http.externalTransactionId),
        transaction(queued.data.externalTransactionId),
      ]);
      expect(results.filter((t) => t.status === "PROCESSED")).toHaveLength(1);
      expect(
        results.filter(
          (t) => t.status === "REJECTED" && t.failureCode === "REFERENCE_ALREADY_REVERSED",
        ),
      ).toHaveLength(1);
      expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("100.00");
      expect((await h.queries.ledgerPage(wallet.id, 0, 100))?.length).toBe(3);
    }),
  );
}, 90_000);

for (const kind of ["ROLLBACK", "REFUND"]) {
  test(`scenario 7: ${kind} waits for its reference across HTTP and SQS processes in both directions`, async () => {
    for (const queueFirst of [true, false]) {
      const wallet = await openHttpWallet();
      const bet = httpWager(wallet);
      const reverse = httpWager(wallet, {
        kind,
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      if (queueFirst) {
        const message = wagerMessage(wallet, reverse);
        await sendWager(transport, message);
        expect((await delivered(message.messageId)).outcome).toBe("PENDING_REFERENCE");
        expect(
          (await h.queries.providerTransaction("provider-a", reverse.externalTransactionId))
            ?.status,
        ).toBe("PENDING_REFERENCE");
        expect((await submitHttp(bet)).status).toBe(200);
      } else {
        const response = await submitHttp(reverse);
        expect(response.status).toBe(202);
        const message = wagerMessage(wallet, bet);
        await sendWager(transport, message);
        await delivered(message.messageId);
      }
      expect((await transaction(reverse.externalTransactionId)).status).toBe("PROCESSED");
      expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("100.00");
      expect((await h.queries.ledgerPage(wallet.id, 0, 100))?.length).toBe(3);
    }
  }, 90_000);
}

test("scenario 8: restarting all eight application replicas during live traffic preserves every expected effect", async () => {
  const wallets = await Promise.all(Array.from({ length: 24 }, () => openHttpWallet()));
  const requests = wallets.map((wallet) => ({
    wallet,
    http: httpWager(wallet),
    key: randomUUID(),
    queued: wagerMessage(wallet),
  }));
  const target = requests[0];
  if (!target) throw new Error("Missing restart fixture");
  await configureRole("consumer", {
    TEST_SYNC_POINTS: "consumer.before_commit",
    TEST_SYNC_MATCH: target.queued.messageId,
  });
  const ids = (
    await Promise.all([containersOf("api"), containersOf("consumer"), containersOf("worker")])
  ).flat();
  const before = await Promise.all(
    ids.map((id) => command(["docker", "inspect", "--format", "{{.State.StartedAt}}", id])),
  );
  let restarting = false;
  try {
    await sendWager(transport, target.queued);
    await runtimeEvent(
      "consumer",
      (r) => r.event === "sync_point_reached" && r.operationId === target.queued.messageId,
    );
    const traffic = Promise.all(
      requests.map(async ({ http, key, queued }, index) => {
        if (index > 0) await sendWager(transport, queued);
        await pollUntil(
          "HTTP recovery with original idempotency key",
          async () => {
            try {
              const response = await submitHttp(http, key);
              if ([502, 503, 504].includes(response.status)) return false;
              expect(response.status).toBe(200);
              return true;
            } catch (error) {
              if (error instanceof TypeError) return false;
              throw error;
            }
          },
          90_000,
        );
      }),
    );
    restarting = true;
    await compose(["restart", "api", "consumer", "worker"]);
    await traffic;
    await waitForReplicas();
    await pollUntil(
      "Nginx readiness after every API recovered",
      async () => (await apiRequest("/health/ready", { client: null })).status === 200,
      30_000,
    );
    for (let i = 0; i < ids.length; i++)
      expect(
        await command(["docker", "inspect", "--format", "{{.State.StartedAt}}", ids[i] as string]),
      ).not.toBe(before[i]);
    for (const { wallet, http, key, queued } of requests) {
      await delivered(queued.messageId);
      expect((await transaction(http.externalTransactionId)).status).toBe("PROCESSED");
      expect((await transaction(queued.data.externalTransactionId)).status).toBe("PROCESSED");
      expect((await submitHttp(http, key)).status).toBe(200);
      expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("80.00");
      expect(await debitCount(wallet.id)).toBe(2);
      expect((await h.reconcile.handle(wallet.id))?.consistent).toBe(true);
    }
    await outboxDrained();
  } finally {
    if (restarting)
      await pollUntil(
        "restarted APIs healthy",
        async () => {
          try {
            return (await apiRequest("/health/ready", { client: null })).status === 200;
          } catch {
            return false;
          }
        },
        90_000,
      );
    await restoreRole("consumer");
  }
}, 180_000);

test("scenario 6: two runtime publishers drain load and a crash after send produces a safe duplicate after the FIFO window", async () => {
  const fixture = await scratchDatabase();
  const consumerName = `crash-events-${randomUUID()}`;
  const consumer = new EventConsumer(fixture.uow, transport, consumerName);
  await consumer.initialize();
  let paused: string | undefined;
  try {
    const wallets = await Promise.all(Array.from({ length: 36 }, () => openHttpWallet()));
    const ids = wallets.map((w) => w.id);
    await outboxDrained();
    const published = await sql<{ id: string }>(
      `SELECT id FROM outbox_messages WHERE payload->'data'->>'walletId' IN (${ids.map(() => "?").join(",")})`,
      ids,
    );
    const eventIds = new Set(published.map((r) => r.id));
    const publishers = new Set(
      (await runtimeLogs("worker"))
        .filter(
          (r) =>
            r.event === "outbox_publish_completed" &&
            r.confirmed === true &&
            eventIds.has(String(r.eventId)),
        )
        .map((r) => r.instanceId),
    );
    expect(publishers.size).toBeGreaterThanOrEqual(2);
    await consumer.waitFor([...eventIds], 1, 90_000);
    for (const id of eventIds) expect(await consumer.effectCount(id)).toBe(1);

    await compose(["stop", "worker"]);
    const wallet = await openHttpWallet();
    const target = (
      await sql<{ id: string }>(
        "SELECT id FROM outbox_messages WHERE payload->'data'->>'walletId' = ? ORDER BY id LIMIT 1",
        [wallet.id],
      )
    )[0];
    if (!target) throw new Error("Missing target outbox event");
    await configureRole(
      "worker",
      {
        TEST_SYNC_POINTS: "publisher.after_send_before_mark",
        TEST_SYNC_MATCH: target.id,
      },
      false,
    );
    const reached = await runtimeEvent(
      "worker",
      (r) =>
        r.event === "sync_point_reached" &&
        r.point === "publisher.after_send_before_mark" &&
        r.operationId === target.id,
    );
    const victim = await instanceContainer("worker", String(reached.instanceId));
    await killContainer(victim);
    const survivor = (await containersOf("worker")).find((id) => id !== victim);
    if (!survivor) throw new Error("Missing surviving publisher");
    paused = survivor;
    await changeContainer(survivor, "pause");
    const first = (await consumer.waitFor([target.id]))[0];
    expect(
      (
        await sql<{ published_at: string | null }>(
          "SELECT published_at FROM outbox_messages WHERE id = ?",
          [target.id],
        )
      )[0]?.published_at,
    ).toBeNull();
    // The real FIFO retains its stable-ID deduplication record even after DeleteMessage.
    // Recovery resumes after this provider-defined window so the publisher's own retry
    // must produce a second physical message; changing the deduplication ID would not prove it.
    const afterDeduplicationWindow = Number(reached.time) + 301_000;
    await pollUntil(
      "the real FIFO's five-minute deduplication window",
      async () => Date.now() >= afterDeduplicationWindow,
      310_000,
      1000,
    );
    await changeContainer(survivor, "unpause");
    paused = undefined;
    const recovered = await runtimeEvent(
      "worker",
      (r) =>
        r.event === "outbox_publish_completed" &&
        r.eventId === target.id &&
        r.confirmed === true &&
        Number(r.attempt) >= 2 &&
        r.instanceId !== reached.instanceId,
      60_000,
    );
    expect(recovered.confirmed).toBe(true);
    await compose(
      ["up", "-d", "--no-deps", "--wait", "--wait-timeout", "90", "--scale", "worker=2", "worker"],
      undefined,
      {
        ...testEnvironment,
        TEST_SYNC_POINTS: "publisher.after_send_before_mark",
        TEST_SYNC_MATCH: target.id,
      },
    );
    const second = (await consumer.waitFor([target.id], 2, 60_000))[0];
    expect(first?.message.MessageId).not.toBe(second?.message.MessageId);
    expect(first?.message.Body).toBe(second?.message.Body);
    expect(second?.message.Attributes?.MessageDeduplicationId).toBe(target.id);
    expect(await consumer.effectCount(target.id)).toBe(1);
    expect(
      await fixture.uow.run((tx) =>
        managerFor(tx).execute(
          "SELECT message_id FROM inbox_messages WHERE consumer_name = ? AND message_id = ? AND processed_at IS NOT NULL",
          [consumerName, target.id],
        ),
      ),
    ).toHaveLength(1);
    await outboxDrained();
  } finally {
    if (paused) await changeContainer(paused, "unpause");
    await restoreRole("worker");
    await assertLedgerInvariant(fixture.database);
    await fixture.cleanup();
  }
}, 420_000);
