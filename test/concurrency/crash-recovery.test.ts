import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import {
  assertLedgerInvariant,
  countRows,
  createTestEnvironment,
  openWallet,
  queueMessage,
  sendToQueue,
  sleep,
  spawnInstance,
  submitWager,
  type TestEnvironment,
  wagerBody,
  waitFor,
  walletRow,
} from '../support/harness';

/**
 * Process death at the worst moments. Each scenario uses real processes that
 * are killed (exit / SIGKILL) and replaced by fresh ones.
 */
let env: TestEnvironment;

beforeAll(async () => {
  env = await createTestEnvironment({ CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '3', OUTBOX_LEASE_MS: '2000' });
});
afterAll(async () => {
  await assertLedgerInvariant(env);
  await env.teardown();
});

const queueDepth = async () => {
  const urls = await env.sqs.queueUrls();
  const { Attributes } = await env.sqs.client.send(
    new GetQueueAttributesCommand({
      QueueUrl: urls.transactions,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Number(Attributes?.ApproximateNumberOfMessages ?? 0) + Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
};

describe('crash recovery', () => {
  test('worker killed AFTER the commit and BEFORE the ack: redelivery has no second effect', async () => {
    const crashing = await spawnInstance(env, { FAULT_INJECTION: 'crash-after-commit' });
    const wallet = await openWallet(crashing.url, '100.00');
    const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '40.00' });
    const message = queueMessage(body);
    await sendToQueue(env, message, wallet.id);

    // the process commits and dies without deleting the message
    expect(await crashing.exited).toBe(137);
    expect(await walletRow(env, wallet.id)).toEqual({ balance: '60.00', version: 2 });
    expect(await queueDepth()).toBe(1);

    // a healthy instance receives the redelivery after the visibility timeout
    const healthy = await spawnInstance(env);
    try {
      await waitFor(async () => (await queueDepth()) === 0, { timeoutMs: 30_000, description: 'redelivered message acked' });
      const metrics = await (await fetch(`${healthy.url}/metrics`)).text();
      expect(metrics).toMatch(/wagering_duplicates_detected_total\{kind="inbox"\} 1/);
      expect(await walletRow(env, wallet.id)).toEqual({ balance: '60.00', version: 2 });
      expect(await countRows(env, `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [wallet.id])).toBe(1);
    } finally {
      healthy.kill('SIGTERM');
      await healthy.exited;
    }
  });

  test('SIGKILL under load, restart: the system converges to a consistent final state', async () => {
    const first = await spawnInstance(env);
    const wallets = await Promise.all(Array.from({ length: 5 }, () => openWallet(first.url, '500.00')));

    // HTTP + queue + out-of-order reversals in flight when the process is killed
    const bets = wallets.flatMap((w) => Array.from({ length: 20 }, () => wagerBody({ walletId: w.id, playerId: w.playerId, kind: 'BET', amount: '5.00' })));
    const refunds = bets.slice(0, 10).map((b) =>
      wagerBody({ walletId: b.walletId, playerId: b.playerId, kind: 'REFUND', amount: '5.00', referenceExternalTransactionId: b.externalTransactionId }),
    );
    await Promise.all(refunds.map((r, i) => sendToQueue(env, queueMessage(r), `refund-${i}`)));
    await Promise.all(bets.slice(0, 50).map((b, i) => sendToQueue(env, queueMessage(b), `bet-${i}`)));
    const inflight = Promise.allSettled(bets.slice(50).map((b) => submitWager(first.url, b)));
    await sleep(150);
    first.kill('SIGKILL');
    await first.exited;
    await inflight;

    // restart: two fresh instances; the HTTP client retries everything it did not get an answer for
    const second = await spawnInstance(env);
    const third = await spawnInstance(env);
    try {
      const retried = await Promise.all(bets.slice(50).map((b, i) => submitWager((i % 2 ? second : third).url, b)));
      expect(retried.every((r) => r.status === 200 || r.status === 422)).toBe(true);

      await waitFor(async () => (await queueDepth()) === 0, { timeoutMs: 60_000, description: 'queue drained' });
      await waitFor(async () => (await countRows(env, `SELECT 1 FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`)) === 0, {
        timeoutMs: 30_000,
        description: 'pending references resolved',
      });
      await waitFor(async () => (await countRows(env, 'SELECT 1 FROM outbox_messages WHERE published_at IS NULL')) === 0, {
        timeoutMs: 30_000,
        description: 'outbox drained',
      });

      // every bet applied exactly once, every refund applied exactly once
      for (const b of bets) {
        expect(await countRows(env, `SELECT 1 FROM wager_transactions WHERE external_transaction_id = $1`, [b.externalTransactionId])).toBe(1);
      }
      expect(await countRows(env, `SELECT 1 FROM wager_transactions WHERE kind = 'REFUND' AND status = 'PROCESSED'`)).toBe(10);
      for (const w of wallets) {
        const processedBets = await countRows(env, `SELECT 1 FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET' AND status = 'PROCESSED'`, [w.id]);
        const refunded = await countRows(env, `SELECT 1 FROM wager_transactions WHERE wallet_id = $1 AND kind = 'REFUND' AND status = 'PROCESSED'`, [w.id]);
        const row = await walletRow(env, w.id);
        expect(Math.round(Number(row.balance) * 100)).toBe(50000 - processedBets * 500 + refunded * 500);
      }
      await assertLedgerInvariant(env);
    } finally {
      second.kill('SIGTERM');
      third.kill('SIGTERM');
      await Promise.all([second.exited, third.exited]);
    }
  });

  test('SIGTERM drains gracefully (exit code 0, consumer drained)', async () => {
    const instance = await spawnInstance(env);
    const wallet = await openWallet(instance.url, '100.00');
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        sendToQueue(env, queueMessage(wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '1.00' })), `g-${i}`),
      ),
    );
    await sleep(300);
    instance.kill('SIGTERM');
    expect(await instance.exited).toBe(0);
    expect(instance.output()).toContain('"drained":true');

    // whatever was not processed is still in the queue and gets processed by the next instance
    const next = await spawnInstance(env);
    try {
      await waitFor(async () => (await queueDepth()) === 0, { timeoutMs: 30_000 });
      expect(await countRows(env, `SELECT 1 FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET'`, [wallet.id])).toBe(10);
      expect((await walletRow(env, wallet.id)).balance).toBe('90.00');
    } finally {
      next.kill('SIGTERM');
      await next.exited;
    }
  });
});
