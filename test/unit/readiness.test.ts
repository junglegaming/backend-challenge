import "reflect-metadata";
import { expect, test } from "bun:test";
import { ReadinessService } from "../../src/infrastructure/health/health";

test("a failing dependency is reported as 'unavailable' — the raw error only goes to the log", async () => {
  const logged: unknown[] = [];
  const logger = { debug() {}, info() {}, warn: (o: unknown) => logged.push(o), error() {} };
  const readiness = new ReadinessService(
    [
      { name: "postgres", check: async () => {} },
      {
        name: "sqs",
        check: async () => {
          throw new Error("connect ECONNREFUSED 10.0.3.17:4566 (internal-sqs.prod.local)");
        },
      },
    ],
    logger,
  );

  const report = await readiness.report();
  expect(report.status).toBe("not_ready");
  expect(report.checks.postgres).toMatchObject({ ok: true });
  expect(report.checks.sqs).toMatchObject({ ok: false, error: "unavailable" });
  expect(JSON.stringify(report)).not.toContain("10.0.3.17");
  expect(logged).toHaveLength(1);
});

test("draining reports not ready without touching the dependencies", async () => {
  let calls = 0;
  const readiness = new ReadinessService([{ name: "postgres", check: async () => void calls++ }]);
  readiness.markDraining();
  expect(await readiness.report()).toEqual({
    status: "not_ready",
    checks: { shutdown: { ok: false, latencyMs: 0, error: "draining" } },
  });
  expect(calls).toBe(0);
});
