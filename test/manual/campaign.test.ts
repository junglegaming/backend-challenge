import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { SqsTransport } from "../../src/messaging/infrastructure/sqs-transport";
import { managerFor } from "../../src/shared/infrastructure/unit-of-work";
import { assertLedgerInvariant, scratchDatabase } from "../support/database";
import { EventConsumer } from "../support/event-consumer";
import { apiRequest, httpWager, openHttpWallet, submissionBody, submitHttp } from "../support/http";
import { assertReplicas, changeContainer, runtimeLogs, waitForReplicas } from "../support/runtime";
import { sendWager, wagerMessage } from "../support/sqs";
import { apiUrl, command, containersOf, pollUntil, testProject } from "../support/stack";
import { accessToken } from "../support/tokens";
import { toxiproxy } from "../support/toxiproxy";
import { wageringHarness } from "../support/wagering";

import {
  evidenceRoot,
  privateRun,
  save as saveEvidence,
  selected,
  tcImage,
  toolArgs,
} from "./tools";

const h = wageringHarness();
const transport = new SqsTransport({ values: h.values });
const observer = await scratchDatabase();
const events = new EventConsumer(observer.uow, transport, `manual-${randomUUID()}`);
const results: string[] = [];
async function save(label: string, values: Record<string, unknown>) {
  await saveEvidence(label, values);
  results.push(label);
}
async function sql<T extends object>(query: string, parameters: unknown[] = []) {
  return (await h.database.orm).em.getConnection().execute<T[]>(query, parameters);
}
async function ready() {
  await waitForReplicas();
  await pollUntil("manual gateway ready", async () => {
    try {
      return (
        (await fetch(`${apiUrl}/health/ready`, { signal: AbortSignal.timeout(3000) })).status ===
        200
      );
    } catch {
      return false;
    }
  });
}
async function drain() {
  await pollUntil(
    "manual unpublished outbox empty",
    async () =>
      (
        await sql<{ count: number }>(
          "SELECT count(*)::int AS count FROM outbox_messages WHERE published_at IS NULL",
        )
      )[0]?.count === 0,
    90_000,
  );
  const ids = (await sql<{ id: string }>("SELECT id FROM outbox_messages ORDER BY id")).map(
    (row) => row.id,
  );
  await events.waitFor(ids, 1, 90_000);
  for (const id of ids) expect(await events.effectCount(id)).toBe(1);
}
async function assertAll() {
  await assertLedgerInvariant(h.database);
  const wallets = await sql<{ id: string }>("SELECT id FROM wallets ORDER BY id");
  expect(wallets.length).toBeGreaterThan(0);
  for (const wallet of wallets)
    expect((await h.reconcile.handle(wallet.id))?.consistent).toBe(true);
  expect(
    (
      await sql<{ count: number }>(
        "SELECT count(*)::int AS count FROM inbox_messages WHERE processed_at IS NULL",
      )
    )[0]?.count,
  ).toBe(0);
  return wallets.length;
}
async function terminal(externalId: string) {
  return pollUntil(
    "manual terminal transaction",
    async () => {
      const result = await h.queries.providerTransaction("provider-a", externalId);
      return result?.status === "PROCESSED" ? result : false;
    },
    90_000,
  );
}
async function oneEffect(
  externalId: string,
  expectedTypes = ["WagerTransactionProcessed", "WalletBalanceChanged"],
) {
  const tx = await terminal(externalId);
  expect(
    (
      await sql<{ count: number }>(
        "SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE transaction_id = ?",
        [tx.transactionId],
      )
    )[0]?.count,
  ).toBe(1);
  const rows = await sql<{ id: string; event_type: string; payload_type: string }>(
    "SELECT id, event_type, payload->>'eventType' AS payload_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = ? ORDER BY event_type",
    [tx.transactionId],
  );
  expect(rows.map((row) => row.event_type).sort()).toEqual([...expectedTypes].sort());
  for (const row of rows) expect(row.payload_type).toBe(row.event_type);
  return tx;
}
async function recover(body: ReturnType<typeof httpWager>, key: string) {
  return pollUntil(
    "manual original-key HTTP recovery",
    async () => {
      try {
        const response = await submitHttp(body, key);
        if ([502, 503, 504].includes(response.status)) return false;
        expect(response.status).toBe(200);
        const result = await submissionBody(response);
        expect(result.status).toBe("PROCESSED");
        return result;
      } catch (error) {
        if (error instanceof TypeError) return false;
        throw error;
      }
    },
    90_000,
  );
}
function freshToken(token: string) {
  const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
  expect(typeof claims.exp).toBe("number");
  expect(claims.exp * 1000 - Date.now()).toBeGreaterThan(60_000);
}
async function seed() {
  const wallet = await openHttpWallet();
  const body = httpWager(wallet);
  const key = randomUUID();
  const response = await submitHttp(body, key);
  expect(response.status).toBe(200);
  const result = await submissionBody(response);
  expect(result.idempotentReplay).toBe(false);
  expect(result.status).toBe("PROCESSED");
  return { wallet, body, key, transactionId: result.transactionId };
}
beforeAll(async () => {
  await assertReplicas();
  await events.initialize();
});
afterEach(async () => {
  await drain();
  await assertAll();
  await assertReplicas();
});
afterAll(async () => {
  try {
    await toxiproxy.reset();
    for (const role of ["api", "consumer", "worker"])
      for (const id of await containersOf(role))
        if (
          (await command(["docker", "inspect", "--format", "{{.State.Paused}}", id])).trim() ===
          "true"
        )
          await changeContainer(id, "unpause");
    await save("final", {
      experiments: [...results],
      walletsReconciled: await assertAll(),
      invariantsPassed: true,
    });
  } finally {
    transport.close();
    const cleanup = await Promise.allSettled([observer.cleanup(), h.database.onModuleDestroy()]);
    expect(cleanup.every((result) => result.status === "fulfilled")).toBe(true);
  }
});

