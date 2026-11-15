import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  assertLedgerInvariant,
  countRows,
  createTestEnvironment,
  openWallet,
  queueMessage,
  type RunningApp,
  sendToQueue,
  startApp,
  submitWager,
  type TestEnvironment,
  wagerBody,
  waitFor,
  walletRow,
} from '../support/harness';

/**
 * Real parallelism against one instance: requests are fired with
 * Promise.all over a connection pool of 20, so PostgreSQL sees genuinely
 * concurrent transactions competing for the same wallet row.
 */
let env: TestEnvironment;
let app: RunningApp;

beforeAll(async () => {
  env = await createTestEnvironment({ CONSUMER_CONCURRENCY: '30' });
  app = await startApp(env);
});
afterEach(async () => {
  await assertLedgerInvariant(env);
});
afterAll(async () => {
  await app.close();
  await env.teardown();
});

describe('races on one instance', () => {
  test('the same BET sent 50 times in parallel debits exactly once', async () => {
    const wallet = await openWallet(app.url, '100.00');
    const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '10.00' });
    const results = await Promise.all(Array.from({ length: 50 }, () => submitWager(app.url, body)));

    expect(results.every((r) => r.status === 200 && r.body.status === 'PROCESSED')).toBe(true);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(results.every((r) => r.body.balance.amount === '90.00')).toBe(true);
    expect(await walletRow(env, wallet.id)).toEqual({ balance: '90.00', version: 2 });
    expect(await countRows(env, `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [wallet.id])).toBe(1);
  });

  test('the same BET delivered 20 times through SQS (distinct messages) debits exactly once', async () => {
    const wallet = await openWallet(app.url, '100.00');
    const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '10.00' });
    // different MessageGroupIds => SQS hands them out in parallel
    await Promise.all(Array.from({ length: 20 }, (_, i) => sendToQueue(env, queueMessage(body), `group-${i}`)));
    await waitFor(async () => (await countRows(env, `SELECT 1 FROM inbox_messages WHERE payload_hash = (SELECT payload_hash FROM wager_transactions WHERE external_transaction_id = $1)`, [body.externalTransactionId])) === 20, {
      timeoutMs: 30_000,
      description: '20 deliveries consumed',
    });
    expect(await walletRow(env, wallet.id)).toEqual({ balance: '90.00', version: 2 });
  });

  test('section 8: balance 100.00, two concurrent BETs of 80.00 -> one PROCESSED, one INSUFFICIENT_FUNDS, balance 20.00', async () => {
    const wallet = await openWallet(app.url, '100.00');
    const bets = [1, 2].map(() => wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '80.00' }));
    const results = await Promise.all(bets.map((b) => submitWager(app.url, b)));

    expect(results.map((r) => r.body.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.find((r) => r.body.status === 'REJECTED')!.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await walletRow(env, wallet.id)).toEqual({ balance: '20.00', version: 2 });
    expect(await countRows(env, `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [wallet.id])).toBe(1);

    // retries of both requests (in parallel, many times) never duplicate the debit
    const retries = await Promise.all(bets.flatMap((b) => Array.from({ length: 10 }, () => submitWager(app.url, b))));
    expect(retries.every((r) => r.body.idempotentReplay === true)).toBe(true);
    expect(await walletRow(env, wallet.id)).toEqual({ balance: '20.00', version: 2 });
  });

  test('hot wallet: 200 concurrent mixed operations keep the balance exact and never negative', async () => {
    const wallet = await openWallet(app.url, '50.00');
    const ops = Array.from({ length: 200 }, (_, i) =>
      wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: i % 3 === 0 ? 'WIN' : 'BET', amount: i % 3 === 0 ? '7.00' : '5.00' }),
    );
    const results = await Promise.all(ops.map((o) => submitWager(app.url, o)));
    expect(results.every((r) => r.status === 200 || r.status === 422)).toBe(true);

    const credits = results.filter((r, i) => r.body.status === 'PROCESSED' && ops[i]!.kind === 'WIN').length;
    const debits = results.filter((r, i) => r.body.status === 'PROCESSED' && ops[i]!.kind === 'BET').length;
    const rejected = results.filter((r) => r.body.status === 'REJECTED');
    expect(rejected.every((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);

    const expectedCents = 5000 + credits * 700 - debits * 500;
    const row = await walletRow(env, wallet.id);
    expect(Math.round(Number(row.balance) * 100)).toBe(expectedCents);
    expect(row.version).toBe(1 + credits + debits);
  });

  test('distinct wallets are processed in parallel and independently', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => openWallet(app.url, '100.00')));
    const started = performance.now();
    await Promise.all(
      wallets.flatMap((w) =>
        Array.from({ length: 10 }, () => submitWager(app.url, wagerBody({ walletId: w.id, playerId: w.playerId, kind: 'BET', amount: '3.00' }))),
      ),
    );
    const elapsedMs = performance.now() - started;
    for (const w of wallets) {
      expect(await walletRow(env, w.id)).toEqual({ balance: '70.00', version: 11 });
    }
    // 200 transactions across 20 wallets; no global lock means they overlap
    expect(elapsedMs).toBeLessThan(15_000);
  });

  test('REFUND racing its BET (many rounds in parallel) always converges', async () => {
    const wallet = await openWallet(app.url, '1000.00');
    const pairs = Array.from({ length: 25 }, (_, i) => {
      const bet = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '10.00', roundId: `round-${i}` });
      const refund = wagerBody({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'REFUND',
        amount: '10.00',
        roundId: `round-${i}`,
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      return { bet, refund };
    });
    await Promise.all(pairs.flatMap(({ bet, refund }) => [submitWager(app.url, refund), submitWager(app.url, bet)]));
    await waitFor(async () => (await countRows(env, `SELECT 1 FROM wager_transactions WHERE wallet_id = $1 AND status = 'PENDING_REFERENCE'`, [wallet.id])) === 0, {
      timeoutMs: 30_000,
      description: 'all refunds resolved',
    });
    expect(await countRows(env, `SELECT 1 FROM wager_transactions WHERE wallet_id = $1 AND kind = 'REFUND' AND status = 'PROCESSED'`, [wallet.id])).toBe(25);
    expect((await walletRow(env, wallet.id)).balance).toBe('1000.00');
  });
});
