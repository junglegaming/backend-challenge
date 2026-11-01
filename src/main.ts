import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import pino from "pino";
import { AppModule } from "./app.module";
import { Configuration } from "./config/config";
import { Dependencies } from "./observability/health/dependencies";
import { configureShutdownReadiness } from "./observability/health/shutdown-readiness";
import { JsonLogger } from "./observability/json-logger";
import { configureHttp } from "./shared/http/configure-http";

try {
  process.env.TZ = "UTC";
  const adapter = new FastifyAdapter();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: false,
    abortOnError: false,
  });
  const config = app.get(Configuration).values;
  const logger = app.get(JsonLogger);
  app.useLogger(logger);
  configureShutdownReadiness(adapter, app.get(Dependencies));
  configureHttp(app);
  app.enableShutdownHooks(undefined, { useProcessExit: true });
  await app.listen(config.port, "0.0.0.0");
  logger.info({ event: "application_started" });
} catch {
  // Configuration and dependency errors may contain credentials: log only a stable event.
  pino({ base: undefined }).error({ event: "application_start_failed" });
  process.exit(1);
}
