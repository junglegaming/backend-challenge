import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  ChangeMessageVisibilityCommand, CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand, GetQueueAttributesCommand,
  ReceiveMessageCommand, SendMessageCommand, SQSClient, type Message,
} from '@aws-sdk/client-sqs';
import { ConsumeWagerMessage } from '../../src/application/wagering/consume-wager-message';
import { OpenWallet } from '../../src/application/wagering/open-wallet';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-enums';
import { SqsWagerConsumer } from '../../src/infrastructure/messaging/sqs-wager-consumer';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { expectWalletMatchesLedger } from './support/http-app';
import { createTestDatabase, type TestDatabase } from './support/test-database';

let db: TestDatabase;
let sqs: SQSClient;
let url: string;
let dlqUrl: string;
let open: OpenWallet;
let processWager: ProcessWagerTransaction;
let consumer: SqsWagerConsumer;
const clock = { now: () => new Date() };
const ids = { next: randomUUID };

beforeAll(async () => {
  db = await createTestDatabase();
  sqs = new SQSClient({ region: 'us-east-1', endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1 });
  const suffix = randomUUID();
  const dlq = await sqs.send(new CreateQueueCommand({ QueueName: `consumer-dlq-${suffix}.fifo`, Attributes: { FifoQueue: 'true' } }));
  if (!dlq.QueueUrl) throw new Error('Missing DLQ URL');
  dlqUrl = dlq.QueueUrl;
  const attrs = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }));
  const arn = attrs.Attributes?.QueueArn;
  if (!arn) throw new Error('Missing DLQ ARN');
  const queue = await sqs.send(new CreateQueueCommand({
    QueueName: `consumer-${suffix}.fifo`,
    Attributes: { FifoQueue: 'true', VisibilityTimeout: '1', RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: '2' }) },
  }));
  if (!queue.QueueUrl) throw new Error('Missing queue URL');
  url = queue.QueueUrl;
  const uow = new MikroOrmUnitOfWork(db.orm.em.fork(), 200);
  open = new OpenWallet(uow, clock, ids);
  processWager = new ProcessWagerTransaction(uow, clock, ids);
  consumer = new SqsWagerConsumer(sqs, url, new ConsumeWagerMessage(processWager));
});

afterAll(async () => {
  if (url) await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
  if (dlqUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
  sqs?.destroy();
  await db?.drop();
});

async function wallet(balance = '100.00') {
  return open.execute({ playerId: randomUUID(), initialBalance: { amount: balance, currency: 'BRL' } });
}

function message(w: Awaited<ReturnType<typeof wallet>>, amount = '10.00') {
  const id = randomUUID();
  return {
    messageId: randomUUID(), type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
    data: { idempotencyKey: `key-${id}`, providerId: 'provider', externalTransactionId: id,
      playerId: w.playerId, walletId: w.id, roundId: 'round', gameId: 'game',
      kind: WagerTransactionKind.Bet, money: { amount, currency: 'BRL' } },
  };
}

async function send(body: unknown, groupId: string) {
  await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: JSON.stringify(body),
    MessageGroupId: groupId, MessageDeduplicationId: randomUUID() }));
}

async function receive(queue = url): Promise<Message | undefined> {
  const result = await sqs.send(new ReceiveMessageCommand({
    QueueUrl: queue, WaitTimeSeconds: 1, VisibilityTimeout: 1,
    MessageSystemAttributeNames: ['ApproximateReceiveCount'],
  }));
  return result.Messages?.[0];
}

async function receiveRequired(queue = url): Promise<Message> {
  const msg = await receive(queue);
  if (!msg) throw new Error('Expected SQS message');
  return msg;
}

