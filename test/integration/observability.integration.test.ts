import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { ConsumeWagerMessage } from '../../src/application/wagering/consume-wager-message';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction';
import { RetryPendingReference } from '../../src/application/wagering/retry-pending-reference';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { PrometheusMetrics } from '../../src/infrastructure/observability/prometheus-metrics';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-enums';
import { createTestApp, type TestApp } from './support/http-app';
import { createTestDatabase, type TestDatabase } from './support/test-database';

let db: TestDatabase;
let api: TestApp;
beforeAll(async () => { db = await createTestDatabase(); api = await createTestApp(db); });
afterAll(async () => { await api?.close(); await db?.drop(); });

test('HTTP correlation propagates to opening and transaction events and retries retain it', async () => {
  const playerId = randomUUID();
  const wallet = await api.post('/wallets', { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
    { 'x-correlation-id': 'open-trace' });
  expect(wallet.headers.get('x-correlation-id')).toBe('open-trace');
  const walletId = wallet.body.id as string;
  const reference = randomUUID();
  const request = {
    providerId: 'provider', externalTransactionId: randomUUID(), playerId, walletId,
    roundId: 'round', gameId: 'game', kind: 'ROLLBACK', money: { amount: '1.00', currency: 'BRL' },
    referenceExternalTransactionId: reference,
  };
  const pending = await api.post('/wagering/transactions', request, {
    'idempotency-key': randomUUID(), 'x-correlation-id': 'original-trace',
  });
  expect(pending.status).toBe(202);
  const transactionId = pending.body.transactionId as string;
  const [first] = await db.run<{ correlation: string }>(
    `select payload->>'correlationId' as correlation from outbox_messages where payload->'data'->>'transactionId' = ?`, [transactionId]);
  expect(first?.correlation).toBe('original-trace');
  const bet = await api.post('/wagering/transactions', { ...request, kind: 'BET', externalTransactionId: reference, referenceExternalTransactionId: undefined }, {
    'idempotency-key': randomUUID(), 'x-correlation-id': 'other-trace',
  });
  expect(bet.status).toBe(200);
  const uow = new MikroOrmUnitOfWork(db.orm.em);
  const clock = { now: () => new Date(Date.now() + 2000) };
  const process = new ProcessWagerTransaction(uow, clock, { next: randomUUID });
  expect(await new RetryPendingReference(uow, clock, process).runOne()).toBe(true);
  const events = await db.run<{ correlation: string }>(
    `select payload->>'correlationId' as correlation from outbox_messages
     where event_type = 'WagerTransactionProcessed' and payload->'data'->>'transactionId' = ?`, [transactionId]);
  expect(events).toEqual([{ correlation: 'original-trace' }]);
  const opening = await db.run<{ correlation: string }>(
    `select payload->>'correlationId' as correlation from outbox_messages
     where event_type = 'WagerTransactionProcessed' and payload->'data'->>'walletId' = ? and payload->'data'->>'kind' = 'OPENING'`, [walletId]);
  expect(opening).toEqual([{ correlation: 'open-trace' }]);
  const metrics = await (await fetch(`${api.url}/metrics`)).text();
  expect(metrics).toContain('wager_transactions_total{status="PENDING_REFERENCE"} 1');
  expect(metrics).toContain('wager_operation_duration_seconds_count{operation="http"}');
});

test('SQS envelope correlation and message causation reach outbox', async () => {
  const playerId = randomUUID();
  const w = await api.post('/wallets', { playerId, initialBalance: { amount: '10.00', currency: 'BRL' } });
  const messageId = randomUUID();
  const uow = new MikroOrmUnitOfWork(db.orm.em);
  const process = new ProcessWagerTransaction(uow, { now: () => new Date() }, { next: randomUUID });
  await new ConsumeWagerMessage(process).execute(JSON.stringify({
    messageId, correlationId: 'message-trace', type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
    data: { idempotencyKey: randomUUID(), providerId: 'provider', externalTransactionId: randomUUID(),
      walletId: w.body.id, playerId, roundId: 'round', gameId: 'game', kind: WagerTransactionKind.Bet,
      money: { amount: '1.00', currency: 'BRL' } },
  }));
  const rows = await db.run<{ correlation: string; causation: string }>(
    `select payload->>'correlationId' as correlation, payload->>'causationId' as causation
     from outbox_messages where payload->>'causationId' = ?`, [messageId]);
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.correlation === 'message-trace' && r.causation === messageId)).toBe(true);
});

test('real lock timeout increments conflict counter without persisting the transaction', async () => {
  const playerId = randomUUID();
  const w = await api.post('/wallets', { playerId, initialBalance: { amount: '10.00', currency: 'BRL' } });
  const metrics = new PrometheusMetrics();
  const process = new ProcessWagerTransaction(new MikroOrmUnitOfWork(db.orm.em, 100, metrics),
    { now: () => new Date() }, { next: randomUUID }, metrics);
  const holder = db.orm.em.fork();
  await holder.begin();
  await holder.getConnection().execute('select id from wallets where id = ? for no key update', [w.body.id], 'all', holder.getTransactionContext());
  try {
    await expect(process.execute({ idempotencyKey: randomUUID(), providerId: 'provider', externalTransactionId: randomUUID(),
      walletId: w.body.id, playerId, roundId: 'round', gameId: 'game', kind: WagerTransactionKind.Bet,
      money: { amount: '1.00', currency: 'BRL' } })).rejects.toThrow();
    expect(await metrics.render()).toContain('wager_lock_conflicts_total 1');
  } finally {
    await holder.rollback();
  }
});
