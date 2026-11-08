import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { CreateQueueCommand, DeleteQueueCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SqsWagerConsumer } from '../../src/infrastructure/messaging/sqs-wager-consumer';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { PublishOutbox } from '../../src/application/outbox/publish-outbox';
import { SqlOutboxPublisherStore } from '../../src/infrastructure/persistence/outbox-publisher-store';
import { createTestApp, type TestApp } from './support/http-app';
import { createTestDatabase, type TestDatabase } from './support/test-database';
import { ConsumeWagerMessage } from '../../src/application/wagering/consume-wager-message';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';

const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
let db: TestDatabase;
let api: TestApp;
let sqs: SQSClient;
let queue: string;

beforeAll(async () => {
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  db = await createTestDatabase();
  api = await createTestApp(db);
  sqs = new SQSClient({ region: 'us-east-1', endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const result = await sqs.send(new CreateQueueCommand({ QueueName: `tracing-${randomUUID()}.fifo`, Attributes: { FifoQueue: 'true' } }));
  if (!result.QueueUrl) throw new Error('Queue URL missing');
  queue = result.QueueUrl;
});

afterAll(async () => {
  await api?.close();
  if (queue) await sqs.send(new DeleteQueueCommand({ QueueUrl: queue }));
  sqs?.destroy();
  await db?.drop();
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

test('HTTP parent, PostgreSQL, persisted outbox, SQS producer and consumer share one trace', async () => {
  const traceId = '1234567890abcdef1234567890abcdef';
  const parentId = '1234567890abcdef';
  const playerId = randomUUID();
  const result = await fetch(`${api.url}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', traceparent: `00-${traceId}-${parentId}-01` },
    body: JSON.stringify({ playerId, initialBalance: { amount: '98765.43', currency: 'BRL' } }),
  });
  expect(result.status).toBe(201);
  const wallet = await result.json() as { id: string };
  const publisher = new PublishOutbox(new SqlOutboxPublisherStore(db.orm.em), new SqsEventPublisher(sqs, queue),
    { now: () => new Date() }, { error: () => { throw new Error('Unexpected publish failure'); } });
  expect(await publisher.runOne()).toBe(true);
  const response = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queue, WaitTimeSeconds: 2, MessageAttributeNames: ['All'] }));
  const received = response.Messages?.[0];
  if (!received) throw new Error('Missing published message');
  expect(received.MessageAttributes?.traceparent?.StringValue).toContain(traceId);
  const process = new ProcessWagerTransaction(new MikroOrmUnitOfWork(db.orm.em), { now: () => new Date() }, { next: randomUUID });
  const consumer = new SqsWagerConsumer(sqs, queue, new ConsumeWagerMessage(process));
  const id = randomUUID();
  await consumer.handle({ ...received, Body: JSON.stringify({ messageId: id, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
    data: { idempotencyKey: id, externalTransactionId: id, providerId: 'provider', walletId: wallet.id, playerId,
      roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '1.00', currency: 'BRL' } } }) });
  await provider.forceFlush();
  const spans = exporter.getFinishedSpans();
  const http = spans.find((s) => s.name === 'HTTP request' && s.spanContext().traceId === traceId);
  const sql = spans.find((s) => s.name === 'PostgreSQL query' && s.spanContext().traceId === traceId);
  const send = spans.find((s) => s.name === 'SQS publish' && s.spanContext().traceId === traceId);
  const consumerSpan = spans.find((s) => s.name === 'SQS process' && s.spanContext().traceId === traceId);
  expect(http?.parentSpanContext?.spanId).toBe(parentId);
  expect(sql?.parentSpanContext?.spanId).toBe(http?.spanContext().spanId);
  expect(send?.parentSpanContext?.spanId).toBe(http?.spanContext().spanId);
  expect(consumerSpan?.parentSpanContext?.spanId).toBe(send?.spanContext().spanId);
  expect(JSON.stringify(spans.map((s) => s.attributes))).not.toContain('98765.43');
});
