import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { SqsTransport } from "../../src/messaging/infrastructure/sqs-transport";
import { QUEUES } from "../../src/observability/health/dependencies";
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
import { command, compose, containersOf, killContainer, pollUntil } from "../support/stack";
import { accessToken } from "../support/tokens";
import { toxiproxy } from "../support/toxiproxy";
import { wageringHarness } from "../support/wagering";

const h = wageringHarness();
const transport = new SqsTransport({ values: h.values });
const eventFixture = await scratchDatabase();
const events = new EventConsumer(eventFixture.uow, transport, `failure-events-${randomUUID()}`);
let walletIds: string[] = [];
beforeAll(() => events.initialize());
beforeEach(async () => {
  walletIds = [];
  await assertReplicas();
});
afterEach(async () => {
  await toxiproxy.reset();
  await waitForReplicas();
  await ready();
  await outboxDrained();
  for (const id of walletIds) expect((await h.reconcile.handle(id))?.consistent).toBe(true);
  await assertLedgerInvariant(h.database);
  await assertLedgerInvariant(eventFixture.database);
  expect(await queueSize(QUEUES.deadLetters)).toBe(0);
});
afterAll(async () => {
  transport.close();
  await eventFixture.cleanup();
  await h.database.onModuleDestroy();
});

async function sql<T extends object>(query: string, parameters: unknown[] = []) {
  return (await h.database.orm).em.getConnection().execute<T[]>(query, parameters);
}
async function wallet() {
  const result = await openHttpWallet();
  walletIds.push(result.id);
  return result;
}
async function ready() {
  return pollUntil(
    "gateway readiness after fault recovery",
    async () => {
      try {
        return (await apiRequest("/health/ready", { client: null })).status === 200;
      } catch (error) {
        if (error instanceof TypeError) return false;
        throw error;
      }
    },
    90_000,
  );
}
async function outboxDrained() {
  await pollUntil(
    "outbox drained after fault recovery",
    async () =>
      (
        await sql<{ count: number }>(
          "SELECT count(*)::int AS count FROM outbox_messages WHERE published_at IS NULL",
        )
      )[0]?.count === 0,
    90_000,
  );
}
async function queueSize(name: string) {
  const { Attributes } = await transport.client.send(
    new GetQueueAttributesCommand({
      QueueUrl: await transport.queue(name),
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
    { abortSignal: AbortSignal.timeout(2000) },
  );
  return (
    Number(Attributes?.ApproximateNumberOfMessages ?? "0") +
    Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? "0")
  );
}
async function delivered(
  messageId: string,
  predicate: (r: Record<string, unknown>) => boolean = () => true,
) {
  return runtimeEvent(
    "consumer",
    (r) => r.event === "consumer_message_completed" && r.messageId === messageId && predicate(r),
    90_000,
  );
}
async function processed(externalId: string) {
  return pollUntil(
    "expected processed operation",
    async () => {
      const row = await h.queries.providerTransaction("provider-a", externalId);
      if (!row || row.status === "PENDING_REFERENCE") return false;
      expect(row.status).toBe("PROCESSED");
      return row;
    },
    90_000,
  );
}
async function debitCount(id: string) {
  return (
    await sql<{ count: number }>(
      "SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
      [id],
    )
  )[0]?.count;
}
async function oneBet(w: { id: string }, envelope: ReturnType<typeof wagerMessage>) {
  await delivered(envelope.messageId);
  await processed(envelope.data.externalTransactionId);
  expect((await h.queries.wallet(w.id))?.balance.amount).toBe("90.00");
  expect((await h.queries.wallet(w.id))?.version).toBe(2);
  expect(await debitCount(w.id)).toBe(1);
  expect(
    await sql(
      "SELECT message_id FROM inbox_messages WHERE message_id = ? AND processed_at IS NOT NULL",
      [envelope.messageId],
    ),
  ).toHaveLength(1);
}
async function retryHttp(body: unknown, key: string) {
  return pollUntil(
    "HTTP original-key recovery",
    async () => {
      try {
        const response = await submitHttp(body, key);
        if ([502, 503, 504].includes(response.status)) return false;
        expect(response.status).toBe(200);
        return response;
      } catch (error) {
        if (error instanceof TypeError) return false;
        throw error;
      }
    },
    90_000,
  );
}
async function holdWallet(id: string) {
  const entered = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const done = h.uow.run(async (tx) => {
    const pid = (
      await managerFor(tx).execute<{ pid: number }[]>("SELECT pg_backend_pid() AS pid")
    )[0]?.pid;
    await managerFor(tx).execute("SELECT id FROM wallets WHERE id = ? FOR UPDATE", [id]);
    if (pid === undefined) throw new Error("Missing test lock-holder PID");
    entered.resolve(pid);
    await release.promise;
  });
  void done.catch(entered.reject);
  return { pid: await entered.promise, release: () => release.resolve(), done };
}
async function blockedBy(pid: number, minimum = 1, timeoutMs = 1500) {
  return pollUntil(
    "real wallet-lock waiters",
    async () => {
      // Row-lock queues can block a second waiter behind the first waiter,
      // rather than directly behind the original wallet-lock owner.
      const rows = await sql<{ pid: number; client_ip: string }>(
        `WITH RECURSIVE blocked(pid) AS (
          SELECT ?::int
          UNION
          SELECT a.pid FROM pg_stat_activity a
          JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid))
          WHERE a.datname = current_database() AND a.state = 'active'
            AND a.wait_event_type = 'Lock'
        )
        SELECT a.pid, host(a.client_addr) AS client_ip
        FROM pg_stat_activity a JOIN blocked b USING (pid) WHERE a.pid <> ?::int`,
        [pid, pid],
      );
      return rows.length >= minimum ? rows : false;
    },
    timeoutMs,
    10,
  );
}
async function observedWalletHolder(id: string) {
  const entered = Promise.withResolvers<number>();
  const contender = h.uow.run(async (tx) => {
    const pid = (
      await managerFor(tx).execute<{ pid: number }[]>("SELECT pg_backend_pid() AS pid")
    )[0]?.pid;
    if (pid === undefined) throw new Error("Missing test contender PID");
    entered.resolve(pid);
    await managerFor(tx).execute("SELECT id FROM wallets WHERE id = ? FOR UPDATE", [id]);
  });
  void contender.catch(entered.reject);
  const finished = contender.catch(() => undefined);
  const pid = await entered.promise;
  try {
    return await pollUntil(
      "the barrier owner's PostgreSQL backend",
      async () => {
        const rows = await sql<{ pid: number; backend_start: string }>(
          "SELECT a.pid, a.backend_start::text FROM pg_stat_activity a WHERE a.pid = ANY(pg_blocking_pids(?::int))",
          [pid],
        );
        return rows.length === 1 ? rows[0] : false;
      },
      1500,
      10,
    );
  } finally {
    // The existing two-second lock_timeout bounds this owned observer. Waiting
    // avoids cancelling its backend after it has returned to the shared pool.
    await finished;
  }
}
async function metricTotal(expression: string) {
  const response = await fetch(
    `http://127.0.0.1:19090/api/v1/query?query=${encodeURIComponent(expression)}`,
  );
  if (!response.ok) throw new Error("Prometheus query failed");
  const body = (await response.json()) as { data: { result: { value: [number, string] }[] } };
  return Number(body.data.result[0]?.value[1] ?? "0");
}
async function allInstances() {
  return (
    await Promise.all([containersOf("api"), containersOf("consumer"), containersOf("worker")])
  )
    .flat()
    .sort();
}

test("PostgreSQL outage gates all consumers across the redrive window and every valid message later applies once", async () => {
  const fixtures = await Promise.all(
    Array.from({ length: 36 }, async () => {
      const w = await wallet();
      return { w, envelope: wagerMessage(w) };
    }),
  );
  const consumers = (await containersOf("consumer")).sort();
  const ids = new Set<string>(fixtures.map((f) => f.envelope.messageId));
  const faultAt = Date.now();
  await toxiproxy.enable("postgres", false);
  try {
    await Promise.all(fixtures.map((f) => sendWager(transport, f.envelope)));
    await pollUntil("three consumers enter their persistent database outage gate", async () => {
      const paused = new Set(
        (await runtimeLogs("consumer"))
          .filter(
            (r) =>
              r.event === "consumer_database_paused" &&
              ids.has(String(r.messageId)) &&
              Number(r.time) >= faultAt,
          )
          .map((r) => r.instanceId),
      );
      return paused.size === 3;
    });
    // Cover more than maxReceiveCount complete visibility windows: an ungated
    // consumer would repeatedly receive valid work and exhaust native redrive.
    const exposure =
      (h.values.consumer.maxReceives + 1) * h.values.consumer.visibilitySeconds * 1000;
    await pollUntil(
      "outage spans the native redrive opportunity without a DLQ transfer",
      async () => {
        expect(await queueSize(QUEUES.deadLetters)).toBe(0);
        return Date.now() >= faultAt + exposure;
      },
      exposure + 10_000,
      250,
    );
    expect(
      await sql(
        `SELECT id FROM wager_transactions WHERE external_transaction_id IN (${fixtures.map(() => "?").join(",")})`,
        fixtures.map((f) => f.envelope.data.externalTransactionId),
      ),
    ).toHaveLength(0);
    expect(
      await sql(
        `SELECT message_id FROM inbox_messages WHERE message_id IN (${fixtures.map(() => "?").join(",")})`,
        [...ids],
      ),
    ).toHaveLength(0);
    for (const { w } of fixtures)
      expect((await h.queries.wallet(w.id))?.balance.amount).toBe("100.00");
  } finally {
    await toxiproxy.enable("postgres", true);
  }
  await pollUntil(
    "all original consumer instances resume automatically",
    async () =>
      new Set(
        (await runtimeLogs("consumer"))
          .filter((r) => r.event === "consumer_database_resumed" && Number(r.time) >= faultAt)
          .map((r) => r.instanceId),
      ).size === 3,
    40_000,
  );
  for (const { w, envelope } of fixtures) await oneBet(w, envelope);
  expect((await containersOf("consumer")).sort()).toEqual(consumers);
  expect(await queueSize(QUEUES.deadLetters)).toBe(0);
}, 150_000);

test("PostgreSQL outage returns HTTP503 Retry-After with live200 ready503 and an original-key retry has one effect", async () => {
  const w = await wallet();
  const body = httpWager(w);
  const key = randomUUID();
  await toxiproxy.enable("postgres", false);
  try {
    const response = await submitHttp(body, key);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    for (let probe = 0; probe < 6; probe++)
      expect((await apiRequest("/health/ready", { client: null })).status).toBe(503);
    expect((await apiRequest("/health/live", { client: null })).status).toBe(200);
    expect(
      await h.queries.providerTransaction("provider-a", body.externalTransactionId),
    ).toBeNull();
    expect(await debitCount(w.id)).toBe(0);
  } finally {
    await toxiproxy.enable("postgres", true);
  }
  const first = await submissionBody(await retryHttp(body, key));
  const replay = await submissionBody(await retryHttp(body, key));
  expect(replay.transactionId).toBe(first.transactionId);
  expect(replay.idempotentReplay).toBe(true);
  expect((await h.queries.wallet(w.id))?.balance.amount).toBe("90.00");
  expect(await debitCount(w.id)).toBe(1);
}, 90_000);

test("SQS outage keeps committed outbox events through increasing retries then publishes every expected event", async () => {
  await toxiproxy.enable("sqs", false);
  let eventIds: string[] = [];
  try {
    const fixtures = await Promise.all(Array.from({ length: 12 }, () => wallet()));
    await Promise.all(
      fixtures.map(async (w) => expect((await submitHttp(httpWager(w))).status).toBe(200)),
    );
    const rows = await sql<{ id: string }>(
      `SELECT id FROM outbox_messages WHERE payload->'data'->>'walletId' IN (${fixtures.map(() => "?").join(",")})`,
      fixtures.map((w) => w.id),
    );
    eventIds = rows.map((r) => r.id);
    expect(eventIds).toHaveLength(48);
    for (let probe = 0; probe < 6; probe++)
      expect((await apiRequest("/health/ready", { client: null })).status).toBe(503);
    await pollUntil(
      "every committed event survives at least three real send attempts",
      async () => {
        const rows = await sql<{ attempts: number; published_at: string | null }>(
          `SELECT attempts, published_at FROM outbox_messages WHERE id IN (${eventIds.map(() => "?").join(",")})`,
          eventIds,
        );
        expect(rows.every((r) => r.published_at === null)).toBe(true);
        return rows.every((r) => r.attempts >= 3);
      },
      60_000,
    );
  } finally {
    await toxiproxy.enable("sqs", true);
  }
  await events.waitFor(eventIds, 1, 90_000);
  for (const id of eventIds) expect(await events.effectCount(id)).toBe(1);
  await outboxDrained();
}, 150_000);

test("pausing MiniStack interrupts a committed message ack and existing consumers recover without recreation", async () => {
  const w = await wallet();
  const envelope = wagerMessage(w);
  const instances = await allInstances();
  const broker = (await containersOf("ministack"))[0];
  if (!broker) throw new Error("Missing test MiniStack");
  const holder = await holdWallet(w.id);
  let paused = false;
  let released = false;
  try {
    await sendWager(transport, envelope);
    await blockedBy(holder.pid);
    await changeContainer(broker, "pause");
    paused = true;
    const pausedAt = Date.now();
    holder.release();
    released = true;
    await holder.done;
    await processed(envelope.data.externalTransactionId);
    expect((await apiRequest("/health/ready", { client: null })).status).toBe(503);
    await runtimeEvent(
      "consumer",
      (r) => r.event === "consumer_poll_failed" && Number(r.time) >= pausedAt,
      20_000,
    );
    await changeContainer(broker, "unpause");
    paused = false;
    await delivered(envelope.messageId, (r) => Number(r.attempt) >= 2);
    await oneBet(w, envelope);
    expect(await allInstances()).toEqual(instances);
  } finally {
    if (!released) {
      holder.release();
      await holder.done;
    }
    if (paused) await changeContainer(broker, "unpause");
  }
}, 90_000);

test("PostgreSQL latency plus observed wallet contention increments lock conflicts and retries without duplicates", async () => {
  const w = await wallet();
  const body = httpWager(w);
  const key = randomUUID();
  const envelope = wagerMessage(w);
  const beforeLocks = await metricTotal(
    'sum(wagering_lock_conflicts_total{reason="lock_timeout"})',
  );
  const beforeRetries = await metricTotal('sum(wagering_retries_total{operation="consumer"})');
  await toxiproxy.latency("postgres", 100);
  const holder = await holdWallet(w.id);
  let response: Response | undefined;
  try {
    const request = submitHttp(body, key);
    await sendWager(transport, envelope);
    // The toxic delays the SQL setup before either operation reaches its lock.
    await blockedBy(holder.pid, 2, 6000);
    await runtimeEvent(
      "consumer",
      (r) => r.event === "consumer_message_retry" && r.messageId === envelope.messageId,
    );
    response = await request;
    expect(response.status).toBe(503);
  } finally {
    holder.release();
    try {
      await holder.done;
    } finally {
      await toxiproxy.removeLatency("postgres");
    }
  }
  await retryHttp(body, key);
  await delivered(envelope.messageId);
  await processed(body.externalTransactionId);
  await processed(envelope.data.externalTransactionId);
  expect((await h.queries.wallet(w.id))?.balance.amount).toBe("80.00");
  expect(await debitCount(w.id)).toBe(2);
  await pollUntil(
    "exported lock conflict and retry increases",
    async () =>
      (await metricTotal('sum(wagering_lock_conflicts_total{reason="lock_timeout"})')) >=
        beforeLocks + 2 &&
      (await metricTotal('sum(wagering_retries_total{operation="consumer"})')) > beforeRetries,
    20_000,
  );
}, 90_000);

test("graceful stop drains exact in-flight consumer work and exits0 with one committed effect", async () => {
  const w = await wallet();
  const envelope = wagerMessage(w);
  await configureRole("consumer", {
    TEST_SYNC_POINTS: "consumer.before_commit",
    TEST_SYNC_MATCH: envelope.messageId,
  });
  try {
    await sendWager(transport, envelope);
    const reached = await runtimeEvent(
      "consumer",
      (r) => r.event === "sync_point_reached" && r.operationId === envelope.messageId,
    );
    const id = await instanceContainer("consumer", String(reached.instanceId));
    await changeContainer(id, "stop");
    expect(
      (await command(["docker", "inspect", "--format", "{{.State.ExitCode}}", id])).trim(),
    ).toBe("0");
    await delivered(envelope.messageId, (r) => r.instanceId === reached.instanceId);
    await runtimeEvent(
      "consumer",
      (r) =>
        r.event === "consumer_stopped" && r.instanceId === reached.instanceId && r.drained === true,
    );
    await oneBet(w, envelope);
  } finally {
    await restoreRole("consumer");
  }
}, 90_000);

test("idle transaction timeout frees a paused consumer wallet and its resumed stale attempt cannot add an effect", async () => {
  const w = await wallet();
  const envelope = wagerMessage(w);
  await configureRole("consumer", {
    TEST_SYNC_POINTS: "consumer.before_commit",
    TEST_SYNC_MATCH: envelope.messageId,
  });
  let paused: string | undefined;
  try {
    await sendWager(transport, envelope);
    const reached = await runtimeEvent(
      "consumer",
      (r) => r.event === "sync_point_reached" && r.operationId === envelope.messageId,
    );
    const id = await instanceContainer("consumer", String(reached.instanceId));
    const backend = await observedWalletHolder(w.id);
    if (!backend) throw new Error("Missing paused transaction backend");
    await changeContainer(id, "pause");
    paused = id;
    expect((await h.queries.wallet(w.id))?.balance.amount).toBe("100.00");
    await pollUntil(
      "PostgreSQL idle timeout removes the exact paused transaction backend",
      async () =>
        (
          await sql(
            "SELECT pid FROM pg_stat_activity WHERE pid = ? AND backend_start = ?::timestamptz",
            [backend.pid, backend.backend_start],
          )
        ).length === 0,
      20_000,
    );
    expect((await command(["docker", "inspect", "--format", "{{.State.Paused}}", id])).trim()).toBe(
      "true",
    );
    await delivered(
      envelope.messageId,
      (r) => r.instanceId !== reached.instanceId && Number(r.attempt) >= 2,
    );
    await oneBet(w, envelope);
    await changeContainer(id, "unpause");
    paused = undefined;
    // SIGTERM releases the test barrier, so the stale callback actually attempts
    // to finish against its expired SQL transaction instead of staying blocked.
    await changeContainer(id, "stop");
    expect(
      (await command(["docker", "inspect", "--format", "{{.State.ExitCode}}", id])).trim(),
    ).toBe("0");
    await runtimeEvent(
      "consumer",
      (r) => r.event === "consumer_stopped" && r.instanceId === reached.instanceId,
    );
    await oneBet(w, envelope);
  } finally {
    if (paused) await changeContainer(paused, "unpause");
    await restoreRole("consumer");
  }
}, 120_000);

test("killing the API that owns an already-sent POST causes one upstream attempt and explicit original-key retry is safe", async () => {
  const w = await wallet();
  const body = httpWager(w);
  const key = randomUUID();
  // A direct connection identifies the owner; the chaos proxy otherwise hides
  // the originating API address. Other roles retain the chaos route.
  await configureRole("api", { APP_DB_HOST: "postgres", APP_DB_PORT: "5432" });
  let holder: Awaited<ReturnType<typeof holdWallet>> | undefined;
  try {
    await ready();
    await Promise.all(
      Array.from({ length: 12 }, async () =>
        expect((await apiRequest(`/wallets/${w.id}`)).status).toBe(200),
      ),
    );
    const apiByIp = new Map<string, string>();
    for (const id of await containersOf("api")) {
      const networks = JSON.parse(
        await command(["docker", "inspect", "--format", "{{json .NetworkSettings.Networks}}", id]),
      ) as Record<string, { IPAddress: string }>;
      for (const network of Object.values(networks)) apiByIp.set(network.IPAddress, id);
    }
    holder = await holdWallet(w.id);
    const original = submitHttp(body, key);
    const [owner] = await blockedBy(holder.pid);
    const victim = owner && apiByIp.get(owner.client_ip);
    if (!victim || !owner) throw new Error("Outstanding POST has no uniquely identified API owner");
    await killContainer(victim);
    const response = await original;
    expect(response.status).toBe(502);
    const requestId = response.headers.get("X-Nginx-Request-Id");
    expect(Boolean(requestId)).toBe(true);
    const record = await pollUntil(
      "the interrupted POST's gateway forwarding evidence",
      async () => {
        const lines = (await compose(["logs", "--no-log-prefix", "--no-color", "nginx"])).split(
          "\n",
        );
        return lines
          .filter((line) => line.startsWith("{"))
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .find((r) => r.requestId === requestId);
      },
    );
    expect(record.method).toBe("POST");
    expect(record.status).toBe("502");
    expect(record.upstreamAddr).toBe(`${owner.client_ip}:3000`);
    expect(record.upstreamStatus).toBe("502");
    expect(
      await h.queries.providerTransaction("provider-a", body.externalTransactionId),
    ).toBeNull();
    expect(await debitCount(w.id)).toBe(0);
    holder.release();
    await holder.done;
    holder = undefined;
    const first = await submissionBody(await retryHttp(body, key));
    const replay = await submissionBody(await retryHttp(body, key));
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.idempotentReplay).toBe(true);
    expect((await h.queries.wallet(w.id))?.balance.amount).toBe("90.00");
    expect(await debitCount(w.id)).toBe(1);
  } finally {
    try {
      if (holder) {
        holder.release();
        await holder.done;
      }
    } finally {
      await restoreRole("api");
    }
  }
}, 120_000);