(selected("parallel") ? test : test.skip)(
  "manual GNU parallel: fifty curl requests with one key commit one debit",
  async () => {
    const wallet = await openHttpWallet();
    const body = httpWager(wallet);
    const key = randomUUID();
    const token = await accessToken("provider-a");
    freshToken(token);
    const joblog = `${evidenceRoot}/parallel-curl-joblog.tsv`;
    await mkdir(evidenceRoot, { recursive: true });
    const curl =
      'TASK12_INDEX={} curl --silent --show-error --max-time 15 --output /dev/null --write-out "%{http_code}\\n" -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $TASK12_TOKEN" -H "Idempotency-Key: $TASK12_KEY" --data "$TASK12_BODY" "$TASK12_URL"';
    const result = await privateRun(
      [
        "parallel",
        "--will-cite",
        "-j50",
        "--halt",
        "now,fail=1",
        "--joblog",
        joblog,
        curl,
        ":::",
        ...Array.from({ length: 50 }, (_, i) => String(i + 1)),
      ],
      {
        ...process.env,
        TASK12_TOKEN: token,
        TASK12_KEY: key,
        TASK12_BODY: JSON.stringify(body),
        TASK12_URL: `${apiUrl}/wagering/transactions`,
      },
    );
    const journal = await Bun.file(joblog).text();
    if (journal.includes(token) || journal.includes(JSON.stringify(body))) {
      await Bun.file(joblog).delete();
      throw new Error("GNU parallel journal unexpectedly expanded private values");
    }
    expect(result.exitCode).toBe(0);
    const statuses = result.stdout.trim().split(/\s+/);
    expect(statuses).toHaveLength(50);
    expect(statuses.every((value) => value === "200")).toBe(true);
    await oneEffect(body.externalTransactionId);
    expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("90.00");
    await save("parallel-curl", {
      tool: "GNU parallel 20221122",
      offered: 50,
      status200: statuses.length,
      elapsedMs: result.elapsedMs,
      oneDebit: true,
      journalHasOnlyVariableReferences: true,
    });
  },
  150_000,
);

