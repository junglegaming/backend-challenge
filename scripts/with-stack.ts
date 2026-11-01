import { compose, composeUp, testEnvironment } from "../test/support/stack";
import { chaosEnvironment, toxiproxy } from "../test/support/toxiproxy";

const action = process.argv[2];
if (action === "up") {
  await compose(
    [
      "up",
      "-d",
      "--build",
      "--wait",
      "--wait-timeout",
      "180",
      "--scale",
      `api=${process.env.API_REPLICAS ?? "1"}`,
      "--scale",
      `consumer=${process.env.CONSUMER_REPLICAS ?? "1"}`,
      "--scale",
      `worker=${process.env.WORKER_REPLICAS ?? "1"}`,
    ],
    "wagering",
    process.env,
  );
} else if (action === "down") {
  await compose(["down", "--remove-orphans"], "wagering", process.env);
} else if (action && ["integration", "concurrency", "failure"].includes(action)) {
  const existing = await compose(["ps", "-aq"]);
  if (existing.trim())
    throw new Error("wagering-test already exists; refusing to replace its services");
  try {
    if (action === "failure") {
      Object.assign(testEnvironment, chaosEnvironment);
      // Bootstrap also uses the fault route, so populate proxies before it connects.
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
    }
    await composeUp();
    const child = Bun.spawn(
      ["bun", "--no-env-file", "test", `test/${action}`, "--timeout", "60000"],
      {
        env: { ...testEnvironment, WAGERING_STACK_MANAGED: "1" },
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    process.exitCode = await child.exited;
    if (process.exitCode !== 0) {
      console.error(await compose(["logs", "--no-log-prefix", "--no-color", "nginx"]));
    }
  } catch (error) {
    // Only our allowlisted JSON events are safe to retain as diagnostics.
    const logs = await compose([
      "logs",
      "--no-log-prefix",
      "--no-color",
      "bootstrap",
      "api",
      "consumer",
      "worker",
    ]);
    for (const line of logs.split("\n")) {
      if (line.startsWith("{")) console.error(line);
    }
    throw error;
  } finally {
    if (process.env.KEEP_STACK !== "1") await compose(["down", "--volumes", "--remove-orphans"]);
  }
} else {
  throw new Error("Expected up, down, integration, concurrency or failure");
}
