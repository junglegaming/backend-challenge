import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './infrastructure/config/app-config';
import { JsonLogger } from './infrastructure/observability/json-logger';

const app = await NestFactory.create(AppModule, { logger: new JsonLogger() });
app.enableShutdownHooks();
await app.listen(loadConfig().port);