(selected("oha") ? test : test.skip)(
  "manual oha replay and GET versus k6 GET on the same seed",
  async () => {
    const fixture = await seed();
    await drain();
    const baselineEvents = await sql<{ id: string }>(
      "SELECT id FROM outbox_messages WHERE payload->'data'->>'transactionId' = ? ORDER BY id",
      [fixture.transactionId],
    );
    const baselineVersion = (await h.queries.wallet(fixture.wallet.id))?.version;
    const common = [
      "oha",
      "-z",
      "30s",
      "-w",
      "-c",
      "20",
      "-q",
      "100",
      "-t",
      "15s",
      "--connect-timeout",
      "5s",
      "--no-tui",
      "--no-color",
      "--http-version",
      "1.1",
      "--output-format",
      "json",
    ];
    for (const probe of ["replay", "get"] as const) {
      const token = await accessToken("provider-a");
      freshToken(token);
      const args = [...common, "-H", `Authorization: Bearer ${token}`];
      if (probe === "replay")
        args.push(
          "-m",
          "POST",
          "-T",
          "application/json",
          "-H",
          `Idempotency-Key: ${fixture.key}`,
          "-d",
          JSON.stringify(fixture.body),
          `${apiUrl}/wagering/transactions`,
        );
      else args.push(`${apiUrl}/wagering/transactions/${fixture.transactionId}`);
      const result = await privateRun(args);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      const latencies: Record<string, number> = {};
      for (const key of ["min", "mean", "p50", "p95", "p99", "max"]) {
        const value = parsed.metrics?.latency_ms?.[key];
        expect(typeof value).toBe("number");
        expect(Number.isFinite(value)).toBe(true);
        latencies[key] = value;
      }
      const statuses: Record<string, number> = {};
      for (const [status, count] of Object.entries(parsed.statusCodeDistribution ?? {})) {
        expect(/^\d{3}$/.test(status)).toBe(true);
        expect(Number.isSafeInteger(count)).toBe(true);
        statuses[status] = count as number;
      }
      const transportErrors = Object.values(parsed.errorDistribution ?? {}).reduce<number>(
        (sum, count) => {
          expect(Number.isSafeInteger(count)).toBe(true);
          expect(count as number).toBeGreaterThanOrEqual(0);
          return sum + (count as number);
        },
        0,
      );
      expect(Object.keys(statuses)).toEqual(["200"]);
      expect(statuses["200"]).toBeGreaterThan(0);
      expect(transportErrors).toBe(0);
      expect(typeof parsed.summary.total).toBe("number");
      expect(typeof parsed.summary.requestsPerSec).toBe("number");
      await save(`oha-${probe}`, {
        tool: "oha 1.16.0",
        configuredSeconds: 30,
        concurrency: 20,
        requestedQps: 100,
        elapsedMs: result.elapsedMs,
        measuredSeconds: parsed.summary.total,
        achievedRequestsPerSecond: parsed.summary.requestsPerSec,
        latencyMs: latencies,
        statuses,
        transportErrors,
        stderrBytes: result.stderrBytes,
        exitCode: result.exitCode,
      });
    }
    const token = await accessToken("provider-a");
    freshToken(token);
    const emptyConfig = `${import.meta.dir}/k6-empty.json`;
    const k6 = await privateRun(
      [
        "k6",
        "run",
        "--quiet",
        "--no-color",
        "--no-usage-report",
        "--config",
        emptyConfig,
        `${import.meta.dir}/get-probe.js`,
      ],
      {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: "C.UTF-8",
        NO_COLOR: "1",
        K6_NO_USAGE_REPORT: "true",
        PROBE_BASE: apiUrl,
        PROBE_TOKEN: token,
        PROBE_TRANSACTION_ID: fixture.transactionId,
        PROBE_EXTERNAL_ID: fixture.body.externalTransactionId,
        PROBE_WALLET_ID: fixture.wallet.id,
      },
    );
    expect(k6.exitCode).toBe(0);
    const parsed = JSON.parse(k6.stdout);
    expect(parsed.probe).toBe("manual-transaction-get");
    const starts = parsed.metrics.read_started?.values.count;
    expect([3000, 3001]).toContain(starts);
    for (const name of ["read_completed", "read_status_200"])
      expect(parsed.metrics[name]?.values.count).toBe(starts);
    expect(parsed.metrics.read_unexpected?.values.rate).toBe(0);
    expect(parsed.metrics.checks?.values.rate).toBe(1);
    for (const metric of Object.values(parsed.metrics) as Array<{
      thresholds?: Record<string, boolean>;
    } | null>)
      for (const ok of Object.values(metric?.thresholds ?? {})) expect(ok).toBe(true);
    await save("k6-get", {
      ...parsed,
      exitCode: k6.exitCode,
      elapsedMs: k6.elapsedMs,
      stderrBytes: k6.stderrBytes,
    });
    const replay = await submissionBody(await submitHttp(fixture.body, fixture.key));
    expect(replay.transactionId).toBe(fixture.transactionId);
    expect(replay.idempotentReplay).toBe(true);
    const read = await apiRequest(`/wagering/transactions/${fixture.transactionId}`, {
      client: "provider-a",
    });
    expect(read.status).toBe(200);
    const value = (await read.json()) as Record<string, unknown>;
    expect(value.transactionId).toBe(fixture.transactionId);
    expect(value.status).toBe("PROCESSED");
    await oneEffect(fixture.body.externalTransactionId);
    expect((await h.queries.wallet(fixture.wallet.id))?.version).toBe(baselineVersion);
    expect(
      await sql(
        "SELECT id FROM outbox_messages WHERE payload->'data'->>'transactionId' = ? ORDER BY id",
        [fixture.transactionId],
      ),
    ).toEqual(baselineEvents);
    expect((await h.queries.wallet(fixture.wallet.id))?.balance.amount).toBe("90.00");
    await save("load-tools-financial-proof", {
      oneDebit: true,
      replayIdentityStable: true,
      walletVersionUnchanged: true,
      eventSetUnchanged: true,
    });
  },
  240_000,
);

