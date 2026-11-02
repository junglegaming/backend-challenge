// Synthetic aggregate fixtures; no application, network, database or payload input.
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docsThemeCsp, docsThemeScript, renderDocsTopbar } from "../../scripts/docs-theme";
import {
  buildCampaign,
  campaignData,
  campaignHtml,
  writeCampaign,
} from "../../scripts/render-load-campaign";
import {
  type AggregateInput,
  ALLOWED_FILES,
  afterWarmup,
  align,
  buildReport,
  counterDelta,
  EXPECTED,
  escapeHtml,
  type InputKey,
  inlineJson,
  lineChart,
  metricNumber,
  PHASES,
  parseArgs,
  readAggregate,
  reportHtml,
  validateCohort,
  writeReport,
} from "../../scripts/render-load-report";

const identity = { sourceCommit: "a".repeat(40), loadSourceSha256: "b".repeat(64) };

function expectTrustedTheme(html: string) {
  const topbar = renderDocsTopbar("../../../");
  expect(html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi)).toEqual([docsThemeScript]);
  expect(html).toContain(docsThemeCsp);
  expect(html).not.toMatch(/script-src[^;"]*'unsafe-inline'/i);
  expect(html).toContain(topbar);
  for (const path of [
    "docs/load-report/index.html",
    "README.md",
    "docs/architecture.html",
    "docs/verification.md",
  ])
    expect(html).toContain(`href="../../../${path}"`);
  expect(html.match(/<style data-docs-dark\b/g)).toHaveLength(1);
  expect(html).toContain('data-docs-dark media="screen and (prefers-color-scheme: dark)"');
  expect(html.indexOf(docsThemeScript)).toBeLessThan(html.indexOf("</head>"));
  expect(html.indexOf(topbar)).toBeGreaterThan(html.indexOf("<main>"));
  expect(html.replace(docsThemeScript, "")).not.toMatch(
    /<script|<iframe|\son\w+\s*=|(?:src|href)\s*=\s*["'](?:https?:|javascript:)/i,
  );
}

function fixture(): AggregateInput[] {
  const verification = {
    runId: "synthetic-quick",
    passed: true,
    partial: false,
    wallets: 1001,
    transactions: 2021,
    processed: 2021,
    entries: 2021,
    outbox: 4042,
    unpublished: 0,
    inbox: 1000,
    unfinished_inbox: 0,
    duplicate_effects: 0,
    remoteInboxes: { total: 5042, requests: 1000, events: 4042, unknown: 0 },
  };
  return [
    {
      key: "aws-quick",
      environment: {
        runId: "synthetic-quick",
        gitHead: identity.sourceCommit,
        loadSourceSha256: identity.loadSourceSha256,
        workingTreeDirty: false,
        profile: "quick",
        target: "remote",
        scenario: "standard",
        startedAt: 1000,
      },
      result: {
        runId: "synthetic-quick",
        profile: "quick",
        passed: true,
        startedAt: 1000,
        completedAt: 2000,
        transactions: 2021,
        dlq: 0,
        sqs: { count: 1000 },
        verification,
      },
      verification: structuredClone(verification),
    },
    {
      key: "local-full",
      environment: {
        runId: "synthetic-local-full",
        gitHead: identity.sourceCommit,
        loadSourceSha256: identity.loadSourceSha256,
        workingTreeDirty: false,
        profile: "full",
        target: "compose",
        scenario: "standard",
      },
    },
    {
      key: "aws-full-1",
      environment: {
        runId: "synthetic-aws-full",
        gitHead: identity.sourceCommit,
        loadSourceSha256: identity.loadSourceSha256,
        workingTreeDirty: false,
        profile: "full",
        target: "remote",
        scenario: "standard",
      },
    },
  ];
}
describe("global identity, acceptance and declared denominator", () => {
  test("only one diagnostic quick; zero of two nominated fulls", () => {
    const result = validateCohort(fixture(), identity);
    expect(result.nominated).toBe(3);
    expect(result.quick).toEqual({ nominated: 1, accepted: 1 });
    expect(result.full).toEqual({ nominated: 2, accepted: 0 });
    expect(result.excluded.map((run) => run.reasons)).toEqual([
      ["missing_result", "missing_verification"],
      ["missing_result", "missing_verification"],
    ]);
  });
  test("mixed hash rejected even on excluded full", () => {
    const input = fixture();
    (input[1]!.environment as Record<string, unknown>).loadSourceSha256 = "c".repeat(64);
    expect(() => validateCohort(input, identity)).toThrow("MIXED_LOAD_SOURCE_HASH");
  });
  test("different commit cannot be renamed into current cohort", () => {
    const input = fixture();
    (input[0]!.environment as Record<string, unknown>).gitHead = "d".repeat(40);
    expect(() => validateCohort(input, identity)).toThrow("MIXED_SOURCE_COMMIT");
  });
  test("partial proof excluded; no fallback to phase data", () => {
    const input = fixture();
    (input[0]!.verification as Record<string, unknown>).partial = true;
    const result = validateCohort(input, identity);
    expect(result.accepted).toHaveLength(0);
    expect(result.excluded[0]!.reasons).toContain("verification_partial_or_unspecified");
  });
  test("failed result excluded", () => {
    const input = fixture();
    (input[0]!.result as Record<string, unknown>).passed = false;
    expect(validateCohort(input, identity).accepted).toHaveLength(0);
  });
  test("embedded and separate accepted proofs must agree", () => {
    const input = fixture();
    (input[0]!.verification as Record<string, unknown>).transactions = 2022;
    expect(() => validateCohort(input, identity)).toThrow("VERIFICATION_PROOFS_DIFFER");
  });
  test("financial contradiction cannot be charted", () => {
    const input = fixture(),
      proof = input[0]!.verification as Record<string, unknown>;
    proof.outbox = 4000;
    (input[0]!.result as Record<string, unknown>).verification = structuredClone(proof);
    expect(() => validateCohort(input, identity)).toThrow("OUTBOX_COUNT_MISMATCH");
  });
  test("quick cannot occupy full label", () => {
    const input = fixture();
    (input[1]!.environment as Record<string, unknown>).profile = "quick";
    expect(() => validateCohort(input, identity)).toThrow("PROFILE_LABEL_MISMATCH");
  });
  test("only eighteen literal aggregate names", () => {
    expect(ALLOWED_FILES).toHaveLength(18);
    expect(new Set(ALLOWED_FILES).size).toBe(18);
    expect(
      ALLOWED_FILES.some((name) => /fixtures|responses|failure|execution|partial|state/.test(name)),
    ).toBe(false);
  });
});

function onDisk<T>(run: (paths: Record<InputKey, string>, root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "load-report-synthetic-"));
  try {
    const paths = {
      "aws-quick": join(root, "quick"),
      "local-full": join(root, "local"),
      "aws-full-1": join(root, "aws"),
    };
    const inputs = fixture();
    for (const input of inputs) {
      mkdirSync(paths[input.key]);
      const environment = input.environment as Record<string, unknown>;
      Object.assign(environment, {
        gitHead: EXPECTED.sourceCommit,
        loadSourceSha256: EXPECTED.loadSourceSha256,
      });
      writeFileSync(join(paths[input.key], "environment.json"), JSON.stringify(environment));
    }
    const input = inputs[0]!,
      result = input.result as Record<string, unknown>,
      proof = input.verification as Record<string, unknown>;
    Object.assign(proof, {
      transactions: 2026,
      processed: 2026,
      entries: 2026,
      outbox: 4052,
      remoteInboxes: { total: 5052, requests: 1000, events: 4052, unknown: 0 },
    });
    const events = {
      elapsedMs: 5,
      activeHandlers: 0,
      coverage: { outbox: 4052, effects: 4052, missing: 0, extra: 0, invalid_inbox: 0 },
    };
    const phases = PHASES.slice(0, 4).map((phase, index) => ({
      phase,
      startedAt: 2000 + index * 25000,
      endedAt: 26000 + index * 25000,
      uniqueCommands: phase === "hot_plus_distributed" ? 2 : 1,
      recovered: 0,
      recoveryMs: 0,
      outboxDrainMs: 1,
      events,
      generatorDroppedIterations: 0,
    }));
    const sqs = {
      count: 1000,
      groups: 1000,
      startedAt: 102000,
      enqueuedAt: 102100,
      completedAt: 104000,
      drainAfterEnqueueMs: 1900,
      sampledBacklogPeak: 900,
      outboxDrainMs: 0,
      events,
    };
    Object.assign(result, {
      completedAt: 105000,
      transactions: 2026,
      phases,
      sqs,
      verification: structuredClone(proof),
    });
    const environment = input.environment as Record<string, unknown>;
    environment.generator = {
      stages: [5, 15, 30],
      stageSeconds: 7,
      maxVUsPerWorkload: 300,
      sqsBatchConcurrency: 5,
    };
    writeFileSync(join(paths["aws-quick"], "environment.json"), JSON.stringify(environment));
    writeFileSync(join(paths["aws-quick"], "result.json"), JSON.stringify(result));
    writeFileSync(join(paths["aws-quick"], "verification.json"), JSON.stringify(proof));
    const sample = (role: string, count: number) => [
      { metric: { role, instance: `synthetic-${role}` }, value: [1, String(count)] },
    ];
    const counters = {
      before: { api: sample("api", 0), consumer: [], worker: sample("worker", 0) },
      after: { api: sample("api", 1), consumer: [], worker: sample("worker", 2) },
    };
    for (const phase of phases) {
      const workloads =
        phase.phase === "hot_wallet"
          ? ["hot"]
          : phase.phase === "hot_plus_distributed"
            ? ["hot", "distributed"]
            : phase.phase === "replays"
              ? ["distributed", "replay"]
              : ["distributed"];
      const metrics: Record<string, unknown> = {
        checks: { values: { rate: 1 } },
        unexpected_status: { values: { rate: 0 } },
        iterations: { values: { count: workloads.length } },
        vus: { values: { max: 1 } },
      };
      for (const workload of workloads) {
        metrics[`requests_${workload}`] = { values: { count: 1, rate: 0.04 } };
        metrics[`committed_${workload}`] = { values: { count: 1 } };
        metrics[`duration_${workload}`] = { values: { med: 10, "p(95)": 15, "p(99)": 20 } };
      }
      const prometheus: Record<string, unknown> = {};
      for (const query of [
        "committed_per_second",
        "outbox_published_per_second",
        "outbox_lag_seconds",
        "processing_p50_seconds",
        "processing_p95_seconds",
        "processing_p99_seconds",
        "lock_wait_p95_seconds",
      ])
        prometheus[query] = {
          series: [
            {
              metric: { role: "api", instance: "synthetic-replica", channel: "http" },
              values: [0, 5, 10, 15, 20].map((offset) => [
                phase.startedAt / 1000 + offset,
                offset === 0 ? "NaN" : "1",
              ]),
            },
          ],
        };
      prometheus.queue_depth = {
        series: [
          {
            metric: { queue: "events", state: "visible" },
            values: [[phase.startedAt / 1000, "0"]],
          },
        ],
      };
      writeFileSync(join(paths["aws-quick"], `${phase.phase}.json`), JSON.stringify({ metrics }));
      writeFileSync(
        join(paths["aws-quick"], `${phase.phase}-counters.json`),
        JSON.stringify(counters),
      );
      writeFileSync(
        join(paths["aws-quick"], `${phase.phase}-prometheus.json`),
        JSON.stringify(prometheus),
      );
    }
    writeFileSync(join(paths["aws-quick"], "sqs_backlog.json"), JSON.stringify(sqs));
    writeFileSync(
      join(paths["aws-quick"], "sqs_backlog-counters.json"),
      JSON.stringify({
        ...counters,
        after: { ...counters.after, consumer: sample("consumer", 1000) },
      }),
    );
    writeFileSync(
      join(paths["aws-quick"], "sqs_backlog-prometheus.json"),
      JSON.stringify({
        committed_per_second: { series: [{ metric: {}, values: [[101.998, "0"]] }] },
      }),
    );
    // Any read of these prohibited/failed subphase inputs would make JSON parsing fail.
    for (const key of Object.keys(paths) as InputKey[])
      for (const name of ["fixtures.json", "responses.jsonl", "failure.json", "execution.json"])
        writeFileSync(join(paths[key], name), "FORBIDDEN_SYNTHETIC_MARKER");
    writeFileSync(join(paths["local-full"], "hot_wallet.json"), "FORBIDDEN_FAILED_PHASE");
    writeFileSync(join(paths["aws-full-1"], "hot_wallet.json"), "FORBIDDEN_FAILED_PHASE");
    return run(paths, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fullFixture(root: string, remote = false): void {
  const read = (name: string) => JSON.parse(readFileSync(join(root, name), "utf8"));
  const save = (name: string, value: unknown) =>
    writeFileSync(join(root, name), JSON.stringify(value));
  const environment = read("environment.json"),
    result = read("result.json"),
    proof = read("verification.json");
  const runId = "2026-11-02T16-38-47-783Z-354c2da7";
  Object.assign(environment, {
    runId,
    profile: "full",
    ...(remote ? { target: "remote", scenario: "standard" } : {}),
    topology: { api: 3, consumer: 3, worker: 2 },
    docker: { cpus: 8, memoryBytes: 16000000000 },
    operational: {
      consumerConcurrency: 10,
      poolMaxPerProcess: 10,
      postgresMaxConnections: 200,
      lockTimeoutMs: 2000,
      visibilitySeconds: 30,
      waitSeconds: 20,
      maxReceives: 5,
      outboxLeaseMs: 15000,
    },
    generator: { stages: [25, 100, 250, 500], stageSeconds: 30, maxVUsPerWorkload: 300 },
  });
  if (!remote) {
    delete environment.target;
    delete environment.scenario;
  }
  proof.runId = runId;
  Object.assign(result, {
    runId,
    profile: "full",
    verification: proof,
    events: result.phases[0].events,
  });
  if (!remote) {
    for (const phase of result.phases) delete phase.events;
    delete result.sqs.events;
    delete result.events;
  }
  for (const phase of PHASES.slice(0, 4)) {
    const summary = read(`${phase}.json`);
    summary.metrics.iterations.values.rate = summary.metrics.iterations.values.count / 24;
    save(`${phase}.json`, summary);
  }
  save("environment.json", environment);
  save("result.json", result);
  save("verification.json", proof);
  save("sqs_backlog.json", result.sqs);
}

describe("separate FULL campaign reports", () => {
  test("one or three runs from another source keep their own identity and measured environment", () =>
    onDisk((paths) => {
      fullFixture(paths["aws-quick"], true);
      const campaign = buildCampaign("aws", [paths["aws-quick"]]);
      campaign.sourceCommit = "c".repeat(40);
      campaign.loadSourceSha256 = "d".repeat(64);
      const first = campaign.runs[0]!;
      first.environment.apiReplicas = 5;
      first.environment.runnerCpus = 7;
      first.environment.consumerConcurrency = 4;
      const single = campaignHtml(campaignData(campaign));
      expect(single).toContain("<h1>AWS · FULL aprovado</h1>");
      expect(single).toContain("ccccccc/dddddddd");
      expect(single).toContain("5 API · 3 consumers · 2 workers");
      expect(single).toContain("7 CPUs");
      expect(single).toContain("4 concorrentes / 10 conexões");
      expect(single).toContain(new Date(first.startedAt).toISOString());
      expect(single).not.toContain("FULL3");
      expect(single).not.toContain("db.m7g.2xlarge");
      expect(single).not.toContain("/health/live");
      for (const suffix of ["00000001", "00000002"]) {
        const copy = structuredClone(first);
        copy.id = copy.id.replace(/[a-f0-9]{8}$/, suffix);
        campaign.runs.push(copy);
      }
      const triple = campaignHtml(campaignData(campaign));
      expect(triple).toContain("<h1>AWS · 3 FULL aprovados</h1>");
      expect(triple).toContain("3 execuções completas aprovadas na coorte ccccccc/dddddddd");
      expect(triple).not.toContain("uma única amostra AWS");
      expect(triple).not.toContain("FULL3");
    }));
  test("historical local instrumentation stays unknown and missing drop metrics never become zero", () =>
    onDisk((paths) => {
      fullFixture(paths["aws-quick"]);
      const campaign = buildCampaign("local", [paths["aws-quick"]]);
      expect(
        campaign.runs[0]!.phases.every(
          (phase) => phase.dropped === null && phase.eventDrainMs === null,
        ),
      ).toBe(true);
      const html = campaignHtml(campaign);
      expect(html).toContain("UNKNOWN");
      expect(html).toContain("não demonstra sustentar 500 req/s");
      expect(html).not.toContain("FORBIDDEN_SYNTHETIC_MARKER");
      expect(JSON.stringify(campaign)).not.toContain("synthetic-replica");
    }));
  test("a remote FULL without persisted event coverage is rejected", () =>
    onDisk((paths) => {
      fullFixture(paths["aws-quick"], true);
      const campaign = buildCampaign("aws", [paths["aws-quick"]]);
      expect(campaign.runs[0]!.remoteInboxes?.events).toBe(4052);
      const path = join(paths["aws-quick"], "result.json");
      const result = JSON.parse(readFileSync(path, "utf8"));
      delete result.phases[0].events;
      writeFileSync(path, JSON.stringify(result));
      expect(() => buildCampaign("aws", [paths["aws-quick"]])).toThrow(
        "MISSING_REMOTE_EVENT_PROOF",
      );
    }));
  test("mixed identity and partial proof cannot be admitted into a campaign", () =>
    onDisk((paths, root) => {
      fullFixture(paths["aws-quick"]);
      const second = join(root, "second");
      mkdirSync(second);
      for (const name of ALLOWED_FILES)
        if (existsSync(join(paths["aws-quick"], name)))
          writeFileSync(join(second, name), readFileSync(join(paths["aws-quick"], name)));
      const envPath = join(second, "environment.json"),
        env = JSON.parse(readFileSync(envPath, "utf8"));
      env.gitHead = "b".repeat(40);
      writeFileSync(envPath, JSON.stringify(env));
      expect(() => buildCampaign("local", [paths["aws-quick"], second])).toThrow(
        "MIXED_SOURCE_COMMIT",
      );
      const proofPath = join(paths["aws-quick"], "verification.json"),
        proof = JSON.parse(readFileSync(proofPath, "utf8"));
      proof.partial = true;
      writeFileSync(proofPath, JSON.stringify(proof));
      expect(() => buildCampaign("local", [paths["aws-quick"]])).toThrow(
        "PARTIAL_CAMPAIGN_VERIFICATION",
      );
    }));
  test("closed projection regenerates byte-identical HTML without original aggregates", () =>
    onDisk((paths, root) => {
      fullFixture(paths["aws-quick"]);
      const campaign = buildCampaign("local", [paths["aws-quick"]]);
      const output = join(root, "rendered");
      writeCampaign(campaign, output);
      const serialized = JSON.parse(readFileSync(join(output, "campaign.json"), "utf8"));
      serialized.unrelatedSecret = "DO_NOT_COPY";
      serialized.runs[0].environment.opaqueEndpoint = "DO_NOT_COPY";
      const projected = campaignData(serialized);
      expect(JSON.stringify(projected)).not.toContain("DO_NOT_COPY");
      const html = campaignHtml(projected);
      expect(html).toBe(readFileSync(join(output, "index.html"), "utf8"));
      expectTrustedTheme(html);
      expect(() => writeCampaign(campaign, output)).toThrow("OUTPUT_EXISTS");
      projected.runs[0]!.financial.duplicate_effects = 1;
      expect(() => writeCampaign(projected, join(root, "failed-output"))).toThrow(
        "FAILED_FINANCIAL_GATE",
      );
      expect(existsSync(join(root, "failed-output"))).toBe(false);
    }));
});

describe("allowlisted file loading and standalone output", () => {
  test("eighteen accepted aggregates plus two excluded environments, without prohibited reads", () =>
    onDisk((paths) => {
      const report = buildReport(paths);
      expect(report.files).toHaveLength(20);
      expect(report.phases).toHaveLength(4);
      expect(report.phases.every((phase) => phase.after30Samples === 0)).toBe(true);
      expect(report.sqs.timestampCount).toBe(1);
      expect(report.sqs.duringTrafficSamples).toBe(0);
      expect(report.sqs.consumerDelta).toBeNull();
    }));
  test("forbidden filenames rejected before opening", () =>
    onDisk((paths) => {
      expect(() => readAggregate(paths["aws-quick"], "responses.jsonl")).toThrow(
        "FORBIDDEN_INPUT_NAME",
      );
      expect(() => readAggregate(paths["aws-quick"], "../environment.json")).toThrow(
        "FORBIDDEN_INPUT_NAME",
      );
    }));
  test("symlink escape cannot expand aggregate readers", () =>
    onDisk((paths, root) => {
      const victim = join(paths["aws-quick"], "hot_wallet-prometheus.json");
      rmSync(victim);
      const outside = join(root, "outside.json");
      writeFileSync(outside, "{}");
      symlinkSync(outside, victim);
      expect(() => buildReport(paths)).toThrow("INPUT_SYMLINK_REFUSED");
    }));
  test("mixed hash on missing-core full rejects before any output", () =>
    onDisk((paths, root) => {
      const file = join(paths["aws-full-1"], "environment.json"),
        environment = JSON.parse(readFileSync(file, "utf8"));
      environment.loadSourceSha256 = "f".repeat(64);
      writeFileSync(file, JSON.stringify(environment));
      const output = join(root, "new-report");
      expect(() => writeReport(paths, output)).toThrow("MIXED_LOAD_SOURCE_HASH");
      expect(existsSync(output)).toBe(false);
    }));
  test("standalone output has no raw labels, input paths or active external content", () =>
    onDisk((paths, root) => {
      const output = join(root, "rendered");
      writeReport(paths, output);
      const html = readFileSync(join(output, "index.html"), "utf8"),
        svg = readFileSync(join(output, "overview.svg"), "utf8");
      expect(html).toContain("FULL aceito 0/2");
      for (const output of [html, svg]) {
        expect(output).not.toMatch(
          /Custo efetivo|custo por transação|custo indisponível|cleanup AWS|fechamento operacional|faturamento/i,
        );
      }
      expect(html).toContain("experiência REJEITADA");
      expect(html).toContain("wallet.balance == saldo reconstruído do ledger");
      expect(html).toContain("Contagem não exportada");
      expect(html).toContain("Reconciliação final dos eventos");
      expect(html).toContain("../verification.md");
      expect(html).not.toContain(root);
      expect(html).not.toContain("synthetic-replica");
      expect(html).not.toContain("synthetic-events.fifo");
      expectTrustedTheme(html);
      expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(svg).not.toContain("FORBIDDEN_SYNTHETIC_MARKER");
      for (const phase of PHASES.slice(0, 4)) {
        const series = readFileSync(join(output, `${phase}.svg`), "utf8");
        expect(series.match(/<svg\b/g)).toHaveLength(7);
        expect(series).toContain("loadSourceSha256");
        expect(series).toContain("QUICK AWS diagnóstica");
        expect(series).toContain("1970-01-01T00:");
        expect(series).not.toMatch(/<script|<iframe|(?:src|href)=["']https?:/i);
      }
      expect(() => writeReport(paths, output)).toThrow("OUTPUT_EXISTS");
    }));
  test("CLI rejects missing/duplicated/unknown args and overlapping canonical output", () =>
    onDisk((paths, root) => {
      expect(() => parseArgs([])).toThrow("MISSING_ARGUMENTS");
      expect(() => parseArgs(["--unknown", "value"])).toThrow("INVALID_ARGUMENTS");
      expect(() => parseArgs(["--aws-quick", "one", "--aws-quick", "two"])).toThrow(
        "INVALID_ARGUMENTS",
      );
      const args = [
        "--aws-quick",
        paths["aws-quick"],
        "--local-full",
        paths["local-full"],
        "--aws-full-1",
        paths["aws-full-1"],
        "--output-dir",
        join(root, "output"),
      ];
      expect(parseArgs(args).output).toBe(join(root, "output"));
      const link = join(root, "alias");
      symlinkSync(paths["aws-quick"], link);
      expect(() => parseArgs([...args.slice(0, -1), join(link, "output")])).toThrow(
        "OUTPUT_NOT_NEW_OR_OVERLAPS_INPUT",
      );
    }));
  test("absent Prometheus query stays a gap rather than an inferred zero", () =>
    onDisk((paths) => {
      const file = join(paths["aws-quick"], "hot_wallet-prometheus.json"),
        value = JSON.parse(readFileSync(file, "utf8"));
      delete value.outbox_published_per_second;
      writeFileSync(file, JSON.stringify(value));
      const report = buildReport(paths);
      expect(
        report.phases[0]!.charts.find((chart) => chart.title === "Publicação outbox")!.curves,
      ).toEqual([]);
      expect(reportHtml(report)).toContain("Série indisponível");
    }));
  test("negative nonnegative-series observation rejects before creating outputs", () =>
    onDisk((paths, root) => {
      const file = join(paths["aws-quick"], "hot_wallet-prometheus.json"),
        value = JSON.parse(readFileSync(file, "utf8"));
      value.outbox_lag_seconds.series[0].values[1][1] = "-0.01";
      writeFileSync(file, JSON.stringify(value));
      const output = join(root, "negative-rejected");
      expect(() => writeReport(paths, output)).toThrow("NEGATIVE_OBSERVATION");
      expect(existsSync(output)).toBe(false);
    }));
  test("final event barrier must cover the accepted financial outbox", () =>
    onDisk((paths) => {
      const resultPath = join(paths["aws-quick"], "result.json"),
        result = JSON.parse(readFileSync(resultPath, "utf8"));
      result.sqs.events.coverage.outbox = 4000;
      result.sqs.events.coverage.effects = 4000;
      writeFileSync(resultPath, JSON.stringify(result));
      writeFileSync(join(paths["aws-quick"], "sqs_backlog.json"), JSON.stringify(result.sqs));
      expect(() => buildReport(paths)).toThrow("FINAL_EVENT_COVERAGE_MISMATCH");
    }));
  test("processing p50 p95 p99 preserve nine replica curves, milliseconds and NaN gaps", () =>
    onDisk((paths) => {
      const file = join(paths["aws-quick"], "hot_wallet-prometheus.json"),
        value = JSON.parse(readFileSync(file, "utf8"));
      for (const [index, quantile] of ["p50", "p95", "p99"].entries()) {
        const series = [1, 2, 3].map((replica) => ({
          metric: { role: "api", instance: `synthetic-replica-${replica}`, channel: "http" },
          values: [
            [2, "NaN"],
            [7, String((index * 3 + replica) / 1000)],
            [12, "NaN"],
          ],
        }));
        value[`processing_${quantile}_seconds`] = {
          series: index === 1 ? series.reverse() : series,
        };
      }
      writeFileSync(file, JSON.stringify(value));
      const chart = buildReport(paths).phases[0]!.charts.find((chart) =>
        chart.title.startsWith("Processamento"),
      )!;
      expect(chart.curves).toHaveLength(9);
      const sorted = [...chart.curves].sort((a, b) => a.label.localeCompare(b.label));
      expect(sorted.map((curve) => curve.points[1]!.value)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(
        sorted.every((curve) => curve.points[0]!.value === null && curve.points[2]!.value === null),
      ).toBe(true);
      expect(new Set(chart.curves.map((curve) => curve.label)).size).toBe(9);
      expect(chart.note).toContain("distintos dos quantis HTTP k6");
    }));
});
describe("missing observations and safe labels", () => {
  test("nonfinite and absent numbers are gaps", () => {
    expect(["NaN", "+Inf", "-Inf", "", null, undefined].map(metricNumber)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(metricNumber("0")).toBe(0);
  });
  test("a chart cannot shift its zero baseline to admit negative observations", () => {
    expect(() =>
      lineChart("synthetic", "s", [{ label: "synthetic", points: [{ at: 0, value: -1 }] }], 0, 1),
    ).toThrow("NEGATIVE_OR_INVALID_CHART_OBSERVATION");
  });
  test("strict first thirty seconds exclusion gives no quick samples", () => {
    expect(
      afterWarmup(
        [0, 5, 10, 15, 20].map((at) => ({ at, value: 1 })),
        0,
      ),
    ).toEqual([]);
    expect(
      afterWarmup(
        [
          { at: 29.999, value: 1 },
          { at: 30, value: 2 },
        ],
        0,
      ),
    ).toEqual([{ at: 30, value: 2 }]);
  });
  test("rates sum only aligned samples", () => {
    expect(
      align(
        [
          [
            { at: 0, value: 1 },
            { at: 5, value: 2 },
          ],
          [{ at: 0, value: 3 }],
        ],
        "sum",
      ),
    ).toEqual([
      { at: 0, value: 4 },
      { at: 5, value: null },
    ]);
  });
  test("replicated gauges use max and preserve NaN gaps", () => {
    expect(
      align(
        [
          [
            { at: 0, value: 2 },
            { at: 5, value: null },
          ],
          [
            { at: 0, value: 7 },
            { at: 5, value: 3 },
          ],
        ],
        "max",
      ),
    ).toEqual([
      { at: 0, value: 7 },
      { at: 5, value: null },
    ]);
  });
  test("missing baseline and reset cannot become zero delta", () => {
    expect(counterDelta({}, { consumer: 1000 })).toBeNull();
    expect(counterDelta({ worker: 4 }, { worker: 3 })).toBeNull();
    expect(counterDelta({ worker: 4 }, { worker: 8 })).toBe(4);
  });
  test("labels and embedded JSON cannot break out into executable HTML", () => {
    expect(escapeHtml("<svg onload='x'>&")).toBe("&lt;svg onload=&#39;x&#39;&gt;&amp;");
    expect(inlineJson({ label: "</script><script>synthetic</script>" })).not.toContain("<");
  });
});
