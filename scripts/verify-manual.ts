import { randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  command,
  compose,
  composeUp,
  pollUntil,
  testEnvironment,
  testProject,
} from "../test/support/stack";
import { chaosEnvironment, toxiproxy } from "../test/support/toxiproxy";
import { assertSuite, captured, writeEvidence } from "./verification-evidence";
import {
  assertCommittedSource,
  concurrencyRound,
  recordStackIdentity,
  sourceGit,
} from "./verify-manual-round";

const available = [
  "parallel",
  "oha",
  "pg-activity",
  "pumba",
  "toxiproxy",
  "netem",
  "tcpdump",
  "stress",
  "determinism",
] as const;
const defaults = available.filter((name) => name !== "determinism");
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--list") {
  console.log(
    JSON.stringify({
      experiments: available,
      default: defaults,
      determinism:
        "20 serial repetitions of the actual 13-case concurrency suite plus final reconciliation per round",
    }),
  );
  process.exit(0);
}
let experiments: string[] = [...defaults];
let outputOption: string | undefined;
let sawOnly = false;
for (const argument of args) {
  if (argument.startsWith("--only=") && !sawOnly) {
    sawOnly = true;
    experiments = argument.slice(7).split(",");
  } else if (argument.startsWith("--output=") && outputOption === undefined) {
    outputOption = argument.slice(9);
  } else throw new Error("Use --list, --only=name[,name] and --output=/external/new-directory");
}
if (
  !experiments.length ||
  new Set(experiments).size !== experiments.length ||
  experiments.some((name) => !available.includes(name as (typeof available)[number]))
) {
  throw new Error("Unknown, empty or duplicate experiment selector");
}
const repo = await realpath(resolve(import.meta.dir, ".."));
if ((await realpath(process.cwd())) !== repo)
  throw new Error("Run verify:manual from the repository");
