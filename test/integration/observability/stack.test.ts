import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SqsTransport } from "../../../src/messaging/infrastructure/sqs-transport";
import { QUEUES } from "../../../src/observability/health/dependencies";
import { managerFor } from "../../../src/shared/infrastructure/unit-of-work";
import { assertLedgerInvariant } from "../../support/database";
import { apiRequest, httpWager, openHttpWallet } from "../../support/http";
import { receiveDeadLetter, sendWager, wagerMessage } from "../../support/sqs";
import { apiUrl, compose, pollUntil } from "../../support/stack";
import { accessToken } from "../../support/tokens";
import { wageringHarness } from "../../support/wagering";

const h = wageringHarness();
const transport = new SqsTransport({ values: h.values });
afterEach(() => assertLedgerInvariant(h.database));
afterAll(async () => {
  transport.close();
  await h.database.onModuleDestroy();
});

interface Sample {
  metric: Record<string, string>;
  value: [number, string];
}
async function query(expression: string) {
  const response = await fetch(
    `http://127.0.0.1:19090/api/v1/query?query=${encodeURIComponent(expression)}`,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { status: string; data: { result: Sample[] } };
  expect(body.status).toBe("success");
  return body.data.result;
}
async function records() {
  const output = await compose([
    "logs",
    "--no-log-prefix",
    "--no-color",
    "api",
    "consumer",
    "worker",
  ]);
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("Prometheus discovers all eight healthy replicas and Grafana exposes its provisioned dashboard anonymously", async () => {
  // The foundation recovery scenario deliberately killed one API earlier in this suite.
  await compose(["up", "-d", "--no-deps", "--wait", "--scale", "api=3", "api"]);
  const samples = await pollUntil(
    "eight Prometheus targets",
    async () => {
      const samples = await query('up{job="wagering"}');
      return samples.length === 8 && samples.every((s) => s.value[1] === "1") ? samples : false;
    },
    40_000,
  );
  expect(new Set(samples.map((s) => s.metric.instance)).size).toBe(8);
  for (const [role, expected] of [
    ["api", 3],
    ["consumer", 3],
    ["worker", 2],
  ] as const)
    expect(samples.filter((s) => s.metric.role === role)).toHaveLength(expected);
  const dashboards = await fetch("http://127.0.0.1:13001/api/search?type=dash-db");
  expect(dashboards.status).toBe(200);
  expect(await dashboards.json()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ uid: "wagering", title: "Wagering Processor" }),
    ]),
  );
  const datasource = await fetch("http://127.0.0.1:13001/api/datasources/uid/prometheus");
  expect(datasource.status).toBe(200);
  expect(await datasource.json()).toMatchObject({
    type: "prometheus",
    url: "http://prometheus:9090",
    readOnly: true,
  });
});

