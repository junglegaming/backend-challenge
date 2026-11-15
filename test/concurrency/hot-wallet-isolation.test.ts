import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import type { AppConfig } from '../../src/infrastructure/config/app-config';
import {
  assertLedgerInvariant,
  createTestEnvironment,
  type HttpResult,
  openWallet,
  type RunningApp,
  sleep,
  startApp,
  submitWager,
  type TestEnvironment,
  wagerBody,
  walletRow,
} from '../support/harness';

/**
 * A hot wallet must not starve other wallets on the same instance.
 *
 * The instance gets a deliberately small pool (4 connections). An external
 * transaction holds the hot wallet's row lock, 20 requests pile up on that
 * wallet, and we measure a request for a different wallet. The control case
 * disables the per-wallet bulkhead to show the starvation the bulkhead prevents.
 */
let env: TestEnvironment;

beforeAll(async () => {
  env = await createTestEnvironment({ CONSUMER_ENABLED: 'false', PENDING_REFERENCE_ENABLED: 'false' });
});
afterAll(async () => {
  await assertLedgerInvariant(env);
  await env.teardown();
});

const SMALL_POOL: Partial<AppConfig> = { DATABASE_POOL_MAX: 4, DB_LOCK_TIMEOUT_MS: 5_000 };

const lockRow = async (walletId: string): Promise<PoolClient> => {
  const client = await env.db.connect();
  await client.query('BEGIN');
  await client.query('SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE', [walletId]);
  return client;
};

const unlock = async (client: PoolClient) => {
  await client.query('ROLLBACK');
  client.release();
};

/** Holds the hot wallet, floods it, and times a request for a cold wallet. */
const scenario = async (app: RunningApp, flood: number) => {
  const hot = await openWallet(app.url, '1000.00');
  const cold = await openWallet(app.url, '1000.00');
  const blocker = await lockRow(hot.id);
  const hotRequests: Array<Promise<HttpResult>> = Array.from({ length: flood }, () =>
    submitWager(app.url, wagerBody({ walletId: hot.id, playerId: hot.playerId, kind: 'BET', amount: '1.00' })),
  );
  await sleep(200); // let the flood reach the server

  const started = performance.now();
  const coldRequest = submitWager(app.url, wagerBody({ walletId: cold.id, playerId: cold.playerId, kind: 'BET', amount: '1.00' }));
  const coldFinishedWhileLocked = await Promise.race([coldRequest.then(() => true), sleep(1_500).then(() => false)]);
  const coldMs = performance.now() - started;

  await unlock(blocker);
  const [coldResult, hotResults] = await Promise.all([coldRequest, Promise.all(hotRequests)]);
  return { hot, cold, coldFinishedWhileLocked, coldMs, coldResult, hotResults };
};

describe('hot wallet isolation', () => {
  test('with the per-wallet bulkhead, other wallets keep flowing while one wallet is locked', async () => {
    const app = await startApp(env, { ...SMALL_POOL, WALLET_MAX_IN_FLIGHT: 1 });
    try {
      const r = await scenario(app, 20);
      expect(r.coldFinishedWhileLocked).toBe(true);
      expect(r.coldMs).toBeLessThan(1_000);
      expect(r.coldResult.status).toBe(200);
      // the queued hot requests all complete once the lock is released
      expect(r.hotResults.every((res) => res.status === 200 && res.body.status === 'PROCESSED')).toBe(true);
      expect(await walletRow(env, r.hot.id)).toEqual({ balance: '980.00', version: 21 });
      const metrics = await (await fetch(`${app.url}/metrics`)).text();
      expect(metrics).toMatch(/wagering_wallet_admission_total\{outcome="queued"\} (19|[2-9]\d)/);
    } finally {
      await app.close();
    }
  });

  test('control: without the bulkhead the same flood starves the pool and blocks other wallets', async () => {
    const app = await startApp(env, { ...SMALL_POOL, WALLET_MAX_IN_FLIGHT: 1_000 });
    try {
      const r = await scenario(app, 20);
      expect(r.coldFinishedWhileLocked).toBe(false);
      expect(r.coldResult.status).toBe(200); // eventually served, after the hot wallet unblocks
    } finally {
      await app.close();
    }
  });

  test('a hot wallet whose queue is full is refused fast with a retryable 503', async () => {
    const app = await startApp(env, { ...SMALL_POOL, WALLET_MAX_IN_FLIGHT: 1, WALLET_MAX_QUEUE: 5 });
    try {
      const hot = await openWallet(app.url, '100.00');
      const blocker = await lockRow(hot.id);
      const requests = Array.from({ length: 12 }, () =>
        submitWager(app.url, wagerBody({ walletId: hot.id, playerId: hot.playerId, kind: 'BET', amount: '1.00' })),
      );
      await sleep(300);
      await unlock(blocker);
      const results = await Promise.all(requests);
      const refused = results.filter((r) => r.status === 503);
      expect(refused.length).toBe(6); // 1 running + 5 queued are admitted
      expect(refused.every((r) => r.body.error.code === 'TEMPORARILY_UNAVAILABLE' && r.body.error.retryable === true)).toBe(true);
      expect(results.filter((r) => r.status === 200)).toHaveLength(6);
      expect(await walletRow(env, hot.id)).toEqual({ balance: '94.00', version: 7 });
    } finally {
      await app.close();
    }
  });
});