(selected("pg-activity") ? test : test.skip)(
  "manual pg_activity: hot-wallet waits coexist with an independent wallet commit",
  async () => {
    const hot = await openHttpWallet("1000.00");
    const cold = await openHttpWallet();
    const script =
      "stty cols 240 rows 40 && exec timeout --signal=INT --kill-after=5s 35s pg_activity -h 127.0.0.1 -p 15432 -U wagering -d wagering --refresh 1 --duration-mode 1 --filter 'dbname:^wagering$' --no-db-size --no-tempfiles --no-walreceiver --no-sys-info --no-proc-info --hide-queries-in-logs";
    const monitor = Bun.spawn(
      toolArgs(["script", "--quiet", "--return", "--command", script, "/dev/null"], {
        ...process.env,
        PGPASSWORD: h.values.database.password,
        TERM: "xterm-256color",
        LC_ALL: "C.UTF-8",
      }),
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PGPASSWORD: h.values.database.password,
          TERM: "xterm-256color",
          LC_ALL: "C.UTF-8",
        },
      },
    );
    const samples: Array<{
      observedAt: number;
      connections: number;
      maxConnections: number;
      active: number;
      idle: number;
      idleInTransaction: number;
      lockWaiting: number;
    }> = [];
    let stderrBytes = 0;
    const readError = (async () => {
      for await (const chunk of monitor.stderr) stderrBytes += chunk.byteLength;
    })();
    const readOutput = (async () => {
      const decoder = new TextDecoder();
      let pending = "";
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strip PTY control sequences without retaining terminal output.
      const ansi = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
      const sessions =
        /Sessions:\s*(\d+)\/(\d+)\s+total\s*⋅\s*(\d+)\s+active\s*⋅\s*(\d+)\s+idle\s*⋅\s*(\d+)\s+idle in txn\s*⋅\s*(\d+)\s+idle in txn abrt\s*⋅\s*(\d+)\s+waiting/g;
      for await (const chunk of monitor.stdout) {
        pending = (pending + decoder.decode(chunk, { stream: true }))
          .replace(ansi, "")
          // biome-ignore lint/suspicious/noControlCharactersInRegex: strip character-set selection sequences too.
          .replace(/\x1b[()][0-2A-Z]/g, "");
        let consumed = 0;
        for (const match of pending.matchAll(sessions)) {
          if (samples.length < 60)
            samples.push({
              observedAt: Date.now(),
              connections: Number(match[1]),
              maxConnections: Number(match[2]),
              active: Number(match[3]),
              idle: Number(match[4]),
              idleInTransaction: Number(match[5]),
              lockWaiting: Number(match[7]),
            });
          consumed = (match.index ?? 0) + match[0].length;
        }
        pending = pending.slice(consumed).slice(-16_384);
      }
      pending = "";
    })();
    let holder: { release: () => void; done: Promise<void> } | undefined;
    let responses: Promise<Response>[] = [];
    const requests = Array.from({ length: 10 }, () => ({
      body: httpWager(hot),
      key: randomUUID(),
    }));
    let blockedCount = 0;
    let coldCommittedWhileHeld = false;
    let heldAt = 0;
    let measurementFailure: unknown;
    let releaseFailure: unknown;
    let monitorExit: number | undefined;
    try {
      await pollUntil("pg_activity numeric sample", async () => samples.length > 0, 15_000);
      const entered = Promise.withResolvers<number>();
      const release = Promise.withResolvers<void>();
      const done = h.uow.run(async (tx) => {
        const pid = (
          await managerFor(tx).execute<{ pid: number }[]>("SELECT pg_backend_pid() AS pid")
        )[0]?.pid;
        await managerFor(tx).execute("SELECT id FROM wallets WHERE id = ? FOR UPDATE", [hot.id]);
        if (pid === undefined) throw new Error("Missing manual holder PID");
        entered.resolve(pid);
        await release.promise;
      });
      void done.catch(entered.reject);
      holder = { release: () => release.resolve(), done };
      const pid = await entered.promise;
      heldAt = Date.now();
      responses = requests.map(({ body, key }) => submitHttp(body, key));
      blockedCount = await pollUntil(
        "manual hot-wallet lock chain",
        async () => {
          const result = await sql<{ count: number }>(
            `WITH RECURSIVE blocked(pid) AS (
        SELECT ?::int UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b
        ON b.pid = ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()
        AND a.state='active' AND a.wait_event_type='Lock')
        SELECT count(*)::int AS count FROM blocked WHERE pid <> ?::int`,
            [pid, pid],
          );
          const count = result[0]?.count ?? 0;
          return count > 0 ? count : false;
        },
        1500,
        10,
      );
      const response = await submitHttp(httpWager(cold));
      expect(response.status).toBe(200);
      coldCommittedWhileHeld = true;
      await pollUntil(
        "pg_activity positive lock wait during owned holder",
        async () => samples.some((sample) => sample.observedAt >= heldAt && sample.lockWaiting > 0),
        1700,
        10,
      );
    } catch (error) {
      measurementFailure = error;
    } finally {
      holder?.release();
      try {
        await holder?.done;
        const completed = await Promise.all(responses);
        for (const response of completed) expect([200, 503]).toContain(response.status);
      } catch (error) {
        releaseFailure = error;
      }
      // The finite monitor and both pipes are always joined before the next case.
      const exitCode = await monitor.exited;
      monitorExit = exitCode;
      await Promise.all([readOutput, readError]);
      await save("pg-activity", {
        tool: "pg_activity 3.0.3",
        exitCode,
        stderrBytes,
        samples,
        blockedCount,
        coldCommittedWhileHeld,
        applicationPoolUpperBound: 80,
        configuredPostgresMaxConnections: 200,
        queryOutputRetained: false,
        measurementFailed: Boolean(measurementFailure),
        releaseFailed: Boolean(releaseFailure),
      });
    }
    if (measurementFailure) throw measurementFailure;
    if (releaseFailure) throw releaseFailure;
    expect([0, 124, 130]).toContain(monitorExit);
    for (const { body, key } of requests) {
      await recover(body, key);
      await oneEffect(body.externalTransactionId);
    }
    expect((await h.queries.wallet(hot.id))?.balance.amount).toBe("900.00");
    expect((await h.queries.wallet(cold.id))?.balance.amount).toBe("90.00");
  },
  150_000,
);

