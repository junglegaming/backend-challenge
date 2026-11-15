import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  assertLedgerInvariant,
  countRows,
  createTestEnvironment,
  http,
  openWallet,
  type RunningApp,
  startApp,
  submitWager,
  type TestEnvironment,
  wagerBody,
  waitFor,
  walletRow,
} from '../support/harness';

/** Out-of-order delivery: the reversal arrives before the transaction it reverts. */
let env: TestEnvironment;
let app: RunningApp;

beforeAll(async () => {
  env = await createTestEnvironment({
    CONSUMER_ENABLED: 'false',
    PENDING_REFERENCE_MAX_ATTEMPTS: '3',
    PENDING_REFERENCE_BASE_DELAY_MS: '200',
    PENDING_REFERENCE_MAX_DELAY_MS: '400',
  });
  app = await startApp(env);
});
afterAll(async () => {
  await app.close();
  await assertLedgerInvariant(env);
  await env.teardown();
});

const statusOf = async (transactionId: string) => (await http('GET', `${app.url}/wagering/transactions/${transactionId}`)).body;

describe('PENDING_REFERENCE resolution', () => {
  test('REFUND before its BET is parked, then applied by the worker once the BET arrives', async () => {
    const wallet = await openWallet(app.url, '100.00');
    const base = { walletId: wallet.id, playerId: wallet.playerId };
    const bet = wagerBody({ ...base, kind: 'BET', amount: '30.00' });
    const refund = wagerBody({ ...base, kind: 'REFUND', amount: '30.00', referenceExternalTransactionId: bet.externalTransactionId });

    const parked = await submitWager(app.url, refund);
    expect(parked.status).toBe(202);
    expect(parked.body.status).toBe('PENDING_REFERENCE');
    expect(await countRows(env, `SELECT 1 FROM outbox_messages WHERE event_type = 'WagerTransactionPendingReference' AND aggregate_id = $1`, [parked.body.transactionId])).toBe(1);

    expect((await submitWager(app.url, bet)).body.balance.amount).toBe('70.00');
    const resolved = await waitFor(async () => {
      const tx = await statusOf(parked.body.transactionId);
      return tx.status === 'PROCESSED' ? tx : undefined;
    }, { description: 'refund resolved' });
    expect(resolved.balance.amount).toBe('100.00');
    expect(await walletRow(env, wallet.id)).toEqual({ balance: '100.00', version: 3 });

    // a replay of the original request now returns the final state
    const replay = await submitWager(app.url, refund);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: true });
  });

  test('ROLLBACK of a WIN that has not arrived yet is applied after it', async () => {
    const wallet = await openWallet(app.url, '10.00');
    const base = { walletId: wallet.id, playerId: wallet.playerId };
    const win = wagerBody({ ...base, kind: 'WIN', amount: '15.00' });
    const rollback = wagerBody({ ...base, kind: 'ROLLBACK', amount: '15.00', referenceExternalTransactionId: win.externalTransactionId });

    const parked = await submitWager(app.url, rollback);
    expect(parked.body.status).toBe('PENDING_REFERENCE');
    await submitWager(app.url, win);
    await waitFor(async () => (await statusOf(parked.body.transactionId)).status === 'PROCESSED');
    expect(await walletRow(env, wallet.id)).toEqual({ balance: '10.00', version: 3 });
  });

  test('a reference that never arrives is REJECTED with REFERENCE_NOT_FOUND after the retry budget, and an event is published', async () => {
    const wallet = await openWallet(app.url, '10.00');
    const parked = await submitWager(
      app.url,
      wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'REFUND', amount: '1.00', referenceExternalTransactionId: 'ghost' }),
    );
    const final = await waitFor(async () => {
      const tx = await statusOf(parked.body.transactionId);
      return tx.status === 'REJECTED' ? tx : undefined;
    }, { description: 'pending reference exhausted' });
    expect(final.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(await countRows(env, `SELECT 1 FROM wager_transactions WHERE id = $1 AND reference_attempts = 2`, [parked.body.transactionId])).toBe(1);
    expect(await countRows(env, `SELECT 1 FROM outbox_messages WHERE event_type = 'WagerTransactionRejected' AND aggregate_id = $1`, [parked.body.transactionId])).toBe(1);
    expect(await walletRow(env, wallet.id)).toEqual({ balance: '10.00', version: 1 });
  });

  test('a reference that ends REJECTED makes the dependent reversal REJECTED (REFERENCE_NOT_PROCESSED)', async () => {
    const wallet = await openWallet(app.url, '5.00');
    const base = { walletId: wallet.id, playerId: wallet.playerId };
    const bet = wagerBody({ ...base, kind: 'BET', amount: '50.00' }); // will be rejected: no funds
    const parked = await submitWager(app.url, wagerBody({ ...base, kind: 'REFUND', amount: '50.00', referenceExternalTransactionId: bet.externalTransactionId }));
    await submitWager(app.url, bet);
    const final = await waitFor(async () => {
      const tx = await statusOf(parked.body.transactionId);
      return tx.status === 'REJECTED' ? tx : undefined;
    });
    expect(final.failureCode).toBe('REFERENCE_NOT_PROCESSED');
  });
});