const output = resolve(
  outputOption ??
    join(
      homedir(),
      ".cache",
      "wagering-verification",
      `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`,
    ),
);
// Resolve the existing ancestor as well: a symlink outside the tree can point into it.
let ancestor = output;
for (;;) {
  try {
    ancestor = await realpath(ancestor);
    break;
  } catch {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("Output ancestor unavailable");
    ancestor = parent;
  }
}
function inside(path: string) {
  const rel = relative(repo, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
if (inside(output) || inside(ancestor))
  throw new Error("Evidence output must be outside the checkout");
try {
  if ((await readdir(output)).length) throw new Error("Evidence directory is not empty");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
async function refuseExisting() {
  const ids = await command([
    "docker",
    "ps",
    "-aq",
    "--filter",
    `label=com.docker.compose.project=${testProject}`,
  ]);
  const networks = await command([
    "docker",
    "network",
    "ls",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${testProject}`,
  ]);
  if (ids.trim() || networks.trim())
    throw new Error("wagering-test already in use; refusing to replace services");
}
await refuseExisting();
const lock = join(homedir(), ".cache", "wagering-verification", "wagering-test.lock");
await mkdir(dirname(lock), { recursive: true });
await mkdir(lock); // Exclusive local ownership; never remove another invocation's lock.
let ownedStack = false;
let failed = false;
let cleanupFailed = false;
const completed: string[] = [];
let source = "unresolved";
let sourceVerified = false;
let sourceWasClean = false;
const instruments: Record<string, string> = {};
Object.assign(process.env, {
  VERIFICATION_SOURCE_DIR: repo,
  VERIFICATION_OUTPUT_DIR: output,
  WAGERING_MANUAL_MANAGED: "1",
  VERIFICATION_EXPERIMENTS: experiments.join(","),
});
Object.assign(testEnvironment, { VERIFICATION_SOURCE_DIR: repo, VERIFICATION_OUTPUT_DIR: output });
const env = () => ({ ...process.env, ...testEnvironment, WAGERING_STACK_MANAGED: "1" });
async function teardown() {
  if (!ownedStack) return;
  await compose(["down", "--volumes", "--remove-orphans"]);
  ownedStack = false;
}
async function childTest(file: string, directory: string, cases: number) {
  const result = await captured(
    ["bun", "--no-env-file", "test", file, "--bail", "--timeout", "150000"],
    { ...env(), VERIFICATION_OUTPUT_DIR: directory },
  );
  await writeEvidence(directory, "test-result", { source, ...result });
  assertSuite(result, cases);
  return result;
}
async function finalReconciliation(directory: string) {
  const result = await captured(
    ["bun", "--no-env-file", "test", "test/manual/final-reconciliation.test.ts"],
    { ...env(), VERIFICATION_OUTPUT_DIR: directory },
  );
  await writeEvidence(directory, "reconciliation-result", result);
  assertSuite(result, 1);
}
try {
  await refuseExisting();
  await mkdir(output, { recursive: true });
  await compose(["--profile", "verification", "build", "verification-tools"]);
  source = (await sourceGit(["rev-parse", "HEAD"])).trim();
  sourceWasClean = !(await sourceGit(["status", "--porcelain"])).trim();
  for (const path of [
    "package.json",
    "compose.yaml",
    "docker/verification/Dockerfile",
    "scripts/verify-manual.ts",
    "scripts/verify-manual-round.ts",
    "scripts/verification-evidence.ts",
    ...(await readdir("test/manual")).map((name) => `test/manual/${name}`),
  ]) {
    instruments[path] = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(path).arrayBuffer())
      .digest("hex");
  }
  await writeEvidence(output, "manifest", {
    createdAt: new Date().toISOString(),
    source,
    workingTreeClean: sourceWasClean,
    experiments,
    hostPlatform: process.platform,
    hostArchitecture: process.arch,
    bun: Bun.version,
    instruments,
  });
  await compose([
    "--profile",
    "verification",
    "pull",
    "verification-oha",
    "verification-pumba",
    "verification-k6",
  ]);
  await command([
    "docker",
    "pull",
    "ghcr.io/alexei-led/pumba-alpine-nettools@sha256:bdcfacdd0c42f64cd280319d6dd5d3911f33425ce4a5168bb1b7de9570b72cd1",
  ]);
  const imageNames = [
    "wagering-verification:local",
    "ghcr.io/hatoo/oha:1.16.0@sha256:3ec3dbf549ea197793482d47a6324797411406bbf438c2fe8b91f244ec641a2f",
    "ghcr.io/alexei-led/pumba:1.2.1@sha256:780505fe261932765921c94a23e24bda107c72927654c26a5893a238d7708bf0",
    "grafana/k6:2.3.0",
    "ghcr.io/alexei-led/pumba-alpine-nettools@sha256:bdcfacdd0c42f64cd280319d6dd5d3911f33425ce4a5168bb1b7de9570b72cd1",
  ];
  const images: Record<string, unknown> = {};
  for (const image of imageNames)
    images[image] = JSON.parse(
      await command(["docker", "image", "inspect", "--format", "{{json .Id}}", image]),
    );
  await writeEvidence(output, "images", images);
  const versions: Record<string, string> = {};
  for (const executable of [
    "bun",
    "parallel",
    "pg_activity",
    "stress-ng",
    "tcpdump",
    "curl",
    "psql",
    "script",
    "git",
  ]) {
    versions[executable] =
      (
        await compose(
          [
            "--profile",
            "verification",
            "run",
            "--rm",
            "--no-deps",
            "-T",
            "verification-tools",
            executable,
            "--version",
          ],
          "wagering-verification-tools",
          env(),
        )
      ).split("\n")[0] ?? "";
    if (!versions[executable]) throw new Error("Tool version unavailable");
  }
  versions.compose = (
    await compose(
      [
        "--profile",
        "verification",
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "verification-tools",
        "docker",
        "compose",
        "version",
      ],
      "wagering-verification-tools",
      env(),
    )
  ).trim();
  versions.daemon = (
    await command(["docker", "version", "--format", "{{.Server.Version}}"])
  ).trim();
  await writeEvidence(output, "versions", versions);
  const manual = experiments.filter((name) => !["tcpdump", "stress", "determinism"].includes(name));
  if (manual.length) {
    const directory = join(output, "manual");
    await mkdir(directory);
    Object.assign(testEnvironment, chaosEnvironment);
    ownedStack = true;
    await compose([
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "90",
      "postgres",
      "ministack",
      "toxiproxy",
    ]);
    await toxiproxy.populate();
    await composeUp();
    await recordStackIdentity(directory);
    let primary: unknown;
    try {
      const cases = manual.reduce(
        (sum, name) =>
          sum + (name === "pumba" || name === "toxiproxy" ? 3 : name === "netem" ? 4 : 1),
        0,
      );
      const result = await childTest("test/manual/campaign.test.ts", directory, cases);
      const expected = manual.flatMap((name) =>
        name === "parallel"
          ? ["parallel-curl"]
          : name === "oha"
            ? ["oha-replay", "oha-get", "k6-get", "load-tools-financial-proof"]
            : name === "pg-activity"
              ? ["pg-activity"]
              : name === "pumba"
                ? ["pumba-consumer", "pumba-worker", "pumba-api"]
                : name === "toxiproxy"
                  ? ["toxiproxy-timeout", "toxiproxy-slicer", "toxiproxy-limit_data"]
                  : [
                      "pumba-netem-postgres-delay",
                      "pumba-netem-postgres-loss",
                      "pumba-netem-sqs-delay",
                      "pumba-netem-sqs-loss",
                    ],
      );
      if (
        JSON.stringify(result.saved.map((item) => item.experiment).sort()) !==
        JSON.stringify([...expected, "final"].sort())
      ) {
        throw new Error("Planned experiment evidence set differs");
      }
    } catch (error) {
      primary = error;
    }
    try {
      await finalReconciliation(directory);
    } catch (error) {
      if (!primary) primary = error;
      else cleanupFailed = true;
    }
    await teardown();
    if (primary) throw primary;
    completed.push(...manual);
  }
  Object.assign(testEnvironment, {
    COMPOSE_PROFILES: "observability",
    APP_DB_HOST: "postgres",
    APP_DB_PORT: "5432",
    APP_SQS_ENDPOINT: "http://ministack:4566",
  });
  if (experiments.includes("tcpdump")) {
    const directory = join(output, "tcpdump");
    await mkdir(directory);
    ownedStack = true;
    await compose(["build", "bootstrap"]);
    await compose(["up", "-d", "--wait", "--wait-timeout", "90", "postgres", "ministack"]);
    await compose(["run", "--rm", "--no-deps", "bootstrap"]);
    await recordStackIdentity(directory);
    const result = await childTest("test/manual/packet.test.ts", directory, 1);
    if (
      JSON.stringify(result.saved.map((item) => item.experiment).sort()) !==
      JSON.stringify(["packet-cleanup", "tcpdump"])
    )
      throw new Error("Packet evidence missing");
    await teardown();
    completed.push("tcpdump");
  }
  if (experiments.includes("stress")) {
    await assertCommittedSource(source);
    const name = `wagering-verification-stress-${randomUUID().slice(0, 8)}`;
    const args = [
      "docker",
      "compose",
      "--env-file",
      "/dev/null",
      "-p",
      "wagering-verification-tools",
      "--profile",
      "verification",
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "--name",
      name,
      "verification-tools",
      "stress-ng",
      "--cpu",
      "0",
      "--cpu-load",
      "80",
      "--metrics-brief",
      // The checkout is read-only; stress-ng validates its temporary directory.
      "--temp-path",
      "/tmp",
    ];
    const stress = Bun.spawn(args, { env: env(), stdout: "pipe", stderr: "pipe" });
    let ready = false;
    let bytes = 0;
    const summary: string[] = [];
    let unsuccessful = false;
    async function read(stream: AsyncIterable<Uint8Array>) {
      const decoder = new TextDecoder();
      let pending = "";
      for await (const chunk of stream) {
        bytes += chunk.byteLength;
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (/dispatching hogs:.*cpu/.test(line)) ready = true;
          if (/successful run completed|dispatching hogs:|\bcpu\s+\d+\s+[\d.]+/.test(line))
            summary.push(line);
          if (/unsuccessful run|failed: [1-9]|error:|fail:\s/.test(line)) unsuccessful = true;
        }
      }
    }
    const reads = [read(stress.stdout), read(stress.stderr)];
    let primary: unknown;
    let activeAtEnd = false;
    try {
      await pollUntil("owned stress process ready", async () => ready, 15_000);
      await refuseExisting();
      ownedStack = true;
      await concurrencyRound("stress", output, source);
      ownedStack = false;
      activeAtEnd = stress.exitCode === null;
    } catch (error) {
      primary = error;
    } finally {
      if (stress.exitCode === null) await command(["docker", "kill", "--signal", "SIGINT", name]);
      const exitCode = await stress.exited;
      await Promise.all(reads);
      await writeEvidence(output, "stress-process", {
        configuredCpuWorkers: "all online CPUs",
        configuredLoadPercent: 80,
        activeAtEnd,
        exitCode,
        bytes,
        summary,
        unsuccessful,
      });
      if (exitCode !== 0 || !activeAtEnd || unsuccessful)
        primary ??= new Error("Stress process failed");
    }
    if (primary) throw primary;
    completed.push("stress");
  }
  if (experiments.includes("determinism")) {
    await assertCommittedSource(source);
    await refuseExisting();
    ownedStack = true;
    const result = await captured(
      [
        "docker",
        "compose",
        "--env-file",
        "/dev/null",
        "-p",
        "wagering-verification-tools",
        "--profile",
        "verification",
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "--env",
        "WAGERING_MANUAL_INNER=1",
        "--env",
        "WAGERING_MANUAL_MANAGED=1",
        "--env",
        "VERIFICATION_OUTPUT_DIR",
        "verification-tools",
        "parallel",
        "--will-cite",
        "-j1",
        "--halt",
        "now,fail=1",
        "--joblog",
        join(output, "joblog.tsv"),
        "bun",
        "--no-env-file",
        "scripts/verify-manual-round.ts",
        "{}",
        source,
        ":::",
        ...Array.from({ length: 20 }, (_, index) => String(index + 1)),
      ],
      env(),
    );
    await writeEvidence(output, "gnu-process", result);
    if (result.exitCode !== 0) throw new Error("GNU campaign failed; do not retry its results");
    const rows = (await Bun.file(join(output, "joblog.tsv")).text()).trim().split("\n").slice(1);
    if (
      rows.length !== 20 ||
      rows.some((row, index) => {
        const fields = row.split("\t");
        return (
          Number(fields[0]) !== index + 1 || Number(fields[6]) !== 0 || Number(fields[7]) !== 0
        );
      })
    ) {
      throw new Error("GNU joblog did not contain twenty successful serial rounds");
    }
    for (let number = 1; number <= 20; number++) {
      const result = await Bun.file(join(output, `repeat-${number}`, "result.json")).json();
      if (
        result.source !== source ||
        !result.passed ||
        !result.cleaned ||
        !result.reconciliationPassed ||
        !result.suitePassed
      ) {
        throw new Error("GNU round evidence incomplete");
      }
    }
    completed.push("determinism");
    ownedStack = false;
  }
  if (sourceWasClean) await assertCommittedSource(source);
  else if ((await sourceGit(["rev-parse", "HEAD"])).trim() !== source)
    throw new Error("Source commit changed during verification");
  for (const [path, expected] of Object.entries(instruments)) {
    const actual = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(path).arrayBuffer())
      .digest("hex");
    if (actual !== expected) throw new Error("Verification instrument changed during execution");
  }
  sourceVerified = true;
} catch (error) {
  failed = true;
  console.error(
    JSON.stringify({
      verificationFailed: true,
      errorName: error instanceof Error ? error.name : "unknown",
      evidence: output,
    }),
  );
} finally {
  try {
    await teardown();
  } catch {
    cleanupFailed = true;
  }
  try {
    await writeEvidence(output, "result", {
      source,
      requested: experiments,
      completed,
      failed,
      cleanupFailed,
      sourceVerified,
      passed: !failed && !cleanupFailed && completed.length === experiments.length,
    });
  } catch {
    cleanupFailed = true;
    console.error(JSON.stringify({ evidenceWriteFailed: true }));
  } finally {
    await rmdir(lock);
  }
}
if (failed || cleanupFailed || completed.length !== experiments.length) process.exitCode = 1;
else console.log(JSON.stringify({ passed: true, completed, evidence: output }));
