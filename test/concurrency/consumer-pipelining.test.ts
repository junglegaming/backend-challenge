import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  assertLedgerInvariant,
  countRows,
  createTestEnvironment,
  openWallet,
  queueMessage,
  type RunningApp,
  sendToQueue,
  sleep,
  startApp,
  type TestEnvironment,
  wagerBody,
  waitFor,
  walletRow,
} from '../support/harness';

/**
 * One slow message must not hold back the consumer. A single poller
 * (CONSUMER_CONCURRENCY=10) receives message A, which blocks on a row lock held
 * by the test; messages for other wallets sent afterwards must still be
 * received and processed while A is stuck.
 */
let env: TestEnvironment;
let app: RunningApp;

beforeAll(async () => {
  env = await createTestEnvironment({
    CONSUMER_CONCURRENCY: '10',
    DB_LOCK_TIMEOUT_MS: '8000',
    OUTBOX_ENABLED: 'false',
    PENDING_REFERENCE_ENABLED: 'false',
  });
  app = await startApp(env);
});
afterAll(async () => {
  await app.close();
  await assertLedgerInvariant(env);
  await env.teardown();
});

const processed = (externalId: string) =>
  countRows(env, `SELECT 1 FROM wager_transactions WHERE external_transaction_id = $1 AND status = 'PROCESSED'`, [externalId]);

describe('consumer pipelining', () => {
  test('messages keep flowing while an earlier message is blocked', async () => {
    const slow = await openWallet(app.url, '100.00');
    const others = await Promise.all(Array.from({ length: 4 }, () => openWallet(app.url, '100.00')));

    const blocker = await env.db.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE', [slow.id]);
    try {
      const slowBet = wagerBody({ walletId: slow.id, playerId: slow.playerId, kind: 'BET', amount: '1.00' });
      await sendToQueue(env, queueMessage(slowBet), slow.id);
      await sleep(1_500); // A is received and now waits on the row lock

      const bets = others.map((w) => wagerBody({ walletId: w.id, playerId: w.playerId, kind: 'BET', amount: '1.00' }));
      await Promise.all(bets.map((b, i) => sendToQueue(env, queueMessage(b), others[i]!.id)));

      // processed while A is still blocked (lock held for up to 8 s)
      await waitFor(async () => (await Promise.all(bets.map((b) => processed(b.externalTransactionId)))).every((n) => n === 1), {
        timeoutMs: 4_000,
        description: 'later messages processed while the first one is blocked',
      });
      expect(await processed(slowBet.externalTransactionId)).toBe(0);

      await blocker.query('ROLLBACK');
      await waitFor(async () => (await processed(slowBet.externalTransactionId)) === 1, { description: 'blocked message processed after unlock' });
      expect(await walletRow(env, slow.id)).toEqual({ balance: '99.00', version: 2 });
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  });
});
