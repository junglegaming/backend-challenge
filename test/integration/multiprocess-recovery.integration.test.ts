import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand, ReceiveMessageCommand, SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { expectWalletMatchesLedger } from './support/http-app';
import { createTestDatabase, type TestDatabase } from './support/test-database';

let db: TestDatabase;
let sqs: SQSClient;
let queue: string;
let events: string;
let dlq: string;
const children: ReturnType<typeof Bun.spawn>[] = [];
const endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';

beforeAll(async () => {
  db = await createTestDatabase();
  sqs = new SQSClient({ region: 'us-east-1', endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const create = async (label: string) => {
    const result = await sqs.send(new CreateQueueCommand({
      QueueName: `multiprocess-${label}-${randomUUID()}.fifo`,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }));
    if (!result.QueueUrl) throw new Error('Queue URL missing');
    return result.QueueUrl;
  };
  queue = await create('input');
  events = await create('events');
  dlq = await create('dlq');
});

afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await child.exited;
  }
  for (const url of [queue, events, dlq]) if (url) await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
  sqs?.destroy();
  await db?.drop();
});

async function start() {
  const child = Bun.spawn(['bun', 'test/integration/support/service-process.ts'], {
    env: { ...process.env, DATABASE_URL: db.url, SQS_ENDPOINT: endpoint, SQS_QUEUE_URL: queue,
      SQS_DLQ_URL: dlq, SQS_EVENTS_QUEUE_URL: events, AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', LOCK_TIMEOUT_MS: '15000' },
    stdout: 'pipe', stderr: 'inherit',
  });
  children.push(child);
  const reader = child.stdout.getReader();
  let output = '';
  const deadline = AbortSignal.timeout(15000);
  for (;;) {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => deadline.addEventListener('abort', () => reject(new Error(`Service startup timed out: ${output}`)), { once: true })),
    ]);
    if (result.done) throw new Error(`Service exited during startup: ${output}`);
    output += new TextDecoder().decode(result.value);
    const match = output.match(/READY:(http:\/\/[^\s]+)/);
    if (match?.[1]) return { child, url: match[1] };
  }
}

async function post(url: string, path: string, body: unknown, key?: string) {
  const response = await fetch(`${url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function waitUntil(check: () => Promise<boolean>, description: string) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

describe('real service processes and recovery', () => {
  test('three simultaneously running instances contend for the same wallet without lost updates', async () => {
    const services = await Promise.all([start(), start(), start()]);
    expect(new Set(services.map((s) => s.child.pid)).size).toBe(3);
    const playerId = randomUUID();
    const created = await post(services[0]!.url, '/wallets', { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    expect(created.status).toBe(201);
    const walletId = String(created.body.id);
    const holder = db.orm.em.fork();
    await holder.begin();
    await holder.getConnection().execute('select id from wallets where id = ? for no key update', [walletId], 'all', holder.getTransactionContext());
    const requests = services.map((service) => {
      const external = randomUUID();
      return post(service.url, '/wagering/transactions', {
        providerId: 'provider', externalTransactionId: external, playerId, walletId,
        roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '40.00', currency: 'BRL' },
      }, external);
    });
    try {
      await waitUntil(async () => {
        const [row] = await db.run<{ count: string }>(
          `select count(*) as count from pg_stat_activity where datname = current_database()
           and wait_event_type = 'Lock' and query ilike '%from wallets where id%'`,
        );
        return Number(row!.count) >= 3;
      }, 'three blocked service processes');
    } finally {
      await holder.rollback();
    }
    const results = await Promise.all(requests);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 422]);
    const [wallet] = await db.run<{ balance: string; version: number }>('select balance, version from wallets where id = ?', [walletId]);
    expect(wallet).toEqual({ balance: '20.00', version: 3 });
    expect(await db.run("select id from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'", [walletId])).toHaveLength(2);
    await expectWalletMatchesLedger(db, walletId);
  });

  test('restart of the service processes messages received while it was down and preserves committed state', async () => {
    const service = await start();
    const playerId = randomUUID();
    const created = await post(service.url, '/wallets', { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    expect(created.status).toBe(201);
    const walletId = String(created.body.id);
    service.child.kill('SIGKILL');
    await service.child.exited;
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await child.exited;
    }
    // Let abandoned SQS long polls expire before enqueuing during downtime.
    await Bun.sleep(11_000);
    const messageId = randomUUID();
    const external = randomUUID();
    await sqs.send(new SendMessageCommand({
      QueueUrl: queue, MessageGroupId: walletId, MessageDeduplicationId: messageId,
      MessageBody: JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
        data: { providerId: 'provider', externalTransactionId: external, idempotencyKey: external,
          playerId, walletId, roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '30.00', currency: 'BRL' } } }),
    }));
    expect(await db.run('select message_id from inbox_messages where message_id = ?', [messageId])).toHaveLength(0);
    const restarted = await start();
    expect(restarted.child.pid).not.toBe(service.child.pid);
    await waitUntil(async () => (await db.run('select message_id from inbox_messages where message_id = ? and processed_at is not null', [messageId])).length === 1,
      'restarted consumer commit');
    await waitUntil(async () => (await db.run('select id from outbox_messages where aggregate_id = ? and published_at is null', [walletId])).length === 0,
      'restarted outbox publisher');
    const expectedEvents = await db.run<{ id: string }>('select id from outbox_messages where aggregate_id = ?', [walletId]);
    expect(expectedEvents).toHaveLength(4);
    const received = new Set<string>();
    await waitUntil(async () => {
      const response = await sqs.send(new ReceiveMessageCommand({ QueueUrl: events, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
      for (const msg of response.Messages ?? []) {
        if (!msg.Body || !msg.ReceiptHandle) throw new Error('Invalid event message');
        const event = JSON.parse(msg.Body) as { eventId: string };
        received.add(event.eventId);
        await sqs.send(new DeleteMessageCommand({ QueueUrl: events, ReceiptHandle: msg.ReceiptHandle }));
      }
      return expectedEvents.every((e) => received.has(e.id));
    }, 'events delivered to SQS after restart');
    const [wallet] = await db.run<{ balance: string; version: number }>('select balance, version from wallets where id = ?', [walletId]);
    expect(wallet).toEqual({ balance: '70.00', version: 2 });
    expect(await db.run("select id from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'", [walletId])).toHaveLength(1);
    await expectWalletMatchesLedger(db, walletId);
  });
});
