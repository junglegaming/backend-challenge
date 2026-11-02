// Aggregate-only, offline load report. Never imports application/load entrypoints.
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
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { docsThemeCsp, docsThemeScript, docsThemeStyles, renderDocsTopbar } from "./docs-theme";
export const PHASES = [
  "hot_wallet",
  "distributed_wallets",
  "replays",
  "hot_plus_distributed",
  "sqs_backlog",
] as const;
export const ALLOWED_FILES = [
  "environment.json",
  "result.json",
  "verification.json",
  ...PHASES.flatMap((phase) => [
    `${phase}.json`,
    `${phase}-counters.json`,
    `${phase}-prometheus.json`,
  ]),
] as const;
export type JsonObject = Record<string, unknown>;
export type InputKey = "aws-quick" | "local-full" | "aws-full-1";
export type AggregateInput = {
  key: InputKey;
  environment: unknown;
  result?: unknown;
  verification?: unknown;
};
export type CohortIdentity = { sourceCommit: string; loadSourceSha256: string };
export type Exclusion = { key: InputKey; profile: "quick" | "full"; reasons: string[] };
export type Accepted = {
  key: InputKey;
  profile: "quick" | "full";
  target: "compose" | "remote";
  environment: JsonObject;
  result: JsonObject;
  verification: JsonObject;
};

export function object(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_OBJECT");
  return value as JsonObject;
}
export function nonnegative(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error("INVALID_NUMBER");
  return value;
}
export function integer(value: unknown): number {
  const number = nonnegative(value);
  if (!Number.isSafeInteger(number)) throw new Error("INVALID_INTEGER");
  return number;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
        .join(",") +
      "}"
    );
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  )
    throw new Error("INVALID_JSON");
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("INVALID_JSON_NUMBER");
  return JSON.stringify(value);
}
function equality(left: unknown, right: unknown, code: string): void {
  if (left !== right) throw new Error(code);
}
export function financial(verification: JsonObject, result: JsonObject, remote: boolean): void {
  for (const key of [
    "wallets",
    "transactions",
    "processed",
    "entries",
    "outbox",
    "unpublished",
    "inbox",
    "unfinished_inbox",
    "duplicate_effects",
  ])
    integer(verification[key]);
  equality(verification.transactions, verification.processed, "TRANSACTION_PROCESSING_MISMATCH");
  equality(verification.transactions, verification.entries, "LEDGER_COUNT_MISMATCH");
  equality(verification.outbox, 2 * integer(verification.transactions), "OUTBOX_COUNT_MISMATCH");
  equality(result.transactions, verification.transactions, "RESULT_COUNT_MISMATCH");
  for (const key of ["unpublished", "unfinished_inbox", "duplicate_effects"])
    equality(verification[key], 0, "FAILED_FINANCIAL_GATE");
  equality(result.dlq, 0, "FAILED_DLQ_GATE");
  const sqs = object(result.sqs);
  equality(integer(sqs.count), verification.inbox, "SQS_INBOX_MISMATCH");
  if (remote) {
    const inbox = object(verification.remoteInboxes);
    for (const key of ["total", "requests", "events", "unknown"]) integer(inbox[key]);
    equality(inbox.unknown, 0, "UNKNOWN_INBOX_CLASS");
    equality(
      inbox.total,
      integer(inbox.requests) + integer(inbox.events),
      "INBOX_PARTITION_MISMATCH",
    );
    equality(inbox.requests, verification.inbox, "REQUEST_INBOX_MISMATCH");
    equality(inbox.events, verification.outbox, "EVENT_COVERAGE_MISMATCH");
  }
}

// Validate every supplied environment before classifying missing/failed core files.
// A failed run from a different hash cannot silently disappear into exclusions.
export function validateCohort(
  inputs: AggregateInput[],
  expected: CohortIdentity,
): {
  accepted: Accepted[];
  excluded: Exclusion[];
  nominated: number;
  full: { nominated: number; accepted: number };
  quick: { nominated: number; accepted: number };
} {
  if (
    !/^[a-f0-9]{40}$/.test(expected.sourceCommit) ||
    !/^[a-f0-9]{64}$/.test(expected.loadSourceSha256)
  )
    throw new Error("INVALID_EXPECTED_IDENTITY");
  if (
    inputs.length !== 3 ||
    new Set(inputs.map((input) => input.key)).size !== 3 ||
    !["aws-quick", "local-full", "aws-full-1"].every((key) =>
      inputs.some((input) => input.key === key),
    )
  )
    throw new Error("INVALID_NOMINATED_INPUTS");
  const environments = inputs.map((input) => {
    const environment = object(input.environment);
    equality(environment.gitHead, expected.sourceCommit, "MIXED_SOURCE_COMMIT");
    equality(environment.loadSourceSha256, expected.loadSourceSha256, "MIXED_LOAD_SOURCE_HASH");
    if (
      typeof environment.runId !== "string" ||
      !environment.runId ||
      !["quick", "full"].includes(String(environment.profile)) ||
      !["compose", "remote"].includes(String(environment.target))
    )
      throw new Error("INVALID_ENVIRONMENT_IDENTITY");
    equality(environment.scenario, "standard", "INCOMPARABLE_SCENARIO");
    equality(
      environment.profile,
      input.key === "aws-quick" ? "quick" : "full",
      "PROFILE_LABEL_MISMATCH",
    );
    equality(
      environment.target,
      input.key === "local-full" ? "compose" : "remote",
      "TARGET_LABEL_MISMATCH",
    );
    return environment;
  });
  if (new Set(environments.map((environment) => environment.runId)).size !== 3)
    throw new Error("DUPLICATE_RUN_IDENTITY");
  const accepted: Accepted[] = [],
    excluded: Exclusion[] = [];
  for (let index = 0; index < inputs.length; index++) {
    const input = inputs[index]!,
      environment = environments[index]!;
    const profile = environment.profile as "quick" | "full";
    const reasons: string[] = [];
    if (environment.workingTreeDirty !== false) reasons.push("source_not_recorded_clean");
    if (input.result === undefined) reasons.push("missing_result");
    if (input.verification === undefined) reasons.push("missing_verification");
    if (reasons.length) {
      excluded.push({ key: input.key, profile, reasons });
      continue;
    }
    const result = object(input.result),
      verification = object(input.verification);
    equality(result.runId, environment.runId, "RESULT_IDENTITY_MISMATCH");
    equality(verification.runId, environment.runId, "VERIFICATION_IDENTITY_MISMATCH");
    equality(result.profile, profile, "RESULT_PROFILE_MISMATCH");
    if (result.passed !== true) reasons.push("result_not_passed");
    if (verification.passed !== true) reasons.push("verification_not_passed");
    if (verification.partial !== false) reasons.push("verification_partial_or_unspecified");
    const embedded = object(result.verification);
    if (embedded.passed !== true) reasons.push("embedded_verification_not_passed");
    if (embedded.partial !== false) reasons.push("embedded_verification_partial_or_unspecified");
    if (reasons.length) {
      excluded.push({ key: input.key, profile, reasons });
      continue;
    }
    equality(canonical(embedded), canonical(verification), "VERIFICATION_PROOFS_DIFFER");
    const start = integer(result.startedAt),
      end = integer(result.completedAt);
    if (end <= start) throw new Error("INVALID_RUN_WINDOW");
    equality(environment.startedAt, start, "START_IDENTITY_MISMATCH");
    financial(verification, result, environment.target === "remote");
    accepted.push({
      key: input.key,
      profile,
      target: environment.target as "compose" | "remote",
      environment,
      result,
      verification,
    });
  }
  return {
    accepted,
    excluded,
    nominated: inputs.length,
    full: {
      nominated: environments.filter((environment) => environment.profile === "full").length,
      accepted: accepted.filter((run) => run.profile === "full").length,
    },
    quick: {
      nominated: environments.filter((environment) => environment.profile === "quick").length,
      accepted: accepted.filter((run) => run.profile === "quick").length,
    },
  };
}