test("publisher killed after claim leaves a persisted lease that another worker recovers without losing its event", async () => {
  await outboxDrained();
  try {
    await compose(["stop", "worker"]);
    const w = await wallet();
    const [target] = await sql<{ id: string }>(
      "SELECT id FROM outbox_messages WHERE payload->'data'->>'walletId' = ? ORDER BY id LIMIT 1",
      [w.id],
    );
    if (!target) throw new Error("Missing claimed-event fixture");
    await configureRole(
      "worker",
      { TEST_SYNC_POINTS: "publisher.after_claim_before_send", TEST_SYNC_MATCH: target.id },
      false,
    );
    const reached = await runtimeEvent(
      "worker",
      (r) =>
        r.event === "sync_point_reached" &&
        r.point === "publisher.after_claim_before_send" &&
        r.operationId === target.id,
    );
    const [claimed] = await sql<{
      attempts: number;
      next_attempt_at: Date;
      published_at: Date | null;
    }>("SELECT attempts, next_attempt_at, published_at FROM outbox_messages WHERE id = ?", [
      target.id,
    ]);
    if (!claimed) throw new Error("Missing persisted event claim");
    expect(claimed.attempts).toBe(1);
    expect(claimed.published_at).toBeNull();
    const dueAt = new Date(claimed.next_attempt_at).getTime();
    expect(dueAt).toBeGreaterThan(Number(reached.time));
    await killContainer(await instanceContainer("worker", String(reached.instanceId)));
    const killedAt = Date.now();
    expect(killedAt).toBeLessThan(dueAt);
    const recovered = await runtimeEvent(
      "worker",
      (r) =>
        r.event === "outbox_publish_completed" &&
        r.eventId === target.id &&
        r.confirmed === true &&
        r.instanceId !== reached.instanceId &&
        Number(r.attempt) >= 2 &&
        Number(r.time) >= killedAt,
      60_000,
    );
    expect(Number(recovered.time)).toBeGreaterThanOrEqual(dueAt);
    await events.waitFor([target.id]);
    expect(await events.effectCount(target.id)).toBe(1);
    expect(
      (
        await sql<{ published: boolean }>(
          "SELECT published_at IS NOT NULL AS published FROM outbox_messages WHERE id = ?",
          [target.id],
        )
      )[0]?.published,
    ).toBe(true);
  } finally {
    await restoreRole("worker");
  }
}, 120_000);