for (const role of ["consumer", "worker", "api"] as const) {
  (selected("pumba") ? test : test.skip)(
    `manual Pumba: random ${role === "api" ? "pause" : "kill"} of one ${role} during traffic`,
    async () => {
      const fixtures = await Promise.all(
        Array.from({ length: 20 }, async () => {
          const wallet = await openHttpWallet();
          return {
            wallet,
            body: httpWager(wallet),
            key: randomUUID(),
            envelope: wagerMessage(wallet),
          };
        }),
      );
      await drain();
      const before = await containersOf(role);
      const startedAt = Date.now();
      const args = [
        "pumba",
        "--label",
        `com.docker.compose.project=${testProject}`,
        "--label",
        `com.docker.compose.service=${role}`,
        "--random",
        ...(role === "api" ? ["pause", "--duration", "5s"] : ["kill", "--signal", "SIGKILL"]),
        "re2:.*",
      ];
      let faultFinished = false;
      let trafficStartedAt = 0;
      let trafficFinishedAt = 0;
      let offered = 0;
      let batches = 0;
      let killedAt: number | undefined;
      const fault = privateRun(args).then((result) => {
        faultFinished = true;
        return result;
      });
      let selected: string[] = [];
      let traffic: Promise<unknown> | undefined;
      try {
        if (role === "api") {
          selected = await pollUntil(
            "Pumba selected paused API",
            async () => {
              const paused: string[] = [];
              for (const id of before)
                if (
                  (
                    await command(["docker", "inspect", "--format", "{{.State.Paused}}", id])
                  ).trim() === "true"
                )
                  paused.push(id);
              return paused.length ? paused : false;
            },
            5000,
            20,
          );
        }
        traffic = (async () => {
          trafficStartedAt = Date.now();
          do {
            batches++;
            offered += fixtures.length;
            if (role === "consumer")
              await Promise.all(fixtures.map((fixture) => sendWager(transport, fixture.envelope)));
            else
              await Promise.all(
                fixtures.map(async (fixture) => {
                  try {
                    const response = await submitHttp(fixture.body, fixture.key);
                    expect([200, 502, 503, 504]).toContain(response.status);
                    return response.status;
                  } catch (error) {
                    if (error instanceof TypeError) return "transport";
                    throw error;
                  }
                }),
              );
            if (batches >= 50 && !faultFinished && role !== "api")
              throw new Error("Pumba action outlasted bounded traffic");
          } while (role !== "api" && !faultFinished);
          trafficFinishedAt = Date.now();
        })();
        const result = await fault;
        expect(result.exitCode).toBe(0);
        if (role !== "api") {
          for (const id of before)
            if (
              (
                await command(["docker", "inspect", "--format", "{{.State.Running}}", id])
              ).trim() === "false"
            )
              selected.push(id);
        }
        expect(selected).toHaveLength(1);
        const selectedId = selected[0];
        if (!selectedId) throw new Error("Pumba target missing");
        await traffic;
        if (role !== "api") {
          killedAt = Date.parse(
            (
              await command(["docker", "inspect", "--format", "{{.State.FinishedAt}}", selectedId])
            ).trim(),
          );
          expect(Number.isFinite(killedAt)).toBe(true);
          expect(killedAt).toBeGreaterThanOrEqual(trafficStartedAt);
          expect(killedAt).toBeLessThanOrEqual(trafficFinishedAt);
        }
        if (role !== "api") await changeContainer(selectedId, "restart");
        await ready();
        for (const fixture of fixtures) {
          const body = role === "consumer" ? fixture.envelope.data : fixture.body;
          if (role !== "consumer") await recover(fixture.body, fixture.key);
          await oneEffect(body.externalTransactionId);
          expect((await h.queries.wallet(fixture.wallet.id))?.balance.amount).toBe("90.00");
          if (role === "consumer")
            expect(
              (
                await sql(
                  "SELECT message_id FROM inbox_messages WHERE message_id = ? AND processed_at IS NOT NULL",
                  [fixture.envelope.messageId],
                )
              ).length,
            ).toBe(1);
        }
        const completions =
          role === "consumer"
            ? (await runtimeLogs("consumer")).filter(
                (record) =>
                  record.event === "consumer_message_completed" &&
                  Number(record.time) >= startedAt &&
                  fixtures.some((fixture) => fixture.envelope.messageId === record.messageId),
              )
            : [];
        await save(`pumba-${role}`, {
          tool: "Pumba 1.2.1",
          action: role === "api" ? "pause-5s" : "SIGKILL",
          selectedContainerIds: selected,
          startedAt,
          elapsedMs: result.elapsedMs,
          exitCode: result.exitCode,
          operations: fixtures.length,
          offered,
          batches,
          trafficStartedAt,
          trafficFinishedAt,
          killedAt,
          oneEffectEach: true,
          observedRedeliveries: completions.filter((record) => Number(record.attempt) >= 2).length,
          survivingConsumerInstanceCount: new Set(completions.map((record) => record.instanceId))
            .size,
          explicitRestartAfterKill: role !== "api",
          deterministicCrashWindow: false,
        });
      } finally {
        try {
          await fault;
          await traffic;
        } finally {
          for (const id of before) {
            if (
              (await command(["docker", "inspect", "--format", "{{.State.Paused}}", id])).trim() ===
              "true"
            )
              await changeContainer(id, "unpause");
            if (
              (
                await command(["docker", "inspect", "--format", "{{.State.Running}}", id])
              ).trim() === "false"
            )
              await changeContainer(id, "restart");
          }
          await ready();
        }
      }
    },
    240_000,
  );
}

