import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from './config';
import { ErrorFilter } from './infra/http/http';
import { logger } from './observability/logger';

const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
app.useGlobalFilters(new ErrorFilter());
app.enableShutdownHooks();

if (config.roles.has('api')) {
  await app.listen(config.port);
  logger.info({ port: config.port }, 'http listening');
} else {
  await app.init();
}