test("paused Keycloak serves cached keys on all APIs, unknown-key refresh returns503 and recovers after resume", async () => {
  const w = await wallet();
  const token = await accessToken("platform-operator");
  async function cachedKeysOnEveryApi() {
    const correlations = new Set<string>();
    const successful = async () =>
      new Set(
        (await runtimeLogs("api"))
          .filter(
            (r) =>
              r.event === "http_request_completed" &&
              r.statusCode === 200 &&
              correlations.has(String(r.correlationId)),
          )
          .map((r) => r.instanceId),
      );
    for (let batch = 0; batch < 4; batch++) {
      await Promise.all(
        Array.from({ length: 12 }, async () => {
          const id = randomUUID();
          correlations.add(id);
          expect(
            (
              await apiRequest(`/wallets/${w.id}`, {
                client: null,
                headers: { Authorization: `Bearer ${token}`, "X-Correlation-Id": id },
              })
            ).status,
          ).toBe(200);
        }),
      );
      if ((await successful()).size === 3) break;
    }
    expect((await successful()).size).toBe(3);
  }
  await cachedKeysOnEveryApi();
  const pieces = token.split(".");
  const header = JSON.parse(Buffer.from(pieces[0] ?? "", "base64url").toString()) as Record<
    string,
    unknown
  >;
  header.kid = randomUUID();
  const unknown = [
    Buffer.from(JSON.stringify(header)).toString("base64url"),
    pieces[1],
    pieces[2],
  ].join(".");
  const identity = (value: string) =>
    apiRequest(`/wallets/${w.id}`, { client: null, headers: { Authorization: `Bearer ${value}` } });
  const keycloak = (await containersOf("keycloak"))[0];
  if (!keycloak) throw new Error("Missing test Keycloak");
  await changeContainer(keycloak, "pause");
  try {
    await cachedKeysOnEveryApi();
    const unavailable = await pollUntil(
      "unknown kid refresh after the real JWKS cooldown",
      async () => {
        expect((await identity(token)).status).toBe(200);
        const response = await identity(unknown);
        if (response.status === 401) return false;
        expect(response.status).toBe(503);
        return response;
      },
      45_000,
      250,
    );
    expect(unavailable.headers.get("Retry-After")).toBe("1");
    expect((await identity(token)).status).toBe(200);
  } finally {
    await changeContainer(keycloak, "unpause");
  }
  await pollUntil(
    "JWKS lookup recovers with normal unknown-key rejection",
    async () => (await identity(unknown)).status === 401,
    30_000,
  );
  expect((await identity(token)).status).toBe(200);
  // This client has not requested a token in this suite; it exercises issuance after recovery.
  expect((await apiRequest(`/wallets/${w.id}`, { client: "provider-b" })).status).toBe(403);
}, 120_000);