for (const [type, dependency, attributes] of [
  ["timeout", "postgres", ["timeout=1000"]],
  ["slicer", "sqs", ["average_size=64", "size_variation=0", "delay=1000"]],
  ["limit_data", "postgres", ["bytes=128"]],
] as const) {
  (selected("toxiproxy") ? test : test.skip)(
    `manual Toxiproxy CLI: ${type} on ${dependency} preserves atomic financial recovery`,
    async () => {
      const wallet = await openHttpWallet();
      const reference = httpWager(wallet);
      const referenceKey = randomUUID();
      const dependent = httpWager(wallet, {
        kind: "REFUND",
        referenceExternalTransactionId: reference.externalTransactionId,
      });
      const dependentKey = randomUUID();
      if (dependency === "postgres") {
        const response = await submitHttp(dependent, dependentKey);
        expect(response.status).toBe(202);
        expect((await submissionBody(response)).status).toBe("PENDING_REFERENCE");
      }
      await drain();
      const pendingBefore = await h.queries.providerTransaction(
        "provider-a",
        dependent.externalTransactionId,
      );
      const name = `task12_${type}`;
      // The CLI executes inside the proxy container, whose API listens on 8474.
      const common = ["toxiproxy-cli", "--host", "http://127.0.0.1:8474", "toxic"];
      let installed: Awaited<ReturnType<typeof privateRun>> | undefined;
      let faultStatus = 0;
      let noFalseReferenceRejection = true;
      let publicationObservedWhileSlicerActive = false;
      let primary: unknown;
      let removalFailed = false;
      let resetFailed = false;
      try {
        installed = await privateRun([
          ...common,
          "add",
          "--type",
          type,
          "--toxicName",
          name,
          "--downstream",
          "--toxicity",
          "1",
          ...attributes.flatMap((value) => ["--attribute", value]),
          dependency,
        ]);
        expect(installed.exitCode).toBe(0);

        const active = (await (
          await fetch(`http://127.0.0.1:18474/proxies/${dependency}`)
        ).json()) as { toxics: Array<{ name: string; type: string }> };
        expect(active.toxics.some((toxic) => toxic.name === name && toxic.type === type)).toBe(
          true,
        );
        const response = await submitHttp(reference, referenceKey);
        faultStatus = response.status;
        expect([200, 503]).toContain(faultStatus);
        if (dependency === "postgres") {
          const pending = await h.queries.providerTransaction(
            "provider-a",
            dependent.externalTransactionId,
          );
          expect(pending?.status).toBe("PENDING_REFERENCE");
          expect(pending?.failureCode).toBeUndefined();
          noFalseReferenceRejection = pending?.status === "PENDING_REFERENCE";
          const failed = await sql<{ count: number }>(
            "SELECT count(*)::int AS count FROM wager_transactions WHERE wallet_id = ? AND status = 'FAILED'",
            [wallet.id],
          );
          expect(failed[0]?.count).toBe(0);
          await assertLedgerInvariant(h.database);
        } else {
          expect(faultStatus).toBe(200);
          const transaction = await terminal(reference.externalTransactionId);
          await pollUntil(
            "target publication while SQS slicer active",
            async () =>
              (
                await sql<{ count: number }>(
                  "SELECT count(*)::int AS count FROM outbox_messages WHERE payload->'data'->>'transactionId'=? AND published_at IS NOT NULL",
                  [transaction.transactionId],
                )
              )[0]?.count === 2,
            90_000,
          );
          publicationObservedWhileSlicerActive = true;
        }
      } catch (error) {
        primary = error;
      } finally {
        try {
          const removed = await privateRun([...common, "remove", "--toxicName", name, dependency]);
          removalFailed = removed.exitCode !== 0;
          if (removalFailed) primary ??= new Error("Toxic removal failed");
        } finally {
          try {
            await toxiproxy.reset();
          } catch (error) {
            resetFailed = true;
            primary ??= error;
          }
        }
      }
      if (primary) {
        await save(`toxiproxy-${type}-failure`, {
          installExit: installed?.exitCode,
          removalFailed,
          resetCompleted: !resetFailed,
        });
        throw primary;
      }
      await ready();
      await recover(reference, referenceKey);
      await oneEffect(reference.externalTransactionId);
      if (dependency === "postgres") {
        await oneEffect(dependent.externalTransactionId, [
          "WagerTransactionPendingReference",
          "WagerTransactionProcessed",
          "WalletBalanceChanged",
        ]);
        expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("100.00");
      } else expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("90.00");
      const clean = (await (
        await fetch(`http://127.0.0.1:18474/proxies/${dependency}`)
      ).json()) as { enabled: boolean; toxics: unknown[] };
      expect(clean.enabled).toBe(true);
      expect(clean.toxics).toHaveLength(0);
      await save(`toxiproxy-${type}`, {
        tool: "toxiproxy-cli 2.13.0",
        type,
        dependency,
        attributes: [...attributes],
        installExit: installed?.exitCode,
        faultStatus,
        noFalseReferenceRejection,
        beforeTtlOnly: dependency === "postgres",
        hadPendingFixture: Boolean(pendingBefore),
        publicationObservedWhileSlicerActive,
        slicerDelayMicroseconds: type === "slicer" ? 1000 : undefined,
        oneEffectEach: true,
        toxicRemoved: true,
      });
    },
    240_000,
  );
}

