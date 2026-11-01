import "reflect-metadata";
import { hostname } from "node:os";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import pino from "pino";
import { AppModule } from "./app.module";
import { Configuration } from "./config/config";

const logger = pino();
try {
  process.env.TZ = "UTC";
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
    abortOnError: false,
  });
  const config = app.get(Configuration).values;
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.enableShutdownHooks();
  await app.listen(config.port, "0.0.0.0");
  logger.info({ event: "application_started", role: config.role, instanceId: hostname() });
} catch {
  // Configuration and dependency errors may contain credentials: log only a stable event.
  logger.error({ event: "application_start_failed" });
  process.exit(1);
}
