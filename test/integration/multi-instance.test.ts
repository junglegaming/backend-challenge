import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  SQSClient,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { AppService } from '../../src/app.service';
import { Kind } from '../../src/domain/wager';

describe('three independent API processes', () => {
  const ports = [3101, 3102, 3103];
  const processes: ReturnType<typeof Bun.spawn>[] = [];
  const walletIds: string[] = [];
  let db: DataSource;
  let service: AppService;
  let sqs: SQSClient;
  let eventQueueUrl: string;
  let crashQueueUrl: string;
  let crashDlqUrl: string;
  const runId = randomUUID();
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL and apply migrations first');
    sqs = new SQSClient({
      region: 'us-east-1',
      endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const eventQueue = await sqs.send(
      new CreateQueueCommand({
        QueueName: `wager-events-test-${runId}.fifo`,
        Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'true' },
      }),
    );
    eventQueueUrl = eventQueue.QueueUrl!;
    const crashDlq = await sqs.send(
      new CreateQueueCommand({
        QueueName: `wager-crash-dlq-${runId}.fifo`,
        Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'true' },
      }),
    );
    crashDlqUrl = crashDlq.QueueUrl!;
    const crashQueue = await sqs.send(
      new CreateQueueCommand({
        QueueName: `wager-crash-${runId}.fifo`,
        Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'true' },
      }),
    );
    crashQueueUrl = crashQueue.QueueUrl!;
    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: crashQueueUrl,
        Attributes: {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: `arn:aws:sqs:us-east-1:000000000000:wager-crash-dlq-${runId}.fifo`,
            maxReceiveCount: '3',
          }),
        },
      }),
    );
    db = new DataSource({ type: 'postgres', url: process.env.DATABASE_URL });
    await db.initialize();
    service = new AppService(db);
    for (const port of ports)
      processes.push(
        Bun.spawn([process.execPath, 'dist/src/main.js'], {
          env: {
            ...(process.env as Record<string, string>),
            PORT: String(port),
            EVENT_QUEUE_URL: eventQueueUrl,
            SQS_RETRY_VISIBILITY_SECONDS: '1',
            NODE_ENV: 'test',
            TEST_DISABLE_OUTBOX_PUBLISHER: 'true',
          },
          stdout: 'ignore',
          stderr: 'ignore',
        }),
      );
    for (const port of ports) {
      let ready = false;
      for (let attempt = 0; attempt < 80 && !ready; attempt++) {
        try {
          ready = (await fetch(`http://127.0.0.1:${port}/health/live`)).ok;
        } catch {}
        if (!ready) await Bun.sleep(250);
      }
      if (!ready) throw new Error(`API process on port ${port} did not become healthy`);
    }
  });
  afterAll(async () => {
    for (const child of processes) child.kill();
    await Promise.all(processes.map((p) => p.exited));
    if (db?.isInitialized) await db.destroy();
    if (eventQueueUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: eventQueueUrl }));
    if (crashQueueUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: crashQueueUrl }));
    if (crashDlqUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: crashDlqUrl }));
  });
  const open = async (balance: string) => {
    const w = await service.createWallet({
      playerId: randomUUID(),
      initialBalance: { amount: balance, currency: 'BRL' },
    });
    walletIds.push(w.id);
    return w;
  };
  afterEach(async () => {
    for (const id of walletIds) expect((await service.reconcile(id))?.consistent).toBe(true);
    walletIds.splice(0);
  });
  const send = async (port: number, input: Record<string, unknown>, key: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(input),
    });
    return {
      statusCode: response.status,
      body: (await response.json()) as {
        status: string;
        transactionId: string;
        balance: { amount: string };
      },
    };
  };
  const startIsolatedWorker = async (port: number, extra: Record<string, string> = {}) => {
    const child = Bun.spawn([process.execPath, 'dist/src/main.js'], {
      env: {
        ...(process.env as Record<string, string>),
        PORT: String(port),
        WAGER_QUEUE_URL: crashQueueUrl,
        EVENT_QUEUE_URL: eventQueueUrl,
        DLQ_QUEUE_URL: crashDlqUrl,
        NODE_ENV: 'test',
        SQS_LONG_POLL_SECONDS: '1',
        SQS_MESSAGE_VISIBILITY_SECONDS: '2',
        SQS_RETRY_VISIBILITY_SECONDS: '1',
        ...extra,
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    processes.push(child);
    let ready = false;
    for (let attempt = 0; attempt < 80 && !ready; attempt++) {
      try {
        ready = (await fetch(`http://127.0.0.1:${port}/health/live`)).ok;
      } catch {}
      if (!ready) await Bun.sleep(250);
    }
    if (!ready) throw new Error(`Isolated worker on port ${port} did not become healthy`);
    return child;
  };
  test('three processes deduplicate 50 deliveries against the same PostgreSQL wallet', async () => {
    const w = await open('100.00'),
      key = `${runId}:same-key`,
      input = {
        providerId: 'three-process-test',
        externalTransactionId: `${runId}:same-bet`,
        playerId: w.playerId,
        walletId: w.id,
        roundId: 'multi-round',
        gameId: 'multi-game',
        kind: Kind.Bet,
        money: { amount: '25.00', currency: 'BRL' },
      };
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => send(ports[i % ports.length], input, key)),
    );
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect((await service.wallet(w.id))?.balance.amount).toBe('75.00');
    const count = await db.query(
      "SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id=$1 AND direction='DEBIT'",
      [w.id],
    );
    expect(count[0].n).toBe(1);
  });
  test('three processes serialize competing bets for one hot wallet', async () => {
    const w = await open('100.00');
    const make = (id: string) => ({
      providerId: 'three-process-test',
      externalTransactionId: `${runId}:${id}`,
      playerId: w.playerId,
      walletId: w.id,
      roundId: 'race-round',
      gameId: 'multi-game',
      kind: Kind.Bet,
      money: { amount: '80.00', currency: 'BRL' },
    });
    const results = await Promise.all([
      send(ports[0], make('race-a'), `${runId}:race-a`),
      send(ports[1], make('race-b'), `${runId}:race-b`),
    ]);
    expect(results.map((r) => r.body.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect((await service.wallet(w.id))?.balance.amount).toBe('20.00');
    expect(results.filter((r) => r.statusCode === 422)).toHaveLength(1);
  });
  test('HTTP distinguishes invalid payload, idempotency conflict, business rejection, and pending acceptance', async () => {
    const invalid = await send(ports[0], {}, `${runId}:http-invalid`);
    expect(invalid.statusCode).toBe(400);
    const w = await open('10.00'),
      base = {
        providerId: 'http-status-test',
        externalTransactionId: `${runId}:http-status`,
        playerId: w.playerId,
        walletId: w.id,
        roundId: 'http-round',
        gameId: 'http-game',
        kind: Kind.Bet,
        money: { amount: '2.00', currency: 'BRL' },
      };
    const accepted = await send(ports[0], base, `${runId}:http-key`);
    expect(accepted.statusCode).toBe(201);
    const conflict = await send(
      ports[0],
      { ...base, money: { amount: '3.00', currency: 'BRL' } },
      `${runId}:http-key`,
    );
    expect(conflict.statusCode).toBe(409);
    const rejected = await send(
      ports[0],
      {
        ...base,
        externalTransactionId: `${runId}:http-overdraw`,
        money: { amount: '20.00', currency: 'BRL' },
      },
      `${runId}:http-overdraw-key`,
    );
    expect(rejected.statusCode).toBe(422);
    const pending = await send(
      ports[0],
      {
        ...base,
        externalTransactionId: `${runId}:http-pending`,
        kind: Kind.Refund,
        referenceExternalTransactionId: `${runId}:http-missing-ref`,
        money: { amount: '2.00', currency: 'BRL' },
      },
      `${runId}:http-pending-key`,
    );
    expect(pending.statusCode).toBe(202);
  }, 30_000);
  test('SQS inbox commits with the wager and makes a redelivery harmless', async () => {
    const queue = process.env.WAGER_QUEUE_URL;
    if (!queue) throw new Error('Set WAGER_QUEUE_URL to the LocalStack FIFO queue');
    const sqs = new SQSClient({
      region: 'us-east-1',
      endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const w = await open('100.00'),
      messageId = `${runId}:sqs-message`,
      idempotencyKey = `${runId}:sqs-idempotency`,
      externalTransactionId = `${runId}:sqs-external`;
    const envelope = {
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'sqs-integration-test',
        externalTransactionId,
        idempotencyKey,
        playerId: w.playerId,
        walletId: w.id,
        roundId: 'sqs-round',
        gameId: 'sqs-game',
        kind: Kind.Bet,
        money: { amount: '35.00', currency: 'BRL' },
      },
    };
    const publish = (dedup: string) =>
      sqs.send(
        new SendMessageCommand({
          QueueUrl: queue,
          MessageBody: JSON.stringify(envelope),
          MessageGroupId: w.id,
          MessageDeduplicationId: dedup,
        }),
      );
    await publish(`${messageId}:first`);
    let tx: any;
    for (let attempt = 0; attempt < 120 && !tx; attempt++) {
      tx = await service.byExternal('sqs-integration-test', externalTransactionId);
      if (!tx) await Bun.sleep(250);
    }
    expect(tx?.status).toBe('PROCESSED');
    await publish(`${messageId}:redelivery`);
    let inbox: any;
    for (let attempt = 0; attempt < 120 && !inbox; attempt++) {
      inbox = (
        await db.query('SELECT * FROM inbox_messages WHERE consumer_name=$1 AND message_id=$2', [
          'wager-processor',
          messageId,
        ])
      )[0];
      if (!inbox) await Bun.sleep(250);
    }
    await Bun.sleep(1000);
    const debit = await db.query(
      'SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE transaction_id=$1',
      [tx.id],
    );
    expect(inbox?.processed_at).toBeTruthy();
    expect(debit[0].n).toBe(1);
    expect((await service.wallet(w.id))?.balance.amount).toBe('65.00');
  }, 30_000);
  test('worker crash after database commit and restart does not apply the wager twice', async () => {
    const w = await open('100.00'),
      messageId = `${runId}:crash-after-commit`,
      idempotencyKey = `${runId}:crash-idempotency`,
      externalTransactionId = `${runId}:crash-external`,
      port = 3191;
    const envelope = {
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'crash-recovery-test',
        externalTransactionId,
        idempotencyKey,
        playerId: w.playerId,
        walletId: w.id,
        roundId: 'crash-round',
        gameId: 'crash-game',
        kind: Kind.Bet,
        money: { amount: '35.00', currency: 'BRL' },
      },
    };
    const crashed = await startIsolatedWorker(port, {
      TEST_CRASH_AFTER_COMMIT_MESSAGE_ID: messageId,
    });
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: crashQueueUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: w.id,
        MessageDeduplicationId: messageId,
      }),
    );
    const exitCode = await Promise.race([
      crashed.exited,
      new Promise<number>((_, reject) =>
        setTimeout(
          () => reject(new Error('Worker did not crash after committing the wager')),
          15000,
        ),
      ),
    ]);
    expect(exitCode).not.toBe(0);
    const tx = await service.byExternal('crash-recovery-test', externalTransactionId);
    expect(tx?.status).toBe('PROCESSED');
    const inbox = await db.query(
      'SELECT processed_at FROM inbox_messages WHERE consumer_name=$1 AND message_id=$2',
      ['wager-processor', messageId],
    );
    expect(inbox[0]?.processed_at).toBeTruthy();
    const outbox = await db.query(
      "SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id=$1 AND event_type='WagerTransactionProcessed'",
      [tx.id],
    );
    expect(outbox[0].n).toBe(1);
    const ledgerBalance = await service.reconcile(w.id);
    expect(ledgerBalance?.consistent).toBe(true);
    const replacement = await startIsolatedWorker(3192);
    for (let attempt = 0; attempt < 40; attempt++) {
      const attrs = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: crashQueueUrl,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
      );
      if (
        Number(attrs.Attributes?.ApproximateNumberOfMessages ?? 0) === 0 &&
        Number(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0) === 0
      )
        break;
      await Bun.sleep(250);
    }
    await Bun.sleep(1500);
    replacement.kill('SIGTERM');
    await replacement.exited;
    const debit = await db.query(
      'SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE transaction_id=$1',
      [tx.id],
    );
    expect(debit[0].n).toBe(1);
    expect((await service.wallet(w.id))?.balance.amount).toBe('65.00');
  }, 30_000);
  test('SIGTERM waits for an in-flight committed message to be acknowledged', async () => {
    const w = await open('20.00'),
      messageId = `${runId}:sigterm-inflight`,
      idempotencyKey = `${runId}:sigterm-key`,
      externalTransactionId = `${runId}:sigterm-external`,
      worker = await startIsolatedWorker(3197, {
        TEST_PAUSE_AFTER_COMMIT_MS: '1800',
        TEST_EMIT_SIGTERM_AFTER_COMMIT_MESSAGE_ID: messageId,
      });
    const envelope = {
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'sigterm-test',
        externalTransactionId,
        idempotencyKey,
        playerId: w.playerId,
        walletId: w.id,
        roundId: 'sigterm-round',
        gameId: 'sigterm-game',
        kind: Kind.Bet,
        money: { amount: '3.00', currency: 'BRL' },
      },
    };
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: crashQueueUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: w.id,
        MessageDeduplicationId: messageId,
      }),
    );
    let inbox: any;
    for (let attempt = 0; attempt < 80 && !inbox?.processed_at; attempt++) {
      inbox = (
        await db.query(
          'SELECT processed_at FROM inbox_messages WHERE consumer_name=$1 AND message_id=$2',
          ['wager-processor', messageId],
        )
      )[0];
      if (!inbox?.processed_at) await Bun.sleep(100);
    }
    expect(inbox?.processed_at).toBeTruthy();
    await Promise.race([
      worker.exited,
      new Promise<number>((_, reject) =>
        setTimeout(
          () => reject(new Error('Worker did not shut down after finishing its active poll')),
          15000,
        ),
      ),
    ]);
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: crashQueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    expect(
      Number(attrs.Attributes?.ApproximateNumberOfMessages ?? 0) +
        Number(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
    ).toBe(0);
    const tx = await service.byExternal('sigterm-test', externalTransactionId),
      debits = await db.query(
        'SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE transaction_id=$1',
        [tx.id],
      );
    expect(debits[0].n).toBe(1);
  }, 30_000);
  test('concurrent outbox publishers deliver the committed event to SQS', async () => {
    const publishers = await Promise.all([startIsolatedWorker(3193), startIsolatedWorker(3194)]);
    const w = await open('40.00'),
      input = {
        providerId: 'outbox-integration-test',
        externalTransactionId: `${runId}:outbox-bet`,
        playerId: w.playerId,
        walletId: w.id,
        roundId: 'outbox-round',
        gameId: 'outbox-game',
        kind: Kind.Bet,
        money: { amount: '5.00', currency: 'BRL' },
      };
    const response = await send(ports[0], input, `${runId}:outbox-key`),
      transactionId = response.body.transactionId;
    expect(response.body.status).toBe('PROCESSED');
    let eventFound = false;
    for (let attempt = 0; attempt < 80 && !eventFound; attempt++) {
      const batch = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: eventQueueUrl,
          WaitTimeSeconds: 2,
          MaxNumberOfMessages: 10,
        }),
      );
      for (const message of batch.Messages ?? []) {
        if (!message.Body || !message.ReceiptHandle) continue;
        const event = JSON.parse(message.Body);
        if (
          event.eventType === 'WagerTransactionProcessed' &&
          event.data.transactionId === transactionId
        )
          eventFound = true;
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: eventQueueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
      }
      if (!eventFound) await Bun.sleep(250);
    }
    expect(eventFound).toBe(true);
    const rows = await db.query(
      "SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id=$1 AND event_type='WagerTransactionProcessed' AND published_at IS NOT NULL",
      [transactionId],
    );
    expect(rows[0].n).toBe(1);
    for (const publisher of publishers) {
      publisher.kill('SIGTERM');
      await publisher.exited;
    }
  }, 30_000);
  test('outbox event is published after a publisher crashes while holding its lease', async () => {
    const w = await open('30.00'),
      input = {
        providerId: 'outbox-crash-test',
        externalTransactionId: `${runId}:outbox-crash-bet`,
        playerId: w.playerId,
        walletId: w.id,
        roundId: 'outbox-crash-round',
        gameId: 'outbox-crash-game',
        kind: Kind.Bet,
        money: { amount: '4.00', currency: 'BRL' },
      };
    const response = await send(ports[0], input, `${runId}:outbox-crash-key`),
      transactionId = response.body.transactionId;
    expect(response.body.status).toBe('PROCESSED');
    const outbox = (
      await db.query(
        "SELECT id FROM outbox_messages WHERE aggregate_id=$1 AND event_type='WagerTransactionProcessed' AND published_at IS NULL",
        [transactionId],
      )
    )[0];
    expect(outbox?.id).toBeTruthy();
    const failed = await startIsolatedWorker(3195, {
      TEST_CRASH_AFTER_OUTBOX_CLAIM_ID: String(outbox.id),
      OUTBOX_LOCK_SECONDS: '2',
    });
    const exitCode = await Promise.race([
      failed.exited,
      new Promise<number>((_, reject) =>
        setTimeout(
          () => reject(new Error('Outbox publisher did not crash after claiming the event')),
          15000,
        ),
      ),
    ]);
    expect(exitCode).not.toBe(0);
    const replacement = await startIsolatedWorker(3196, { OUTBOX_LOCK_SECONDS: '2' });
    let eventFound = false;
    for (let attempt = 0; attempt < 40 && !eventFound; attempt++) {
      const row = (
        await db.query('SELECT published_at FROM outbox_messages WHERE id=$1', [outbox.id])
      )[0];
      if (row?.published_at) {
        const batch = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: eventQueueUrl,
            WaitTimeSeconds: 1,
            MaxNumberOfMessages: 10,
          }),
        );
        for (const message of batch.Messages ?? []) {
          if (!message.Body || !message.ReceiptHandle) continue;
          const event = JSON.parse(message.Body);
          if (
            event.eventType === 'WagerTransactionProcessed' &&
            event.data.transactionId === transactionId
          )
            eventFound = true;
          await sqs.send(
            new DeleteMessageCommand({
              QueueUrl: eventQueueUrl,
              ReceiptHandle: message.ReceiptHandle,
            }),
          );
        }
      }
      if (!eventFound) await Bun.sleep(250);
    }
    expect(eventFound).toBe(true);
    replacement.kill('SIGTERM');
    await replacement.exited;
  }, 30_000);
  test('permanent poison messages reach the configured SQS dead-letter queue', async () => {
    const queue = process.env.WAGER_QUEUE_URL,
      dlq = process.env.DLQ_QUEUE_URL;
    if (!queue || !dlq) throw new Error('Configure the wager queue and DLQ');
    const poisonId = `${runId}:poison`;
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue,
        MessageBody: JSON.stringify({ messageId: poisonId }),
        MessageGroupId: poisonId,
        MessageDeduplicationId: poisonId,
      }),
    );
    let found = false;
    for (let attempt = 0; attempt < 45 && !found; attempt++) {
      const batch = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: dlq, WaitTimeSeconds: 1, MaxNumberOfMessages: 10 }),
      );
      for (const message of batch.Messages ?? []) {
        if (!message.Body || !message.ReceiptHandle) continue;
        try {
          if (JSON.parse(message.Body).messageId === poisonId) {
            found = true;
            await sqs.send(
              new DeleteMessageCommand({ QueueUrl: dlq, ReceiptHandle: message.ReceiptHandle }),
            );
          }
        } catch {
          /* leave unrelated DLQ messages untouched */
        }
      }
      if (!found) await Bun.sleep(250);
    }
    expect(found).toBe(true);
  }, 60_000);
});
