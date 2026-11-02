import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACK_STATS, createEventAcknowledger } from "../../load/event-observer";
import { QUEUES } from "../../src/observability/health/dependencies";

const runner = readFileSync(new URL("../../scripts/aws-runner.ts", import.meta.url), "utf8");
const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" });
const prometheusName = "wagering-load-synthetic-prometheus";
function section(start: string, end: string) {
  const a = runner.indexOf(start),
    b = runner.indexOf(end, a);
  if (a < 0 || b <= a) throw new Error("Runner fixture boundaries not found");
  return runner.slice(a, b);
}
const gateSource = section(
  "async function waitForPrometheusReady(",
  "function parseSafePrometheusStatus(",
);
type Last = {
  containerRunning: boolean | null;
  readyStatus: number | null;
  queryStatus: number | null;
  status: string;
  errorType: string;
  errorName: string | null;
  resultCount: number | null;
  upCount: number | null;
};
type Diagnostic = { passed: boolean; polls: number; elapsedMs: number; last: Last | null };
type Fetcher = (url: string, options: RequestInit) => Response | Promise<Response>;
function gate(fetcher: Fetcher, state = "true\n", exitCode = 0) {
  let now = 0;
  const inspections: {
    argv: string[];
    options: { timeout: number; killSignal: string; stderr: string };
  }[] = [];
  const fetches: { url: string; options: RequestInit }[] = [];
  const timeouts: { milliseconds: number; signal: AbortSignal }[] = [];
  const mockedBun = {
    sleep: async (ms: number) => {
      now += ms;
    },
    spawn: (argv: string[], options: { timeout: number; killSignal: string; stderr: string }) => {
      inspections.push({ argv, options });
      return {
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(state));
            controller.close();
          },
        }),
        exited: Promise.resolve(exitCode),
        kill() {},
      };
    },
  };
  const fn = new Function(
    "fetch",
    "Bun",
    "Date",
    "AbortSignal",
    "Buffer",
    "TextDecoder",
    transpiler.transformSync(gateSource) + ";return waitForPrometheusReady;",
  )(
    (url: string, options: RequestInit) => {
      fetches.push({ url, options });
      return fetcher(url, options);
    },
    mockedBun,
    { now: () => now },
    {
      timeout: (milliseconds: number) => {
        const signal = new AbortController().signal;
        timeouts.push({ milliseconds, signal });
        return signal;
      },
    },
    Buffer,
    TextDecoder,
  ) as (cutoff: number, name: string) => Promise<Diagnostic>;
  return { run: (cutoff: number) => fn(cutoff, prometheusName), inspections, fetches, timeouts };
}
const vector = (length = 8) => ({
  status: "success",
  data: { resultType: "vector", result: Array.from({ length }, () => ({ value: [0, "1"] })) },
});
function responses(readyStatus = 200, queryStatus = 200, value: unknown = vector()): Fetcher {
  return (url) =>
    url.endsWith("/-/ready")
      ? new Response("synthetic ready body", { status: readyStatus })
      : Response.json(value, { status: queryStatus });
}

