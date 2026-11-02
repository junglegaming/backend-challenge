// Offline, aggregate-only FULL campaign views. No application, SDK or load-runner imports.
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { docsThemeCsp, docsThemeScript, docsThemeStyles, renderDocsTopbar } from "./docs-theme";
import {
  ALLOWED_FILES,
  canonical,
  combined,
  counterView,
  escapeHtml,
  financial,
  integer,
  lineChart,
  nonnegative,
  object,
  PHASES,
  queues,
  readAggregate,
} from "./render-load-report";

type Curve = { label: string; points: { at: number; value: number | null }[] };
type Phase = {
  name: string;
  start: number;
  end: number;
  requests: number;
  rate: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  httpErrorRate: number | null;
  dropped: number | null;
  unique: number;
  outboxDrainMs: number;
  eventDrainMs: number | null;
  counters: Record<string, { before: number; after: number; delta: number | null }>;
  charts: Record<string, Curve[]>;
};
type Run = {
  id: string;
  startedAt: number;
  completedAt: number;
  environment: Record<string, number>;
  stages: number[];
  stageSeconds: number;
  maxVUs: number;
  financial: Record<string, number>;
  remoteInboxes: Record<string, number> | null;
  sqs: {
    count: number;
    groups: number;
    start: number;
    end: number;
    enqueueMs: number;
    drainMs: number;
    peak: number;
    outboxDrainMs: number;
    eventDrainMs: number | null;
    charts: Curve[];
  };
  phases: Phase[];
  files: { name: string; sha256: string }[];
};
export type Campaign = {
  schema: "wagering-load-campaign/v1";
  target: "local" | "aws";
  sourceCommit: string;
  loadSourceSha256: string;
  runs: Run[];
};
const NAMES: Record<string, string> = {
  hot_wallet: "Carteira disputada",
  distributed_wallets: "Carteiras distribuídas",
  replays: "Replays",
  hot_plus_distributed: "Disputada + distribuídas",
};
const CHARTS: Record<string, [string, string]> = {
  committed: ["Commits financeiros", "transações/s"],
  lag: ["Lag da outbox", "s"],
  errors: ["Erro de processamento · máximo por réplica", "fração"],
  conflicts: ["Conflitos de lock · soma alinhada", "conflitos/30s"],
  queues: ["Profundidade SQS · máximo entre coletores", "mensagens"],
};
const FINANCIAL = [
  "wallets",
  "transactions",
  "processed",
  "entries",
  "outbox",
  "unpublished",
  "inbox",
  "unfinished_inbox",
  "duplicate_effects",
] as const;
const ENVIRONMENT = [
  "apiReplicas",
  "consumerReplicas",
  "workerReplicas",
  "runnerCpus",
  "runnerMemoryBytes",
  "consumerConcurrency",
  "databasePoolMax",
  "postgresMaxConnections",
  "lockTimeoutMs",
  "visibilityTimeoutSeconds",
  "waitTimeSeconds",
  "maxReceiveCount",
  "outboxLeaseMs",
] as const;
function fail(code: string): never {
  throw new Error(code);
}
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : fail("INVALID_CAMPAIGN_ARRAY");
const nullable = (value: unknown): number | null =>
  value === undefined || value === null ? null : nonnegative(value);
const requireEqual = (a: unknown, b: unknown, code: string) => {
  if (a !== b) fail(code);
};
const countRecord = (input: unknown, keys: readonly string[]): Record<string, number> => {
  const source = object(input);
  return Object.fromEntries(keys.map((key) => [key, integer(source[key])]));
};
function eventDrain(input: unknown): number | null {
  if (input === undefined || input === null) return null;
  const event = object(input),
    coverage = object(event.coverage);
  requireEqual(event.activeHandlers, 0, "EVENT_HANDLER_STILL_ACTIVE");
  for (const key of ["missing", "extra", "invalid_inbox"])
    requireEqual(coverage[key], 0, "FAILED_EVENT_COVERAGE");
  requireEqual(integer(coverage.outbox), integer(coverage.effects), "EVENT_EFFECT_COUNT_MISMATCH");
  return nonnegative(event.elapsedMs);
}
function values(summary: unknown, name: string): Record<string, unknown> | undefined {
  const metric = object(object(summary).metrics)[name];
  return metric === undefined ? undefined : object(object(metric).values);
}
function assertCampaign(campaign: Campaign): void {
  if (
    !/^[a-f0-9]{40}$/.test(campaign.sourceCommit) ||
    !/^[a-f0-9]{64}$/.test(campaign.loadSourceSha256)
  )
    fail("INVALID_CAMPAIGN_IDENTITY");
  if (
    !campaign.runs.length ||
    campaign.runs.length > 8 ||
    new Set(campaign.runs.map((run) => run.id)).size !== campaign.runs.length
  )
    fail("INVALID_CAMPAIGN_RUNS");
  for (const run of campaign.runs) {
    if (!/^\d{4}-\d{2}-\d{2}T[\dTZ.-]+-[a-f0-9]{8}$/.test(run.id)) fail("INVALID_CAMPAIGN_RUN_ID");
    if (run.completedAt <= run.startedAt || run.phases.length !== 4)
      fail("INVALID_CAMPAIGN_WINDOW");
    requireEqual(canonical(run.stages), "[25,100,250,500]", "INCOMPARABLE_CAMPAIGN_GENERATOR");
    requireEqual(run.stageSeconds, 30, "INCOMPARABLE_CAMPAIGN_GENERATOR");
    requireEqual(run.maxVUs, 300, "INCOMPARABLE_CAMPAIGN_GENERATOR");
    if (campaign.target === "aws" && run.sqs.eventDrainMs === null)
      fail("MISSING_REMOTE_EVENT_PROOF");
    let previous = run.startedAt;
    for (const [index, phase] of run.phases.entries()) {
      if (
        phase.name !== PHASES[index] ||
        phase.start < previous ||
        phase.end <= phase.start ||
        phase.end > run.completedAt
      )
        fail("INVALID_CAMPAIGN_PHASE_WINDOW");
      if (campaign.target === "aws" && phase.eventDrainMs === null)
        fail("MISSING_REMOTE_EVENT_PROOF");
      if (phase.httpErrorRate !== null && phase.httpErrorRate !== 0) fail("FAILED_HTTP_REQUESTS");
      previous = phase.end;
    }
    const proof = {
      ...run.financial,
      ...(run.remoteInboxes ? { remoteInboxes: run.remoteInboxes } : {}),
    };
    financial(
      proof,
      { transactions: run.financial.transactions, dlq: 0, sqs: { count: run.sqs.count } },
      campaign.target === "aws",
    );
  }
}

