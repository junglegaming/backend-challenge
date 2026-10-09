/**
 * Load test (bun run test:load) against the docker compose stack (3 replicas behind nginx).
 *
 *   bun run test:load [--duration 30] [--concurrency 64] [--wallets 200] [--scenario all|distributed|hot|sqs]
 *                     [--api http://localhost:8080] [--sqs http://localhost:4566]
 *                     [--db postgres://wagering_migrator:migrator_dev_password@localhost:5433/wagering]
 *
 * Scenarios
 *   distributed — many wallets, random BET/WIN/LOSS mix over HTTP (closed-loop, `concurrency` virtual users)
 *   hot         — every virtual user hammers ONE wallet (worst case for the per-wallet lock)
 *   sqs         — N messages enqueued at once over many wallets; measures end-to-end drain throughput
 *
 * Collected: throughput, latency p50/p95/p99/max, HTTP status distribution, error rate, lock conflicts and
 * transient retries (from the database's own view: lock waits are visible as pg_stat_database deadlocks plus
 * application metrics when Prometheus is up), outbox lag sampled every second, and a full reconciliation of
 * every wallet touched at the end (the real success criterion).
 */
import { cpus, platform, release, totalmem } from "node:os";
import { DeleteMessageBatchCommand, PurgeQueueCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { Client } from "pg";
import { SqsGateway } from "../src/infrastructure/messaging/sqs-gateway";

const args = new Map<string, string>();
const argv = process.argv.slice(2).filter((a) => a !== "--");
for (let i = 0; i < argv.length; i++) {
  const k = argv[i];
  const v = argv[i + 1];
  if (k?.startsWith("--") && v !== undefined && !v.startsWith("--")) {
    args.set(k.slice(2), v);
    i++;
  }
}
const opt = (k: string, d: string) => args.get(k) ?? d;
const API = opt("api", "http://localhost:8080");
const SQS = opt("sqs", "http://localhost:4566");
const DB = opt("db", "postgres://wagering_migrator:migrator_dev_password@localhost:5433/wagering");
const PROM = opt("prometheus", "http://localhost:9090");
const DURATION_S = Number(opt("duration", "30"));
const CONCURRENCY = Number(opt("concurrency", "64"));
const WALLETS = Number(opt("wallets", "200"));
const SQS_MESSAGES = Number(opt("sqs-messages", "3000"));
const SQS_WALLETS = Number(opt("sqs-wallets", "100"));
const SCENARIO = opt("scenario", "all");

interface Wallet {
  id: string;
  playerId: string;
}

interface ScenarioResult {
  name: string;
  durationS: number;
  requests: number;
  throughputRps: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number; mean: number };
  statuses: Record<string, number>;
  outcomes: Record<string, number>;
  errorRate: number;
  outboxLagMaxS: number;
  outboxLagP95S: number;
  lockConflicts: number | null;
  transientRetries: number | null;
}

const percentile = (sorted: number[], p: number) =>
  sorted.length === 0
    ? 0
    : (sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0);
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: json, headers: res.headers };
}

async function createWallets(n: number, amount: string): Promise<Wallet[]> {
  const out: Wallet[] = [];
  const batch = 20;
  for (let i = 0; i < n; i += batch) {
    const created = await Promise.all(
      Array.from({ length: Math.min(batch, n - i) }, async () => {
        const playerId = Bun.randomUUIDv7();
        const res = await post("/wallets", { playerId, initialBalance: { amount, currency: "BRL" } });
        if (res.status !== 201)
          throw new Error(`wallet creation failed: ${res.status} ${JSON.stringify(res.body)}`);
        return { id: res.body.id as string, playerId };
      }),
    );
    out.push(...created);
  }
  return out;
}

