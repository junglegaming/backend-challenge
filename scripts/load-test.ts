import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { LoadFixtures, loadCommand, parallelEach, Workload } from "../load/model";
import { healthyScrapeTimestamps, instant, phaseMetrics } from "../load/prometheus";
import {
  assertResponseOutcome,
  parseResponseEvidence,
  responseKey,
} from "../load/response-evidence";
import { produceBacklog } from "../load/sqs-producer";
import { parseConfiguration } from "../src/config/config";
import { SqsTransport } from "../src/messaging/infrastructure/sqs-transport";
import { Dependencies, QUEUES } from "../src/observability/health/dependencies";
import { Database } from "../src/shared/infrastructure/database";
import { apiUrl, command, compose, pollUntil, testEnvironment } from "../test/support/stack";
import { accessToken } from "../test/support/tokens";

const profile = process.env.LOAD_PROFILE ?? "quick";
if (profile !== "quick" && profile !== "full")
  throw new Error("LOAD_PROFILE must be quick or full");
const runId = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const runDir = resolve("load/results", runId);
await mkdir(runDir, { recursive: true });
const environment = {
  ...testEnvironment,
  NODE_ENV: "production",
  COMPOSE_PROFILES: "observability,load",
  APP_IMAGE_TAG: "load",
  APP_DB_HOST: "postgres",
  APP_DB_PORT: "5432",
  APP_SQS_ENDPOINT: "http://ministack:4566",
  TEST_SYNC_POINTS: "",
  TEST_SYNC_MATCH: "",
  SQS_WAIT_SECONDS: "20",
  SQS_VISIBILITY_SECONDS: "30",
  SQS_MAX_RECEIVES: "5",
  SQS_RETRY_BASE_SECONDS: "2",
  SQS_RETRY_MAX_SECONDS: "30",
  CONSUMER_CONCURRENCY: "10",
  SQS_BATCH_SIZE: "10",
  SHUTDOWN_DRAIN_MS: "25000",
  OUTBOX_LEASE_MS: "15000",
  OUTBOX_RETRY_MAX_MS: "300000",
  REFERENCE_TTL_MS: "86400000",
  LOAD_RESULTS_DIR: runDir,
  LOAD_UID: String(process.getuid?.() ?? 12345),
  LOAD_GID: String(process.getgid?.() ?? 12345),
};
const dc = (args: string[], extra = {}) =>
  compose(args, "wagering-test", { ...environment, ...extra });
if ((await dc(["ps", "-aq"])).trim())
  throw new Error("wagering-test already exists; refusing to replace its services");

const values = parseConfiguration({
  ...environment,
  DB_HOST: "127.0.0.1",
  DB_PORT: "15432",
  DB_NAME: "wagering",
  DB_USER: "wagering",
  DB_PASSWORD: process.env.POSTGRES_PASSWORD ?? "local-wagering-only",
  SQS_ENDPOINT: "http://127.0.0.1:14566",
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "local",
  AWS_SECRET_ACCESS_KEY: "local",
  AUTH_ISSUER: "http://keycloak:8080/realms/wagering",
  AUTH_JWKS_URL: "http://127.0.0.1:18080/realms/wagering/protocol/openid-connect/certs",
});
let database: Database | undefined;
let transport: SqsTransport | undefined;
let dependencies: Dependencies | undefined;
const write = (name: string, data: unknown) =>
  Bun.write(`${runDir}/${name}.json`, JSON.stringify(data, null, 2));
const startedAt = Date.now();
console.log(`Load ${profile}: ${runId}`);

