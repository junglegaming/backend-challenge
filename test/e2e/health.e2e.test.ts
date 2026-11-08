import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SqsWagerConsumer } from '../../src/infrastructure/messaging/sqs-wager-consumer';
import { OutboxPublisherWorker } from '../../src/infrastructure/system/outbox-publisher-worker';
import { PendingReferenceWorker } from '../../src/infrastructure/system/pending-reference-worker';

describe('GET /health/live', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres://wagering:wagering@localhost:5432/wagering';
    process.env.SQS_QUEUE_URL ??= 'http://localhost:4566/000000000000/wager-transactions.fifo';
    process.env.SQS_DLQ_URL ??= 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo';
    process.env.SQS_EVENTS_QUEUE_URL ??= 'http://localhost:4566/000000000000/wager-events.fifo';
    process.env.SQS_ENDPOINT ??= 'http://localhost:4566';
    process.env.AWS_ACCESS_KEY_ID ??= 'test';
    process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
    const { AppModule } = await import('../../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SqsWagerConsumer).useValue({})
      .overrideProvider(OutboxPublisherWorker).useValue({})
      .overrideProvider(PendingReferenceWorker).useValue({})
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
  });

  afterAll(async () => {
    await app?.close();
  });

  test('is open (no auth) and returns ok', async () => {
    const res = await fetch(`${await app.getUrl()}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  test('/health/ready reports postgres and sqs, 503 when any is down', async () => {
    const res = await fetch(`${await app.getUrl()}/health/ready`);
    const body = (await res.json()) as { status: string; checks: Record<string, string> };
    expect(Object.keys(body.checks).sort()).toEqual(['postgres', 'sqs']);
    expect(res.status).toBe(body.status === 'ok' ? 200 : 503);
  });
});