/** Samples the age of the oldest unpublished outbox event once per second. */
function sampleOutboxLag(db: Client) {
  const samples: number[] = [];
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      const { rows } = await db.query<{ lag: string | null }>(
        "SELECT EXTRACT(EPOCH FROM (now() - MIN(occurred_at)))::text AS lag FROM outbox_messages WHERE published_at IS NULL",
      );
      samples.push(rows[0]?.lag ? Number(rows[0].lag) : 0);
      await Bun.sleep(1000);
    }
  })();
  return async () => {
    stop = true;
    await loop;
    const sorted = [...samples].sort((a, b) => a - b);
    return { max: round(sorted.at(-1) ?? 0, 2), p95: round(percentile(sorted, 95), 2) };
  };
}

async function promCounter(metric: string): Promise<number | null> {
  try {
    const res = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(`sum(${metric})`)}`, {
      signal: AbortSignal.timeout(1000),
    });
    const json = (await res.json()) as { data?: { result?: { value: [number, string] }[] } };
    const v = json.data?.result?.[0]?.value[1];
    return v === undefined ? 0 : Number(v);
  } catch {
    return null; // Prometheus not running (observability profile off)
  }
}

async function runHttpScenario(
  name: string,
  db: Client,
  pick: () => { wallet: Wallet; kind: string; amount: string },
): Promise<ScenarioResult> {
  const lockBefore = await promCounter("db_lock_conflicts_total");
  const retriesBefore = await promCounter("db_transient_retries_total");
  const stopLag = sampleOutboxLag(db);
  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  const outcomes: Record<string, number> = {};
  const deadline = performance.now() + DURATION_S * 1000;
  const started = performance.now();

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (performance.now() < deadline) {
        const { wallet, kind, amount } = pick();
        const externalTransactionId = `load-${Bun.randomUUIDv7()}`;
        const t0 = performance.now();
        let status = "network_error";
        try {
          const res = await post(
            "/wagering/transactions",
            {
              providerId: "load-provider",
              externalTransactionId,
              playerId: wallet.playerId,
              walletId: wallet.id,
              roundId: "load-round",
              gameId: "load-game",
              kind,
              money: { amount, currency: "BRL" },
            },
            { "Idempotency-Key": `load-provider:${externalTransactionId}` },
          );
          status = String(res.status);
          const outcome =
            (res.body.status as string | undefined) ?? (res.body.code as string | undefined) ?? "unknown";
          const key = res.body.failureCode ? `${outcome}:${res.body.failureCode}` : outcome;
          outcomes[key] = (outcomes[key] ?? 0) + 1;
        } catch {
          // counted as network_error
        }
        latencies.push(performance.now() - t0);
        statuses[status] = (statuses[status] ?? 0) + 1;
      }
    }),
  );

  const elapsed = (performance.now() - started) / 1000;
  const lag = await stopLag();
  await Bun.sleep(6000); // let Prometheus scrape the final counters
  const lockAfter = await promCounter("db_lock_conflicts_total");
  const retriesAfter = await promCounter("db_transient_retries_total");
  const sorted = latencies.sort((a, b) => a - b);
  const errors = Object.entries(statuses)
    .filter(([s]) => s === "network_error" || s.startsWith("5"))
    .reduce((n, [, c]) => n + c, 0);
  return {
    name,
    durationS: round(elapsed, 1),
    requests: sorted.length,
    throughputRps: round(sorted.length / elapsed, 1),
    latencyMs: {
      p50: round(percentile(sorted, 50)),
      p95: round(percentile(sorted, 95)),
      p99: round(percentile(sorted, 99)),
      max: round(sorted.at(-1) ?? 0),
      mean: round(sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)),
    },
    statuses,
    outcomes,
    errorRate: round((errors / Math.max(1, sorted.length)) * 100, 3),
    outboxLagMaxS: lag.max,
    outboxLagP95S: lag.p95,
    lockConflicts: lockBefore === null || lockAfter === null ? null : lockAfter - lockBefore,
    transientRetries: retriesBefore === null || retriesAfter === null ? null : retriesAfter - retriesBefore,
  };
}

async function runSqsScenario(db: Client, wallets: Wallet[]) {
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
  const ids: string[] = [];
  const t0 = performance.now();
  for (let i = 0; i < SQS_MESSAGES; i += 50) {
    await Promise.all(
      Array.from({ length: Math.min(50, SQS_MESSAGES - i) }, async (_, j) => {
        const w = wallets[(i + j) % wallets.length] as Wallet;
        const ext = `sqs-load-${Bun.randomUUIDv7()}`;
        const messageId = `m-${ext}`;
        ids.push(messageId);
        const body = {
          messageId,
          type: "WagerTransactionRequested",
          occurredAt: new Date().toISOString(),
          data: {
            providerId: "load-provider",
            externalTransactionId: ext,
            idempotencyKey: `load-provider:${ext}`,
            playerId: w.playerId,
            walletId: w.id,
            roundId: "load-round",
            gameId: "load-game",
            kind: "BET",
            money: { amount: "0.10", currency: "BRL" },
          },
        };
        await sqs.sendWager(JSON.stringify(body), w.id, Bun.randomUUIDv7());
      }),
    );
  }
  const enqueuedS = (performance.now() - t0) / 1000;
  const stopLag = sampleOutboxLag(db);
  let processed = 0;
  while (processed < ids.length) {
    const { rows } = await db.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM inbox_messages WHERE message_id = ANY($1) AND processed_at IS NOT NULL",
      [ids],
    );
    processed = Number(rows[0]?.n);
    if (performance.now() - t0 > 600_000) break;
    await Bun.sleep(250);
  }
  const totalS = (performance.now() - t0) / 1000;
  const lag = await stopLag();
  sqs.destroy();
  return {
    name: "sqs",
    messages: ids.length,
    processed,
    enqueueS: round(enqueuedS, 1),
    endToEndS: round(totalS, 1),
    throughputMsgPerS: round(processed / totalS, 1),
    outboxLagMaxS: lag.max,
    outboxLagP95S: lag.p95,
  };
}

/** The edge rate-limits reconciliation (expensive endpoint): 429 is waited out, never counted as a divergence. */
async function reconcileOne(w: Wallet) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const r = await post(`/wallets/${w.id}/reconciliation`, {});
    if (r.status !== 429) return r;
    await Bun.sleep(1000 * Number(r.headers.get("retry-after") ?? 1));
  }
  return post(`/wallets/${w.id}/reconciliation`, {});
}

async function reconcile(wallets: Wallet[]) {
  let consistent = 0;
  const inconsistent: string[] = [];
  const unchecked: string[] = [];
  for (let i = 0; i < wallets.length; i += 25) {
    const reports = await Promise.all(
      wallets.slice(i, i + 25).map((w) => reconcileOne(w).then((r) => ({ w, r }))),
    );
    for (const { w, r } of reports) {
      if (r.status !== 200) unchecked.push(w.id);
      else if (r.body.consistent === true) consistent++;
      else inconsistent.push(w.id);
    }
  }
  return { checked: wallets.length, consistent, inconsistent, unchecked };
}

// ------------------------------------------------------------------ main
const db = new Client({ connectionString: DB });
await db.connect();

// Downstream consumer stand-in: the stack has no subscriber for wallet-events.fifo, and an in-memory emulator
// degrades as an unconsumed FIFO queue grows (88k messages observed). Purge it, then keep it drained.
const sink = startEventSink();
const environment = {
  date: new Date().toISOString(),
  host: {
    platform: `${platform()} ${release()}`,
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model,
    memGiB: round(totalmem() / 2 ** 30, 1),
  },
  bun: Bun.version,
  target: API,
  settings: {
    durationS: DURATION_S,
    concurrency: CONCURRENCY,
    wallets: WALLETS,
    sqsMessages: SQS_MESSAGES,
    sqsWallets: SQS_WALLETS,
  },
};
console.log("environment", JSON.stringify(environment));

const results: unknown[] = [];
const touched: Wallet[] = [];

if (SCENARIO === "all" || SCENARIO === "distributed") {
  const wallets = await createWallets(WALLETS, "100000.00");
  touched.push(...wallets);
  const kinds = ["BET", "BET", "BET", "WIN", "LOSS"];
  const r = await runHttpScenario("distributed", db, () => {
    const kind = kinds[Math.floor(Math.random() * kinds.length)] as string;
    return {
      wallet: wallets[Math.floor(Math.random() * wallets.length)] as Wallet,
      kind,
      amount:
        kind === "LOSS"
          ? "0.00"
          : `${1 + Math.floor(Math.random() * 50)}.${String(Math.floor(Math.random() * 100)).padStart(2, "0")}`,
    };
  });
  results.push(r);
  console.log("result", JSON.stringify(r));
}

if (SCENARIO === "all" || SCENARIO === "hot") {
  const [hot] = await createWallets(1, "999999999.00");
  if (!hot) throw new Error("hot wallet not created");
  touched.push(hot);
  const r = await runHttpScenario("hot-wallet", db, () => ({ wallet: hot, kind: "BET", amount: "1.00" }));
  results.push(r);
  console.log("result", JSON.stringify(r));
}

if (SCENARIO === "all" || SCENARIO === "sqs") {
  const wallets = await createWallets(SQS_WALLETS, "100000.00");
  touched.push(...wallets);
  const r = await runSqsScenario(db, wallets);
  results.push(r);
  console.log("result", JSON.stringify(r));
}

// Drain the outbox, then reconcile every wallet the test touched.
for (let i = 0; i < 120; i++) {
  const { rows } = await db.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM outbox_messages WHERE published_at IS NULL",
  );
  if (rows[0]?.n === "0") break;
  await Bun.sleep(500);
}
const reconciliation = await reconcile(touched);
const sinkStats = await sink.stop();
console.log("event-sink", JSON.stringify(sinkStats));
console.log("reconciliation", JSON.stringify(reconciliation));

const report = { environment, results, eventSink: sinkStats, reconciliation };
const file = `load/results/${environment.date.replace(/[:.]/g, "-")}.json`;
await Bun.write(file, JSON.stringify(report, null, 2));
console.log(`\nreport written to ${file}`);
await db.end();
if (reconciliation.inconsistent.length > 0 || reconciliation.unchecked.length > 0) process.exit(1);

function startEventSink() {
  const events = new SqsGateway({
    region: "us-east-1",
    endpoint: SQS,
    verifyMd5: false,
    wagerQueueName: "wager-transactions.fifo",
    wagerDlqName: "wager-transactions-dlq.fifo",
    eventsQueueName: "wallet-events.fifo",
    maxReceiveCount: 5,
    visibilityTimeoutSeconds: 30,
  });
  let stop = false;
  let received = 0;
  const seen = new Set<string>();
  const loop = (async () => {
    const url = await events.queueUrl("wallet-events.fifo");
    await events.client.send(new PurgeQueueCommand({ QueueUrl: url })).catch(() => {});
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (!stop) {
          const res = await events.client
            .send(
              new ReceiveMessageCommand({
                QueueUrl: url,
                MaxNumberOfMessages: 10,
                WaitTimeSeconds: 1,
                MessageAttributeNames: ["eventId"],
              }),
            )
            .catch(() => ({ Messages: [] }));
          const batch = res.Messages ?? [];
          if (batch.length === 0) continue;
          received += batch.length;
          for (const m of batch) {
            const id = m.MessageAttributes?.eventId?.StringValue;
            if (id) seen.add(id);
          }
          await events.client
            .send(
              new DeleteMessageBatchCommand({
                QueueUrl: url,
                Entries: batch.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle ?? "" })),
              }),
            )
            .catch(() => {});
        }
      }),
    );
  })();
  return {
    async stop() {
      stop = true;
      await loop;
      events.destroy();
      // Duplicates are expected under at-least-once delivery; consumers de-dup by eventId.
      return { received, uniqueEvents: seen.size, duplicates: received - seen.size };
    },
  };
}
