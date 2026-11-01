import "reflect-metadata";
import { afterAll, expect, test } from "bun:test";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Configuration } from "../../../src/config/config";
import { Dependencies } from "../../../src/observability/health/dependencies";
import { HealthController } from "../../../src/observability/health/health.controller";
import { configureShutdownReadiness } from "../../../src/observability/health/shutdown-readiness";
import { JsonLogger } from "../../../src/observability/json-logger";
import { LogContext } from "../../../src/observability/log-context";
import { configureHttp } from "../../../src/shared/http/configure-http";
import { assertLedgerInvariant, testDatabase } from "../../support/database";

const fixture = testDatabase();
afterAll(async () => {
  await assertLedgerInvariant(fixture.database);
  await fixture.database.onModuleDestroy();
});
@Module({})
class HealthProbeModule {}

test("readiness checks real dependencies then becomes 503 before provider drain, while liveness remains 200", async () => {
  const dependencies = new Dependencies({ values: fixture.values }, fixture.database);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const adapter = new FastifyAdapter();
  const app = await NestFactory.create<NestFastifyApplication>(
    {
      module: HealthProbeModule,
      controllers: [HealthController],
      providers: [
        { provide: Configuration, useValue: { values: fixture.values } },
        { provide: Dependencies, useValue: dependencies },
        LogContext,
        JsonLogger,
        {
          provide: "held-drain",
          useValue: {
            async onModuleDestroy() {
              entered.resolve();
              await release.promise;
            },
          },
        },
      ],
    },
    adapter,
    { logger: false, abortOnError: false },
  );
  configureHttp(app);
  configureShutdownReadiness(adapter, dependencies);
  await app.listen(0, "127.0.0.1");
  const url = await app.getUrl();
  let closing: Promise<void> | undefined;
  try {
    expect((await fetch(`${url}/health/ready`)).status).toBe(200);
    let finished = false;
    closing = app.close().then(() => {
      finished = true;
    });
    await entered.promise;
    expect(finished).toBe(false);
    expect((await fetch(`${url}/health/ready`)).status).toBe(503);
    expect((await fetch(`${url}/health/live`)).status).toBe(200);
    expect(finished).toBe(false);
  } finally {
    release.resolve();
    await (closing ?? app.close());
  }
});

test("a probe that began before shutdown cannot report ready after shutdown starts", async () => {
  const dependencies = new Dependencies({ values: fixture.values }, fixture.database);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  dependencies.sqs.middlewareStack.add(
    (next) => async (args) => {
      entered.resolve();
      await release.promise;
      return next(args);
    },
    { step: "initialize", name: "holdReadiness" },
  );
  try {
    const checking = dependencies.check();
    await entered.promise;
    dependencies.beginShutdown();
    release.resolve();
    expect(await checking).toBe(false);
  } finally {
    release.resolve();
    await dependencies.onModuleDestroy();
  }
});

test("readiness has a bounded response while SQS does not answer", async () => {
  const dependencies = new Dependencies({ values: fixture.values }, fixture.database);
  const release = Promise.withResolvers<void>();
  dependencies.sqs.middlewareStack.add(
    (next) => async (args) => {
      await release.promise;
      return next(args);
    },
    { step: "initialize", name: "holdReadinessTimeout" },
  );
  try {
    const start = performance.now();
    expect(await dependencies.check()).toBe(false);
    expect(performance.now() - start).toBeLessThan(3000);
  } finally {
    release.resolve();
    await dependencies.onModuleDestroy();
  }
});
