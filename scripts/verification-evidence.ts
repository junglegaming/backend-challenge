import { join } from "node:path";

export async function captured(args: string[], env: NodeJS.ProcessEnv) {
  const began = performance.now();
  const startedAt = new Date().toISOString();
  const child = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const raw = `${stdout}\n${stderr}`;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: remove terminal escapes before allowlisting output.
  const lines = raw.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: performance.now() - began,
    exitCode,
    byteCount: Buffer.byteLength(raw),
    outcomes: lines.filter((line) => /^\((?:pass|fail)\) (?:manual |scenario |race: )/.test(line)),
    counts: lines.filter((line) => /^\s*\d+ (?:pass|fail|skip|expect\(\) calls)/.test(line)),
    summaries: lines.filter((line) => /^Ran \d+ tests? across/.test(line)),
    saved: lines
      .filter((line) => /^\{"experiment":"[a-z0-9_-]+","evidenceSaved":true\}$/.test(line))
      .map((line) => JSON.parse(line) as { experiment: string }),
    assertions: lines.filter((line) => /^error: expect\(/.test(line)),
    locations: lines
      .filter((line) => /^\s*at .*\/(?:test|src|scripts)\/[^\r\n]*:\d+:\d+\)?$/.test(line))
      .map((line) => line.trim()),
  };
}

export function assertSuite(result: Awaited<ReturnType<typeof captured>>, expected: number) {
  if (
    result.exitCode !== 0 ||
    result.outcomes.length !== expected ||
    result.outcomes.some((line) => !line.startsWith("(pass) ")) ||
    !result.counts.some((line) => /^\s*0 fail$/.test(line))
  ) {
    throw new Error("Requested suite did not pass every planned case");
  }
}

export async function writeEvidence(directory: string, label: string, value: unknown) {
  const path = join(directory, `${label}.json`);
  if (await Bun.file(path).exists()) throw new Error("Evidence already exists");
  await Bun.write(path, JSON.stringify(value, null, 2));
}
