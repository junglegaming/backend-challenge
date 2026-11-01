import { expect, test } from "bun:test";

test("JSON logger restricts fields and ignores untrusted Nest messages in concurrent async contexts", async () => {
  const child = Bun.spawn(
    [
      "bun",
      "--no-env-file",
      "--no-install",
      "--eval",
      `
    import { JsonLogger } from "./src/observability/json-logger";
    import { LogContext } from "./src/observability/log-context";
    const context = new LogContext();
    const logger = new JsonLogger({ values: { role: "api" } }, context);
    const unsafe = { amount: "876543.21", balance: "987654.32", Authorization: "Bearer secret-token", payload: { token: "secret-token" } };
    await Promise.all(Array.from({ length: 20 }, (_, i) => context.run({ correlationId: "corr-" + i, walletId: "wallet-" + i }, async () => {
      await Bun.sleep(i % 3);
      logger.info({ event: "isolated", ...unsafe, index: i });
      logger.error(unsafe, unsafe); logger.warn(unsafe); logger.log(unsafe); logger.debug(unsafe); logger.verbose(unsafe); logger.fatal(unsafe);
    })));
    logger.info({ event: "outside" });
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(0);
  expect(error).toBe("");
  for (const forbidden of [
    "876543.21",
    "987654.32",
    "Bearer",
    "secret-token",
    "Authorization",
    '"payload"',
    '"amount"',
    '"balance"',
    '"index"',
  ])
    if (output.includes(forbidden)) throw new Error("Sensitive data in JSON logger output");
  const logs = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(logs).toHaveLength(141);
  for (const record of logs.filter((row) => row.event !== "outside")) {
    expect(record.walletId).toBe(record.correlationId.replace("corr-", "wallet-"));
    expect(record.role).toBe("api");
    expect(typeof record.instanceId).toBe("string");
  }
  expect(logs.at(-1)).not.toHaveProperty("correlationId");
  expect(logs.at(-1)).not.toHaveProperty("walletId");
});