test("HTTP, SQS and worker logs carry isolated identifiers and never serialize financial data or authorization", async () => {
  const wallet = await openHttpWallet("123456789.23");
  const token = await accessToken("provider-a");
  const requests = Array.from({ length: 12 }, () => ({
    correlationId: randomUUID(),
    body: httpWager(wallet, { money: { amount: "123.47", currency: "BRL" } }),
  }));
  await Promise.all(
    requests.map(async ({ correlationId, body }) => {
      const response = await apiRequest("/wagering/transactions", {
        method: "POST",
        client: "provider-a",
        body,
        headers: { "Idempotency-Key": randomUUID(), "X-Correlation-Id": correlationId },
      });
      expect(response.status).toBe(200);
    }),
  );
  const badCorrelation = randomUUID();
  expect(
    (
      await fetch(`${apiUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Correlation-Id": badCorrelation,
          Authorization: "Bearer do-not-log-this-token",
        },
        body: '{"amount":"999888.77",',
      })
    ).status,
  ).toBe(400);
  const deniedCorrelation = randomUUID();
  expect(
    (
      await apiRequest(`/wallets/${wallet.id}`, {
        client: null,
        headers: {
          "X-Correlation-Id": deniedCorrelation,
          Authorization: "Bearer do-not-log-this-token",
        },
      })
    ).status,
  ).toBe(401);
  const message = wagerMessage(wallet, { money: { amount: "456.79", currency: "BRL" } });
  await sendWager(transport, message);
  await pollUntil("correlated logs through outbox publication", async () => {
    const logs = await records();
    return logs.some(
      (r) =>
        r.event === "outbox_publish_completed" &&
        r.correlationId === message.messageId &&
        r.transactionId,
    );
  });
  const logs = await records();
  for (const { correlationId } of requests) {
    const submissions = logs.filter(
      (r) => r.event === "wager_submission_completed" && r.correlationId === correlationId,
    );
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      walletId: wallet.id,
      providerId: "provider-a",
      channel: "http",
      role: "api",
    });
    expect(typeof submissions[0]?.transactionId).toBe("string");
  }
  expect(
    logs.some(
      (r) =>
        r.event === "http_request_completed" &&
        r.correlationId === badCorrelation &&
        r.statusCode === 400,
    ),
  ).toBe(true);
  expect(
    logs.some(
      (r) =>
        r.event === "http_request_completed" &&
        r.correlationId === deniedCorrelation &&
        r.statusCode === 401,
    ),
  ).toBe(true);
  const completed = logs.find(
    (r) => r.event === "consumer_message_completed" && r.messageId === message.messageId,
  );
  expect(completed).toMatchObject({
    correlationId: message.messageId,
    walletId: wallet.id,
    providerId: "provider-a",
    role: "consumer",
  });
  expect(typeof completed?.transactionId).toBe("string");
  const serialized = JSON.stringify(logs);
  for (const forbidden of [
    "123456789.23",
    "123.47",
    "456.79",
    "999888.77",
    token,
    "do-not-log-this-token",
    '"amount"',
    '"balance"',
    '"balanceBefore"',
    '"balanceAfter"',
    '"Authorization"',
    '"authorization"',
    '"payload"',
    '"body"',
    '"headers"',
    "Bearer ",
  ])
    if (serialized.includes(forbidden)) throw new Error("Sensitive data in application logs");
  for (const row of logs) {
    expect(typeof row.instanceId).toBe("string");
    expect(["api", "consumer", "worker"]).toContain(String(row.role));
  }
});

test("explicit DLQ and transient consumer retries change exported counters on real consumer replicas", async () => {
  const wallet = await openHttpWallet();
  const bad = wagerMessage(wallet);
  await sendWager(transport, bad, JSON.stringify({ ...bad, type: "InvalidMessage" }));
  const dead = await receiveDeadLetter(transport, bad.messageId);
  await transport.acknowledge(QUEUES.deadLetters, dead);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const hold = h.uow.run(async (tx) => {
    await managerFor(tx).execute("SELECT id FROM wallets WHERE id = ? FOR UPDATE", [wallet.id]);
    entered.resolve();
    await release.promise;
  });
  const retry = wagerMessage(wallet);
  try {
    await entered.promise;
    await sendWager(transport, retry);
    await pollUntil("consumer retry metric cause", async () =>
      (await records()).some(
        (r) => r.event === "consumer_message_retry" && r.messageId === retry.messageId,
      ),
    );
  } finally {
    release.resolve();
    await hold;
  }
  await pollUntil("consumer retry recovery", async () =>
    (await records()).some(
      (r) => r.event === "consumer_message_completed" && r.messageId === retry.messageId,
    ),
  );
  await pollUntil("exported DLQ/retry counters", async () => {
    const dlq = await query('sum(wagering_dlq_messages_total{reason="INVALID_MESSAGE"})');
    const retries = await query('sum(wagering_retries_total{operation="consumer"})');
    return Number(dlq[0]?.value[1]) > 0 && Number(retries[0]?.value[1]) > 0;
  });
});
