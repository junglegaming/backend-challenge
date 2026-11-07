import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand, ReceiveMessageCommand, SQSClient,
} from '@aws-sdk/client-sqs';
import { PublishOutbox, type EventPublisher } from '../../src/application/outbox/publish-outbox';
import { OpenWallet } from '../../src/application/wagering/open-wallet';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-enums';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SqlOutboxPublisherStore } from '../../src/infrastructure/persistence/outbox-publisher-store';
import { OutboxPublisherWorker } from '../../src/infrastructure/system/outbox-publisher-worker';
import { expectWalletMatchesLedger } from './support/http-app';
import { createTestDatabase, type TestDatabase } from './support/test-database';

let db: TestDatabase;
let sqs: SQSClient;
let queueUrl: string;
let open: OpenWallet;
let process: ProcessWagerTransaction;
let publisher: SqsEventPublisher;
let now: Date;
const clock = { now: () => new Date(now) };
const ids = { next: randomUUID };
const logged: unknown[] = [];
const logger = { error: (_message: string, error: unknown) => { logged.push(error); } };

beforeAll(async () => {
  db = await createTestDatabase();
  sqs = new SQSClient({
    region: 'us-east-1', endpoint: processEnvEndpoint(),
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1,
  });
  const queue = await sqs.send(new CreateQueueCommand({
    QueueName: `outbox-test-${randomUUID()}.fifo`,
    Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
  }));
  if (!queue.QueueUrl) throw new Error('SQS did not return a queue URL');
  queueUrl = queue.QueueUrl;
  now = new Date(Date.now() + 1000);
  const uow = new MikroOrmUnitOfWork(db.orm.em.fork());
  open = new OpenWallet(uow, clock, ids);
  process = new ProcessWagerTransaction(uow, clock, ids);
  publisher = new SqsEventPublisher(sqs, queueUrl);
});

