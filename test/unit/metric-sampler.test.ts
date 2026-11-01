import { expect, test } from "bun:test";
import type { Dependencies } from "../../src/observability/health/dependencies";
import { MetricSampler } from "../../src/observability/metric-sampler";
import type { WageringTelemetry } from "../../src/observability/wagering-telemetry";
import type { Database } from "../../src/shared/infrastructure/database";

for (const queuesFail of [true, false]) {
  test(`a held SQL sample stays singular while ${queuesFail ? "failing" : "healthy"} queues continue sampling`, async () => {
    const release = Promise.withResolvers<void>();
    const refreshed = Promise.withResolvers<void>();
    let queries = 0;
    let outstanding = 0;
    let maximum = 0;
    let queueChecks = 0;
    let queueUpdates = 0;
    const database = {
      orm: Promise.resolve({
        em: {
          getConnection: () => ({
            execute: async () => {
              queries++;
              maximum = Math.max(maximum, ++outstanding);
              try {
                await release.promise;
                return [{ lag: "0", pending: 0 }];
              } finally {
                outstanding--;
              }
            },
          }),
        },
      }),
    } as unknown as Database;
    const dependencies = {
      queueAttributes: async () => {
        if (++queueChecks >= 9) refreshed.resolve();
        if (queuesFail) throw new Error("Queue unavailable");
        return {
          ApproximateNumberOfMessages: "1",
          ApproximateNumberOfMessagesNotVisible: "0",
          ApproximateNumberOfMessagesDelayed: "0",
        };
      },
    } as unknown as Dependencies;
    const telemetry = {
      logger: { warning() {}, info() {} },
      outboxLag: { set() {} },
      pending: { set() {} },
      queue: {
        set() {
          queueUpdates++;
        },
      },
    } as unknown as WageringTelemetry;
    const sampler = new MetricSampler(database, dependencies, telemetry);
    sampler.onModuleInit();
    try {
      // Third queue cycle is the observed event: no arbitrary sleep or dependency timeout.
      await refreshed.promise;
      expect(queries).toBe(1);
      expect(maximum).toBe(1);
      expect(outstanding).toBe(1);
      if (!queuesFail) expect(queueUpdates).toBeGreaterThanOrEqual(18);
      let drained = false;
      const closing = sampler.onModuleDestroy().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      release.resolve();
      await closing;
      expect(outstanding).toBe(0);
      expect(queries).toBe(1);
    } finally {
      release.resolve();
      await sampler.onModuleDestroy();
    }
  }, 10_000);
}