async function request(path: string, body: unknown, operator = false, key?: string) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Bearer ${await accessToken(operator ? "platform-operator" : "provider-a")}`,
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  });
  if (response.status !== (operator ? 201 : 200))
    throw new Error(`Load ${operator ? "seed" : "recovery"} returned ${response.status}`);
  return response.json() as Promise<{
    id: string;
    playerId: string;
    transactionId: string;
    status: string;
    idempotentReplay: boolean;
  }>;
}

interface K6Summary {
  runId: string;
  phase: string;
  profile: string;
  metrics: Record<
    string,
    { values: Record<string, number>; thresholds?: Record<string, { ok: boolean }> }
  >;
}
function count(summary: K6Summary, metric: string) {
  return summary.metrics[metric]?.values.count ?? 0;
}
function validateSummary(summary: K6Summary, phase: string) {
  if (summary.runId !== runId || summary.phase !== phase || summary.profile !== profile)
    throw new Error("k6 summary identity mismatch");
  for (const name of ["checks", "unexpected_status"]) {
    const metric = summary.metrics[name];
    if (!metric?.thresholds || Object.values(metric.thresholds).some((threshold) => !threshold.ok))
      throw new Error(`k6 ${name} threshold evidence missing or failed`);
  }
  if (
    summary.metrics.unexpected_status?.values.rate !== 0 ||
    summary.metrics.checks?.values.rate !== 1
  )
    throw new Error("k6 contract checks failed");
  const total = ["hot", "distributed", "replay"].reduce(
    (n, kind) => n + count(summary, `requests_${kind}`),
    0,
  );
  if (total <= 0 || count(summary, "iterations") !== total)
    throw new Error("k6 did not complete all started requests");
  for (const kind of ["hot", "distributed", "replay"]) {
    if (
      count(summary, `requests_${kind}`) !==
      count(summary, `committed_${kind}`) + count(summary, `backpressure_${kind}`)
    )
      throw new Error("k6 outcome counters diverged");
  }
  if (phase === "replays" && count(summary, "requests_replay") !== Math.floor(total / 10))
    throw new Error("k6 did not exercise deterministic 10% replays");
}

async function verifyFinancialState(partial = false) {
  const verification = Bun.spawn(
    ["bun", "--no-env-file", "test", "load/verification.test.ts", "--timeout", "120000"],
    {
      env: {
        ...environment,
        WAGERING_STACK_MANAGED: "1",
        LOAD_RUN_DIR: runDir,
        LOAD_VERIFY_PARTIAL: partial ? "1" : "0",
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if (await verification.exited) throw new Error("Load financial verification failed");
}

try {
  await dc([
    "up",
    "-d",
    "--build",
    "--wait",
    "--wait-timeout",
    "180",
    "--scale",
    "api=3",
    "--scale",
    "consumer=3",
    "--scale",
    "worker=2",
    "nginx",
    "consumer",
    "worker",
    "prometheus",
    "grafana",
  ]);
  database = new Database({ values });
  transport = new SqsTransport({ values });
  dependencies = new Dependencies({ values }, database);
  const connection = (await database.orm).em.getConnection();
  const scalar = async (sql: string, params: unknown[] = []) => {
    const [row] = await connection.execute<{ count: number }[]>(sql, params);
    if (!row) throw new Error("Missing SQL count");
    return row.count;
  };
  const drain = async () => {
    const start = Date.now();
    await pollUntil(
      "load outbox drain",
      async () =>
        (await scalar(
          "SELECT count(*)::int AS count FROM outbox_messages WHERE published_at IS NULL",
        )) === 0,
      // Full ramps can commit faster than the two publishers drain their events.
      // Keep the zero-pending assertion, with a separate bound for that larger backlog.
      profile === "full" ? 1_800_000 : 180_000,
      250,
    );
    return Date.now() - start;
  };
  const queueDepth = async (queue: string) => {
    if (!dependencies) throw new Error("Missing load dependency observer");
    const attributes = await dependencies.queueAttributes(queue);
    return (
      [
        "ApproximateNumberOfMessages",
        "ApproximateNumberOfMessagesNotVisible",
        "ApproximateNumberOfMessagesDelayed",
      ] as const
    ).reduce((sum, key) => sum + Number(attributes[key] ?? 0), 0);
  };
  const wallets: LoadFixtures["distributed"] = [];
  await parallelEach(
    Array.from({ length: 1001 }, (_, i) => i),
    16,
    async (index) => {
      const result = await request(
        "/wallets",
        {
          playerId: randomUUID(),
          initialBalance: { amount: "1000000.00", currency: "BRL" },
        },
        true,
      );
      wallets[index] = { id: result.id, playerId: result.playerId };
    },
  );
  const hot = wallets.shift();
  if (!hot) throw new Error("Missing hot wallet");
  const fixtures: LoadFixtures = { runId, profile, hot, distributed: wallets, replays: [] };
  for (let index = 0; index < 20; index++) {
    const fixture = loadCommand(fixtures, "replay_seed", "distributed", index);
    const result = await request("/wagering/transactions", fixture.body, false, fixture.key);
    if (result.status !== "PROCESSED" || result.idempotentReplay)
      throw new Error("Invalid replay seed");
    fixtures.replays.push({ index, transactionId: result.transactionId });
  }
  await write("fixtures", fixtures);
  await drain();
  await pollUntil(
    "eight healthy Prometheus targets",
    async () => {
      const up = await instant('up{job="wagering"}');
      return up.length === 8 && up.every((series) => series.value[1] === "1");
    },
    45_000,
    500,
  );
  const snapshot = async () => ({
    api: await instant(
      'sum by(role,instance) (wagering_processing_duration_seconds_count{role="api",channel="http"})',
    ),
    consumer: await instant(
      'sum by(role,instance) (wagering_processing_duration_seconds_count{role="consumer",channel="sqs"})',
    ),
    worker: await instant('sum by(role,instance) (wagering_outbox_published_total{role="worker"})'),
  });
  const scrapeFence = async () => {
    const fence = Date.now() / 1000;
    await pollUntil(
      "fresh scrape from all eight replicas",
      async () => {
        const stamps = await instant(healthyScrapeTimestamps);
        return stamps.length === 8 && stamps.every((series) => Number(series.value[1]) >= fence);
      },
      20_000,
      500,
    );
  };
  await scrapeFence();
  const baseline = await snapshot();
  const source = new Bun.CryptoHasher("sha256");
  for (const path of [
    "compose.yaml",
    "scripts/load-test.ts",
    "load/model.ts",
    "load/prometheus.ts",
    "load/response-evidence.ts",
    "load/sqs-producer.ts",
    "load/verification.test.ts",
    "load/verification-query.ts",
    "load/k6/wagering.js",
    "docker/nginx/nginx.conf",
  ])
    source.update(await Bun.file(path).arrayBuffer());
  const metadata = {
    runId,
    profile,
    startedAt,
    gitHead: Bun.which("git") ? (await command(["git", "rev-parse", "HEAD"])).trim() : null,
    workingTreeDirty: Bun.which("git")
      ? Boolean((await command(["git", "status", "--porcelain"])).trim())
      : null,
    appImageId: (
      await command(["docker", "image", "inspect", "--format", "{{.Id}}", "wagering-app:load"])
    ).trim(),
    loadSourceSha256: source.digest("hex"),
    bun: Bun.version,
    platform: process.platform,
    architecture: process.arch,
    docker: JSON.parse(
      await command([
        "docker",
        "info",
        "--format",
        '{"cpus":{{.NCPU}},"memoryBytes":{{.MemTotal}},"serverVersion":"{{.ServerVersion}}"}',
      ]),
    ),
    images: (await dc(["config", "--images"])).trim().split("\n"),
    topology: { api: 3, consumer: 3, worker: 2 },
    operational: {
      visibilitySeconds: 30,
      waitSeconds: 20,
      maxReceives: 5,
      retryBaseSeconds: 2,
      retryMaxSeconds: 30,
      outboxLeaseMs: 15000,
      outboxRetryMaxMs: 300000,
      consumerConcurrency: 10,
      poolMaxPerProcess: 10,
      postgresMaxConnections: 200,
      lockTimeoutMs: 2000,
      nginxWorkerConnections: 2048,
      nginxNoFile: 4096,
    },
    generator: {
      stages: profile === "full" ? [25, 100, 250, 500] : [5, 15, 30],
      stageSeconds: profile === "full" ? 30 : 7,
      maxVUsPerWorkload: 300,
      sqsBatchConcurrency: 5,
    },
  };
  await write("environment", metadata);
  let uniqueCommands = 20;
  const phases: Record<string, unknown>[] = [];
  for (const phase of ["hot_wallet", "distributed_wallets", "replays", "hot_plus_distributed"]) {
    console.log(`Load phase: ${phase}`);
    const phaseStart = Date.now();
    const countersBefore = await snapshot();
    const output = await dc(
      [
        "run",
        "--rm",
        "--no-deps",
        "k6",
        "run",
        "--log-format",
        "raw",
        "--console-output",
        `/results/${phase}-responses.jsonl`,
        "/load/k6/wagering.js",
      ],
      { LOAD_PHASE: phase },
    );
    const phaseEnd = Date.now();
    await Bun.write(`${runDir}/${phase}.txt`, output);
    // A successful k6 process alone does not prove handleSummary wrote a usable result.
    const summary = (await Bun.file(`${runDir}/${phase}.json`).json()) as K6Summary;
    validateSummary(summary, phase);
    const responses = parseResponseEvidence(
      await Bun.file(`${runDir}/${phase}-responses.jsonl`).text(),
    );
    for (const kind of ["hot", "distributed", "replay"]) {
      const evidence = [...responses.values()].filter((row) => row.workload === kind);
      if (
        evidence.length !== count(summary, `requests_${kind}`) ||
        evidence.filter((row) => row.status === 200).length !==
          count(summary, `committed_${kind}`) ||
        evidence.filter((row) => row.status === 503).length !==
          count(summary, `backpressure_${kind}`)
      )
        throw new Error("HTTP identity evidence differs from response counters");
    }
    if (phase === "replays") {
      const attempts = count(summary, "requests_distributed") + count(summary, "requests_replay");
      for (let index = 9; index < attempts; index += 10) {
        const key = responseKey("replay", index);
        const response = responses.get(key);
        const fixture = fixtures.replays[Math.floor(index / 10) % fixtures.replays.length];
        if (
          !response ||
          !fixture ||
          (response.status === 200 && response.transactionId !== fixture.transactionId)
        )
          throw new Error("Replay identity evidence differs from its seed");
        responses.delete(key);
      }
    }
    const workloads: Workload[] =
      phase === "hot_wallet"
        ? ["hot"]
        : phase === "hot_plus_distributed"
          ? ["hot", "distributed"]
          : ["distributed"];
    let recovered = 0;
    let phaseUnique = 0;
    const recoveryStart = Date.now();
    for (const workload of workloads) {
      const attempts =
        count(summary, `requests_${workload}`) +
        (phase === "replays" ? count(summary, "requests_replay") : 0);
      const expected = Array.from({ length: attempts }, (_, index) => index)
        .filter((index) => phase !== "replays" || index % 10 !== 9)
        .map((index) => loadCommand(fixtures, phase, workload, index));
      const rows = await connection.execute<
        {
          id: string;
          external_transaction_id: string;
          idempotency_key: string;
          wallet_id: string;
          player_id: string;
          kind: string;
          status: string;
          amount: string;
        }[]
      >(
        "SELECT id,external_transaction_id,idempotency_key,wallet_id,player_id,kind,status,amount::text FROM wager_transactions WHERE external_transaction_id LIKE ?",
        [`${runId}:${phase}:${workload}:%`],
      );
      const byKey = new Map(rows.map((row) => [row.external_transaction_id, row]));
      if (rows.length !== count(summary, `committed_${workload}`))
        throw new Error("HTTP success count differs from durable outcomes");
      const missing: typeof expected = [];
      for (const command of expected) {
        const row = byKey.get(command.key);
        const index = Number(command.key.slice(command.key.lastIndexOf(":") + 1));
        const evidenceKey = responseKey(workload, index);
        assertResponseOutcome(responses.get(evidenceKey), row?.id);
        responses.delete(evidenceKey);
        if (!row) {
          missing.push(command);
          continue;
        }
        if (
          row.status !== "PROCESSED" ||
          row.idempotency_key !== command.key ||
          row.wallet_id !== command.body.walletId ||
          row.player_id !== command.body.playerId ||
          row.kind !== command.body.kind ||
          row.amount !== "1.00"
        )
          throw new Error("Persisted load command differs from its deterministic fixture");
        byKey.delete(command.key);
      }
      if (byKey.size || missing.length !== count(summary, `backpressure_${workload}`))
        throw new Error("Load command identity/count diverged");
      await parallelEach(missing, workload === "hot" ? 1 : 10, async (command) => {
        const result = await request("/wagering/transactions", command.body, false, command.key);
        if (result.status !== "PROCESSED" || result.idempotentReplay)
          throw new Error("Backpressure recovery diverged");
        const [row] = await connection.execute<{ id: string }[]>(
          "SELECT id FROM wager_transactions WHERE provider_id = 'provider-a' AND external_transaction_id = ?",
          [command.key],
        );
        if (!row || result.transactionId !== row.id)
          throw new Error("Recovery response differs from its durable transaction");
      });
      recovered += missing.length;
      phaseUnique += expected.length;
    }
    if (responses.size) throw new Error("Unexpected HTTP identity evidence remains");
    uniqueCommands += phaseUnique;
    const recoveryMs = Date.now() - recoveryStart;
    const outboxDrainMs = await drain();
    await scrapeFence();
    await write(`${phase}-counters`, { before: countersBefore, after: await snapshot() });
    await write(`${phase}-prometheus`, await phaseMetrics(phaseStart, phaseEnd));
    phases.push({
      phase,
      startedAt: phaseStart,
      endedAt: phaseEnd,
      uniqueCommands: phaseUnique,
      recovered,
      recoveryMs,
      outboxDrainMs,
      generatorDroppedIterations: count(summary, "dropped_iterations"),
    });
    console.log(
      `Load ${phase}: ${phaseUnique} unique, ${recovered} recovered, outbox drain ${outboxDrainMs}ms`,
    );
  }
  console.log("Load phase: sqs_backlog");
  const sqsStart = Date.now();
  const sqsCountersBefore = await snapshot();
  const sqsCount = profile === "full" ? 10_000 : 1000;
  let sampledBacklogPeak = 0;
  let samplingError: unknown;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try {
        sampledBacklogPeak = Math.max(sampledBacklogPeak, await queueDepth(QUEUES.requests));
      } catch (error) {
        samplingError = error;
      }
      if (sampling) await Bun.sleep(250);
    }
  })();
  let producer: Awaited<ReturnType<typeof produceBacklog>>;
  try {
    producer = await produceBacklog(transport, fixtures, sqsCount);
    await pollUntil(
      "all intended SQS commands committed",
      async () =>
        (await scalar(
          "SELECT count(*)::int AS count FROM wager_transactions WHERE external_transaction_id LIKE ? AND status = 'PROCESSED'",
          [`${runId}:sqs_backlog:%`],
        )) === sqsCount,
      180_000,
      250,
    );
    await pollUntil(
      "SQS requests acknowledged",
      async () => (await queueDepth(QUEUES.requests)) === 0,
      60_000,
      250,
    );
  } finally {
    sampling = false;
    await sampler;
  }
  if (samplingError) throw new Error("SQS backlog sampling failed");
  if (sampledBacklogPeak <= 0) throw new Error("SQS workload produced no observable backlog");
  const sqsEnd = Date.now();
  const sqsOutboxDrainMs = await drain();
  await scrapeFence();
  await write("sqs_backlog-counters", { before: sqsCountersBefore, after: await snapshot() });
  const sqs = {
    ...producer,
    completedAt: sqsEnd,
    drainAfterEnqueueMs: sqsEnd - producer.enqueuedAt,
    sampledBacklogPeak,
    outboxDrainMs: sqsOutboxDrainMs,
  };
  await write("sqs_backlog", sqs);
  await write("sqs_backlog-prometheus", await phaseMetrics(sqsStart, sqsEnd));
  uniqueCommands += sqsCount;
  const transactions = uniqueCommands + 1001;
  await write("expected", { transactions, sqs: sqsCount });
  await pollUntil(
    "all committed and published metrics scraped",
    async () => {
      const committed = await instant('sum(wagering_transactions_total{kind!="OPENING"})');
      const published = await instant("sum(wagering_outbox_published_total)");
      return (
        Number(committed[0]?.value[1]) === uniqueCommands &&
        // Confirmations can repeat under at-least-once delivery; SQL verifies distinct events.
        Number(published[0]?.value[1]) >= transactions * 2
      );
    },
    30_000,
    500,
  );
  const participation = await snapshot();
  for (const [role, replicas] of Object.entries(participation))
    if (
      replicas.length !== (role === "worker" ? 2 : 3) ||
      replicas.some(
        (replica) =>
          Number(replica.value[1]) <=
          Number(
            baseline[role as keyof typeof baseline].find(
              (before) => before.metric.instance === replica.metric.instance,
            )?.value[1] ?? 0,
          ),
      )
    )
      throw new Error(`Missing actual load participation: ${role}`);
  await write("participation", { before: baseline, after: participation });
  if (await queueDepth(QUEUES.deadLetters)) throw new Error("DLQ is not empty after load");
  await verifyFinancialState();
  const proof = (await Bun.file(`${runDir}/verification.json`).json()) as {
    runId: string;
    passed: boolean;
  };
  if (proof.runId !== runId || proof.passed !== true)
    throw new Error("Load verification artifact missing");
  await write("result", {
    runId,
    profile,
    passed: true,
    startedAt,
    completedAt: Date.now(),
    phases,
    sqs,
    transactions,
    dlq: 0,
    verification: proof,
  });
  console.log(`Load passed: ${runDir}/result.json`);
} catch (error) {
  if (database) {
    console.error("Load failed; checking partial financial state before teardown");
    try {
      await verifyFinancialState(true);
    } catch (verificationError) {
      throw new AggregateError(
        [error, verificationError],
        "Load and partial financial verification failed",
      );
    }
  }
  throw error;
} finally {
  transport?.close();
  await dependencies?.onModuleDestroy();
  await database?.onModuleDestroy();
  if (process.env.KEEP_STACK !== "1") await dc(["down", "--volumes", "--remove-orphans"]);
}