/** Each run is admitted independently, then the complete campaign must share source and load hash. */
export function buildCampaign(target: "local" | "aws", roots: string[]): Campaign {
  if (target !== "local" && target !== "aws") fail("INVALID_CAMPAIGN_TARGET");
  if (
    !roots.length ||
    roots.length > 8 ||
    new Set(roots.map((root) => realpathSync(root))).size !== roots.length
  )
    fail("INVALID_CAMPAIGN_INPUTS");
  let sourceCommit = "",
    loadSourceSha256 = "";
  const runs = roots.map((root) => {
    const files: Run["files"] = [];
    const read = (name: string) => {
      const file = readAggregate(root, name)!;
      files.push({ name, sha256: file.sha256 });
      return file.value;
    };
    const environment = object(read("environment.json")),
      result = object(read("result.json")),
      proof = object(read("verification.json"));
    requireEqual(environment.profile, "full", "CAMPAIGN_REQUIRES_FULL");
    requireEqual(environment.workingTreeDirty, false, "CAMPAIGN_REQUIRES_CLEAN_SOURCE");
    // Historical Compose manifests predate target/scenario fields. Absence is explicit, never rewritten as current instrumentation.
    if (target === "aws" || environment.target !== undefined)
      requireEqual(
        environment.target,
        target === "aws" ? "remote" : "compose",
        "CAMPAIGN_TARGET_MISMATCH",
      );
    if (environment.scenario !== undefined)
      requireEqual(environment.scenario, "standard", "INCOMPARABLE_SCENARIO");
    if (typeof environment.gitHead !== "string" || typeof environment.loadSourceSha256 !== "string")
      fail("MISSING_CAMPAIGN_IDENTITY");
    if (!sourceCommit) {
      sourceCommit = environment.gitHead;
      loadSourceSha256 = environment.loadSourceSha256;
    }
    requireEqual(environment.gitHead, sourceCommit, "MIXED_SOURCE_COMMIT");
    requireEqual(environment.loadSourceSha256, loadSourceSha256, "MIXED_LOAD_SOURCE_HASH");
    requireEqual(result.runId, environment.runId, "RUN_ID_MISMATCH");
    requireEqual(proof.runId, environment.runId, "VERIFICATION_RUN_ID_MISMATCH");
    requireEqual(result.profile, "full", "CAMPAIGN_REQUIRES_FULL");
    requireEqual(result.passed, true, "FAILED_CAMPAIGN_RESULT");
    requireEqual(proof.passed, true, "FAILED_CAMPAIGN_VERIFICATION");
    requireEqual(proof.partial, false, "PARTIAL_CAMPAIGN_VERIFICATION");
    requireEqual(
      canonical(result.verification),
      canonical(proof),
      "EMBEDDED_VERIFICATION_MISMATCH",
    );
    financial(proof, result, target === "aws");
    if (target === "aws") {
      const finalEvents = object(result.sqs).events;
      if (eventDrain(finalEvents) === null) fail("MISSING_REMOTE_EVENT_PROOF");
      requireEqual(
        object(object(finalEvents).coverage).outbox,
        proof.outbox,
        "FINAL_EVENT_COVERAGE_MISMATCH",
      );
    }
    const generator = object(environment.generator),
      topology = object(environment.topology),
      operational = object(environment.operational),
      docker = object(environment.docker);
    const env = {
      apiReplicas: integer(topology.api),
      consumerReplicas: integer(topology.consumer),
      workerReplicas: integer(topology.worker),
      runnerCpus: integer(docker.cpus),
      runnerMemoryBytes: integer(docker.memoryBytes),
      consumerConcurrency: integer(operational.consumerConcurrency),
      databasePoolMax: integer(operational.poolMaxPerProcess),
      postgresMaxConnections: integer(operational.postgresMaxConnections),
      lockTimeoutMs: integer(operational.lockTimeoutMs),
      visibilityTimeoutSeconds: integer(operational.visibilitySeconds),
      waitTimeSeconds: integer(operational.waitSeconds),
      maxReceiveCount: integer(operational.maxReceives),
      outboxLeaseMs: integer(operational.outboxLeaseMs),
    };
    const phases = array(result.phases).map((raw, index): Phase => {
      const phase = object(raw),
        name = PHASES[index];
      if (!name || index > 3 || phase.phase !== name) fail("INVALID_CAMPAIGN_PHASE");
      const summary = read(`${name}.json`),
        counters = counterView(read(`${name}-counters.json`)),
        prom = read(`${name}-prometheus.json`);
      requireEqual(values(summary, "checks")?.rate, 1, "FAILED_HTTP_CHECKS");
      requireEqual(values(summary, "unexpected_status")?.rate, 0, "UNEXPECTED_HTTP_STATUS");
      const httpErrorRate = nullable(values(summary, "http_req_failed")?.rate);
      if (httpErrorRate !== null && httpErrorRate !== 0) fail("FAILED_HTTP_REQUESTS");
      const duration = values(summary, "http_req_duration");
      const drain = eventDrain(phase.events);
      if (target === "aws" && drain === null) fail("MISSING_REMOTE_EVENT_PROOF");
      return {
        name,
        start: integer(phase.startedAt),
        end: integer(phase.endedAt),
        requests: integer(values(summary, "iterations")?.count),
        rate: nonnegative(values(summary, "iterations")?.rate),
        p50: nullable(duration?.med),
        p95: nullable(duration?.["p(95)"]),
        p99: nullable(duration?.["p(99)"]),
        httpErrorRate,
        dropped: nullable(values(summary, "dropped_iterations")?.count),
        unique: integer(phase.uniqueCommands),
        outboxDrainMs: nonnegative(phase.outboxDrainMs),
        eventDrainMs: drain,
        counters,
        charts: {
          committed: combined(prom, "committed_per_second", "sum"),
          lag: combined(prom, "outbox_lag_seconds", "max"),
          errors: combined(prom, "processing_error_rate", "max"),
          conflicts: combined(prom, "lock_conflicts", "sum"),
          queues: queues(prom),
        },
      };
    });
    const sqs = object(read("sqs_backlog.json"));
    requireEqual(canonical(sqs), canonical(result.sqs), "SQS_AGGREGATE_MISMATCH");
    const sqsEvents = eventDrain(sqs.events);
    if (target === "aws" && sqsEvents === null) fail("MISSING_REMOTE_EVENT_PROOF");
    return {
      id: String(environment.runId),
      startedAt: integer(result.startedAt),
      completedAt: integer(result.completedAt),
      environment: env,
      stages: array(generator.stages).map(integer),
      stageSeconds: nonnegative(generator.stageSeconds),
      maxVUs: integer(generator.maxVUsPerWorkload),
      financial: countRecord(proof, FINANCIAL),
      remoteInboxes:
        target === "aws"
          ? countRecord(proof.remoteInboxes, ["total", "requests", "events", "unknown"])
          : null,
      sqs: {
        count: integer(sqs.count),
        groups: integer(sqs.groups),
        start: integer(sqs.startedAt),
        end: integer(sqs.completedAt),
        enqueueMs: integer(sqs.enqueuedAt) - integer(sqs.startedAt),
        drainMs: nonnegative(sqs.drainAfterEnqueueMs),
        peak: integer(sqs.sampledBacklogPeak),
        outboxDrainMs: nonnegative(sqs.outboxDrainMs),
        eventDrainMs: sqsEvents,
        charts: queues(read("sqs_backlog-prometheus.json")),
      },
      phases,
      files,
    };
  });
  const campaign: Campaign = {
    schema: "wagering-load-campaign/v1",
    target,
    sourceCommit,
    loadSourceSha256,
    runs,
  };
  assertCampaign(campaign);
  return campaign;
}