test("PostgreSQL restart during mixed traffic recovers existing processes and preserves every original-key effect", async () => {
  const fixtures = await Promise.all(
    Array.from({ length: 24 }, async () => {
      const w = await wallet();
      return { w, body: httpWager(w), key: randomUUID(), envelope: wagerMessage(w) };
    }),
  );
  const target = fixtures[0];
  if (!target) throw new Error("Missing restart fixture");
  const instances = await allInstances();
  const postgres = (await containersOf("postgres"))[0];
  if (!postgres) throw new Error("Missing test PostgreSQL");
  const startedAt = await command([
    "docker",
    "inspect",
    "--format",
    "{{.State.StartedAt}}",
    postgres,
  ]);
  const holder = await holdWallet(target.w.id);
  const traffic = Promise.all(
    fixtures.map(async ({ body, key, envelope }) => {
      await sendWager(transport, envelope);
      await retryHttp(body, key);
    }),
  );
  try {
    await blockedBy(holder.pid);
    await compose(["restart", "postgres"]);
  } finally {
    holder.release();
    await holder.done.catch(() => undefined);
  }
  await traffic;
  await waitForReplicas();
  await ready();
  expect(
    await command(["docker", "inspect", "--format", "{{.State.StartedAt}}", postgres]),
  ).not.toBe(startedAt);
  expect(await allInstances()).toEqual(instances);
  for (const { w, body, key, envelope } of fixtures) {
    await delivered(envelope.messageId);
    await processed(body.externalTransactionId);
    await processed(envelope.data.externalTransactionId);
    expect((await submissionBody(await retryHttp(body, key))).idempotentReplay).toBe(true);
    expect((await h.queries.wallet(w.id))?.balance.amount).toBe("80.00");
    expect(await debitCount(w.id)).toBe(2);
    expect(
      await sql(
        "SELECT message_id FROM inbox_messages WHERE message_id = ? AND processed_at IS NOT NULL",
        [envelope.messageId],
      ),
    ).toHaveLength(1);
  }
  await outboxDrained();
}, 180_000);