async function qdisc(container: string) {
  return privateRun([
    "docker",
    "run",
    "--rm",
    "--pull=never",
    "--network",
    `container:${container}`,
    "--cap-drop",
    "ALL",
    "--cap-add",
    "NET_ADMIN",
    "--entrypoint",
    "tc",
    tcImage,
    "qdisc",
    "show",
    "dev",
    "eth0",
  ]);
}
for (const dependency of ["postgres", "sqs"] as const) {
  for (const effect of ["delay", "loss"] as const) {
    (selected("netem") ? test : test.skip)(
      `manual Pumba netem: ${effect} on ${dependency} link with observed qdisc cleanup`,
      async () => {
        const wallet = await openHttpWallet();
        const body = httpWager(wallet);
        const key = randomUUID();
        await drain();
        const proxy = (await containersOf("toxiproxy"))[0];
        const target = (
          await containersOf(dependency === "postgres" ? "postgres" : "ministack")
        )[0];
        if (!proxy || !target) throw new Error("Missing owned netem endpoint");
        const baseline = await qdisc(proxy);
        const canInspect = baseline.exitCode === 0;
        if (!canInspect && !baseline.capabilityDenied && !baseline.kernelUnsupported)
          throw new Error("Unclassified tc helper failure");
        let installed = false;
        let faultStatus = 0;
        let faultElapsedMs = 0;
        let observedUnpublished: number | undefined;
        let observedAttempts: number | undefined;
        let targetPublicationUnderFault = false;
        let failedPublicationUnderFault = false;
        let qdiscActiveAtPublicationObservation = false;
        async function observeSqs(effectStartedAt: number) {
          const tx = await terminal(body.externalTransactionId);
          if (effect === "delay") {
            await pollUntil(
              "target SQS publish under delay",
              async () =>
                (
                  await sql<{ count: number }>(
                    "SELECT count(*)::int AS count FROM outbox_messages WHERE payload->'data'->>'transactionId'=? AND published_at IS NOT NULL",
                    [tx.transactionId],
                  )
                )[0]?.count === 2,
              7000,
            );
            targetPublicationUnderFault = true;
          } else {
            await pollUntil(
              "isolated target SQS failure under outage",
              async () => {
                const rows = await sql<{ count: number; attempts: number }>(
                  "SELECT count(*)::int AS count, coalesce(max(attempts),0)::int AS attempts FROM outbox_messages WHERE payload->'data'->>'transactionId'=? AND published_at IS NULL",
                  [tx.transactionId],
                );
                observedUnpublished = rows[0]?.count;
                observedAttempts = rows[0]?.attempts;
                const failures = (await runtimeLogs("worker")).filter(
                  (record) =>
                    record.event === "outbox_publish_failed" &&
                    Number(record.time) >= effectStartedAt,
                );
                return (
                  observedUnpublished === 2 && (observedAttempts ?? 0) > 0 && failures.length > 0
                );
              },
              7000,
            );
            // All previous events were drained; no other work was submitted in this window.
            expect(
              (
                await sql<{ count: number }>(
                  "SELECT count(*)::int AS count FROM outbox_messages WHERE published_at IS NULL",
                )
              )[0]?.count,
            ).toBe(2);
            failedPublicationUnderFault = true;
          }
        }
        let fallbackReason: string | undefined;
        let faultResult: Awaited<ReturnType<typeof privateRun>> | undefined;
        let after: Awaited<ReturnType<typeof privateRun>> | undefined;
        if (canInspect) {
          const fault = privateRun([
            "pumba",
            "--label",
            `com.docker.compose.project=${testProject}`,
            "--label",
            "com.docker.compose.service=toxiproxy",
            "netem",
            "--duration",
            "10s",
            "--interface",
            "eth0",
            "--target",
            target,
            "--tc-image",
            tcImage,
            ...(effect === "delay"
              ? ["delay", "--time", "250", "--jitter", "0", "--correlation", "0"]
              : ["loss", "--percent", "100", "--correlation", "0"]),
            "re2:.*",
          ]);
          // Poll tc directly: Pumba success alone cannot prove installation or cleanup.
          try {
            installed = await pollUntil(
              "owned netem qdisc",
              async () => {
                const current = await qdisc(proxy);
                return current.exitCode === 0 && /\bnetem\b/.test(current.stdout);
              },
              4000,
              20,
            );
            const effectStartedAt = Date.now();
            const before = Date.now();
            const response = await submitHttp(body, key);
            faultElapsedMs = Date.now() - before;
            faultStatus = response.status;
            expect([200, 503]).toContain(faultStatus);
            if (dependency === "sqs") {
              expect(faultStatus).toBe(200);
              await observeSqs(effectStartedAt);
              const active = await qdisc(proxy);
              expect(active.exitCode).toBe(0);
              expect(/\bnetem\b/.test(active.stdout)).toBe(true);
              qdiscActiveAtPublicationObservation = true;
            }
          } catch (error) {
            faultResult = await fault;
            if (!installed && (faultResult.capabilityDenied || faultResult.kernelUnsupported))
              fallbackReason = faultResult.capabilityDenied
                ? "NET_ADMIN denied"
                : "kernel netem unsupported";
            else throw error;
          } finally {
            faultResult ??= await fault;
            after = await qdisc(proxy);
            expect(after.exitCode).toBe(0);
            expect(after.stdout).toBe(baseline.stdout);
            expect(/\bnetem\b/.test(after.stdout)).toBe(false);
          }
          if (installed) expect(faultResult.exitCode).toBe(0);
        } else
          fallbackReason = baseline.capabilityDenied
            ? "NET_ADMIN denied"
            : "kernel netem unsupported";
        after ??= await qdisc(proxy);
        if (canInspect) {
          expect(after.exitCode).toBe(0);
          expect(after.stdout).toBe(baseline.stdout);
          expect(/\bnetem\b/.test(after.stdout)).toBe(false);
        }
        expect(
          fallbackReason,
          "Actual netem is required; inspect Docker/kernel capabilities",
        ).toBeUndefined();
        expect(installed).toBe(true);
        await ready();
        await recover(body, key);
        await oneEffect(body.externalTransactionId);
        await drain();
        expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("90.00");
        await save(`pumba-netem-${dependency}-${effect}`, {
          tool: "Pumba 1.2.1",
          tcImage,
          dependency,
          effect,
          durationSeconds: 10,
          delayMilliseconds: effect === "delay" ? 250 : undefined,
          lossPercent: effect === "loss" ? 100 : undefined,
          installed,
          baselineQdisc: canInspect ? baseline.stdout.trim() : undefined,
          qdiscRestored: canInspect ? after.stdout === baseline.stdout : null,
          exitCode: faultResult?.exitCode,
          faultStatus,
          faultElapsedMs,
          observedUnpublished,
          observedAttempts,
          targetPublicationUnderFault,
          failedPublicationUnderFault,
          qdiscActiveAtPublicationObservation,
          fallbackReason,
          fallback: fallbackReason
            ? effect === "delay"
              ? "Toxiproxy 250ms downstream latency"
              : "Toxiproxy disabled endpoint; not packet loss"
            : undefined,
          oneEffect: true,
          unpublishedAfterRecovery: 0,
        });
      },
      240_000,
    );
  }
}
