/**
 * End-to-end demo against a running stack (docker compose up):
 *   bun run scripts/demo.ts [--api http://localhost:8080] [--sqs http://localhost:4566]
 *
 * Creates a wallet, sends wagers over HTTP and SQS (including a ROLLBACK that arrives before its BET and a
 * duplicate delivery), then prints the wallet, its ledger, the reconciliation report and a sample of events.
 */
import { ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { SqsGateway } from "../src/infrastructure/messaging/sqs-gateway";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
// Defaults target the full docker compose stack (not the .env used for host development).
const API = arg("api", "http://localhost:8080");
const SQS = arg("sqs", "http://localhost:4566");

const sqs = new SqsGateway({
  region: "us-east-1",
  endpoint: SQS,
  verifyMd5: false,
  wagerQueueName: "wager-transactions.fifo",
  wagerDlqName: "wager-transactions-dlq.fifo",
  eventsQueueName: "wallet-events.fifo",
  maxReceiveCount: 5,
  visibilityTimeoutSeconds: 30,
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json as Record<string, unknown> };
}

const show = (label: string, value: unknown) =>
  console.log(`\n▶ ${label}\n${JSON.stringify(value, null, 2)}`);

const playerId = Bun.randomUUIDv7();
const wallet = await call("POST", "/wallets", {
  playerId,
  initialBalance: { amount: "1000.00", currency: "BRL" },
});
show(`POST /wallets → ${wallet.status}`, wallet.body);
const walletId = wallet.body.id as string;

const run = Date.now().toString(36); // unique external ids per demo run
const base = {
  providerId: "provider-a",
  playerId,
  walletId,
  roundId: `round-${Date.now()}`,
  gameId: "fortune-chimp",
};
const submit = async (
  externalTransactionId: string,
  kind: string,
  amount: string,
  extra: Record<string, unknown> = {},
) => {
  const res = await call(
    "POST",
    "/wagering/transactions",
    { ...base, externalTransactionId, kind, money: { amount, currency: "BRL" }, ...extra },
    { "Idempotency-Key": `provider-a:${externalTransactionId}` },
  );
  show(`POST /wagering/transactions ${kind} ${externalTransactionId} → ${res.status}`, res.body);
  return res;
};

await submit(`bet-1-${run}`, "BET", "25.00");
await submit(`bet-1-${run}`, "BET", "25.00"); // replay
await submit(`bet-1-${run}`, "BET", "99.00"); // conflict
await submit(`win-1-${run}`, "WIN", "40.00", { referenceExternalTransactionId: `bet-1-${run}` });
await submit(`bet-2-${run}`, "BET", "5000.00"); // insufficient funds

// Via SQS: a ROLLBACK that arrives before its BET, and the BET delivered twice.
const message = (
  externalTransactionId: string,
  kind: string,
  amount: string,
  extra: Record<string, unknown> = {},
) => ({
  messageId: `msg-${externalTransactionId}-${Date.now()}`,
  type: "WagerTransactionRequested",
  occurredAt: new Date().toISOString(),
  data: {
    ...base,
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    kind,
    money: { amount, currency: "BRL" },
    ...extra,
  },
});
const rollback = message(`rb-3-${run}`, "ROLLBACK", "10.00", {
  referenceExternalTransactionId: `bet-3-${run}`,
});
const bet3 = message(`bet-3-${run}`, "BET", "10.00");
await sqs.sendWager(JSON.stringify(rollback), walletId, Bun.randomUUIDv7());
await sqs.sendWager(JSON.stringify(bet3), walletId, Bun.randomUUIDv7());
await sqs.sendWager(JSON.stringify(bet3), walletId, Bun.randomUUIDv7()); // duplicate delivery
console.log("\n▶ sent via SQS: ROLLBACK rb-3 (before its BET), BET bet-3 twice");

for (let i = 0; i < 40; i++) {
  const rb = await call("GET", `/providers/provider-a/wagering/transactions/rb-3-${run}`);
  if (rb.body.status === "PROCESSED") break;
  await Bun.sleep(500);
}
show("GET rb-3", (await call("GET", `/providers/provider-a/wagering/transactions/rb-3-${run}`)).body);
show("GET /wallets/:id", (await call("GET", `/wallets/${walletId}`)).body);
show("GET /wallets/:id/ledger?limit=10", (await call("GET", `/wallets/${walletId}/ledger?limit=10`)).body);
show("POST /wallets/:id/reconciliation", (await call("POST", `/wallets/${walletId}/reconciliation`)).body);

await Bun.sleep(1000);
const events = await sqs.client.send(
  new ReceiveMessageCommand({
    QueueUrl: await sqs.queueUrl("wallet-events.fifo"),
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 1,
    VisibilityTimeout: 0,
  }),
);
show(
  "wallet-events.fifo (sample, not consumed)",
  (events.Messages ?? []).map((m) => {
    const e = JSON.parse(m.Body ?? "{}");
    return { eventType: e.eventType, eventId: e.eventId, aggregateId: e.aggregateId };
  }),
);
sqs.destroy();
