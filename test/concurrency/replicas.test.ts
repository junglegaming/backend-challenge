import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SqsTransport } from "../../src/messaging/infrastructure/sqs-transport";
import { QUEUES } from "../../src/observability/health/dependencies";
import { managerFor } from "../../src/shared/infrastructure/unit-of-work";
import {
  assertLedgerInvariant,
  insertRow,
  rawTransaction,
  scratchDatabase,
} from "../support/database";
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
async function causedOutbox(messageId: string) {
  return sql<{
    id: string;
    event_type: string;
    payload_event_id: string | null;
    wallet_id: string | null;
    transaction_id: string | null;
    outbox_xid: string;
    attempts: number;
    published_at: Date | null;
    ledger_id: string | null;
    ledger_xid: string | null;
    ledger_wallet_id: string | null;
  }>(
    `SELECT o.id, o.event_type, o.payload->>'eventId' AS payload_event_id,
       o.payload->'data'->>'walletId' AS wallet_id,
       o.payload->'data'->>'transactionId' AS transaction_id,
       o.xmin::text AS outbox_xid, o.attempts, o.published_at,
       l.id AS ledger_id, l.xmin::text AS ledger_xid,
       l.wallet_id::text AS ledger_wallet_id
     FROM outbox_messages o LEFT JOIN wallet_ledger_entries l
       ON l.transaction_id::text = o.payload->'data'->>'transactionId'
     WHERE o.payload->>'causationId' = ? ORDER BY o.event_type, o.id`,
    [messageId],
  );
}
async function assertCausedOutbox(messageId: string, walletId: string, transactionId: string) {
  const rows = await causedOutbox(messageId);
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.event_type).sort()).toEqual([
    "WagerTransactionProcessed",
    "WalletBalanceChanged",
  ]);
  expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  expect(new Set(rows.map((row) => row.ledger_id)).size).toBe(1);
  for (const row of rows) {
    expect(row.payload_event_id).toBe(row.id);
    expect(row.wallet_id).toBe(walletId);
    expect(row.transaction_id).toBe(transactionId);
    expect(row.ledger_id).not.toBeNull();
    expect(row.ledger_wallet_id).toBe(walletId);
    // Workers are stopped: these fresh row versions still identify their insert transaction.
    expect(row.outbox_xid).toMatch(/^\d+$/);
    expect(row.ledger_xid).toBe(row.outbox_xid);
    expect(row.attempts).toBe(0);
    expect(row.published_at).toBeNull();
  }
  return rows.map((row) => row.id).sort();
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

  // The wallet lock can mask a missing provider/key constraint for same-wallet retries.
  const other = await openHttpWallet();
  let violation: unknown;
  try {
    await h.uow.run(async (tx) => {
      await insertRow(
        tx,
        "wager_transactions",
        rawTransaction(other.id, {
          provider_id: request.providerId,
          idempotency_key: key,
          player_id: other.playerId,
        }),
      );
      throw new Error("Rollback-only unique-key probe unexpectedly accepted");
    });
  } catch (error) {
    violation = error;
  }
  expect(violation).toMatchObject({ code: "23505" });
  const error = violation as { constraint?: string; cause?: { constraint?: string } };
  expect(error.constraint ?? error.cause?.constraint).toBe("uq_wager_transactions_provider_key");
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
  try {
    await compose(["stop", "consumer"]);
    // Finish an empty broker long poll after stopping the old clients, allowing
    // their outstanding receives to expire before the first gated delivery.
    expect(
      await transport.receive(
        QUEUES.requests,
        new AbortController().signal,
        h.values.consumer.waitSeconds,
      ),
    ).toEqual([]);
    const held = [];
    // SQS does not promise fair distribution of a finite burst. Preserve each
    // existing replica's exact-operation gate while adding the next consumer.
    for (let replica = 1; replica <= 3; replica++) {
      const wallet = await openHttpWallet();
      const envelope = wagerMessage(wallet);
      messageIds.add(envelope.messageId);
      await compose(
        [
          "up",
          "-d",
          "--no-deps",
          replica === 1 ? "--force-recreate" : "--no-recreate",
          "--scale",
          `consumer=${replica}`,
          "consumer",
        ],
        undefined,
        {
          ...testEnvironment,
          TEST_SYNC_POINTS: "consumer.after_commit_before_ack",
          TEST_SYNC_MATCH: envelope.messageId,
          SQS_BATCH_SIZE: "1",
          SQS_VISIBILITY_SECONDS: "180",
        },
      );
      await sendWager(transport, envelope);
      const reached = await runtimeEvent(
        "consumer",
        (r) =>
          r.event === "sync_point_reached" &&
          r.point === "consumer.after_commit_before_ack" &&
          r.operationId === envelope.messageId,
      );
      expect(consumerInstances.has(reached.instanceId)).toBe(false);
      consumerInstances.add(reached.instanceId);
      const http = await correlatedSubmit(httpWager(wallet));
      expect(http.response.status).toBe(200);
      apiCorrelations.add(http.correlationId);
      held.push({ wallet, envelope, instanceId: reached.instanceId });
    }
    const live = await containersOf("consumer");
    expect(live).toHaveLength(3);
    for (const { wallet, envelope, instanceId } of held) {
      expect(live.some((id) => id.startsWith(String(instanceId)))).toBe(true);
      expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("80.00");
      expect(
        await sql(
          "SELECT message_id FROM inbox_messages WHERE message_id = ? AND processed_at IS NOT NULL",
          [envelope.messageId],
        ),
      ).toHaveLength(1);
    }
    // Normal shutdown releases the existing gates and completes the real acks.
    // Read completions before restoring the role replaces their containers/logs.
    await compose(["stop", "consumer"]);
    for (const { envelope, instanceId } of held) {
      const completed = await delivered(envelope.messageId);
      expect(completed.instanceId).toBe(instanceId);
    }
  } finally {
    await restoreRole("consumer");
  }
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
}, 180_000);

