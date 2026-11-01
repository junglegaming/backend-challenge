import "reflect-metadata";
import { hostname } from "node:os";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import pino from "pino";
import { AppModule } from "./app.module";
import { Configuration } from "./config/config";
import { configureHttp } from "./shared/http/configure-http";

const logger = pino();
try {
  process.env.TZ = "UTC";
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
    abortOnError: false,
  });
  const config = app.get(Configuration).values;
  configureHttp(app);
  app.enableShutdownHooks();
  await app.listen(config.port, "0.0.0.0");
  logger.info({ event: "application_started", role: config.role, instanceId: hostname() });
} catch {
  // Configuration and dependency errors may contain credentials: log only a stable event.
  logger.error({ event: "application_start_failed" });
  process.exit(1);
}
