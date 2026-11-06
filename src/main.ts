import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.enableShutdownHooks([], { useProcessExit: true });
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
void bootstrap();
