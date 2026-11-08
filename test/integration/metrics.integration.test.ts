import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { CreateQueueCommand, DeleteQueueCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { SqsWagerConsumer } from '../../src/infrastructure/messaging/sqs-wager-consumer';
import { PendingReferenceWorker } from '../../src/infrastructure/system/pending-reference-worker';
import { OutboxPublisherWorker } from '../../src/infrastructure/system/outbox-publisher-worker';
import { createTestDatabase, type TestDatabase } from './support/test-database';
import { PublishOutbox } from '../../src/application/outbox/publish-outbox';
import { SqlOutboxPublisherStore } from '../../src/infrastructure/persistence/outbox-publisher-store';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';

let db: TestDatabase;
let app: INestApplication;
let sqs: SQSClient;
const queues: string[] = [];
const previous = { ...process.env };

beforeAll(async () => {
  db = await createTestDatabase();
  const endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
  sqs = new SQSClient({ region: 'us-east-1', endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  for (let i = 0; i < 3; i++) {
    const result = await sqs.send(new CreateQueueCommand({ QueueName: `metrics-${randomUUID()}.fifo`, Attributes: { FifoQueue: 'true' } }));
    if (!result.QueueUrl) throw new Error('Queue URL missing');
    queues.push(result.QueueUrl);
  }
  Object.assign(process.env, {
    DATABASE_URL: db.url, AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test',
    SQS_ENDPOINT: endpoint, SQS_QUEUE_URL: queues[0], SQS_DLQ_URL: queues[1], SQS_EVENTS_QUEUE_URL: queues[2],
  });
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
  for (const queue of queues) await sqs.send(new DeleteQueueCommand({ QueueUrl: queue }));
  sqs?.destroy();
  await db?.drop();
  for (const key of ['DATABASE_URL', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'SQS_ENDPOINT', 'SQS_QUEUE_URL', 'SQS_DLQ_URL', 'SQS_EVENTS_QUEUE_URL']) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

test('scrape reads the real DLQ and oldest unpublished outbox event', async () => {
  await sqs.send(new SendMessageCommand({ QueueUrl: queues[1], MessageBody: '{}', MessageGroupId: 'test', MessageDeduplicationId: randomUUID() }));
  const url = await app.getUrl();
  const response = await fetch(`${url}/wallets`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-correlation-id': 'end-to-end-trace' },
    body: JSON.stringify({ playerId: randomUUID(), initialBalance: { amount: '10.00', currency: 'BRL' } }),
  });
  expect(response.status).toBe(201);
  await db.run(`update outbox_messages set occurred_at = now() - interval '30 seconds'`);
  const scrape = await fetch(`${url}/metrics`);
  expect(scrape.status).toBe(200);
  const text = await scrape.text();
  expect(text).toContain('wager_dlq_messages 1');
  const lag = text.match(/^wager_outbox_oldest_unpublished_seconds (\S+)$/m);
  expect(Number(lag?.[1])).toBeGreaterThanOrEqual(30);
  const publisher = new PublishOutbox(new SqlOutboxPublisherStore(db.orm.em), new SqsEventPublisher(sqs, queues[2]!),
    { now: () => new Date() }, { error: () => { throw new Error('Unexpected publication failure'); } });
  expect(await publisher.runOne()).toBe(true);
  const delivered = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queues[2], WaitTimeSeconds: 2 }));
  const event = JSON.parse(delivered.Messages?.[0]?.Body ?? '{}') as { correlationId?: string };
  expect(event.correlationId).toBe('end-to-end-trace');
});

test('load command exercises all scenarios, duplicates and ledger validation', async () => {
  const child = Bun.spawn(['bun', 'scripts/load-test.ts'], {
    env: { ...process.env, LOAD_BASE_URL: await app.getUrl(), LOAD_REQUESTS: '6', LOAD_WALLETS: '2', LOAD_CONCURRENCY: '3' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(stderr).toBe('');
  expect(status).toBe(0);
  const report = JSON.parse(stdout) as {
    scenarios: { scenario: string; errors: number; duplicates: { expected: number; observed: number; violations: number } }[];
    reconciliation: { walletsCreated: number; checked: number; failures: string[] };
  };
  expect(report.scenarios.map((scenario) => scenario.scenario)).toEqual(['many-wallets', 'hot-wallet', 'mixed-duplicates']);
  expect(report.scenarios.every((scenario) => scenario.errors === 0)).toBe(true);
  expect(report.scenarios[2]?.duplicates).toEqual({ expected: 3, observed: 3, violations: 0 });
  expect(report.reconciliation).toEqual({ walletsCreated: 5, checked: 5, failures: [] });
});