/** Closed projection reader: unknown fields are discarded, never copied to delivered artifacts. */
export function campaignData(input: unknown): Campaign {
  const data = object(input);
  requireEqual(data.schema, "wagering-load-campaign/v1", "UNSUPPORTED_CAMPAIGN_SCHEMA");
  if (data.target !== "local" && data.target !== "aws") fail("INVALID_CAMPAIGN_TARGET");
  const curves = (input: unknown): Curve[] =>
    array(input).map((raw) => {
      const curve = object(raw);
      if (typeof curve.label !== "string" || curve.label.length > 100) fail("INVALID_CURVE_LABEL");
      return {
        label: curve.label,
        points: array(curve.points).map((raw) => {
          const point = object(raw);
          return { at: nonnegative(point.at), value: nullable(point.value) };
        }),
      };
    });
  const campaign: Campaign = {
    schema: "wagering-load-campaign/v1",
    target: data.target,
    sourceCommit: String(data.sourceCommit),
    loadSourceSha256: String(data.loadSourceSha256),
    runs: array(data.runs).map((raw) => {
      const run = object(raw),
        sqs = object(run.sqs);
      return {
        id: String(run.id),
        startedAt: integer(run.startedAt),
        completedAt: integer(run.completedAt),
        environment: countRecord(run.environment, ENVIRONMENT),
        stages: array(run.stages).map(integer),
        stageSeconds: nonnegative(run.stageSeconds),
        maxVUs: integer(run.maxVUs),
        financial: countRecord(run.financial, FINANCIAL),
        remoteInboxes:
          run.remoteInboxes === null
            ? null
            : countRecord(run.remoteInboxes, ["total", "requests", "events", "unknown"]),
        sqs: {
          count: integer(sqs.count),
          groups: integer(sqs.groups),
          start: integer(sqs.start),
          end: integer(sqs.end),
          enqueueMs: nonnegative(sqs.enqueueMs),
          drainMs: nonnegative(sqs.drainMs),
          peak: integer(sqs.peak),
          outboxDrainMs: nonnegative(sqs.outboxDrainMs),
          eventDrainMs: nullable(sqs.eventDrainMs),
          charts: curves(sqs.charts),
        },
        phases: array(run.phases).map((raw) => {
          const phase = object(raw),
            counters = object(phase.counters),
            charts = object(phase.charts);
          return {
            name: String(phase.name),
            start: integer(phase.start),
            end: integer(phase.end),
            requests: integer(phase.requests),
            rate: nonnegative(phase.rate),
            p50: nullable(phase.p50),
            p95: nullable(phase.p95),
            p99: nullable(phase.p99),
            httpErrorRate: nullable(phase.httpErrorRate),
            dropped: nullable(phase.dropped),
            unique: integer(phase.unique),
            outboxDrainMs: nonnegative(phase.outboxDrainMs),
            eventDrainMs: nullable(phase.eventDrainMs),
            counters: Object.fromEntries(
              ["api", "consumer", "worker"].map((role) => {
                const record = object(counters[role]);
                return [
                  role,
                  {
                    before: integer(record.before),
                    after: integer(record.after),
                    delta: nullable(record.delta),
                  },
                ];
              }),
            ),
            charts: Object.fromEntries(
              Object.keys(CHARTS).map((key) => [key, curves(charts[key])]),
            ),
          };
        }),
        files: array(run.files).map((raw) => {
          const file = object(raw);
          if (
            !(ALLOWED_FILES as readonly unknown[]).includes(file.name) ||
            typeof file.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(file.sha256)
          )
            fail("INVALID_CAMPAIGN_PROVENANCE");
          return { name: String(file.name), sha256: file.sha256 };
        }),
      };
    }),
  };
  assertCampaign(campaign);
  return campaign;
}

