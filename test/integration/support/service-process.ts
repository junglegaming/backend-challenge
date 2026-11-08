import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

const { AppModule } = await import('../../../src/app.module');
const app = await NestFactory.create(AppModule, { logger: false });
app.enableShutdownHooks();
await app.listen(0, '127.0.0.1');
console.log(`READY:${await app.getUrl()}`);
