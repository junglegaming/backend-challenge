import { join } from "node:path";
import { testEnvironment, testProject } from "../support/stack";

const output = process.env.VERIFICATION_OUTPUT_DIR;
if (!output || process.env.WAGERING_MANUAL_MANAGED !== "1") {
  throw new Error("Use bun run verify:manual");
}
export const evidenceRoot: string = output;
export const tcImage =
  "ghcr.io/alexei-led/pumba-alpine-nettools@sha256:bdcfacdd0c42f64cd280319d6dd5d3911f33425ce4a5168bb1b7de9570b72cd1";

export function toolArgs(args: string[], environment: NodeJS.ProcessEnv = process.env) {
  const [tool, ...rest] = args;
  if (tool === "docker") return args;
  if (tool === "toxiproxy-cli") {
    return [
      "docker",
      "compose",
      "--env-file",
      "/dev/null",
      "-p",
      testProject,
      "exec",
      "-T",
      "toxiproxy",
      "/toxiproxy-cli",
      ...rest,
    ];
  }
  const service =
    tool === "oha"
      ? "verification-oha"
      : tool === "pumba"
        ? "verification-pumba"
        : tool === "k6"
          ? "verification-k6"
          : "verification-tools";
  const pass = Object.keys(environment).filter(
    (name) =>
      /^(?:TASK12_|PROBE_|K6_|VERIFICATION_)/.test(name) ||
      ["PGPASSWORD", "TERM", "LC_ALL", "NO_COLOR"].includes(name),
  );
  return [
    "docker",
    "compose",
    "--env-file",
    "/dev/null",
    "-p",
    testProject,
    "--profile",
    "verification",
    "run",
    "--rm",
    "--no-deps",
    "-T",
    ...pass.flatMap((name) => ["--env", name]),
    service,
    ...(service === "verification-tools" ? args : rest),
  ];
}

// Raw tool output can contain terminal queries, request headers or bodies. Keep it
// only in memory; callers persist closed numeric/status projections.
export async function privateRun(args: string[], environment: NodeJS.ProcessEnv = process.env) {
  const started = performance.now();
  const env = { ...testEnvironment, ...environment };
  const child = Bun.spawn(toolArgs(args, env), { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    stdout,
    stderrBytes: Buffer.byteLength(stderr),
    exitCode,
    elapsedMs: performance.now() - started,
    capabilityDenied: /operation not permitted|permission denied|cap_net_admin/i.test(
      `${stdout}\n${stderr}`,
    ),
    kernelUnsupported: /specified qdisc kind is unknown|not supported|unknown qdisc/i.test(
      `${stdout}\n${stderr}`,
    ),
  };
}

export function selected(name: string) {
  return (process.env.VERIFICATION_EXPERIMENTS ?? "").split(",").includes(name);
}

export async function save(label: string, values: Record<string, unknown>) {
  if (!/^[a-z0-9_-]+$/.test(label)) throw new Error("Invalid evidence label");
  const path = join(evidenceRoot, `${label}.json`);
  if (await Bun.file(path).exists()) throw new Error("Evidence already exists");
  await Bun.write(
    path,
    JSON.stringify({ label, observedAt: new Date().toISOString(), ...values }, null, 2),
  );
  console.log(JSON.stringify({ experiment: label, evidenceSaved: true }));
}
