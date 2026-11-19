import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { EventPublisher, TxStore, UnitOfWork } from '../../src/application/ports';
import { PublishOutbox } from '../../src/application/publish-outbox';
import { SubmitWagerTransaction } from '../../src/application/submit-wager-transaction';
import { OutboxMessage } from '../../src/domain/messaging';
import { WagerTransactionsConsumer } from '../../src/infra/sqs/consumer';
import { SqsEventPublisher } from '../../src/infra/sqs/event-publisher';
import { QueueUrls } from '../../src/infra/sqs/queues';
import { drain, enqueue, freshDatabase, freshQueues, harness, queueDepth, queueTotal, uuid, wagerMessage, waitFor } from '../support';

/** PostgreSQL e SQS (LocalStack) reais. As únicas falhas simuladas são as de infraestrutura. */
let orm: MikroORM;
let h: ReturnType<typeof harness>;
let sqs: SQSClient;
let queues: QueueUrls;

beforeAll(async () => {
  orm = await freshDatabase();
  h = harness(orm);
  ({ sqs, queues } = await freshQueues());
});
afterAll(async () => {
  await h.assertLedgerConsistent();
  await orm.close();
  sqs.destroy();
});

/** Unit of work que falha como se o banco estivesse fora, nas primeiras `failures` execuções. */
class FlakyUnitOfWork extends UnitOfWork {
  calls = 0;
  constructor(private readonly inner: UnitOfWork, private readonly failures: number) {
    super();
  }
  run<T>(fn: (store: TxStore) => Promise<T>): Promise<T> {
    this.calls += 1;
    if (this.calls <= this.failures) return Promise.reject(new Error('connection refused (simulated outage)'));
    return this.inner.run(fn);
  }
}

/** Executa tudo dentro da transação e falha logo antes do COMMIT (processo morrendo no pior momento). */
class CrashBeforeCommit extends UnitOfWork {
  constructor(private readonly inner: UnitOfWork) {
    super();
  }
  run<T>(fn: (store: TxStore) => Promise<T>): Promise<T> {
    return this.inner.run(async (store) => {
      await fn(store);
      throw new Error('crash before commit (simulated)');
    });
  }
}

async function withConsumer<T>(body: () => Promise<T>, submit: SubmitWagerTransaction = h.submit): Promise<T> {
  const consumer = new WagerTransactionsConsumer(sqs, queues, submit);
  consumer.start();
  try {
    return await body();
  } finally {
    await consumer.stop();
  }
}

