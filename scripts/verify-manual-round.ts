import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { command, compose, testEnvironment } from "../test/support/stack";
import { assertSuite, captured, writeEvidence } from "./verification-evidence";

export async function assertCommittedSource(source: string) {
  const head = (await sourceGit(["rev-parse", "HEAD"])).trim();
  if (head !== source || (await sourceGit(["status", "--porcelain"])).trim()) {
    throw new Error("Committed source changed during verification");
  }
}

export function sourceGit(args: string[]) {
  if (process.env.WAGERING_MANUAL_INNER === "1") return command(["git", ...args]);
  return compose(
    [
      "--profile",
      "verification",
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "verification-tools",
      "git",
      ...args,
    ],
    "wagering-verification-tools",
    {
      ...testEnvironment,
      ...process.env,
    },
  );
}

export async function recordStackIdentity(directory: string) {
  const ids = (await compose(["ps", "-aq"])).trim().split(/\s+/).filter(Boolean);
  if (!ids.length) throw new Error("No owned stack to identify");
  const projection =
    '{"id":{{json .Id}},"image":{{json .Image}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"project":{{json (index .Config.Labels "com.docker.compose.project")}}}';
  const containers = (await command(["docker", "inspect", "--format", projection, ...ids]))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { id: string; image: string; project: string });
  if (
    containers.length !== ids.length ||
    containers.some((item) => item.project !== "wagering-test")
  )
    throw new Error("Stack identity ownership differs");
  await writeEvidence(directory, "stack-images", { containers });
}

export async function concurrencyRound(label: string, root: string, source: string) {
  await assertCommittedSource(source);
  if ((await compose(["ps", "-aq"])).trim()) throw new Error("Existing test stack");
  const output = join(root, label);
  await mkdir(output);
  let suitePassed = false;
  let reconciliationPassed = false;
  let cleaned = false;
  let primary: unknown;
  let secondaryFailure = false;
  const env = {
    ...testEnvironment,
    KEEP_STACK: "1",
    VERIFICATION_OUTPUT_DIR: output,
    WAGERING_MANUAL_MANAGED: "1",
  };
  try {
    const suite = await captured(["bun", "--no-env-file", "run", "test:concurrency"], env);
    await writeEvidence(output, "suite", { source, ...suite });
    assertSuite(suite, 13);
    const titles = suite.outcomes.map((line) => line.replace(/\s+\[[\d.]+ms\]$/, ""));
    if (new Set(titles).size !== 13) throw new Error("Concurrency case identities differ");
    suitePassed = true;
  } catch (error) {
    primary = error;
  }
  try {
    await recordStackIdentity(output);
    const result = await captured(
      ["bun", "--no-env-file", "test", "test/manual/final-reconciliation.test.ts"],
      { ...env, WAGERING_STACK_MANAGED: "1" },
    );
    await writeEvidence(output, "reconciliation-result", result);
    assertSuite(result, 1);
    if (result.saved.length !== 1 || result.saved[0]?.experiment !== "all-wallet-reconciliation") {
      throw new Error("Final reconciliation evidence missing");
    }
    reconciliationPassed = true;
  } catch (error) {
    if (primary) secondaryFailure = true;
    else primary = error;
  }
  try {
    await compose(["down", "--volumes", "--remove-orphans"]);
    cleaned = true;
  } catch (error) {
    if (primary) secondaryFailure = true;
    else primary = error;
  }
  try {
    await assertCommittedSource(source);
  } catch (error) {
    if (primary) secondaryFailure = true;
    else primary = error;
  }
  await writeEvidence(output, "result", {
    source,
    label,
    suitePassed,
    reconciliationPassed,
    cleaned,
    secondaryFailure,
    passed: !primary,
  });
  if (primary) throw new Error("Concurrency round failed; preserved its safe evidence");
  console.log(
    JSON.stringify({ round: label, passed: true, mandatoryCases: 13, reconciliationCases: 1 }),
  );
}

if (import.meta.main) {
  const [round, source] = process.argv.slice(2);
  const root = process.env.VERIFICATION_OUTPUT_DIR;
  if (
    process.env.WAGERING_MANUAL_INNER !== "1" ||
    !root ||
    !round ||
    !/^(?:[1-9]|1[0-9]|20)$/.test(round) ||
    !source ||
    !/^[a-f0-9]{40}$/.test(source)
  ) {
    throw new Error("Use the determinism selector in bun run verify:manual");
  }
  await concurrencyRound(`repeat-${round}`, root, source);
}