test("only the generated nonsecret scrape YAML becomes0644 under umask077", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wagering-prom-mode-")),
    old = process.umask(0o077);
  const calls: { path: string; mode: number }[] = [];
  try {
    const configSource = section("  const prometheusConfig =", "  prometheusAttempted = true;");
    const write = new Function(
      "Bun",
      "chmod",
      "base",
      "manifest",
      "return (async()=>{" +
        transpiler.transformSync(configSource) +
        "return prometheusConfig;})()",
    ) as (
      runtime: typeof Bun,
      setMode: (path: string, mode: number) => Promise<void>,
      base: string,
      manifest: { unit: string; namespace: string },
    ) => Promise<string>;
    const config = await write(
      Bun,
      async (path, mode) => {
        calls.push({ path, mode });
        await chmod(path, mode);
      },
      dir,
      { unit: "smoke", namespace: "synthetic.internal" },
    );
    expect(calls).toEqual([{ path: config, mode: 0o644 }]);
    expect(statSync(config).mode & 0o777).toBe(0o644);
    expect(readFileSync(config, "utf8")).toContain("scrape_interval: 5s");
    expect(runner.match(/await chmod\(/g)).toHaveLength(1);
    expect(runner.indexOf("await chmod(prometheusConfig")).toBeLessThan(
      runner.indexOf("prometheusAttempted = true"),
    );
  } finally {
    process.umask(old);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Prometheus gate checks the exact owned container and bounds both fetches with a signal", async () => {
  const h = gate(responses()),
    d = await h.run(100_000);
  expect(d.passed).toBe(true);
  expect(d.polls).toBe(1);
  expect(d.last?.resultCount).toBe(8);
  expect(d.last?.upCount).toBe(8);
  expect(h.inspections).toHaveLength(1);
  expect(h.inspections[0]!.argv).toEqual([
    "docker",
    "inspect",
    "--format",
    "{{.State.Running}}",
    prometheusName,
  ]);
  expect(h.inspections[0]!.options.timeout).toBe(2500);
  expect(h.inspections[0]!.options.killSignal).toBe("SIGKILL");
  expect(h.inspections[0]!.options.stderr).toBe("ignore");
  expect(h.timeouts).toHaveLength(1);
  expect(h.timeouts[0]!.milliseconds).toBe(2500);
  expect(h.fetches).toHaveLength(2);
  expect(new URL(h.fetches[0]!.url).pathname).toBe("/-/ready");
  expect(new URL(h.fetches[1]!.url).searchParams.get("query")).toBe('up{job="wagering"}');
  for (const call of h.fetches) {
    expect(call.options.redirect).toBe("manual");
    expect(call.options.signal).toBe(h.timeouts[0]!.signal);
  }
});

test("startup accepts an empty success vector without replacing the child's up8 gate", async () => {
  const d = await gate(responses(200, 200, vector(0))).run(100_000);
  expect(d.passed).toBe(true);
  expect(d.last?.resultCount).toBe(0);
  expect(runner).toContain('"scripts/load-test.ts"');
  expect(runner).not.toContain("--preload");
});

test("ready HTTP, query HTTP, API status, vector shape and JSON are independent conditions", async () => {
  const cases: { fetcher: Fetcher; ready: number; query: number; status: string }[] = [
    { fetcher: responses(503, 200), ready: 503, query: 200, status: "success" },
    { fetcher: responses(200, 503), ready: 200, query: 503, status: "success" },
    {
      fetcher: responses(200, 200, { ...vector(), status: "error", errorType: "execution" }),
      ready: 200,
      query: 200,
      status: "error",
    },
    {
      fetcher: responses(200, 200, {
        status: "success",
        data: { resultType: "matrix", result: [] },
      }),
      ready: 200,
      query: 200,
      status: "success",
    },
    {
      fetcher: (url) =>
        url.endsWith("/-/ready") ? new Response("ready") : new Response("SYNTHETIC_UNSAFE_JSON"),
      ready: 200,
      query: 200,
      status: "INVALID_JSON",
    },
  ];
  for (const item of cases) {
    const d = await gate(item.fetcher).run(1);
    expect(d.passed).toBe(false);
    expect(d.polls).toBe(1);
    expect(d.last?.readyStatus).toBe(item.ready);
    expect(d.last?.queryStatus).toBe(item.query);
    expect(d.last?.status).toBe(item.status);
    expect(JSON.stringify(d)).not.toContain("SYNTHETIC_UNSAFE_JSON");
  }
});

test("own container false or inspect failure blocks before any HTTP probe", async () => {
  for (const [state, exitCode] of [
    ["false\n", 0],
    ["true\n", 1],
  ] as const) {
    const h = gate(responses(), state, exitCode),
      d = await h.run(100_000);
    expect(d.passed).toBe(false);
    expect(d.last?.containerRunning).toBe(false);
    expect(d.polls).toBe(1);
    expect(h.fetches).toHaveLength(0);
  }
});

test("gate preserves timeout errors as closed failure and caps timeouts to remaining cutoff", async () => {
  const h = gate(() => {
    throw Object.assign(new Error("SYNTHETIC_UNSAFE_ERROR"), { name: "TimeoutError" });
  });
  const d = await h.run(1);
  expect(d.passed).toBe(false);
  expect(d.last?.errorName).toBe("TimeoutError");
  expect(h.inspections[0]!.options.timeout).toBe(1);
  expect(h.timeouts[0]!.milliseconds).toBe(1);
  expect(h.fetches[0]!.options.signal).toBe(h.timeouts[0]!.signal);
  expect(JSON.stringify(d)).not.toContain("SYNTHETIC_UNSAFE_ERROR");
});

test("gate stops at45s or the earlier cutoff and never probes after an expired cutoff", async () => {
  const h = gate(responses(503, 503, { status: "error", errorType: "unavailable" }));
  const d = await h.run(100_000);
  expect(d.passed).toBe(false);
  expect(d.elapsedMs).toBe(45_000);
  expect(d.polls).toBe(90);
  const early = gate(responses(503)),
    e = await early.run(750);
  expect(e.elapsedMs).toBe(750);
  expect(e.polls).toBe(2);
  expect(early.timeouts.map((item) => item.milliseconds)).toEqual([750, 250]);
  const expired = gate(responses()),
    x = await expired.run(0);
  expect(x.passed).toBe(false);
  expect(x.polls).toBe(0);
  expect(expired.inspections).toHaveLength(0);
  expect(expired.fetches).toHaveLength(0);
});

test("query body over64KiB fails closed without including the response", async () => {
  const h = gate((url) =>
    url.endsWith("/-/ready") ? new Response("ready") : new Response("x".repeat(65_537)),
  );
  const d = await h.run(1);
  expect(d.passed).toBe(false);
  expect(d.last?.errorName).toBe("ResponseBodyLimit");
  expect(JSON.stringify(d)).not.toContain("x".repeat(100));
});

test("real readiness guard throws before the child on failure and permits it only after PASS", async () => {
  const source = section('  execution.stage = "prometheus-ready";', "  const loadEnv =");
  const invoke = new Function(
    "execution",
    "cutoff",
    "prometheusName",
    "waitForPrometheusReady",
    "child",
    "return (async()=>{" + transpiler.transformSync(source) + "await child();})()",
  ) as (
    execution: { stage?: string; prometheusReady?: Diagnostic },
    cutoff: number,
    name: string,
    wait: (cutoff: number, name: string) => Promise<Diagnostic>,
    child: () => void,
  ) => Promise<void>;
  for (const passed of [false, true]) {
    let children = 0;
    const execution: { stage?: string; prometheusReady?: Diagnostic } = {};
    const diagnostic: Diagnostic = { passed, polls: 1, elapsedMs: 0, last: null };
    const run = invoke(
      execution,
      100_000,
      prometheusName,
      async (cutoff, name) => {
        expect(cutoff).toBe(100_000);
        expect(name).toBe(prometheusName);
        return diagnostic;
      },
      () => {
        children++;
      },
    );
    if (passed) await run;
    else await expect(run).rejects.toMatchObject({ name: "PrometheusPreloadGate" });
    expect(children).toBe(passed ? 1 : 0);
    expect(execution.stage).toBe("prometheus-ready");
    expect(execution.prometheusReady).toBe(diagnostic);
  }
  const readinessAssignment =
    /execution\.prometheusReady\s*=\s*await waitForPrometheusReady\(\s*cutoff,\s*prometheusName,?\s*\)/.exec(
      runner,
    );
  expect(readinessAssignment).not.toBe(null);
  expect(readinessAssignment?.index).toBeLessThan(runner.indexOf('const child = Bun.spawn(["bun"'));
});

test("future child Prometheus HTTP status is anchored numeric only", () => {
  const parse = new Function(
    transpiler.transformSync(
      section("function parseSafePrometheusStatus(", "// Invoked through SSM"),
    ) + ";return parseSafePrometheusStatus;",
  )() as (stderr: string) => number | null;
  expect(parse("error: Prometheus returned 503\n at synthetic:1:2")).toBe(503);
  for (const value of [
    "prefix error: Prometheus returned 503",
    "error: Prometheus returned 503 UNSAFE",
    "error: Prometheus returned 999",
    "unrelated",
  ])
    expect(parse(value)).toBe(null);
});

test("runner parses generated ACK stats, keeps the last stats line and rejects unsafe fields", async () => {
  const ack = createEventAcknowledger({ async acknowledge() {} }, new AbortController().signal);
  await ack.acknowledge(QUEUES.events, {});
  const parse = new Function(
    transpiler.transformSync(
      section("function parseSafeSdkDiagnostic(", "async function waitForPrometheusReady("),
    ) + ";return parseSafeSdkDiagnostic;",
  )() as (stderr: string) => {
    eventAcks: typeof ack.stats | null;
    firstError: unknown;
    fatalError: unknown;
    eventAckRetryReady: boolean;
    sdkDiagnosticReady: boolean;
  };
  const line = (value: unknown) => ACK_STATS + JSON.stringify(value);
  expect(parse(line(ack.stats)).eventAcks).toEqual(ack.stats);
  expect(parse(line({ ...ack.stats, calls: 0 }) + "\n" + line(ack.stats)).eventAcks).toEqual(
    ack.stats,
  );
  for (const value of [
    { ...ack.stats, extra: "DO_NOT_EXPORT" },
    { ...ack.stats, failed: -1 },
    { ...ack.stats, maxAttemptsObserved: 8 },
  ])
    expect(parse(line(value)).eventAcks).toBe(null);
  expect(parse("").eventAcks).toBe(null);
  const first = {
    operation: "DeleteMessageCommand",
    name: "RequestThrottled",
    httpStatus: 403,
    attempts: 1,
  };
  const d = parse(
    "WAGERING_SAFE_SDK_READY\nWAGERING_EVENT_ACK_RETRY_READY\nWAGERING_SAFE_SDK_FAILURE " +
      JSON.stringify(first),
  );
  expect(d.sdkDiagnosticReady).toBe(true);
  expect(d.eventAckRetryReady).toBe(true);
  expect(d.firstError).toEqual(first);
  const bad = parse(
    "WAGERING_SAFE_SDK_FAILURE " + JSON.stringify({ ...first, name: "DO_NOT_EXPORT" }),
  );
  expect(bad.firstError).toBe(null);
  expect(JSON.stringify(bad)).not.toContain("DO_NOT_EXPORT");
});

test("first and fatal SDK sentinels are independent and absent or unsafe fatal remains null", () => {
  const parse = new Function(
    transpiler.transformSync(
      section("function parseSafeSdkDiagnostic(", "async function waitForPrometheusReady("),
    ) + ";return parseSafeSdkDiagnostic;",
  )() as (stderr: string) => { firstError: unknown; fatalError: unknown };
  const first = {
    operation: "DeleteMessageCommand",
    name: "RequestThrottled",
    httpStatus: 403,
    attempts: 1,
  };
  const fatal = { ...first, operation: "SendMessageBatchCommand" };
  const firstLine = "WAGERING_SAFE_SDK_FAILURE " + JSON.stringify(first);
  const fatalLine = "WAGERING_SAFE_SDK_FATAL " + JSON.stringify(fatal);
  expect(parse(firstLine + "\n" + fatalLine)).toMatchObject({
    firstError: first,
    fatalError: fatal,
  });
  expect(parse(firstLine)).toMatchObject({ firstError: first, fatalError: null });
  expect(parse(fatalLine)).toMatchObject({ firstError: null, fatalError: fatal });
  expect(parse("")).toMatchObject({ firstError: null, fatalError: null });
  for (const value of [
    null,
    { ...fatal, extra: "DO_NOT_EXPORT" },
    { ...fatal, name: "DO_NOT_EXPORT" },
    { ...fatal, httpStatus: 999 },
  ]) {
    const d = parse(firstLine + "\nWAGERING_SAFE_SDK_FATAL " + JSON.stringify(value));
    expect(d.firstError).toEqual(first);
    expect(d.fatalError).toBe(null);
    expect(JSON.stringify(d)).not.toContain("DO_NOT_EXPORT");
  }
});
