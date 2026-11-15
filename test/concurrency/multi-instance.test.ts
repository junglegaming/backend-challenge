import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  assertLedgerInvariant,
  type ChildInstance,
  countRows,
  createTestEnvironment,
  http,
  openWallet,
  queueMessage,
  sendToQueue,
  spawnInstance,
  submitWager,
  type TestEnvironment,
  wagerBody,
  waitFor,
  walletRow,
} from '../support/harness';

/**
 * Three independent OS processes (`bun src/main.ts`), each running HTTP, the
 * SQS consumer, the outbox publisher and the pending-reference worker,
 * sharing one PostgreSQL database and one set of queues.
 */
let env: TestEnvironment;
let instances: ChildInstance[] = [];
const pick = (i: number) => instances[i % instances.length]!.url;

beforeAll(async () => {
  env = await createTestEnvironment({ CONSUMER_CONCURRENCY: '20' });
  instances = await Promise.all([spawnInstance(env), spawnInstance(env), spawnInstance(env)]);
});
afterAll(async () => {
  for (const instance of instances) instance.kill('SIGTERM');
  await Promise.all(instances.map((i) => i.exited));
  await assertLedgerInvariant(env);
  await env.teardown();
});

describe('3 instances', () => {
  test('section 8 across instances: exactly one of two 80.00 BETs wins', async () => {
    const wallet = await openWallet(pick(0), '100.00');
    const bets = [1, 2].map(() => wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '80.00' }));
    const results = await Promise.all(bets.map((b, i) => submitWager(pick(i + 1), b)));
    expect(results.map((r) => r.body.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(await walletRow(env, wallet.id)).toEqual({ balance: '20.00', version: 2 });
  });

  test('the same BET sent 60 times, round-robin over the 3 instances, debits once', async () => {
    const wallet = await openWallet(pick(0), '100.00');
    const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '1.00' });
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => submitWager(pick(i), body)));
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(await walletRow(env, wallet.id)).toEqual({ balance: '99.00', version: 2 });
  });

  test('hot wallet hammered by HTTP on all instances and SQS at the same time', async () => {
    const wallet = await openWallet(pick(0), '100.00');
    const httpOps = Array.from({ length: 90 }, () => wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '1.00' }));
    const queueOps = Array.from({ length: 30 }, () => wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'WIN', amount: '2.00' }));
    await Promise.all([
      ...httpOps.map((b, i) => submitWager(pick(i), b)),
      // each WIN in its own message group: consumed in parallel by all three instances
      ...queueOps.map((b, i) => sendToQueue(env, queueMessage(b), `win-${i}`)),
    ]);
    await waitFor(async () => (await countRows(env, `SELECT 1 FROM wager_transactions WHERE wallet_id = $1 AND kind = 'WIN'`, [wallet.id])) === 30, {
      timeoutMs: 30_000,
      description: 'queued WINs consumed',
    });
    const { rows } = await env.db.query(
      `SELECT kind, status, COUNT(*)::int AS n FROM wager_transactions WHERE wallet_id = $1 AND kind <> 'OPENING' GROUP BY 1, 2`,
      [wallet.id],
    );
    const n = (kind: string, status: string) => rows.find((r: { kind: string; status: string }) => r.kind === kind && r.status === status)?.n ?? 0;
    const expected = 10000 - n('BET', 'PROCESSED') * 100 + n('WIN', 'PROCESSED') * 200;
    const row = await walletRow(env, wallet.id);
    expect(Math.round(Number(row.balance) * 100)).toBe(expected);
    expect(n('BET', 'PROCESSED') + n('BET', 'REJECTED')).toBe(90);
    expect(n('WIN', 'PROCESSED')).toBe(30);
  });

  test('distinct wallets in parallel across instances', async () => {
    const wallets = await Promise.all(Array.from({ length: 15 }, (_, i) => openWallet(pick(i), '10.00')));
    await Promise.all(
      wallets.flatMap((w, wi) =>
        Array.from({ length: 6 }, (_, k) => submitWager(pick(wi + k), wagerBody({ walletId: w.id, playerId: w.playerId, kind: 'BET', amount: '1.50' }))),
      ),
    );
    for (const w of wallets) expect(await walletRow(env, w.id)).toEqual({ balance: '1.00', version: 7 });
  });

  test('every committed event is eventually published by the 3 concurrent outbox publishers', async () => {
    await waitFor(async () => (await countRows(env, 'SELECT 1 FROM outbox_messages WHERE published_at IS NULL')) === 0, {
      timeoutMs: 30_000,
      description: 'outbox drained',
    });
    const metrics = await Promise.all(instances.map(async (i) => (await http('GET', `${i.url}/health/ready`)).status));
    expect(metrics).toEqual([200, 200, 200]);
  });
});
