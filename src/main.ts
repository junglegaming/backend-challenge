import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from './infrastructure/config/app-config';
import { JsonLogger } from './infrastructure/observability/json-logger';
import { startTracing } from './infrastructure/observability/tracing-sdk';

const tracing = startTracing();
const { AppModule } = await import('./app.module');
const app = await NestFactory.create(AppModule, { logger: new JsonLogger() });
app.enableShutdownHooks();
await app.listen(loadConfig().port);
if (tracing) {
  app.getHttpServer().on('close', () => {
    void tracing.shutdown().catch(() => new JsonLogger('Tracing').error('OpenTelemetry shutdown failed'));
  });
}
