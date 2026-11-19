import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { QueueUrls } from '../../src/infra/sqs/queues';
import { enqueue, freshDatabase, freshQueues, harness, Instance, queueTotal, spawnInstance, uuid, wagerMessage, waitFor } from '../support';

/**
 * Processos reais: cada instância é um `bun src/main.ts` separado (API + consumidor + workers),
 * todos no mesmo Postgres e nas mesmas filas. Nada aqui compartilha memória.
 */
let orm: MikroORM;
let h: ReturnType<typeof harness>;
let sqs: SQSClient;
let queues: QueueUrls;
let instances: Instance[] = [];

const PORTS = [3301, 3302, 3303];
const startAll = async () => (instances = await Promise.all(PORTS.map((port) => spawnInstance(port))));
const killAll = async (signal: 'SIGKILL' | 'SIGTERM' = 'SIGKILL') => {
  await Promise.all(instances.map((i) => i.kill(signal)));
  instances = [];
};

beforeAll(async () => {
  orm = await freshDatabase();
  h = harness(orm);
  ({ sqs, queues } = await freshQueues());
}, 30_000);
afterAll(async () => {
  await killAll();
  await h.assertLedgerConsistent();
  await orm.close();
  sqs.destroy();
});

const post = (instance: Instance, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${instance.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const submit = async (instance: Instance, payload: Record<string, any>): Promise<Record<string, any>> => {
  const response = await post(instance, '/wagering/transactions', payload, { 'Idempotency-Key': `${payload.providerId}:${payload.externalTransactionId}` });
  return { http: response.status, ...((await response.json()) as Record<string, any>) };
};
const debits = async (walletId: string) => (await h.sql(`select 1 from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [walletId])).length;
const pendingOutbox = async () => (await h.sql(`select 1 from outbox_messages where published_at is null`)).length;
const quiet = () =>
  waitFor(async () => (await queueTotal(sqs, queues.input)) === 0 && (await pendingOutbox()) === 0, 60_000, 'queue drained and outbox published');

describe('worker killed after commit and before ack', () => {
  test('the redelivered message is recognised by the inbox: one debit only', async () => {
    const wallet = await h.wallet('100.00');
    const messageId = uuid();
    await enqueue(sqs, queues.input, wagerMessage(messageId, h.payload(wallet, 'BET', '30.00')), wallet.id);

    // Esta instância se mata (SIGKILL) exatamente entre o commit e o DeleteMessage.
    const doomed = await spawnInstance(3310, { ROLES: 'consumer', FAULT_INJECTION: 'crash_before_ack' });
    await doomed.process.exited;

    expect(await h.balance(wallet.id)).toBe('70.00'); // o commit aconteceu
    expect(await queueTotal(sqs, queues.input)).toBe(1); // o ack não
    expect(await h.sql(`select 1 from inbox_messages where message_id = ? and processed_at is not null`, [messageId])).toHaveLength(1);

    // Outra instância recebe a mesma mensagem depois do visibility timeout.
    const healthy = await spawnInstance(3311, { ROLES: 'consumer,workers' });
    try {
      await quiet();
    } finally {
      await healthy.kill('SIGTERM');
    }
    expect(await h.balance(wallet.id)).toBe('70.00');
    expect(await debits(wallet.id)).toBe(1);
    await h.assertLedgerConsistent(wallet.id);
  }, 60_000);
});

describe('three instances', () => {
  test('mandatory scenario across instances: 100.00 and two bets of 80.00 sent to different processes', async () => {
    await startAll();
    const [a, b, c] = instances as [Instance, Instance, Instance];
    const created = await post(a, '/wallets', { playerId: uuid(), initialBalance: { amount: '100.00', currency: 'BRL' } });
    expect(created.status).toBe(201);
    const wallet = (await created.json()) as { id: string; playerId: string; balance: any; version: number };

    const [first, second] = [h.payload(wallet, 'BET', '80.00'), h.payload(wallet, 'BET', '80.00')];
    const results = await Promise.all([submit(a, first), submit(b, second)]);
    expect(results.map((r) => r.http).sort()).toEqual([200, 422]);
    expect(results.find((r) => r.http === 422)).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });

    // retries espalhados pelas três instâncias não duplicam o débito
    const retries = await Promise.all([a, b, c, a, b, c].map((instance, i) => submit(instance, i % 2 === 0 ? first : second)));
    expect(retries.every((r) => r.idempotentReplay === true)).toBe(true);
    expect(await h.balance(wallet.id)).toBe('20.00');
    expect(await debits(wallet.id)).toBe(1);
  }, 60_000);

  test('the same bet sent 50 times in parallel across three instances produces a single debit', async () => {
    const wallet = await h.wallet('100.00');
    const bet = h.payload(wallet, 'BET', '10.00');
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(instances[i % 3]!, bet)));
    expect(results.every((r) => r.http === 200)).toBe(true);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(await debits(wallet.id)).toBe(1);
    expect(await h.balance(wallet.id)).toBe('90.00');
  }, 60_000);

  test('a queue backlog with duplicates is consumed by three instances; wallets end consistent', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => h.wallet('100.00')));
    const sends: Promise<void>[] = [];
    for (const wallet of wallets) {
      for (let i = 0; i < 20; i++) {
        const message = wagerMessage(uuid(), h.payload(wallet, 'BET', '1.00'));
        sends.push(enqueue(sqs, queues.input, message, wallet.id));
        if (i % 2 === 0) sends.push(enqueue(sqs, queues.input, message, wallet.id)); // redelivery da mesma mensagem
        if (i % 5 === 0) sends.push(enqueue(sqs, queues.input, { ...message, messageId: uuid() }, wallet.id)); // mesma transação, outra mensagem
      }
    }
    await Promise.all(sends);
    await quiet();

    for (const wallet of wallets) {
      expect(await h.balance(wallet.id)).toBe('80.00');
      expect(await debits(wallet.id)).toBe(20);
    }
    await h.assertLedgerConsistent();
    // o trabalho foi de fato dividido entre processos diferentes
    const metricsText = await Promise.all(instances.map((i) => fetch(`${i.url}/metrics`).then((r) => r.text())));
    const processedBy = metricsText.map((text) => Number(/wager_transactions_total\{kind="BET",status="PROCESSED",failure_code=""\} (\d+)/.exec(text)?.[1] ?? 0));
    expect(processedBy.filter((n) => n > 0).length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  test('all instances are killed mid-flight and restarted: final state is consistent and complete', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => h.wallet('100.00')));
    await Promise.all(
      wallets.flatMap((wallet) => Array.from({ length: 30 }, () => enqueue(sqs, queues.input, wagerMessage(uuid(), h.payload(wallet, 'BET', '2.00')), wallet.id))),
    );
    await waitFor(async () => (await h.sql(`select 1 from wager_transactions where kind = 'BET' and wallet_id in (?)`, [wallets.map((w) => w.id)])).length > 20, 30_000, 'processing started');
    await killAll('SIGKILL'); // sem aviso, no meio do trabalho

    // Mesmo parado no meio, o que foi confirmado é consistente.
    await h.assertLedgerConsistent();
    const processedBeforeRestart = (await h.sql(`select 1 from wager_transactions where kind = 'BET' and wallet_id in (?)`, [wallets.map((w) => w.id)])).length;
    expect(processedBeforeRestart).toBeLessThan(300);

    await startAll();
    await quiet();
    for (const wallet of wallets) {
      expect(await h.balance(wallet.id)).toBe('40.00');
      expect(await debits(wallet.id)).toBe(30);
    }
    await h.assertLedgerConsistent();
    await killAll('SIGTERM');
  }, 180_000);
});
