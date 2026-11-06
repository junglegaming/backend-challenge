import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './infrastructure/config/app-config';

const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(loadConfig().port);