export type Point = { at: number; value: number | null };
export function metricNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
export function afterWarmup(points: Point[], startedAtSeconds: number, seconds = 30): Point[] {
  nonnegative(startedAtSeconds);
  nonnegative(seconds);
  return points.filter((point) => point.at >= startedAtSeconds + seconds);
}
// Strict timestamp alignment. Missing/nonfinite observations stay gaps, not zero.
export function align(series: Point[][], mode: "sum" | "max"): Point[] {
  if (!series.length) return [];
  const maps = series.map((points) => {
    const map = new Map<number, number | null>();
    for (const point of points) {
      nonnegative(point.at);
      if (map.has(point.at)) throw new Error("DUPLICATE_TIMESTAMP");
      map.set(point.at, point.value === null ? null : metricNumber(point.value));
    }
    return map;
  });
  const timestamps = [...new Set(series.flatMap((points) => points.map((point) => point.at)))].sort(
    (a, b) => a - b,
  );
  return timestamps.map((at) => {
    const values = maps.map((map) => map.get(at));
    if (values.some((value) => value === undefined || value === null)) return { at, value: null };
    const numeric = values as number[];
    return {
      at,
      value: mode === "sum" ? numeric.reduce((sum, value) => sum + value, 0) : Math.max(...numeric),
    };
  });
}
export function counterDelta(
  before: Record<string, number>,
  after: Record<string, number>,
): number | null {
  const keys = Object.keys(before);
  if (
    !keys.length ||
    keys.length !== Object.keys(after).length ||
    keys.some((key) => !Object.hasOwn(after, key))
  )
    return null;
  let delta = 0;
  for (const key of keys) {
    const start = nonnegative(before[key]),
      end = nonnegative(after[key]);
    if (end < start) return null;
    delta += end - start;
  }
  return delta;
}
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
export function inlineJson(value: unknown): string {
  return canonical(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export const EXPECTED = {
  sourceCommit: "a98d1e6fe248f2e6bee4f2cf54317fc961aab062",
  loadSourceSha256: "36b77c2acde5dc63e35cff9f950c021a8c14601333d87cf590d47de5cc94f161",
};
const HTTP_PHASES = PHASES.slice(0, 4);
const LABELS: Record<string, string> = {
  hot_wallet: "Carteira concentrada",
  distributed_wallets: "Carteiras distribuídas",
  replays: "Replays",
  hot_plus_distributed: "Carga mista",
  sqs_backlog: "Backlog SQS",
};
const INPUT_LABELS: Record<InputKey, string> = {
  "aws-quick": "AWS · QUICK diagnóstica",
  "local-full": "Local · FULL retida",
  "aws-full-1": "AWS · FULL 1",
};
type FileProof = { input: InputKey; name: string; sha256: string };
type Curve = { label: string; points: Point[] };
type PhaseView = {
  name: string;
  start: number;
  end: number;
  requests: number;
  dropped: number;
  vus: number;
  outboxDrainMs: number;
  eventDrainMs: number;
  offeredSeconds: number;
  workloads: {
    name: string;
    requests: number;
    rate: number;
    p50: number;
    p95: number;
    p99: number;
  }[];
  counters: Record<string, { delta: number | null; before: number; after: number }>;
  charts: { title: string; unit: string; curves: Curve[]; note: string }[];
  after30Samples: number;
};
export type ReportView = {
  acceptedQuick: number;
  acceptedFull: number;
  excluded: Exclusion[];
  files: FileProof[];
  start: number;
  end: number;
  financial: Record<string, number>;
  eventCoverage: Record<string, number>;
  phases: PhaseView[];
  sqs: {
    count: number;
    groups: number;
    enqueueMs: number;
    completionMs: number;
    afterEnqueueMs: number;
    peak: number;
    outboxMs: number;
    eventsMs: number;
    timestampCount: number;
    duringTrafficSamples: number;
    consumerDelta: number | null;
  };
  generator: { stages: number[]; seconds: number; maxVUs: number; batchConcurrency: number };
};
function fail(code: string): never {
  throw new Error(code);
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : fail("INVALID_ARRAY");
}
function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith("../") && !isAbsolute(part);
}

// Literal filenames only, no directory enumeration. Symlinks cannot extend the input allowlist.
export function readAggregate(
  root: string,
  name: string,
  optional = false,
): { value: unknown; sha256: string } | undefined {
  if (!(ALLOWED_FILES as readonly string[]).includes(name)) fail("FORBIDDEN_INPUT_NAME");
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    fail("INVALID_INPUT_DIRECTORY");
  const base = realpathSync(root),
    path = resolve(base, name);
  let fd: number;
  try {
    if (!inside(base, realpathSync(path)) || lstatSync(path).isSymbolicLink())
      fail("INPUT_SYMLINK_REFUSED");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    fail(
      (error as Error).message === "INPUT_SYMLINK_REFUSED"
        ? "INPUT_SYMLINK_REFUSED"
        : "INPUT_UNREADABLE",
    );
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) fail("INVALID_INPUT_FILE");
    const bytes = readFileSync(fd);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("INVALID_AGGREGATE_JSON");
    }
    return { value, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
  } finally {
    closeSync(fd);
  }
}
export function counterView(raw: unknown): PhaseView["counters"] {
  const input = object(raw),
    before = object(input.before),
    after = object(input.after);
  return Object.fromEntries(
    ["api", "consumer", "worker"].map((role) => {
      const parse = (value: unknown) => {
        const records: Record<string, number> = {};
        for (const item of array(value)) {
          const entry = object(item),
            metric = object(entry.metric),
            pair = array(entry.value);
          if (
            metric.role !== role ||
            typeof metric.instance !== "string" ||
            Object.hasOwn(records, metric.instance)
          )
            fail("INVALID_COUNTER_SERIES");
          const number = metricNumber(pair[1]);
          if (number === null || number < 0) fail("INVALID_COUNTER_VALUE");
          records[metric.instance] = number;
        }
        return records;
      };
      const first = parse(before[role]),
        last = parse(after[role]);
      return [
        role,
        {
          delta: counterDelta(first, last),
          before: Object.keys(first).length,
          after: Object.keys(last).length,
        },
      ];
    }),
  );
}
function promSeries(raw: unknown, name: string): { metric: JsonObject; points: Point[] }[] {
  const entry = object(raw)[name];
  if (entry === undefined) return [];
  const query = object(entry);
  return array(query.series).map((item) => {
    const series = object(item),
      metric = object(series.metric);
    const points = array(series.values).map((value) => {
      const pair = array(value);
      const number = metricNumber(pair[1]);
      if (number !== null && number < 0) fail("NEGATIVE_OBSERVATION");
      return { at: nonnegative(pair[0]), value: number };
    });
    if (points.some((point, index) => index > 0 && point.at <= points[index - 1]!.at))
      fail("UNORDERED_PROMETHEUS_POINTS");
    return { metric, points };
  });
}
export function combined(raw: unknown, name: string, mode: "sum" | "max"): Curve[] {
  const series = promSeries(raw, name);
  return series.length
    ? [
        {
          label: mode === "sum" ? "Soma alinhada" : "Máximo entre réplicas",
          points: align(
            series.map((entry) => entry.points),
            mode,
          ),
        },
      ]
    : [];
}
function perReplica(raw: unknown, name: string, factor = 1): Curve[] {
  return promSeries(raw, name).map((entry, index) => ({
    label: `Réplica ${index + 1}`,
    points: entry.points.map((point) => ({
      at: point.at,
      value: point.value === null ? null : point.value * factor,
    })),
  }));
}
function processingQuantiles(raw: unknown): Curve[] {
  const series = (["p50", "p95", "p99"] as const).flatMap((quantile) =>
    promSeries(raw, `processing_${quantile}_seconds`).map((entry) => ({ quantile, ...entry })),
  );
  const replicaKey = (metric: JsonObject) => {
    if (typeof metric.instance !== "string" || !["api", "consumer"].includes(String(metric.role)))
      fail("INVALID_PROCESSING_REPLICA");
    return `${metric.role}\u0000${metric.instance}`;
  };
  const replicas = [...new Set(series.map((entry) => replicaKey(entry.metric)))].sort();
  return series.map((entry) => {
    const channel = entry.metric.channel;
    if (channel !== "http" && channel !== "sqs") fail("INVALID_PROCESSING_CHANNEL");
    return {
      label: `${entry.quantile} · Réplica ${replicas.indexOf(replicaKey(entry.metric)) + 1} · ${channel.toUpperCase()}`,
      points: entry.points.map((point) => ({
        at: point.at,
        value: point.value === null ? null : point.value * 1000,
      })),
    };
  });
}
export function queues(raw: unknown): Curve[] {
  const groups = new Map<string, Point[][]>();
  for (const entry of promSeries(raw, "queue_depth")) {
    const queue = String(entry.metric.queue),
      state = String(entry.metric.state);
    // Only logical aliases cross the projection boundary; infrastructure queue names do not.
    const aliases: Record<string, string> = {
      requests: "Comandos",
      events: "Eventos",
      deadLetters: "DLQ",
    };
    const alias = aliases[queue] ?? fail("UNKNOWN_QUEUE_CLASS");
    if (!["visible", "not_visible", "delayed"].includes(state)) fail("UNKNOWN_QUEUE_STATE");
    const key = `${alias} · ${{ visible: "visíveis", not_visible: "em voo", delayed: "atrasadas" }[state]}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(entry.points);
    groups.set(key, bucket);
  }
  return [...groups].map(([label, series]) => ({ label, points: align(series, "max") }));
}
function metric(summary: JsonObject, name: string): JsonObject | undefined {
  const value = object(summary.metrics)[name];
  return value === undefined ? undefined : object(object(value).values);
}
function coverage(raw: unknown): void {
  const events = object(raw),
    proof = object(events.coverage);
  for (const key of ["missing", "extra", "invalid_inbox"])
    equality(proof[key], 0, "EVENT_BARRIER_INCOMPLETE");
  equality(proof.effects, proof.outbox, "EVENT_BARRIER_COUNT_MISMATCH");
  equality(events.activeHandlers, 0, "EVENT_HANDLERS_ACTIVE");
}

export function buildReport(paths: Record<InputKey, string>, expected = EXPECTED): ReportView {
  const files: FileProof[] = [];
  const read = (key: InputKey, name: string, optional = false) => {
    const result = readAggregate(paths[key], name, optional);
    if (result) files.push({ input: key, name, sha256: result.sha256 });
    return result?.value;
  };
  const inputs: AggregateInput[] = (["aws-quick", "local-full", "aws-full-1"] as const).map(
    (key) => ({
      key,
      environment: read(key, "environment.json"),
      result: read(key, "result.json", true),
      verification: read(key, "verification.json", true),
    }),
  );
  const cohort = validateCohort(inputs, expected);
  if (
    cohort.accepted.length !== 1 ||
    cohort.accepted[0]!.key !== "aws-quick" ||
    cohort.full.accepted !== 0
  )
    fail("UNEXPECTED_CURRENT_POPULATION");
  const accepted = cohort.accepted[0]!,
    result = accepted.result,
    environment = accepted.environment;
  const generator = object(environment.generator),
    stages = array(generator.stages).map(nonnegative);
  if (!stages.length) fail("MISSING_GENERATOR_STAGES");
  const seconds = nonnegative(generator.stageSeconds),
    records = array(result.phases).map(object);
  if (canonical(records.map((record) => record.phase)) !== canonical(HTTP_PHASES))
    fail("INVALID_PHASE_SEQUENCE");
  const start = integer(result.startedAt),
    end = integer(result.completedAt);
  let previous = start;
  const phases = records.map((record) => {
    const name = String(record.phase),
      phaseStart = integer(record.startedAt),
      phaseEnd = integer(record.endedAt);
    if (phaseStart < previous || phaseEnd <= phaseStart || phaseEnd > end)
      fail("INVALID_PHASE_WINDOW");
    previous = phaseEnd;
    const summary = object(read("aws-quick", `${name}.json`)),
      counters = counterView(read("aws-quick", `${name}-counters.json`)),
      prometheus = read("aws-quick", `${name}-prometheus.json`);
    equality(metric(summary, "checks")?.rate, 1, "HTTP_CHECK_FAILED");
    equality(metric(summary, "unexpected_status")?.rate, 0, "HTTP_STATUS_FAILED");
    const workloads = ["hot", "distributed", "replay"].flatMap((workload) => {
      const requests = metric(summary, `requests_${workload}`);
      if (!requests) return [];
      equality(
        requests.count,
        metric(summary, `committed_${workload}`)?.count,
        "HTTP_OUTCOME_MISMATCH",
      );
      const pressure = metric(summary, `backpressure_${workload}`);
      if (pressure) equality(pressure.count, 0, "HTTP_BACKPRESSURE_PRESENT");
      const duration = metric(summary, `duration_${workload}`) ?? fail("MISSING_DURATION");
      return [
        {
          name: workload,
          requests: integer(requests.count),
          rate: nonnegative(requests.rate),
          p50: nonnegative(duration.med),
          p95: nonnegative(duration["p(95)"]),
          p99: nonnegative(duration["p(99)"]),
        },
      ];
    });
    if (!workloads.length) fail("MISSING_HTTP_WORKLOAD");
    const count = workloads.reduce((sum, workload) => sum + workload.requests, 0);
    equality(count, metric(summary, "iterations")?.count, "HTTP_ITERATION_MISMATCH");
    coverage(record.events);
    const charts = [
      {
        title: "Commits financeiros",
        unit: "transações/s",
        curves: combined(prometheus, "committed_per_second", "sum"),
        note: "Rate de 30 s, alinhada entre réplicas; exclui OPENING.",
      },
      {
        title: "Publicação outbox",
        unit: "eventos/s",
        curves: combined(prometheus, "outbox_published_per_second", "sum"),
        note: "Rate de 30 s dos workers; não é claim/send/confirm por estágio.",
      },
      {
        title: "Lag da outbox",
        unit: "s",
        curves: combined(prometheus, "outbox_lag_seconds", "max"),
        note: "Gauge replicada: máximo por instante, sem soma nem deslocamento temporal.",
      },
      {
        title: "Profundidade das filas",
        unit: "mensagens",
        curves: queues(prometheus),
        note: "Máximo por fila/estado entre réplicas; não é cardinalidade SQL de eventos.",
      },
      {
        title: "Processamento p50 / p95 / p99 por réplica",
        unit: "ms",
        curves: processingQuantiles(prometheus),
        note: "Histogramas da tentativa: p50/p95/p99 por réplica e canal; distintos dos quantis HTTP k6, sem média nem percentil global inventado.",
      },
      {
        title: "Espera por lock p95 por réplica",
        unit: "ms",
        curves: perReplica(prometheus, "lock_wait_p95_seconds", 1000),
        note: "Percentil da tentativa por réplica; não é latência do cliente.",
      },
    ];
    const timestamps = [
      ...new Set(
        charts.flatMap((chart) =>
          chart.curves.flatMap((curve) => curve.points.map((point) => point.at)),
        ),
      ),
    ];
    const after30Samples = afterWarmup(
      timestamps.map((at) => ({ at, value: 1 })),
      phaseStart / 1000,
    ).length;
    return {
      name,
      start: phaseStart,
      end: phaseEnd,
      requests: count,
      dropped: integer(record.generatorDroppedIterations),
      vus: integer(metric(summary, "vus")?.max),
      outboxDrainMs: nonnegative(record.outboxDrainMs),
      eventDrainMs: nonnegative(object(record.events).elapsedMs),
      offeredSeconds: seconds * stages.length,
      workloads,
      counters,
      charts,
      after30Samples,
    };
  });
  const sqs = object(result.sqs),
    sqsSummary = read("aws-quick", "sqs_backlog.json");
  equality(canonical(sqsSummary), canonical(sqs), "SQS_SUMMARY_MISMATCH");
  coverage(sqs.events);
  const sqsCounters = counterView(read("aws-quick", "sqs_backlog-counters.json")),
    sqsProm = read("aws-quick", "sqs_backlog-prometheus.json");
  const sqsStart = integer(sqs.startedAt),
    sqsEnd = integer(sqs.completedAt),
    enqueued = integer(sqs.enqueuedAt);
  if (sqsStart < previous || enqueued < sqsStart || sqsEnd < enqueued || sqsEnd > end)
    fail("INVALID_SQS_WINDOW");
  const timestamps = [
    ...new Set(
      promSeries(sqsProm, "committed_per_second").flatMap((entry) =>
        entry.points.map((point) => point.at),
      ),
    ),
  ];
  const financialKeys = [
    "wallets",
    "transactions",
    "processed",
    "entries",
    "outbox",
    "unpublished",
    "inbox",
    "unfinished_inbox",
    "duplicate_effects",
  ];
  const remoteInboxes = object(accepted.verification.remoteInboxes),
    finalCoverage = object(object(sqs.events).coverage);
  equality(finalCoverage.outbox, accepted.verification.outbox, "FINAL_EVENT_COVERAGE_MISMATCH");
  return {
    acceptedQuick: cohort.quick.accepted,
    acceptedFull: cohort.full.accepted,
    excluded: cohort.excluded,
    files,
    start,
    end,
    financial: {
      ...Object.fromEntries(financialKeys.map((key) => [key, integer(accepted.verification[key])])),
      remoteInboxTotal: integer(remoteInboxes.total),
      remoteRequestInboxes: integer(remoteInboxes.requests),
      remoteEventInboxes: integer(remoteInboxes.events),
      remoteUnknownInboxes: integer(remoteInboxes.unknown),
    },
    eventCoverage: Object.fromEntries(
      ["outbox", "effects", "missing", "extra", "invalid_inbox"].map((key) => [
        key,
        integer(finalCoverage[key]),
      ]),
    ),
    phases,
    generator: {
      stages,
      seconds,
      maxVUs: integer(generator.maxVUsPerWorkload),
      batchConcurrency: integer(generator.sqsBatchConcurrency),
    },
    sqs: {
      count: integer(sqs.count),
      groups: integer(sqs.groups),
      enqueueMs: enqueued - sqsStart,
      completionMs: sqsEnd - sqsStart,
      afterEnqueueMs: nonnegative(sqs.drainAfterEnqueueMs),
      peak: integer(sqs.sampledBacklogPeak),
      outboxMs: nonnegative(sqs.outboxDrainMs),
      eventsMs: nonnegative(object(sqs.events).elapsedMs),
      timestampCount: timestamps.length,
      duringTrafficSamples: timestamps.filter((at) => at >= sqsStart / 1000 && at <= sqsEnd / 1000)
        .length,
      consumerDelta: sqsCounters.consumer!.delta,
    },
  };
}

const number = (value: number, digits = 3) =>
  new Intl.NumberFormat("pt-BR", { maximumFractionDigits: digits }).format(value);
const xml = escapeHtml;
const COLORS = [
  "#087f8c",
  "#d0712c",
  "#7656a5",
  "#4b8d46",
  "#cb4c66",
  "#617a91",
  "#ab8544",
  "#477799",
  "#91616e",
];
const svgStyle =
  "<style>text{font-family:system-ui,sans-serif;fill:var(--chart-text,#18323e)}.paper{fill:var(--chart-bg,#fff)}.grid{stroke:var(--chart-grid,#dce5e9);stroke-width:1}.muted{fill:var(--chart-muted,#526975)}.heading{font-weight:700}.axis{font-size:11px}.small{font-size:13px}</style>";
function svgFrame(width: number, height: number, label: string, body: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
    width +
    " " +
    height +
    '" role="img" aria-label="' +
    xml(label) +
    '"><title>' +
    xml(label) +
    "</title>" +
    svgStyle +
    '<rect class="paper" width="100%" height="100%" rx="12"/>' +
    body +
    "</svg>"
  );
}
export function lineChart(
  title: string,
  unit: string,
  curves: Curve[],
  start: number,
  end: number,
): string {
  const width = 620,
    height = 320,
    left = 62,
    top = 33,
    right = 25,
    bottom = 110;
  const finite = curves.flatMap((curve) =>
    curve.points.flatMap((point) => (point.value === null ? [] : [point.value])),
  );
  if (finite.some((value) => !Number.isFinite(value) || value < 0))
    fail("NEGATIVE_OR_INVALID_CHART_OBSERVATION");
  let body = `<text x="20" y="23" class="heading small">${xml(title)}</text>`;
  if (!finite.length)
    return svgFrame(
      width,
      height,
      title,
      body +
        '<text x="24" y="110" class="muted small">Série indisponível · sem imputação de zero</text>',
    );
  const max = Math.max(...finite, 0.001),
    min = 0,
    span = max - min;
  const x = (at: number) =>
    left + ((at - start) / Math.max(end - start, 0.001)) * (width - left - right);
  const y = (value: number) => top + ((max - value) / span) * (height - top - bottom);
  for (let index = 0; index <= 4; index++) {
    const value = min + (index / 4) * span,
      yy = y(value);
    body +=
      '<line class="grid" x1="' +
      left +
      '" x2="' +
      (width - right) +
      '" y1="' +
      yy +
      '" y2="' +
      yy +
      '"/><text x="' +
      (left - 8) +
      '" y="' +
      (yy + 4) +
      '" text-anchor="end" class="axis muted">' +
      number(value, 2) +
      "</text>";
    const at = start + (index / 4) * (end - start);
    body +=
      '<text x="' +
      x(at) +
      '" y="' +
      (height - bottom + 20) +
      '" text-anchor="middle" class="axis muted">' +
      number(at - start, 1) +
      " s</text>";
  }
  body +=
    '<text x="' +
    left +
    '" y="' +
    (height - 22) +
    '" class="axis muted">' +
    xml(unit) +
    " · segundos desde a fronteira da fase</text>";
  curves.forEach((curve, index) => {
    const color = COLORS[index % COLORS.length]!;
    let segment: Point[] = [];
    const flush = () => {
      if (segment.length)
        body +=
          '<polyline fill="none" stroke="' +
          color +
          '" stroke-width="2" points="' +
          segment.map((point) => `${x(point.at)},${y(point.value!)}`).join(" ") +
          '"/>';
      segment = [];
    };
    for (const point of curve.points) {
      if (point.value === null) {
        flush();
        continue;
      }
      segment.push(point);
      body +=
        '<circle cx="' +
        x(point.at) +
        '" cy="' +
        y(point.value) +
        '" r="2.6" fill="' +
        color +
        '"><title>' +
        xml(curve.label) +
        ": " +
        number(point.value) +
        " " +
        xml(unit) +
        " · +" +
        number(point.at - start) +
        " s</title></circle>";
    }
    flush();
    body +=
      '<text x="' +
      (left + (index % 3) * 175) +
      '" y="' +
      (height - 76 + Math.floor(index / 3) * 14) +
      '" font-size="10" style="fill:' +
      color +
      '">' +
      xml(curve.label) +
      "</text>";
  });
  return svgFrame(width, height, title, body);
}
export function overviewSvg(view: ReportView): string {
  const requests = view.phases.reduce((sum, phase) => sum + phase.requests, 0);
  let body =
    '<text x="36" y="48" font-size="26" class="heading">Carga observada · QUICK diagnóstica AWS</text><text x="36" y="78" font-size="14" class="muted">Uma execução aceita. Nenhum FULL elegível nos dois inputs FULL nominados.</text>';
  const cards: [string, string][] = [
    ["QUICK aceita / nominada", "1 / 1"],
    ["FULL aceito / nominado", "0 / 2"],
    ["Respostas HTTP", number(requests, 0)],
  ];
  cards.forEach(([label, value], index) => {
    const x = 36 + index * 388;
    body +=
      '<rect x="' +
      x +
      '" y="103" width="352" height="88" rx="10" fill="none" stroke="#93abb6"/><text x="' +
      (x + 16) +
      '" y="130" class="small muted">' +
      label +
      '</text><text x="' +
      (x + 16) +
      '" y="167" font-size="25" class="heading">' +
      value +
      "</text>";
  });
  body +=
    '<text x="36" y="231" font-size="20" class="heading">Latência do cliente · p50 / p95 / p99, ms</text><text x="36" y="255" class="small muted">Resumo k6 da fase inteira; os dois workloads da carga mista oferecem mais tráfego total.</text>';
  const rows = view.phases.flatMap((phase) =>
    phase.workloads.map((workload) => ({
      label: `${LABELS[phase.name]} / ${workload.name}`,
      ...workload,
    })),
  );
  const maximum = Math.max(1, ...rows.map((row) => row.p99));
  rows.forEach((row, index) => {
    const y = 290 + index * 51;
    body += `<text x="36" y="${y + 11}" class="small">${xml(row.label)}</text>`;
    [row.p50, row.p95, row.p99].forEach((value, quantile) => {
      body +=
        '<rect x="365" y="' +
        (y - 7 + quantile * 10) +
        '" width="' +
        (value / maximum) * 500 +
        '" height="7" rx="2" fill="' +
        COLORS[quantile] +
        '"/>';
    });
    body +=
      '<text x="890" y="' +
      (y + 12) +
      '" class="small">' +
      number(row.p50) +
      " / " +
      number(row.p95) +
      " / " +
      number(row.p99) +
      "</text>";
  });
  const base = 290 + rows.length * 51 + 27;
  body +=
    '<text x="36" y="' +
    base +
    '" font-size="20" class="heading">Prova financeira salva e conclusão SQS</text>';
  const facts = [
    number(view.financial.wallets!, 0) +
      " carteiras reconciliadas · " +
      number(view.financial.transactions!, 0) +
      " transações = entradas no ledger",
    number(view.financial.outbox!, 0) +
      " eventos outbox · 0 não publicados · 0 efeitos duplicados · DLQ final 0",
    number(view.sqs.count, 0) +
      " comandos SQS · envio " +
      number(view.sqs.enqueueMs) +
      " ms · conclusão " +
      number(view.sqs.completionMs) +
      " ms desde o primeiro envio",
    "Depois do último envio: " +
      number(view.sqs.afterEnqueueMs) +
      " ms · pico amostrado do backlog: " +
      number(view.sqs.peak, 0),
    "Sem três FULL AWS, comparação full local/AWS ou ganho de performance demonstrado.",
    "CPU/memória, estágios claim/send/confirm e séries durante a drenagem: indisponíveis nesta allowlist.",
  ];
  facts.forEach((fact, index) => {
    body +=
      '<text x="36" y="' +
      (base + 31 + index * 25) +
      '" class="small ' +
      (index > 3 ? "muted" : "") +
      '">' +
      xml(fact) +
      "</text>";
  });
  body +=
    '<text x="36" y="' +
    (base + 210) +
    '" font-size="11" class="muted">Fonte a98d1e6 · loadSourceSha256 ' +
    EXPECTED.loadSourceSha256 +
    "</text>";
  return svgFrame(
    1200,
    base + 235,
    "Resumo da única QUICK AWS aceita, com dois FULL excluídos",
    body,
  );
}
export function phaseSvg(phase: PhaseView): string {
  let body = `<text x="24" y="36" font-size="24" class="heading">QUICK AWS diagnóstica · ${xml(LABELS[phase.name]!)}</text><text x="24" y="62" class="small muted">${new Date(phase.start).toISOString()} → ${new Date(phase.end).toISOString()} · ${number((phase.end - phase.start) / 1000)} s</text><text x="24" y="85" class="small muted">Janela inteira; lookback de 30 s pode incluir trabalho anterior. ${phase.after30Samples} timestamps após excluir os primeiros 30 s.</text>`;
  phase.charts.forEach((chart, index) => {
    const x = 14 + (index % 2) * 640,
      y = 104 + Math.floor(index / 2) * 375;
    body += lineChart(
      chart.title,
      chart.unit,
      chart.curves,
      phase.start / 1000,
      phase.end / 1000,
    ).replace("<svg ", `<svg x="${x}" y="${y}" width="620" height="320" `);
    const lines = chart.note.split(" ").reduce<string[]>((rows, word) => {
      const last = rows.length - 1;
      if (last < 0 || rows[last]!.length + word.length > 75) rows.push(word);
      else rows[last] += ` ${word}`;
      return rows;
    }, []);
    lines.forEach((line, row) => {
      body += `<text x="${x + 12}" y="${y + 339 + row * 15}" font-size="12" class="muted">${xml(line)}</text>`;
    });
  });
  body += `<text x="24" y="1250" font-size="12" class="muted">Séries ausentes/NaN preservam lacunas · eixos Y partem de zero · fonte a98d1e6 / loadSourceSha256 ${EXPECTED.loadSourceSha256}</text>`;
  return svgFrame(1280, 1270, `Seis séries diagnósticas de ${LABELS[phase.name]}`, body);
}
function table(headers: string[], rows: string[][]): string {
  return (
    '<div class="table"><table><thead><tr>' +
    headers.map((header) => `<th>${xml(header)}</th>`).join("") +
    "</tr></thead><tbody>" +
    rows.map((row) => `<tr>${row.map((cell) => `<td>${xml(cell)}</td>`).join("")}</tr>`).join("") +
    "</tbody></table></div>"
  );
}
export function reportHtml(view: ReportView): string {
  const phaseRows = view.phases.flatMap((phase) =>
    phase.workloads.map((workload) => [
      LABELS[phase.name]!,
      workload.name,
      number(workload.requests, 0),
      number(workload.rate),
      number(workload.p50),
      number(workload.p95),
      number(workload.p99),
    ]),
  );
  const phaseSection = view.phases
    .map(
      (phase) =>
        '<section id="' +
        phase.name +
        '"><h2>' +
        LABELS[phase.name] +
        "</h2><p>" +
        number(phase.offeredSeconds, 0) +
        " s de tráfego programado; janela completa " +
        number((phase.end - phase.start) / 1000) +
        " s. Drops registrados pelo runner: <strong>" +
        number(phase.dropped, 0) +
        "</strong>; VUs máximos observados: <strong>" +
        number(phase.vus, 0) +
        "</strong>. Drenagem residual outbox: " +
        number(phase.outboxDrainMs) +
        " ms; barreira de eventos: " +
        number(phase.eventDrainMs) +
        ' ms. <a href="' +
        phase.name +
        '.svg">SVG independente das seis séries</a>.</p><p class="warning">' +
        phase.after30Samples +
        ' timestamps depois de excluir os primeiros 30 s. Estas séries curtas são diagnósticas; rates e histogramas usam lookback de 30 s e podem incluir trabalho anterior. Quantis k6 acima são da fase inteira.</p><div class="charts">' +
        phase.charts
          .map(
            (chart) =>
              "<figure>" +
              lineChart(
                chart.title,
                chart.unit,
                chart.curves,
                phase.start / 1000,
                phase.end / 1000,
              ) +
              "<figcaption>" +
              xml(chart.note) +
              "</figcaption></figure>",
          )
          .join("") +
        "</div>" +
        table(
          ["Papel", "Séries antes / depois", "Delta alinhado do contador"],
          Object.entries(phase.counters).map(([role, value]) => [
            role,
            `${value.before} / ${value.after}`,
            value.delta === null
              ? "Indisponível: baseline, série ou reset"
              : number(value.delta, 0),
          ]),
        ) +
        "</section>",
    )
    .join("");
  const exclusions = table(
    ["Input nominado", "Perfil", "Resultado elegível", "Motivo derivado somente do core"],
    view.excluded.map((entry) => [
      INPUT_LABELS[entry.key],
      entry.profile.toUpperCase(),
      "Excluído integralmente",
      entry.reasons
        .map(
          (reason) =>
            ({
              missing_result: "result.json ausente",
              missing_verification: "verification.json ausente",
              source_not_recorded_clean: "árvore não registrada limpa",
            })[reason] ?? reason,
        )
        .join("; "),
    ]),
  );
  const invariants = table(
    ["Invariante / controle", "Evidência agregada da QUICK aceita"],
    [
      [
        "wallet.balance == saldo reconstruído do ledger",
        `Verificador salvo PASS; ${number(view.financial.wallets!, 0)} carteiras. O core não exporta um contador separado de divergências.`,
      ],
      [
        "Saldos negativos",
        "Contagem não exportada nos agregados permitidos; não se inventa zero nem se substitui a verificação do banco.",
      ],
      [
        "Transações = processadas = entradas no ledger",
        `${number(view.financial.transactions!, 0)} = ${number(view.financial.processed!, 0)} = ${number(view.financial.entries!, 0)}`,
      ],
      ["Outbox = duas mensagens por transação", number(view.financial.outbox!, 0)],
      [
        "Não publicados / inbox inacabado / efeitos duplicados",
        `${number(view.financial.unpublished!, 0)} / ${number(view.financial.unfinished_inbox!, 0)} / ${number(view.financial.duplicate_effects!, 0)}`,
      ],
      [
        "Partição dos inboxes remotos",
        `${number(view.financial.remoteInboxTotal!, 0)} = ${number(view.financial.remoteRequestInboxes!, 0)} comandos + ${number(view.financial.remoteEventInboxes!, 0)} eventos; desconhecidos ${number(view.financial.remoteUnknownInboxes!, 0)}`,
      ],
      [
        "Reconciliação final dos eventos",
        `${number(view.eventCoverage.effects!, 0)} efeitos / ${number(view.eventCoverage.outbox!, 0)} outbox; ausentes ${number(view.eventCoverage.missing!, 0)}, extras ${number(view.eventCoverage.extra!, 0)}, inboxes inválidos ${number(view.eventCoverage.invalid_inbox!, 0)}`,
      ],
    ],
  );
  const darkCss =
    ":root{--bg:#101e26;--panel:#182b35;--ink:#e3edf0;--muted:#aec1ca;--edge:#34505d;--chart-bg:#182b35;--chart-text:#e3edf0;--chart-grid:#34505d;--chart-muted:#aec1ca}a,.tag{color:#65c7cf}";
  const css =
    "html{color-scheme:light dark;scroll-behavior:smooth}*{box-sizing:border-box}:root{--bg:#edf3f5;--panel:#fff;--ink:#18323e;--muted:#526975;--edge:#cedce2;--chart-bg:#fff;--chart-text:#18323e;--chart-grid:#dce5e9;--chart-muted:#526975}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 system-ui,sans-serif}main{max-width:1360px;margin:auto;padding:36px 24px}header{margin-bottom:24px}h1{font-size:clamp(29px,4vw,46px);line-height:1.15;margin:12px 0}h2{font-size:25px;margin:0 0 14px}h3{font-size:19px}p{max-width:105ch}section{background:var(--panel);border:1px solid var(--edge);border-radius:18px;padding:25px;margin:24px 0}a{color:#087f8c}nav{display:flex;gap:12px;flex-wrap:wrap}.tag{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#087f8c}.muted,figcaption{color:var(--muted)}.warning{border-left:4px solid #d0712c;padding:8px 14px;background:color-mix(in srgb,#d0712c 8%,transparent)}.charts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}figure{margin:0;min-width:0;overflow-x:auto}.overview{overflow-x:auto}.overview>svg{min-width:900px}.charts svg{min-width:560px}svg{width:100%;height:auto;display:block}figcaption{font-size:13px;margin:6px 12px 16px}.table{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--edge);vertical-align:top}th{color:var(--muted)}code,pre{font:12px/1.6 ui-monospace,monospace;overflow-wrap:anywhere}pre{white-space:pre-wrap;background:var(--bg);padding:16px;border-radius:10px}summary{cursor:pointer;font-weight:700}.hashes{font-size:11px;word-break:break-all}footer{padding:20px 0 40px;color:var(--muted)}@media(max-width:750px){main{padding:24px 12px}section{padding:18px 12px}.charts{grid-template-columns:1fr}th,td{padding:8px;font-size:12px}}";
  return (
    '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'none\'; ' +
    docsThemeCsp +
    '"><title>Relatório de carga · QUICK AWS diagnóstica</title><style>' +
    css +
    docsThemeStyles +
    '</style><style data-docs-dark media="screen and (prefers-color-scheme: dark)">' +
    darkCss +
    "</style>" +
    docsThemeScript +
    "</head><body><main>" +
    renderDocsTopbar("../../../") +
    '<header><div class="tag">Evidência de carga · fonte a98 / hash global 36b</div><h1>Uma QUICK diagnóstica.<br>Comparação FULL indisponível.</h1><p>Este relatório contém somente agregados de uma execução AWS QUICK aprovada. Os dois FULL nominados, local e AWS, estão excluídos inteiros. A rodada curta não representa três rounds, capacidade sustentada, repetibilidade ou ganho entre ambientes.</p><nav><a href="#coorte">População</a><a href="#http">HTTP</a><a href="#invariantes">Invariantes</a><a href="#hot_wallet">Séries</a><a href="#sqs">SQS</a><a href="#limites">Lacunas</a><a href="#experiencias">Experiências e recuperação</a><a href="#reproducao">Reprodução</a></nav><p class="muted">Em telas estreitas, deslize horizontalmente o resumo, os gráficos e as tabelas para ler sua largura completa.</p></header>' +
    '<div class="overview">' +
    overviewSvg(view) +
    "</div>" +
    '<section id="coorte"><h2>População e exclusões explícitas</h2><p><strong>Denominador: três diretórios nominados</strong> — QUICK aceita 1/1, FULL aceito 0/2. Isto não é uma taxa de aprovação de todos os smokes, falhas de setup ou diagnósticos AWS. A QUICK desenhada é o smoke5 aceito; as demais tentativas e seus resultados permanecem na documentação operacional. Não houve seleção de fases favoráveis de FULL reprovado.</p>' +
    exclusions +
    '<p>O encerramento operacional registrou os dois FULL como FAIL; essa classificação editorial não é deduzida por este leitor. O leitor só registra a ausência/rejeição do core permitido, sem abrir failure, execution ou partial. Os três FULL históricos c99 permanecem nas tabelas de <a href="../load-test.md">load-test.md</a>, fora dos gráficos e da coorte atual.</p><p class="muted">QUICK aceita: ' +
    new Date(view.start).toISOString() +
    " → " +
    new Date(view.end).toISOString() +
    "; duração total " +
    number((view.end - view.start) / 1000) +
    " s, incluindo preparação e barreiras. Fonte: <code>" +
    EXPECTED.sourceCommit +
    "</code>. loadSourceSha256: <code>" +
    EXPECTED.loadSourceSha256 +
    '</code>.</p></section><section id="http"><h2>HTTP: latência e carga efetivamente iniciada</h2><p>Percentis custom k6 em milissegundos sobre a fase inteira. A taxa é a média emitida pelo contador k6, não pico nem requests divididos pela duração total do run. Alvos da rampa: ' +
    view.generator.stages.map((stage) => number(stage, 0)).join(" → ") +
    "/s por executor, " +
    number(view.generator.seconds, 0) +
    " s por estágio; máximo configurado " +
    number(view.generator.maxVUs, 0) +
    " VUs por workload. A fase mista tem dois executores simultâneos e maior taxa total; não isola apenas distribuição de carteiras.</p>" +
    table(
      ["Fase", "Workload", "Respostas", "Média k6, req/s", "p50, ms", "p95, ms", "p99, ms"],
      phaseRows,
    ) +
    '<p class="muted">Replays são respostas com efeito já existente; não são novas transações. Drops do scheduler não chegam à aplicação. Métrica de drops ausente não será apresentada como observação explícita de zero: acima usa-se o campo numérico salvo pelo runner.</p></section>' +
    '<section id="invariantes"><h2>Invariantes financeiros e reconciliação dos eventos</h2><p>O core aceito registra result.passed=true e verification.passed=true, partial=false. As conclusões são do verificador salvo; este renderer não executa SQL nem revalida saldos. Contagens que o core não exporta permanecem indisponíveis.</p>' +
    invariants +
    "</section>" +
    phaseSection +
    '<section id="sqs"><h2>SQS: burst e barreiras de conclusão</h2>' +
    table(
      ["Métrica", "Valor"],
      [
        ["Comandos / grupos FIFO", `${number(view.sqs.count, 0)} / ${number(view.sqs.groups, 0)}`],
        ["Envio do produtor", `${number(view.sqs.enqueueMs)} ms`],
        ["Após o último envio até conclusão", `${number(view.sqs.afterEnqueueMs)} ms`],
        [
          "Primeiro envio até comandos completos e fila vazia",
          `${number(view.sqs.completionMs)} ms`,
        ],
        ["Pico amostrado de backlog de entrada", number(view.sqs.peak, 0)],
        ["Drenagem residual outbox", `${number(view.sqs.outboxMs)} ms`],
        ["Barreira de eventos", `${number(view.sqs.eventsMs)} ms`],
        [
          "Delta dos consumers por réplica",
          view.sqs.consumerDelta === null
            ? "Indisponível: séries sem baseline correspondente"
            : number(view.sqs.consumerDelta, 0),
        ],
        [
          "Timestamps Prometheus / durante o tráfego SQS",
          `${view.sqs.timestampCount} / ${view.sqs.duringTrafficSamples}`,
        ],
      ],
    ) +
    "<p>Envio e consumo se sobrepõem. O burst curto não mede capacidade sustentada ou percentil por mensagem. A série SQS disponível contém somente uma fronteira anterior ao primeiro envio; por isso nenhuma curva de consumo/publicação SQS é desenhada. As durações e contagens acima têm fontes e janelas próprias. Concorrência de batches configurada: " +
    number(view.generator.batchConcurrency, 0) +
    '.</p></section><section id="experiencias"><h2>Experiência rejeitada e provas de recuperação separadas</h2><p><strong>Persistência em lote da outbox: experiência REJEITADA.</strong> O candidato não foi retido; nenhum ganho de desempenho é reivindicado. A metodologia, os critérios e o resultado fechado estão na <a href="../load-test.md">experiência controlada documentada em load-test.md</a>. Seus benchmarks não alimentam estes gráficos.</p><p>As provas aceitas de falhas e recuperação pertencem às campanhas descritas em <a href="../verification.md">verification.md: oito seletores manuais</a>. A <a href="../verification.md">campanha GNU de seis rodadas e a falha formal do wrapper</a> mantém seu waiver e seu resultado próprios. Esses vínculos editoriais não leem artefatos adicionais, não transformam testes de falha em amostras de carga e não alteram o denominador deste painel.</p></section><section id="limites"><h2>Lacunas que permanecem visíveis</h2><ul><li>Sem três FULL AWS aceitos ou comparação quantitativa local/AWS. Nenhuma otimização de performance foi retida.</li><li>CPU, memória, rede, RDS e ALB não pertencem aos agregados admitidos; não são gráficos vazios com zero.</li><li>Claim PostgreSQL, send SQS, confirm PostgreSQL, latência por evento e cardinalidade SQL ao longo do tempo: não medidos por estes arquivos.</li><li>Não há trecho QUICK após excluir 30 s nem série durante toda a drenagem. NaN e séries ausentes permanecem lacunas; sem suavização ou deslocamento temporal.</li><li>Conflitos de lock sem série não significam zero conflitos. Histogramas por réplica não viram percentil global por média.</li></ul><p>Prova financeira e cobertura de eventos são resultados do verificador salvo. O renderer não consulta o banco ou reconstrói o ledger.</p></section><section id="reproducao"><h2>Reproduzir com Bun, sem serviço ou rede</h2><p>O script acompanha o clone e usa somente Bun e APIs nativas. Forneça os três diretórios com os agregados autorizados e uma pasta de saída nova; nenhum caminho privado de planejamento é default. Nenhum agregado bruto com identificadores precisa ser commitado.</p><pre>BUN_CONFIG_NO_ENV_FILE=true BUN_CONFIG_NO_AUTO_INSTALL=true bun --no-env-file scripts/render-load-report.ts \\\n  --aws-quick /caminho/agregados-quick \\\n  --local-full /caminho/agregados-full-local \\\n  --aws-full-1 /caminho/agregados-full-aws \\\n  --output-dir /caminho/novo-relatorio</pre><p>Os leitores abrem somente result.json, verification.json, environment.json e os quinze nomes literais de fase/counters/prometheus. Os FULL excluídos não têm suas fases abertas. Mistura de fonte/hash é recusada mesmo quando o run seria excluído. HTML/SVG usam conteúdo inline, sem bibliotecas, fontes, scripts ou serviços externos.</p><details><summary>Proveniência dos ' +
    view.files.length +
    ' agregados efetivamente abertos</summary><div class="hashes">' +
    table(
      ["Input", "Nome permitido", "SHA-256 dos bytes"],
      view.files.map((file) => [INPUT_LABELS[file.input], file.name, file.sha256]),
    ) +
    "</div></details></section><footer>Relatório offline · um único loadSourceSha256 global · QUICK diagnóstica · FULL 0/2.</footer></main></body></html>"
  );
}

export function parseArgs(args: string[]): { paths: Record<InputKey, string>; output: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index],
      value = args[index + 1];
    if (
      !key ||
      !["--aws-quick", "--local-full", "--aws-full-1", "--output-dir"].includes(key) ||
      !value ||
      value.startsWith("--") ||
      values.has(key)
    )
      fail("INVALID_ARGUMENTS");
    values.set(key, resolve(value));
  }
  if (values.size !== 4) fail("MISSING_ARGUMENTS");
  const paths: Record<InputKey, string> = {
    "aws-quick": values.get("--aws-quick")!,
    "local-full": values.get("--local-full")!,
    "aws-full-1": values.get("--aws-full-1")!,
  };
  const roots = Object.values(paths).map((path) => {
    try {
      return realpathSync(path);
    } catch {
      return fail("INPUT_DIRECTORY_MISSING");
    }
  });
  if (new Set(roots).size !== 3) fail("DUPLICATE_INPUT_DIRECTORY");
  const requestedOutput = values.get("--output-dir")!;
  let output: string;
  try {
    output = resolve(realpathSync(dirname(requestedOutput)), basename(requestedOutput));
  } catch {
    return fail("OUTPUT_PARENT_MISSING");
  }
  if (existsSync(output) || roots.some((root) => inside(root, output) || inside(output, root)))
    fail("OUTPUT_NOT_NEW_OR_OVERLAPS_INPUT");
  return { paths, output };
}
export function writeReport(paths: Record<InputKey, string>, output: string): ReportView {
  if (existsSync(output)) fail("OUTPUT_EXISTS");
  const parent = realpathSync(dirname(output)),
    destination = resolve(parent, basename(output));
  if (
    Object.values(paths).some((path) => {
      const root = realpathSync(path);
      return inside(root, destination) || inside(destination, root);
    })
  )
    fail("OUTPUT_OVERLAPS_INPUT");
  const report = buildReport(paths);
  // Render entirely before creating output: rejection never produces partial charts.
  const html = reportHtml(report),
    svg = overviewSvg(report),
    phaseImages = report.phases.map((phase) => ({
      name: `${phase.name}.svg`,
      svg: phaseSvg(phase),
    }));
  mkdirSync(destination, { mode: 0o755 });
  try {
    writeFileSync(resolve(destination, "index.html"), html, { flag: "wx", mode: 0o644 });
    writeFileSync(resolve(destination, "overview.svg"), svg, { flag: "wx", mode: 0o644 });
    for (const image of phaseImages)
      writeFileSync(resolve(destination, image.name), image.svg, { flag: "wx", mode: 0o644 });
  } catch {
    rmSync(destination, { recursive: true, force: true });
    fail("OUTPUT_WRITE_FAILED");
  }
  return report;
}
if (
  import.meta.main &&
  (process.argv.includes("--campaign") || process.argv.includes("--campaign-data"))
) {
  const { runCampaignCli } = await import("./render-load-campaign");
  runCampaignCli(process.argv.slice(2));
} else if (import.meta.main) {
  const usage =
    "Uso: bun --no-env-file scripts/render-load-report.ts --aws-quick DIR --local-full DIR --aws-full-1 DIR --output-dir NEW_DIR\n" +
    "FULL: bun --no-env-file scripts/render-load-report.ts --campaign local|aws --run DIR [--run DIR] --output-dir NEW_DIR\n" +
    "Offline: bun --no-env-file scripts/render-load-report.ts --campaign-data campaign.json --output-dir NEW_DIR";
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    console.log(usage);
  } else {
    try {
      const args = parseArgs(process.argv.slice(2)),
        report = writeReport(args.paths, args.output);
      console.log(
        JSON.stringify({
          status: "RENDERED_AGGREGATES_ONLY",
          quick: { accepted: report.acceptedQuick, nominated: 1 },
          full: { accepted: report.acceptedFull, nominated: 2 },
          exclusions: report.excluded.length,
          filesRead: report.files.length,
        }),
      );
    } catch (error) {
      const code =
        error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "RENDER_FAILED";
      console.error(JSON.stringify({ status: "REJECTED", code }));
      console.error(usage);
      process.exitCode = 1;
    }
  }
}
