import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';

describe('GET /health/live', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres://wagering:wagering@localhost:5432/wagering';
    process.env.SQS_QUEUE_URL ??= 'http://localhost:4566/000000000000/wager-transactions.fifo';
    process.env.SQS_DLQ_URL ??= 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo';
    process.env.SQS_EVENTS_QUEUE_URL ??= 'http://localhost:4566/000000000000/wager-events.fifo';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
});
