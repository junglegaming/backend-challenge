import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';
import { ConsumeWagerMessage } from '../../../src/application/wagering/consume-wager-message';
import { ProcessWagerTransaction } from '../../../src/application/wagering/process-wager-transaction';
import { buildOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SqsWagerConsumer } from '../../../src/infrastructure/messaging/sqs-wager-consumer';
import { SystemClock, UuidV7Generator } from '../../../src/infrastructure/system/system-clock-and-ids';

const database = process.env.TEST_DATABASE_URL;
const queue = process.env.TEST_QUEUE_URL;
if (!database || !queue) throw new Error('test database and queue are required');
const orm = await MikroORM.init(buildOrmConfig(database));
const sqs = new SQSClient({
  region: 'us-east-1', endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});
const useCase = new ProcessWagerTransaction(new MikroOrmUnitOfWork(orm.em), new SystemClock(), new UuidV7Generator());

@Module({
  providers: [{ provide: SqsWagerConsumer, useValue: new SqsWagerConsumer(sqs, queue, new ConsumeWagerMessage(useCase)) }],
})
class TestModule {}

const app = await NestFactory.createApplicationContext(TestModule, { logger: false });
app.enableShutdownHooks();
console.log('READY');