const n = (value: number | null, digits = 2): string =>
  value === null
    ? "UNKNOWN"
    : new Intl.NumberFormat("pt-BR", { maximumFractionDigits: digits }).format(value);
const text = escapeHtml;
const table = (headers: string[], rows: string[][]): string =>
  `<div class="scroll"><table><thead><tr>${headers.map((value) => `<th>${text(value)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${text(value)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
function environmentTable(run: Run): string {
  const env = run.environment;
  return table(
    ["Configuração registrada nesta rodada", "Valor"],
    [
      [
        "Topologia",
        `${n(env.apiReplicas!, 0)} API · ${n(env.consumerReplicas!, 0)} consumers · ${n(env.workerReplicas!, 0)} workers`,
      ],
      [
        "Runner · capacidade do daemon",
        `${n(env.runnerCpus!, 0)} CPUs · ${n(env.runnerMemoryBytes! / 1024 ** 3)} GiB RAM`,
      ],
      [
        "Consumer / pool por processo",
        `${n(env.consumerConcurrency!, 0)} concorrentes / ${n(env.databasePoolMax!, 0)} conexões`,
      ],
      [
        "PostgreSQL",
        `max_connections ${n(env.postgresMaxConnections!, 0)} · lock_timeout ${n(env.lockTimeoutMs!)} ms`,
      ],
      [
        "SQS",
        `visibility ${n(env.visibilityTimeoutSeconds!)} s · long polling ${n(env.waitTimeSeconds!)} s · maxReceiveCount ${n(env.maxReceiveCount!, 0)}`,
      ],
      ["Lease da outbox", `${n(env.outboxLeaseMs!)} ms`],
      [
        "Geração por workload",
        `${run.stages.map((value) => n(value, 0)).join(" → ")} req/s · ${n(run.stageSeconds)} s/estágio · até ${n(run.maxVUs, 0)} VUs · duas rampas na fase mista`,
      ],
    ],
  );
}
function bars(run: Run, kind: "latency" | "throughput"): string {
  const latency = kind === "latency",
    title = latency ? "Latência HTTP observada" : "Vazão HTTP observada";
  const series = latency ? (["p50", "p95", "p99"] as const) : (["rate"] as const);
  const maximum = Math.max(
    1,
    ...run.phases.flatMap((phase) => series.map((key) => phase[key] ?? 0)),
  );
  let body = `<title>${title}</title><rect width="760" height="340" fill="var(--chart-paper,#fff)"/><text x="28" y="34" font-size="20" font-weight="700">${title}</text><text x="28" y="58" font-size="12">${latency ? "Percentis do k6 · ms · cada fase tem sua própria população" : "Iterações de negócio/s · taxa do resumo k6"}</text>`;
  const colors = ["#087f8c", "#db6e25", "#7959ac"];
  run.phases.forEach((phase, index) => {
    const y = 80 + index * 56;
    body += `<text x="28" y="${y + 16}" font-size="12">${text(NAMES[phase.name]!)}</text>`;
    series.forEach((key, si) => {
      const value = phase[key],
        yy = y + si * 13;
      if (value !== null)
        body += `<rect x="212" y="${yy}" width="${(value / maximum) * 385}" height="10" rx="2" fill="${colors[si]}"/><text x="${Math.max(220, 220 + (value / maximum) * 385)}" y="${yy + 9}" font-size="11">${n(value)}${latency ? ` (${key})` : " req/s"}</text>`;
    });
  });
  body += `<text x="28" y="325" font-size="12">${latency ? "Percentis por fase não são somados nem calculados por média entre réplicas." : "Oferta: 25 → 100 → 250 → 500 req/s por workload. Fase mista: duas rampas."}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 340" role="img" aria-label="${title}" style="font-family:system-ui,sans-serif;fill:var(--chart-ink,#18313f)">${body}</svg>`;
}
export function campaignHtml(campaign: Campaign): string {
  const local = campaign.target === "local",
    historicalLocal =
      local &&
      campaign.sourceCommit === "06e6165cb8611ec650dfc4ec947c6d4513da92cf" &&
      campaign.loadSourceSha256 ===
        "c99c4ac6e9f568ae3a718b9e0bff973b3a143a355875fbe85e9d4a420e4dd9de" &&
      campaign.runs.every((run) =>
        [
          "2026-11-01T09-08-31-505Z-33137235",
          "2026-11-01T09-48-21-364Z-684a5de9",
          "2026-11-01T10-28-36-009Z-160b3ad6",
        ].includes(run.id),
      ),
    full3 =
      !local &&
      campaign.sourceCommit === "d52abedad905f02c03c5a10ba5f16598271ef888" &&
      campaign.loadSourceSha256 ===
        "0d029aecc50c418ba0c6e9154b08d0310911f08399928c2068c5bf5ea4628f5e" &&
      campaign.runs.length === 1 &&
      campaign.runs[0]?.id === "2026-11-02T16-38-47-783Z-354c2da7",
    title = local
      ? `Carga local · ${campaign.runs.length === 3 ? "três" : campaign.runs.length} FULL ${historicalLocal ? (campaign.runs.length > 1 ? "históricos" : "histórico") : campaign.runs.length > 1 ? "aprovados" : "aprovado"}`
      : full3
        ? "AWS · FULL3 aprovado"
        : campaign.runs.length === 1
          ? "AWS · FULL aprovado"
          : `AWS · ${campaign.runs.length} FULL aprovados`;
  const darkCss =
    ":root{--paper:#101c23;--panel:#172730;--ink:#e5eff3;--muted:#a5bac6;--line:#314b59;--accent:#68cbd1;--chart-paper:#172730;--chart-ink:#e5eff3;--chart-muted:#a5bac6;--chart-grid:#314b59}";
  const css = `:root{color-scheme:light dark;--paper:#f4f7f8;--panel:#fff;--ink:#18313f;--muted:#526774;--line:#d6e1e6;--accent:#087f8c;--chart-bg:var(--panel);--chart-text:var(--ink);--chart-paper:#fff;--chart-ink:#18313f;--chart-muted:#526774;--chart-grid:#d6e1e6}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 system-ui,sans-serif}main{max-width:1260px;margin:auto;padding:36px 24px}a{color:var(--accent);text-underline-offset:3px}.eyebrow{font-size:12px;letter-spacing:.15em;text-transform:uppercase;font-weight:800;color:var(--accent)}h1{font-size:clamp(32px,5vw,52px);line-height:1.12;margin:18px 0}h2{font-size:27px;margin-top:0}h3{font-size:20px}.lead{max-width:900px;font-size:19px;color:var(--muted)}section,.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:24px;margin:24px 0}.notice{border-left:5px solid #db6e25}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px}.cards .card{margin:0;padding:18px}.value{font-size:29px;font-weight:800}.label{font-size:13px;color:var(--muted)}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:14px}th,td{padding:11px 13px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}th{background:var(--paper)}code,pre{font:13px/1.6 ui-monospace,monospace;overflow-wrap:anywhere}pre{background:var(--paper);padding:18px;white-space:pre-wrap}.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,480px),1fr));gap:18px}.chart{min-width:0}.chart svg{display:block;width:100%;height:auto}.charts .chart p{font-size:13px;color:var(--muted)}summary{cursor:pointer;font-weight:700;padding:12px 0}details{border-top:1px solid var(--line);margin-top:18px}.subtle{color:var(--muted);font-size:14px}.badge{display:inline-block;padding:5px 10px;border-radius:30px;background:#d9f0ec;color:#09594d;font-size:12px;font-weight:800}nav{display:flex;gap:18px;flex-wrap:wrap}.hashes td{font-family:ui-monospace,monospace;font-size:11px}.run{scroll-margin-top:20px}footer{padding:24px 0;color:var(--muted);font-size:13px}@media(max-width:600px){main{padding:24px 14px}section{padding:18px}h2{font-size:23px}}`;
  const identity = `${text(campaign.sourceCommit.slice(0, 7))}/${text(campaign.loadSourceSha256.slice(0, 8))}`;
  const intro = local
    ? `${campaign.runs.length} ${campaign.runs.length === 1 ? "execução completa aprovada" : "execuções completas aprovadas"} na coorte ${identity}. Os instrumentos pertencem a esta coorte. Estes resultados não medem automaticamente o desempenho de outra fonte.`
    : `${campaign.runs.length} ${campaign.runs.length === 1 ? "execução completa aprovada" : "execuções completas aprovadas"} na coorte ${identity}. O verificador financeiro e a cobertura persistida de eventos passaram; os descartes do gerador limitam a conclusão de capacidade.`;
  let html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; ${docsThemeCsp}"><title>${title} · Wagering Processor</title><style>${css}${docsThemeStyles}</style><style data-docs-dark media="screen and (prefers-color-scheme: dark)">${darkCss}</style>${docsThemeScript}</head><body><main>${renderDocsTopbar("../../../")}<nav><a href="../index.html">← Todos os relatórios</a><a href="../../${local ? "load-test.md" : "load-test-aws.md"}">Método e evidências</a><a href="../../architecture.html">Arquitetura</a></nav><header><p class="eyebrow">Distributed Wagering Processor · evidência de carga</p><h1>${title}</h1><p class="lead">${intro}</p><span class="badge">${campaign.runs.length} FULL aprovado${campaign.runs.length > 1 ? "s" : ""} · prova final completa</span></header><section class="notice"><h2>O que esta evidência permite afirmar</h2><p>Os gates de cada execução admitida passaram e o verificador salvo reconciliou os efeitos financeiros com o ledger. O relatório lê agregados; não consulta PostgreSQL nem reconstrói o ledger novamente. Não há comparação quantitativa local × AWS: fontes, instrumentos, recursos e janelas são diferentes.</p><p>${historicalLocal ? "Estas rodadas locais são históricas. A cobertura de eventos de domínio e a participação por réplica não têm os mesmos instrumentos da campanha AWS final. A ausência de uma série não comprova zero." : full3 ? "Esta campanha possui uma única amostra AWS. Não existem três FULL AWS aprovados para medir variação. A alteração operacional do health check do ALB para /health/live precedeu esta rodada e não integra a identidade do bundle de aplicação; nenhuma melhora causal de performance é inferida." : "A evidência inclui somente as rodadas nominadas nesta página. Instrumentos ou metadados não registrados permanecem UNKNOWN. A ausência de uma série não comprova zero."}</p></section><section><h2>Identidade e ambiente</h2>${table(
    ["Campo", "Valor"],
    [
      ["Fonte da aplicação", campaign.sourceCommit],
      ["SHA-256 das fontes de carga", campaign.loadSourceSha256],
      [
        "Janela conjunta UTC",
        `${new Date(Math.min(...campaign.runs.map((run) => run.startedAt))).toISOString()} → ${new Date(Math.max(...campaign.runs.map((run) => run.completedAt))).toISOString()}`,
      ],
      ["Perfil e geração", "FULL · ramping-arrival-rate · parâmetros numéricos por rodada abaixo"],
      ["Topologia e configuração", "Valores registrados por rodada nas tabelas abaixo"],
      [
        "Runtime / ferramentas",
        historicalLocal || full3
          ? "Bun 1.4.3 · k6 2.3.0 · PostgreSQL 17"
          : "UNKNOWN · versões não fazem parte desta projeção numérica",
      ],
      [
        "Ambiente",
        historicalLocal
          ? "Docker Compose · MiniStack 1.5.28 · Prometheus · ingresso Nginx"
          : full3
            ? "us-east-2 · ECS/Fargate · SQS FIFO gerenciado · ALB interno · RDS PostgreSQL 17"
            : `${local ? "Compose" : "Remoto"} · serviços, versões e região: UNKNOWN nesta projeção`,
      ],
      [
        "Recursos",
        full3
          ? "API/consumer/worker: 1 vCPU e 2 GiB cada · RDS db.m7g.2xlarge, Single-AZ, gp3 100 GiB · runner c7i.2xlarge"
          : "CPU e memória do runner: valores por rodada abaixo. Recursos por serviço: UNKNOWN nesta projeção",
      ],
    ],
  )}<p class="subtle">A configuração numérica por rodada e as impressões SHA-256 dos arquivos admitidos estão na projeção <a href="campaign.json">campaign.json</a>. Os recursos AWS acima descrevem o ambiente registrado; não são métricas de utilização.</p><nav>${campaign.runs.map((run, index) => `<a href="#run-${index}">${local ? `Rodada ${String.fromCharCode(65 + index)}` : full3 ? "FULL3" : `FULL ${index + 1}`} · ${text(run.id.slice(11, 19))} UTC</a>`).join("")}</nav></section>`;
  for (const [index, run] of campaign.runs.entries()) {
    const requests = run.phases.reduce((sum, phase) => sum + phase.requests, 0),
      drops = run.phases.reduce((sum, phase) => sum + (phase.dropped ?? 0), 0),
      unknown = run.phases.filter((phase) => phase.dropped === null).length;
    html += `<section class="run" id="run-${index}"><p class="eyebrow">${local ? `Rodada ${historicalLocal ? "histórica " : ""}${String.fromCharCode(65 + index)}` : full3 ? "Último FULL AWS aceito" : `FULL AWS ${index + 1} aceito`}</p><h2>${text(run.id)}</h2><p class="subtle">${text(new Date(run.startedAt).toISOString())} → ${text(new Date(run.completedAt).toISOString())} · ${n((run.completedAt - run.startedAt) / 60000)} min de janela total, incluindo preparação e drenagem.</p>${environmentTable(run)}<div class="cards">${[
      ["Iterações HTTP", n(requests, 0)],
      ["Efeitos financeiros", n(run.financial.transactions!, 0)],
      ["Eventos na outbox", n(run.financial.outbox!, 0)],
      ["Descartes reportados", n(drops, 0) + (unknown ? " + UNKNOWN" : "")],
    ]
      .map(
        ([label, value]) =>
          `<div class="card"><div class="label">${label}</div><div class="value">${value}</div></div>`,
      )
      .join(
        "",
      )}</div><div class="charts"><div class="chart">${bars(run, "latency")}</div><div class="chart">${bars(run, "throughput")}</div></div>${table(
      ["Fase", "Iterações", "req/s", "p50 ms", "p95 ms", "p99 ms", "HTTP falho", "Descartes"],
      run.phases.map((phase) => [
        NAMES[phase.name]!,
        n(phase.requests, 0),
        n(phase.rate),
        n(phase.p50),
        n(phase.p95),
        n(phase.p99),
        phase.httpErrorRate === null ? "UNKNOWN" : `${n(100 * phase.httpErrorRate)}%`,
        n(phase.dropped, 0),
      ]),
    )}<p class="subtle">Vazão: iterations.count/rate do k6 (requisições de negócio). Latência: http_req_duration, que também pode incluir a requisição de preparação. Não é latência por evento. ${unknown ? `${unknown} fases não materializaram dropped_iterations: UNKNOWN, mesmo quando o runner gravou zero por fallback.` : "Todas as fases materializaram a contagem de descartes."} O total reportado soma somente observações presentes. Descartes são iterações não iniciadas e não entram no denominador das respostas HTTP.</p><p><strong>Capacidade:</strong> completar o FULL e passar os gates não demonstra sustentar 500 req/s. ${n(drops, 0)} descartes reportados e a separação entre taxa oferecida e vazão observada impedem essa conclusão.</p>`;
    for (const phase of run.phases)
      html += `<details><summary>${text(NAMES[phase.name]!)} · séries, janelas e drenagem</summary><p class="subtle">Janela HTTP ${new Date(phase.start).toISOString()} → ${new Date(phase.end).toISOString()}. O eixo começa no início desta fase, sem deslocamento ou suavização. Janelas rate() incluem seu histórico anterior; o gráfico exibe também os primeiros 30 s, sem reivindicar regime estável. NaN e timestamps ausentes são lacunas.</p><div class="charts">${Object.entries(
        CHARTS,
      )
        .map(
          ([key, [title, unit]]) =>
            `<div class="chart">${lineChart(title, unit, phase.charts[key]!, phase.start / 1000, phase.end / 1000)}</div>`,
        )
        .join("")}</div>${table(
        ["Papel", "Séries antes", "Séries depois", "Delta com baseline correspondente"],
        Object.entries(phase.counters).map(([role, counter]) => [
          role,
          n(counter.before, 0),
          n(counter.after, 0),
          n(counter.delta, 0),
        ]),
      )}<p class="subtle">Sem série de conflitos de lock significa UNKNOWN, não zero conflitos. Séries de contadores sem baseline correspondente não provam participação individual. Drenagem da outbox após HTTP: ${n(phase.outboxDrainMs)} ms. Barreira de eventos persistidos: ${n(phase.eventDrainMs)} ms${phase.eventDrainMs === null ? " (instrumento não disponível nesta rodada)" : ""}.</p></details>`;
    html += `<h3>Backlog SQS e drenagem</h3><div class="charts"><div class="chart">${lineChart(
      "Comandos SQS · observação durante o burst",
      "mensagens",
      run.sqs.charts.filter((curve) => curve.label.startsWith("Comandos")),
      run.sqs.start / 1000,
      run.sqs.end / 1000,
    )}</div><div class="chart">${lineChart(
      "Eventos SQS · observação durante o burst",
      "mensagens",
      run.sqs.charts.filter((curve) => curve.label.startsWith("Eventos")),
      run.sqs.start / 1000,
      run.sqs.end / 1000,
    )}</div></div>${table(
      ["Métrica", "Resultado"],
      [
        ["Comandos / grupos", `${n(run.sqs.count, 0)} / ${n(run.sqs.groups, 0)}`],
        ["Tempo de envio", `${n(run.sqs.enqueueMs)} ms`],
        ["Drenagem após o último envio", `${n(run.sqs.drainMs)} ms`],
        ["Pico de backlog amostrado", `${n(run.sqs.peak, 0)} mensagens`],
        ["Drenagem da outbox", `${n(run.sqs.outboxDrainMs)} ms`],
        [
          "Barreira persistida de eventos",
          run.sqs.eventDrainMs === null
            ? "UNKNOWN · instrumento ausente"
            : `${n(run.sqs.eventDrainMs)} ms`,
        ],
        ["DLQ final", "0"],
      ],
    )}<p class="subtle">Envio e consumo se sobrepõem. A drenagem após enqueue não mede latência individual nem capacidade sustentada. O pico é amostrado. Não se preenche uma curva SQS sem cobertura temporal suficiente.</p><h3>Oráculo financeiro final</h3>${table(
      ["Invariante verificado", "Resultado"],
      [
        ["Transações = processadas = entradas do ledger", n(run.financial.transactions!, 0)],
        ["Outbox = 2 × transações", n(run.financial.outbox!, 0)],
        ["Carteiras reconciliadas", n(run.financial.wallets!, 0)],
        ["Inbox de comandos SQS", n(run.financial.inbox!, 0)],
        ["Outbox não publicada / inbox incompleta / efeitos duplicados", "0 / 0 / 0"],
        ["Verificação parcial", "false"],
        ["Saldo = reconstrução do ledger e cadeia financeira", "PASS no verificador salvo"],
        ...(run.remoteInboxes
          ? [
              [
                "Inbox remota: comandos / eventos / desconhecidos",
                `${n(run.remoteInboxes.requests!, 0)} / ${n(run.remoteInboxes.events!, 0)} / ${n(run.remoteInboxes.unknown!, 0)}`,
              ],
              ["Eventos persistidos sem missing / extra / invalid", "PASS nas barreiras salvas"],
            ]
          : []),
      ],
    )}<details class="hashes"><summary>Proveniência · ${run.files.length} agregados lidos por nomes permitidos</summary>${table(
      ["Arquivo", "SHA-256 dos bytes originais"],
      run.files.map((file) => [file.name, file.sha256]),
    )}</details></section>`;
  }
  html += `<section><h2>Limites e reprodução offline</h2><p>Os gráficos não contêm CPU, memória consumida, I/O do RDS, ALB, custo ou latência por evento: essas métricas não pertencem aos agregados admitidos. Percentis por fase não são um percentil global da campanha. Métricas ausentes aparecem como UNKNOWN ou lacunas; nunca viram zero.</p><p>${historicalLocal ? "A execução QUICK local posterior, na fonte d52abed, passou com 3.251 efeitos financeiros e 6.502 eventos na outbox, segundo a evidência externa final de Task 13. Seu environment.json não registra gitHead; ela é um gate funcional associado externamente, sem ser uma quarta rodada FULL ou uma medição de desempenho comparável." : "Uma rodada aprovada demonstra esta execução e estes invariantes. O relatório não transforma retries de SQS em perda de comandos nem usa a ausência de erros HTTP para afirmar ausência de throttling interno."}</p><p>campaign.json é uma projeção fechada, versionada, com contagens, quantis, séries anônimas e impressões dos arquivos de origem. Não contém fixture, payload financeiro, ARN, endpoint, credencial ou identificação de réplica. Ela permite recriar este HTML sem os caches privados e sem iniciar serviços.</p><pre>BUN_CONFIG_NO_ENV_FILE=true BUN_CONFIG_NO_AUTO_INSTALL=true bun --no-env-file scripts/render-load-report.ts \
  --campaign-data docs/load-report/${campaign.target}/campaign.json \
  --output-dir /tmp/novo-relatorio-${campaign.target}</pre><p class="subtle">O destino precisa ser novo. Para recalcular a projeção a partir dos agregados originais, use --campaign ${campaign.target}, um ou mais --run DIR e --output-dir NOVO_DIR. Somente os nomes literais permitidos são abertos. Fontes diferentes, FULL parcial, gate financeiro falho ou prova remota incompleta são recusados antes da escrita.</p></section><footer>Documento offline · ${campaign.runs.length} FULL desta coorte · sem comparação entre ambientes · <a href="../historical/index.html">painel QUICK histórico a98d1e6</a></footer></main></body></html>`;
  return html;
}

export function writeCampaign(campaign: Campaign, output: string): void {
  const safe = campaignData(campaign),
    html = campaignHtml(safe);
  if (existsSync(output)) fail("OUTPUT_EXISTS");
  const destination = resolve(realpathSync(dirname(output)), basename(output));
  mkdirSync(destination, { mode: 0o755 });
  try {
    writeFileSync(resolve(destination, "index.html"), html, { flag: "wx", mode: 0o644 });
    writeFileSync(resolve(destination, "campaign.json"), JSON.stringify(safe) + "\n", {
      flag: "wx",
      mode: 0o644,
    });
  } catch {
    rmSync(destination, { recursive: true, force: true });
    fail("OUTPUT_WRITE_FAILED");
  }
}
function readProjection(path: string): unknown {
  if (basename(path) !== "campaign.json" || lstatSync(path).isSymbolicLink())
    fail("INVALID_PROJECTION_FILE");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) fail("INVALID_PROJECTION_FILE");
    return JSON.parse(readFileSync(fd).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}
export function runCampaignCli(args: string[]): void {
  try {
    const roots: string[] = [];
    let target: "local" | "aws" | undefined,
      projection: string | undefined,
      output: string | undefined;
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index],
        value = args[index + 1];
      if (!value || value.startsWith("--")) fail("INVALID_ARGUMENTS");
      if (key === "--run") roots.push(resolve(value));
      else if (key === "--campaign" && !target && (value === "local" || value === "aws"))
        target = value;
      else if (key === "--campaign-data" && !projection) projection = resolve(value);
      else if (key === "--output-dir" && !output) output = resolve(value);
      else fail("INVALID_ARGUMENTS");
    }
    if (!output || (projection ? target || roots.length : !target || !roots.length))
      fail("INVALID_ARGUMENTS");
    const destination = resolve(realpathSync(dirname(output)), basename(output));
    for (const source of [...roots, ...(projection ? [dirname(projection)] : [])]) {
      const canonicalSource = realpathSync(source),
        fromSource = relative(canonicalSource, destination),
        fromOutput = relative(destination, canonicalSource);
      if (
        (!fromSource.startsWith("..") && !fromSource.startsWith("/")) ||
        (!fromOutput.startsWith("..") && !fromOutput.startsWith("/"))
      )
        fail("OUTPUT_OVERLAPS_INPUT");
    }
    const campaign = projection
      ? campaignData(readProjection(projection))
      : buildCampaign(target!, roots);
    writeCampaign(campaign, output);
    console.log(
      JSON.stringify({
        status: "RENDERED_CAMPAIGN_AGGREGATES_ONLY",
        target: campaign.target,
        fullAccepted: campaign.runs.length,
      }),
    );
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : "CAMPAIGN_RENDER_FAILED";
    console.error(JSON.stringify({ status: "REJECTED", code }));
    process.exitCode = 1;
  }
}