for (const point of ["consumer.after_commit_before_ack", "consumer.before_commit"]) {
  test(`scenario ${point.endsWith("before_commit") ? "5b" : "5"}: killing the exact replica at ${point} recovers on a different consumer`, async () => {
    const wallet = await openHttpWallet();
    const envelope = wagerMessage(wallet);
    try {
      await compose(["stop", "worker"]);
      expect(await containersOf("worker")).toHaveLength(0);
      await configureRole("consumer", {
        TEST_SYNC_POINTS: point,
        TEST_SYNC_MATCH: envelope.messageId,
      });
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
      let committedEventIds: string[] = [];
      if (committed) {
        const observed = await h.queries.providerTransaction(
          "provider-a",
          envelope.data.externalTransactionId,
        );
        if (!observed) throw new Error("Committed transaction missing at crash gate");
        expect(observed.status).toBe("PROCESSED");
        committedEventIds = await assertCausedOutbox(
          envelope.messageId,
          wallet.id,
          observed.transactionId,
        );
      } else {
        expect(await causedOutbox(envelope.messageId)).toHaveLength(0);
      }
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
      const recovered = await transaction(envelope.data.externalTransactionId);
      expect(recovered.status).toBe("PROCESSED");
      expect(await debitCount(wallet.id)).toBe(1);
      expect(
        await sql(
          "SELECT message_id FROM inbox_messages WHERE message_id = ? AND processed_at IS NOT NULL",
          [envelope.messageId],
        ),
      ).toHaveLength(1);
      expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("90.00");
      const recoveredEventIds = await assertCausedOutbox(
        envelope.messageId,
        wallet.id,
        recovered.transactionId,
      );
      if (committed) expect(recoveredEventIds).toEqual(committedEventIds);
    } finally {
      try {
        await restoreRole("consumer");
      } finally {
        await restoreRole("worker");
      }
    }
  }, 300_000);
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
    await outboxDrained();
    await compose(["stop", "worker"]);
    const wallets = await Promise.all(Array.from({ length: 36 }, () => openHttpWallet()));
    const ids = wallets.map((w) => w.id);
    const published = await sql<{ id: string }>(
      `SELECT id FROM outbox_messages WHERE payload->'data'->>'walletId' IN (${ids.map(() => "?").join(",")}) ORDER BY next_attempt_at, id`,
      ids,
    );
    expect(published).toHaveLength(72);
    const eventIds = new Set(published.map((r) => r.id));
    const participationTarget = published[0];
    if (!participationTarget) throw new Error("Missing publisher participation target");
    // A finite burst need not be shared fairly. Hold one committed claim while the
    // other runtime publisher proves progress, then release the holder by graceful stop.
    const participationEnvironment = {
      ...testEnvironment,
      TEST_SYNC_POINTS: "publisher.after_claim_before_send",
      TEST_SYNC_MATCH: participationTarget.id,
      OUTBOX_LEASE_MS: "60000",
      OUTBOX_RETRY_MAX_MS: "60000",
    };
    await compose(
      ["up", "-d", "--no-deps", "--force-recreate", "--scale", "worker=1", "worker"],
      undefined,
      participationEnvironment,
    );
    const claimed = await runtimeEvent(
      "worker",
      (r) =>
        r.event === "sync_point_reached" &&
        r.point === "publisher.after_claim_before_send" &&
        r.operationId === participationTarget.id,
    );
    const holder = await instanceContainer("worker", String(claimed.instanceId));
    await compose(
      ["up", "-d", "--no-deps", "--scale", "worker=2", "worker"],
      undefined,
      participationEnvironment,
    );
    await runtimeEvent(
      "worker",
      (r) =>
        r.event === "outbox_publish_completed" &&
        r.confirmed === true &&
        eventIds.has(String(r.eventId)) &&
        r.instanceId !== claimed.instanceId,
    );
    expect(
      await sql<{ attempts: number; published_at: Date | null }>(
        "SELECT attempts, published_at FROM outbox_messages WHERE id = ?",
        [participationTarget.id],
      ),
    ).toEqual([{ attempts: 1, published_at: null }]);
    await changeContainer(holder, "stop");
    await runtimeEvent(
      "worker",
      (r) =>
        r.event === "outbox_publish_completed" &&
        r.eventId === participationTarget.id &&
        r.confirmed === true &&
        r.instanceId === claimed.instanceId,
    );
    await outboxDrained();
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