const debitCount = async (walletId: string) => (await h.sql(`select 1 from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [walletId])).length;
/** Espera o efeito no banco e, só então, que a fila esteja vazia de forma estável (tudo confirmado). */
const settled = async (walletId: string, balance: string) => {
  await waitFor(async () => (await h.balance(walletId)) === balance, 20_000, `wallet balance ${balance}`);
  let zeros = 0;
  await waitFor(async () => (zeros = (await queueTotal(sqs, queues.input)) === 0 ? zeros + 1 : 0) >= 3, 15_000, 'input queue fully acked');
};

describe('SQS consumer + inbox', () => {
  test('processes a message with the same use case as HTTP and acks only after commit', async () => {
    const wallet = await h.wallet('100.00');
    const messageId = uuid();
    await withConsumer(async () => {
      await enqueue(sqs, queues.input, wagerMessage(messageId, h.payload(wallet, 'BET', '25.00')), wallet.id);
      await settled(wallet.id, '75.00');
    });
    const [inbox] = await h.sql(`select consumer_name, processed_at from inbox_messages where message_id = ?`, [messageId]);
    expect(inbox!.consumer_name).toBe('wager-transactions-consumer');
    expect(inbox!.processed_at).not.toBeNull();
  }, 30_000);

  test('redelivery of the same message does not duplicate effects', async () => {
    const wallet = await h.wallet('100.00');
    const message = wagerMessage(uuid(), h.payload(wallet, 'BET', '25.00'));
    await withConsumer(async () => {
      for (let i = 0; i < 4; i++) await enqueue(sqs, queues.input, message, wallet.id);
      await settled(wallet.id, '75.00');
    });
    expect(await h.balance(wallet.id)).toBe('75.00');
    expect(await debitCount(wallet.id)).toBe(1);
    expect(await h.sql(`select 1 from inbox_messages where message_id = ?`, [message.messageId])).toHaveLength(1);
  }, 30_000);

  test('a different message carrying an already processed transaction is acked as a replay', async () => {
    const wallet = await h.wallet('100.00');
    const payload = h.payload(wallet, 'BET', '25.00');
    await withConsumer(async () => {
      await enqueue(sqs, queues.input, wagerMessage(uuid(), payload), wallet.id);
      await enqueue(sqs, queues.input, wagerMessage(uuid(), payload), wallet.id);
      await settled(wallet.id, '75.00');
    });
    expect(await debitCount(wallet.id)).toBe(1);
  }, 30_000);

  test('atomicity: a crash before commit leaves no inbox, transaction, ledger, outbox or balance change', async () => {
    const wallet = await h.wallet('100.00');
    const payload = h.payload(wallet, 'BET', '25.00');
    const messageId = uuid();
    const crashing = new SubmitWagerTransaction(new CrashBeforeCommit(h.uow));
    const command = { idempotencyKey: 'atomic-key', payload, correlationId: 't', inbox: { messageId, payloadHash: 'a'.repeat(64) } };
    expect(crashing.execute(command)).rejects.toThrow('crash before commit');

    const count = async (table: string, where: string, param: string) => (await h.sql(`select 1 from ${table} where ${where}`, [param])).length;
    expect(await count('inbox_messages', 'message_id = ?', messageId)).toBe(0);
    expect(await count('wager_transactions', 'idempotency_key = ?', 'atomic-key')).toBe(0);
    expect(await debitCount(wallet.id)).toBe(0);
    expect(await count('outbox_messages', `aggregate_id = ? and event_type <> 'WalletBalanceChanged' and payload->'data'->>'kind' = 'BET'`, wallet.id)).toBe(0);
    expect(await h.balance(wallet.id)).toBe('100.00');

    // a mesma mensagem, reprocessada depois, é aplicada normalmente: nada ficou pela metade
    await h.submit.execute(command);
    expect(await h.balance(wallet.id)).toBe('75.00');
    expect(await count('inbox_messages', 'message_id = ? and processed_at is not null', messageId)).toBe(1);
  });

  test('transient failure: message is not acked, comes back after backoff and is processed once', async () => {
    const wallet = await h.wallet('100.00');
    const flaky = new FlakyUnitOfWork(h.uow, 2);
    await withConsumer(async () => {
      await enqueue(sqs, queues.input, wagerMessage(uuid(), h.payload(wallet, 'BET', '25.00')), wallet.id);
      await settled(wallet.id, '75.00');
    }, new SubmitWagerTransaction(flaky));
    expect(flaky.calls).toBe(3);
    expect(await h.balance(wallet.id)).toBe('75.00');
    expect(await debitCount(wallet.id)).toBe(1);
    expect(await queueDepth(sqs, queues.dlq)).toBe(0);
  }, 30_000);

  test('retries exhausted: the message lands in the DLQ and nothing is applied', async () => {
    const wallet = await h.wallet('100.00');
    const messageId = uuid();
    const alwaysDown = new FlakyUnitOfWork(h.uow, Number.POSITIVE_INFINITY);
    await withConsumer(async () => {
      await enqueue(sqs, queues.input, wagerMessage(messageId, h.payload(wallet, 'BET', '25.00')), wallet.id);
      await waitFor(async () => (await queueDepth(sqs, queues.dlq)) === 1, 30_000, 'message in DLQ');
    }, new SubmitWagerTransaction(alwaysDown));
    expect(alwaysDown.calls).toBe(3); // SQS_MAX_RECEIVE_COUNT nos testes
    const dead = await drain(sqs, queues.dlq);
    expect(dead.map((d) => d.body.messageId)).toEqual([messageId]);
    expect(await h.balance(wallet.id)).toBe('100.00');
    expect(await queueTotal(sqs, queues.input)).toBe(0);
  }, 60_000);

  test('permanent errors go straight to the DLQ with a reason, without retries', async () => {
    const wallet = await h.wallet('100.00');
    const processed = h.payload(wallet, 'BET', '10.00');
    await h.send(processed, 'dlq-conflict-key');
    await withConsumer(async () => {
      await enqueue(sqs, queues.input, '{not json', 'g1');
      await enqueue(sqs, queues.input, wagerMessage(uuid(), h.payload(wallet, 'OPENING', '10.00')), 'g2');
      await enqueue(sqs, queues.input, wagerMessage(uuid(), h.payload(wallet, 'BET', '10.00', { walletId: uuid() })), 'g3');
      await enqueue(sqs, queues.input, wagerMessage(uuid(), { ...processed, money: { amount: '11.00', currency: 'BRL' } }, 'dlq-conflict-key'), 'g4');
      await waitFor(async () => (await queueDepth(sqs, queues.dlq)) === 4, 20_000, '4 messages in DLQ');
    });
    const reasons = (await drain(sqs, queues.dlq)).map((d) => d.attributes.reason.StringValue).sort();
    expect(reasons).toEqual(['idempotency_conflict', 'invalid_payload', 'malformed_message', 'wallet_not_found']);
    expect(await h.balance(wallet.id)).toBe('90.00');
  }, 60_000);

  test('graceful shutdown: finishes the in-flight message and gives back the ones not started', async () => {
    const wallet = await h.wallet('100.00');
    class SlowUnitOfWork extends UnitOfWork {
      run<T>(fn: (store: TxStore) => Promise<T>): Promise<T> {
        return h.uow.run(async (store) => {
          const result = await fn(store);
          await Bun.sleep(700);
          return result;
        });
      }
    }
    for (let i = 0; i < 2; i++) await enqueue(sqs, queues.input, wagerMessage(uuid(), h.payload(wallet, 'BET', '10.00')), wallet.id);
    const consumer = new WagerTransactionsConsumer(sqs, queues, new SubmitWagerTransaction(new SlowUnitOfWork()));
    consumer.start();
    await waitFor(async () => (await queueDepth(sqs, queues.input)) === 0, 10_000, 'both messages received');
    await consumer.stop(); // equivalente ao SIGTERM

    expect(await h.balance(wallet.id)).toBe('90.00'); // a que estava em andamento foi concluída e confirmada
    expect(await queueDepth(sqs, queues.input)).toBe(1); // a outra voltou a ficar visível imediatamente
    await withConsumer(() => settled(wallet.id, '80.00'));
  }, 30_000);
});

describe('transactional outbox', () => {
  class CountingPublisher extends EventPublisher {
    readonly sent: string[] = [];
    constructor(private readonly inner: EventPublisher) {
      super();
    }
    async publish(message: OutboxMessage): Promise<void> {
      await this.inner.publish(message);
      this.sent.push(message.id);
    }
  }
  const pending = async () => (await h.sql(`select id from outbox_messages where published_at is null`)).map((r) => r.id as string);
  const untilEmpty = async (publisher: PublishOutbox) => {
    while ((await publisher.runOnce()) > 0);
  };

  test('two concurrent publishers over the same outbox publish every event exactly once', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => h.wallet('100.00')));
    await Promise.all(wallets.flatMap((w) => Array.from({ length: 15 }, () => h.send(h.payload(w, 'BET', '1.00')))));
    const expected = await pending(); // eventos confirmados e ainda não publicados ("processo morreu antes de publicar")
    expect(expected.length).toBeGreaterThan(150);
    await drain(sqs, queues.events);

    const counting = new CountingPublisher(new SqsEventPublisher(sqs, queues.events));
    await Promise.all([untilEmpty(new PublishOutbox(h.uow, counting)), untilEmpty(new PublishOutbox(h.uow, counting)), untilEmpty(new PublishOutbox(h.uow, counting))]);

    expect(counting.sent).toHaveLength(expected.length); // nenhum evento enviado duas vezes
    expect(new Set(counting.sent)).toEqual(new Set(expected)); // nenhum evento perdido
    expect(await pending()).toHaveLength(0);

    const delivered = await drain(sqs, queues.events);
    expect(new Set(delivered.map((d) => d.body.eventId))).toEqual(new Set(expected));
    const sample = delivered.find((d) => d.body.eventType === 'WalletBalanceChanged')!.body;
    expect(sample).toMatchObject({ version: 1, correlationId: 'test', data: { money: { amount: expect.any(String), currency: 'BRL' } } });
    expect(typeof sample.data.balanceAfter.amount).toBe('string'); // MoneyProps, nunca number
  }, 60_000);

  test('publish failure keeps the event pending with backoff; it is published later, in order', async () => {
    await untilEmpty(new PublishOutbox(h.uow, new SqsEventPublisher(sqs, queues.events)));
    await drain(sqs, queues.events);
    const wallet = await h.wallet('100.00'); // 2 eventos: WalletBalanceChanged, WagerTransactionProcessed

    const sqsDown = new (class extends EventPublisher {
      async publish(): Promise<void> {
        throw new Error('SQS unavailable (simulated)');
      }
    })();
    await new PublishOutbox(h.uow, sqsDown).runOnce();
    const rows = await h.sql(`select attempts, next_attempt_at, published_at from outbox_messages where aggregate_id = ? order by sequence`, [wallet.id]);
    // o primeiro falhou e foi reagendado; o segundo da mesma wallet nem foi tentado, para não inverter a ordem
    expect(rows.map((r) => r.attempts)).toEqual([1, 0]);
    expect(rows[0]!.next_attempt_at).not.toBeNull();
    expect(rows.every((r) => r.published_at === null)).toBe(true);

    await Bun.sleep(1200); // backoff da primeira tentativa: 1s
    await untilEmpty(new PublishOutbox(h.uow, new SqsEventPublisher(sqs, queues.events)));
    const delivered = await drain(sqs, queues.events);
    expect(delivered.map((d) => d.body.eventType)).toEqual(['WalletBalanceChanged', 'WagerTransactionProcessed']);
  }, 30_000);

  test('a duplicate publication is safe: same eventId, deduplicated by the broker and by the consumer key', async () => {
    const wallet = await h.wallet('0.00');
    await h.send(h.payload(wallet, 'LOSS', '1.00'));
    const [row] = await h.sql(`select id, aggregate_id, event_type, payload, occurred_at from outbox_messages where aggregate_id = ?`, [wallet.id]);
    const message = OutboxMessage.rehydrate({ id: row!.id, aggregateId: row!.aggregate_id, eventType: row!.event_type, payload: row!.payload, occurredAt: row!.occurred_at, attempts: 0 });
    const publisher = new SqsEventPublisher(sqs, queues.events);
    await publisher.publish(message);
    await publisher.publish(message); // "publicou, morreu antes do commit, outra instância publicou de novo"
    const delivered = (await drain(sqs, queues.events)).filter((d) => d.body.aggregateId === wallet.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.body.eventId).toBe(row!.id);
  }, 30_000);
});