describe('SQS consumer with PostgreSQL and LocalStack', () => {
  test('redelivery of the same message commits inbox and debit only once', async () => {
    const w = await wallet();
    const body = message(w);
    await send(body, w.id);
    await consumer.handle(await receiveRequired());
    await send(body, w.id);
    await consumer.handle(await receiveRequired());
    expect(await receive()).toBeUndefined();
    expect(await db.run('select id from wagering_transactions where idempotency_key = ?', [body.data.idempotencyKey])).toHaveLength(1);
    expect(await db.run('select message_id from inbox_messages where message_id = ? and processed_at is not null', [body.messageId])).toHaveLength(1);
    expect(await db.run("select id from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'", [w.id])).toHaveLength(1);
    await expectWalletMatchesLedger(db, w.id);
  });

  test('HTTP use case and queue share idempotency; different group ID is not a correctness lock', async () => {
    const w = await wallet();
    const body = message(w);
    await processWager.execute(body.data);
    await send(body, randomUUID());
    await consumer.handle(await receiveRequired());
    const [state] = await db.run<{ balance: string }>('select balance from wallets where id = ?', [w.id]);
    expect(state?.balance).toBe('90.00');
    expect(await db.run('select message_id from inbox_messages where message_id = ?', [body.messageId])).toHaveLength(1);
    await expectWalletMatchesLedger(db, w.id);
  });

  test('concurrent deliveries of the same message serialize on the persistent inbox', async () => {
    const w = await wallet();
    const body = message(w);
    const handler = new ConsumeWagerMessage(processWager);
    await Promise.all(Array.from({ length: 10 }, () => handler.execute(JSON.stringify(body))));
    expect(await db.run('select message_id from inbox_messages where message_id = ?', [body.messageId])).toHaveLength(1);
    expect(await db.run("select id from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'", [w.id])).toHaveLength(1);
    await expectWalletMatchesLedger(db, w.id);
  });

  test('business rejection is committed and acknowledged', async () => {
    const w = await wallet('1.00');
    const body = message(w, '20.00');
    await send(body, w.id);
    await consumer.handle(await receiveRequired());
    expect(await receive()).toBeUndefined();
    const [tx] = await db.run<{ status: string; failure_code: string }>('select status, failure_code from wagering_transactions where idempotency_key = ?', [body.data.idempotencyKey]);
    expect(tx).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await db.run('select message_id from inbox_messages where message_id = ? and processed_at is not null', [body.messageId])).toHaveLength(1);
    await expectWalletMatchesLedger(db, w.id);
  });

  test('process killed after commit before ack: SQS redelivery is acknowledged without another debit', async () => {
    const w = await wallet();
    const body = message(w);
    await send(body, w.id);
    const child = Bun.spawn(['bun', 'test/integration/support/consumer-crash-process.ts'], {
      env: { ...process.env, TEST_DATABASE_URL: db.url, TEST_QUEUE_URL: url }, stdout: 'pipe', stderr: 'inherit',
    });
    try {
      const { value } = await child.stdout.getReader().read();
      expect(new TextDecoder().decode(value)).toContain('COMMITTED');
    } finally {
      child.kill('SIGKILL');
      await child.exited;
    }
    await Bun.sleep(1400);
    await consumer.handle(await receiveRequired());
    expect(await receive()).toBeUndefined();
    expect(await db.run("select id from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'", [w.id])).toHaveLength(1);
    await expectWalletMatchesLedger(db, w.id);
  });

  test('transient lock timeout rolls inbox back and retry succeeds without acking the failure', async () => {
    const w = await wallet();
    const body = message(w);
    const holder = db.orm.em.fork();
    await holder.begin();
    await holder.getConnection().execute('select id from wallets where id = ? for update', [w.id], 'all', holder.getTransactionContext());
    try {
      await send(body, w.id);
      await consumer.handle(await receiveRequired());
      expect(await db.run('select message_id from inbox_messages where message_id = ?', [body.messageId])).toHaveLength(0);
    } finally {
      await holder.rollback();
    }
    await Bun.sleep(1300);
    await consumer.handle(await receiveRequired());
    expect(await receive()).toBeUndefined();
    expect(await db.run('select message_id from inbox_messages where message_id = ? and processed_at is not null', [body.messageId])).toHaveLength(1);
    await expectWalletMatchesLedger(db, w.id);
  });

  test('outbox write failure rolls inbox and financial changes back before retry', async () => {
    const w = await wallet();
    const body = message(w);
    const beforeWallet = await db.run('select balance, version from wallets where id = ?', [w.id]);
    const beforeLedger = await db.run('select id from wallet_ledger_entries where wallet_id = ? order by id', [w.id]);
    const beforeOutbox = await db.run('select id from outbox_messages where aggregate_id = ? order by id', [w.id]);
    await db.run(`create function test_inbox_outbox_failure() returns trigger language plpgsql as $$
      begin if new.event_type = 'WalletBalanceChanged' then raise exception 'test outbox failure'; end if;
      return new; end $$`);
    await db.run('create trigger test_inbox_outbox_failure before insert on outbox_messages for each row execute function test_inbox_outbox_failure()');
    let delivery: Message;
    try {
      await send(body, w.id);
      delivery = await receiveRequired();
      await consumer.handle(delivery);
      expect(await db.run('select message_id from inbox_messages where message_id = ?', [body.messageId])).toHaveLength(0);
      expect(await db.run('select id from wagering_transactions where idempotency_key = ?', [body.data.idempotencyKey])).toHaveLength(0);
      expect(await db.run('select balance, version from wallets where id = ?', [w.id])).toEqual(beforeWallet);
      expect(await db.run('select id from wallet_ledger_entries where wallet_id = ? order by id', [w.id])).toEqual(beforeLedger);
      expect(await db.run('select id from outbox_messages where aggregate_id = ? order by id', [w.id])).toEqual(beforeOutbox);
      await expectWalletMatchesLedger(db, w.id);
    } finally {
      await db.run('drop trigger test_inbox_outbox_failure on outbox_messages');
      await db.run('drop function test_inbox_outbox_failure()');
    }
    if (!delivery.ReceiptHandle) throw new Error('Missing receipt');
    await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: url, ReceiptHandle: delivery.ReceiptHandle, VisibilityTimeout: 0 }));
    await consumer.handle(await receiveRequired());
    expect(await db.run('select message_id from inbox_messages where message_id = ? and processed_at is not null', [body.messageId])).toHaveLength(1);
    expect(await db.run('select id from wagering_transactions where idempotency_key = ?', [body.data.idempotencyKey])).toHaveLength(1);
    expect(await db.run('select id from wallet_ledger_entries where wallet_id = ?', [w.id])).toHaveLength(beforeLedger.length + 1);
    expect(await db.run('select id from outbox_messages where aggregate_id = ?', [w.id])).toHaveLength(beforeOutbox.length + 2);
    await expectWalletMatchesLedger(db, w.id);
  });

  test('permanent invalid payload is retried up to redrive limit then arrives in DLQ', async () => {
    const w = await wallet();
    const body = message(w);
    body.data.money.amount = '-2.00';
    await send(body, w.id);
    for (let i = 0; i < 2; i++) {
      const msg = await receiveRequired();
      await consumer.handle(msg);
      if (!msg.ReceiptHandle) throw new Error('Missing receipt');
      await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: url, ReceiptHandle: msg.ReceiptHandle, VisibilityTimeout: 0 }));
    }
    expect(await receive()).toBeUndefined();
    const dead = await receiveRequired(dlqUrl);
    expect(JSON.parse(dead.Body ?? '{}').messageId).toBe(body.messageId);
    await sqs.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: dead.ReceiptHandle }));
    expect(await db.run('select message_id from inbox_messages where message_id = ?', [body.messageId])).toHaveLength(0);
    await expectWalletMatchesLedger(db, w.id);
  });

  test('same inbox ID with different content cannot be silently acknowledged', async () => {
    const w = await wallet();
    const body = message(w);
    await send(body, w.id);
    await consumer.handle(await receiveRequired());
    body.data.money.amount = '11.00';
    await send(body, w.id);
    for (let i = 0; i < 2; i++) {
      const msg = await receiveRequired();
      await consumer.handle(msg);
      if (!msg.ReceiptHandle) throw new Error('Missing receipt');
      await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: url, ReceiptHandle: msg.ReceiptHandle, VisibilityTimeout: 0 }));
    }
    await receive();
    const dlq = await receiveRequired(dlqUrl);
    expect(JSON.parse(dlq.Body ?? '{}').messageId).toBe(body.messageId);
    await sqs.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: dlq.ReceiptHandle }));
    await expectWalletMatchesLedger(db, w.id);
  });

  test('shutdown stops polling and waits for in-flight work to finish before ack', async () => {
    const w = await wallet();
    const body = message(w);
    const holder = db.orm.em.fork();
    await holder.begin();
    await holder.getConnection().execute('select id from wallets where id = ? for update', [w.id], 'all', holder.getTransactionContext());
    const slowUow = new MikroOrmUnitOfWork(db.orm.em.fork(), 5000);
    const liveClient = new SQSClient({ region: 'us-east-1', endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1 });
    const live = new SqsWagerConsumer(liveClient, url, new ConsumeWagerMessage(new ProcessWagerTransaction(slowUow, clock, ids)));
    await send(body, w.id);
    live.onModuleInit();
    try {
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        const rows = await db.run('select pid from pg_stat_activity where datname = current_database() and wait_event_type = ? and query like ?', ['Lock', '%wagering_transactions%']);
        if (rows.length) { blocked = true; break; }
        await Bun.sleep(50);
      }
      expect(blocked).toBe(true);
      const shutdown = live.onModuleDestroy();
      await holder.rollback();
      await shutdown;
    } finally {
      if (holder.getTransactionContext()) await holder.rollback();
      await live.onModuleDestroy();
    }
    expect(await receive()).toBeUndefined();
    expect(await db.run('select message_id from inbox_messages where message_id = ? and processed_at is not null', [body.messageId])).toHaveLength(1);
    await expectWalletMatchesLedger(db, w.id);
  });

  test.skipIf(process.platform === 'win32')('SIGTERM drains an in-flight message before the Nest process exits', async () => {
    const w = await wallet();
    const body = message(w);
    const holder = db.orm.em.fork();
    await holder.begin();
    await holder.getConnection().execute('select id from wallets where id = ? for update', [w.id], 'all', holder.getTransactionContext());
    await send(body, w.id);
    const child = Bun.spawn(['bun', 'test/integration/support/consumer-sigterm-process.ts'], {
      env: { ...process.env, TEST_DATABASE_URL: db.url, TEST_QUEUE_URL: url }, stdout: 'pipe', stderr: 'inherit',
    });
    try {
      const { value } = await child.stdout.getReader().read();
      expect(new TextDecoder().decode(value)).toContain('READY');
      const deadline = Date.now() + 4000;
      let blocked = false;
      while (Date.now() < deadline) {
        const rows = await db.run('select pid from pg_stat_activity where datname = current_database() and wait_event_type = ? and query like ?', ['Lock', '%wagering_transactions%']);
        if (rows.length) { blocked = true; break; }
        await Bun.sleep(50);
      }
      expect(blocked).toBe(true);
      child.kill('SIGTERM');
      await holder.rollback();
      await child.exited;
      expect(await receive()).toBeUndefined();
      expect(await db.run('select message_id from inbox_messages where message_id = ? and processed_at is not null', [body.messageId])).toHaveLength(1);
    } finally {
      if (holder.getTransactionContext()) await holder.rollback();
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
    }
    await expectWalletMatchesLedger(db, w.id);
  });
});
