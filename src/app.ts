import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { type AppConfig, loadConfig } from './infrastructure/config/app-config';
import { createRootLogger, NestPinoLogger } from './infrastructure/observability/logger';

/**
 * Builds a fully wired (not yet listening) application. Used by main.ts and
 * by tests. Signal handling lives in main.ts, so callers own the lifecycle.
 */
export const createApp = async (config: AppConfig = loadConfig()): Promise<INestApplication> => {
  const rootLogger = createRootLogger(config.LOG_LEVEL, config.INSTANCE_ID);
  const app = await NestFactory.create(AppModule.forRoot(config, rootLogger), {
    logger: new NestPinoLogger(rootLogger),
    abortOnError: false,
  });
  return app;
};