afterAll(async () => {
  if (queueUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  sqs?.destroy();
  await db?.drop();
});

beforeEach(() => {
  now = new Date(Date.now() + 60_000);
});

function processEnvEndpoint(): string {
  return globalThis.process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
}

function worker(sender: EventPublisher = publisher) {
  return new PublishOutbox(new SqlOutboxPublisherStore(db.orm.em), sender, clock, logger);
}

async function drain() {
  const bodies: Record<string, unknown>[] = [];
  for (;;) {
    const response = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
    if (!response.Messages?.length) return bodies;
    for (const message of response.Messages) {
      if (!message.Body || !message.ReceiptHandle) throw new Error('SQS message is incomplete');
      bodies.push(JSON.parse(message.Body) as Record<string, unknown>);
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }
  }
}

async function publishAll() {
  while (await worker().runOne()) { /* drain committed rows */ }
}

describe('transactional outbox with PostgreSQL and SQS', () => {
  test('two concurrent publishers claim all four event types without losing messages', async () => {
    const w = await open.execute({ playerId: randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } });
    const submit = (kind: WagerTransactionKind, amount: string, reference?: string) => {
      const externalTransactionId = randomUUID();
      return process.execute({
        idempotencyKey: externalTransactionId, externalTransactionId, providerId: 'provider', playerId: w.playerId,
        walletId: w.id, roundId: 'round', gameId: 'game', kind,
        money: { amount, currency: 'BRL' }, referenceExternalTransactionId: reference,
      });
    };
    await submit(WagerTransactionKind.Bet, '10.00');
    await submit(WagerTransactionKind.Bet, '1000.00');
    await submit(WagerTransactionKind.Refund, '1.00', randomUUID());
    const rows = await db.run<{ id: string; event_type: string }>('select id, event_type from outbox_messages');
    expect(new Set(rows.map((r) => r.event_type))).toEqual(new Set([
      'WagerTransactionProcessed', 'WagerTransactionRejected', 'WagerTransactionPendingReference', 'WalletBalanceChanged',
    ]));
    const run = async () => {
      const p = worker();
      while (await p.runOne()) { /* drain committed rows */ }
    };
    await Promise.all([run(), run()]);
    const remaining = await db.run('select id from outbox_messages where published_at is null');
    expect(remaining).toHaveLength(0);
    const events = await drain();
    expect(events).toHaveLength(rows.length);
    expect(new Set(events.map((e) => e.eventId))).toEqual(new Set(rows.map((r) => r.id)));
    for (const event of events) {
      expect(event.version).toBe(1);
      const data = event.data as { money: { amount: unknown; currency: unknown } };
      expect(typeof data.money.amount).toBe('string');
      expect(data.money.currency).toBe('BRL');
    }
    await expectWalletMatchesLedger(db, w.id);
  });

  test('process killed after commit before publication: another instance publishes committed events', async () => {
    const child = Bun.spawn(['bun', 'test/integration/support/outbox-crash-producer.ts'], {
      env: { ...globalThis.process.env, TEST_DATABASE_URL: db.url }, stdout: 'pipe', stderr: 'inherit',
    });
    let walletId: string;
    try {
      const reader = child.stdout.getReader();
      const result = await reader.read();
      const match = new TextDecoder().decode(result.value).match(/COMMITTED:([0-9a-f-]+)/);
      if (!match?.[1]) throw new Error('producer did not commit a wallet');
      walletId = match[1];
    } finally {
      child.kill('SIGKILL');
      await child.exited;
    }
    const pending = await db.run<{ id: string }>('select id from outbox_messages where aggregate_id = ? and published_at is null', [walletId]);
    expect(pending).toHaveLength(2);
    await publishAll();
    const delivered = await drain();
    expect(new Set(delivered.map((e) => e.eventId))).toEqual(new Set(pending.map((r) => r.id)));
    await expectWalletMatchesLedger(db, walletId);
  });

  test('a locked message is skipped and a different publisher can publish another message', async () => {
    const w = await open.execute({ playerId: randomUUID(), initialBalance: { amount: '10.00', currency: 'BRL' } });
    const [locked] = await db.run<{ id: string }>(
      'select id from outbox_messages where aggregate_id = ? order by next_attempt_at, id limit 1', [w.id],
    );
    const holder = db.orm.em.fork();
    await holder.begin();
    try {
      await holder.getConnection().execute('select id from outbox_messages where id = ? for update', [locked!.id], 'all', holder.getTransactionContext());
      expect(await worker().runOne()).toBe(true);
      const state = await db.run<{ id: string; published: boolean }>(
        'select id, published_at is not null as published from outbox_messages where aggregate_id = ?', [w.id],
      );
      expect(state.find((r) => r.id === locked!.id)?.published).toBe(false);
      expect(state.find((r) => r.id !== locked!.id)?.published).toBe(true);
    } finally {
      await holder.rollback();
    }
    await publishAll();
    expect(await drain()).toHaveLength(2);
    await expectWalletMatchesLedger(db, w.id);
  });

  test('publication succeeds but database mark fails: retry uses same eventId and FIFO suppresses duplicate', async () => {
    const w = await open.execute({ playerId: randomUUID(), initialBalance: { amount: '5.00', currency: 'BRL' } });
    await db.run(`create function test_fail_publish_mark() returns trigger language plpgsql as $$
      begin if new.published_at is not null then raise exception 'test mark failure'; end if; return new; end $$`);
    await db.run('create trigger test_fail_publish_mark before update on outbox_messages for each row execute function test_fail_publish_mark()');
    try {
      await expect(worker().runOne()).rejects.toThrow('test mark failure');
    } finally {
      await db.run('drop trigger test_fail_publish_mark on outbox_messages');
      await db.run('drop function test_fail_publish_mark()');
    }
    expect(await db.run('select id from outbox_messages where aggregate_id = ? and published_at is null', [w.id])).toHaveLength(2);
    await publishAll();
    const delivered = await drain();
    expect(delivered).toHaveLength(2);
    expect(new Set(delivered.map((e) => e.eventId)).size).toBe(2);
    await expectWalletMatchesLedger(db, w.id);
  });

  test('SQS failure is logged and commits exponential retry; later publication succeeds', async () => {
    const w = await open.execute({ playerId: randomUUID(), initialBalance: { amount: '5.00', currency: 'BRL' } });
    const failure = new Error('SQS unavailable');
    const broken: EventPublisher = { publish: async () => { throw failure; } };
    await db.run(`update outbox_messages set next_attempt_at = ?::timestamptz
      where id = (select id from outbox_messages where aggregate_id = ? order by id limit 1)`,
    [new Date(now.getTime() + 60_000).toISOString(), w.id]);
    expect(await worker(broken).runOne()).toBe(true);
    const [row] = await db.run<{ id: string; attempts: number; next_attempt_at: string }>(
      'select id, attempts, next_attempt_at from outbox_messages where aggregate_id = ? and attempts = 1', [w.id],
    );
    expect(row).toBeDefined();
    expect(new Date(row!.next_attempt_at).getTime() - now.getTime()).toBe(1000);
    expect(logged).toContain(failure);
    now = new Date(now.getTime() + 1000);
    expect(await worker(broken).runOne()).toBe(true);
    const [again] = await db.run<{ attempts: number; next_attempt_at: string }>('select attempts, next_attempt_at from outbox_messages where id = ?', [row!.id]);
    expect(again!.attempts).toBe(2);
    expect(new Date(again!.next_attempt_at).getTime() - now.getTime()).toBe(2000);
    now = new Date(now.getTime() + 60_000);
    await publishAll();
    expect(await drain()).toHaveLength(2);
    await expectWalletMatchesLedger(db, w.id);
  });

  test('scheduler publishes and shuts down without losing a committed event', async () => {
    const w = await open.execute({ playerId: randomUUID(), initialBalance: { amount: '3.00', currency: 'BRL' } });
    const scheduled = new OutboxPublisherWorker(worker());
    scheduled.onModuleInit();
    try {
      const deadline = Date.now() + 8000;
      while ((await db.run('select id from outbox_messages where aggregate_id = ? and published_at is null', [w.id])).length && Date.now() < deadline) {
        await Bun.sleep(50);
      }
      expect(await db.run('select id from outbox_messages where aggregate_id = ? and published_at is null', [w.id])).toHaveLength(0);
    } finally {
      await scheduled.onModuleDestroy();
    }
    expect(await drain()).toHaveLength(2);
    await expectWalletMatchesLedger(db, w.id);
  });
});
