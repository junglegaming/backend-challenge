import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { v7 as uuidv7 } from 'uuid';
import {
  assertLedgerInvariant,
  countRows,
  createTestEnvironment,
  http,
  openWallet,
  queueMessage,
  receiveAll,
  type RunningApp,
  sendToQueue,
  startApp,
  type TestEnvironment,
  wagerBody,
  waitFor,
  walletRow,
} from '../support/harness';

/**
 * Real LocalStack SQS + real PostgreSQL. Short visibility/backoff values keep
 * the retry tests fast; the lock timeout is short so a held row lock turns
 * into a transient error quickly.
 */
let env: TestEnvironment;
let app: RunningApp;
const CONSUMER = 'wager-transactions-consumer';

beforeAll(async () => {
  env = await createTestEnvironment({
    CONSUMER_MAX_ATTEMPTS: '3',
    CONSUMER_RETRY_BASE_SECONDS: '1',
    CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '5',
    DB_LOCK_TIMEOUT_MS: '300',
  });
  app = await startApp(env);
});
afterAll(async () => {
  await app.close();
  await assertLedgerInvariant(env);
  await env.teardown();
});

const processedCount = (externalId: string) =>
  countRows(env, `SELECT 1 FROM wager_transactions WHERE external_transaction_id = $1 AND status = 'PROCESSED'`, [externalId]);

describe('SQS consumer', () => {
  test('processes a message through the same use case and records the inbox', async () => {
    const wallet = await openWallet(app.url, '100.00');
    const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '25.00' });
    const message = queueMessage(body);
    await sendToQueue(env, message, wallet.id);

    await waitFor(async () => (await processedCount(body.externalTransactionId)) === 1, { description: 'message processed' });
    expect(await walletRow(env, wallet.id)).toEqual({ balance: '75.00', version: 2 });
    expect(await countRows(env, 'SELECT 1 FROM inbox_messages WHERE consumer_name = $1 AND message_id = $2', [CONSUMER, message.messageId])).toBe(1);
    // the same transaction is visible over HTTP
    const viaHttp = await http('GET', `${app.url}/providers/provider-a/wagering/transactions/${body.externalTransactionId}`);
    expect(viaHttp.body.status).toBe('PROCESSED');
  });

  test('redelivery of the same message (same messageId) has no second effect', async () => {
    const wallet = await openWallet(app.url, '100.00');
    const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '10.00' });
    const message = queueMessage(body);
    // three physical deliveries of one logical message (different SQS dedup ids)
    await sendToQueue(env, message, wallet.id);
    await sendToQueue(env, message, wallet.id);
    await sendToQueue(env, message, wallet.id);

    await waitFor(async () => (await processedCount(body.externalTransactionId)) === 1);
    await waitFor(async () => {
      const metrics = await (await fetch(`${app.url}/metrics`)).text();
      return /wagering_duplicates_detected_total\{kind="inbox"\} [2-9]/.test(metrics);
    }, { description: 'inbox duplicates metric' });
    expect(await walletRow(env, wallet.id)).toEqual({ balance: '90.00', version: 2 });
  });

  test('a different message with the same idempotency key is an idempotent replay', async () => {
    const wallet = await openWallet(app.url, '100.00');
    const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '10.00' });
    await sendToQueue(env, queueMessage(body), wallet.id);
    await sendToQueue(env, queueMessage(body), wallet.id);
    await waitFor(async () => (await countRows(env, 'SELECT 1 FROM inbox_messages WHERE payload_hash IN (SELECT payload_hash FROM wager_transactions WHERE external_transaction_id = $1)', [body.externalTransactionId])) === 2);
    expect(await walletRow(env, wallet.id)).toEqual({ balance: '90.00', version: 2 });
  });

  test('business rejection is terminal: acked, not retried, not in the DLQ', async () => {
    const wallet = await openWallet(app.url, '5.00');
    const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '50.00' });
    await sendToQueue(env, queueMessage(body), wallet.id);
    await waitFor(async () =>
      (await countRows(env, `SELECT 1 FROM wager_transactions WHERE external_transaction_id = $1 AND failure_code = 'INSUFFICIENT_FUNDS'`, [body.externalTransactionId])) === 1,
    );
  });

  test('invalid payloads go straight to the DLQ (permanent error)', async () => {
    await sendToQueue(env, '{not json', 'poison-1');
    await sendToQueue(env, { messageId: 'bad-1', type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: { kind: 'OPENING' } }, 'poison-2');
    const dlq = await waitFor(async () => {
      const messages = await receiveAll(env, 'dlq', { visibility: 0, rounds: 1 });
      return messages.length >= 2 ? messages : undefined;
    }, { description: 'poison messages in DLQ' });
    const reasons = dlq.map((m) => m.MessageAttributes?.reason?.StringValue).sort();
    expect(reasons).toEqual(['malformed-json', 'validation']);
  });

  test('transient errors are retried with backoff and eventually succeed', async () => {
    const wallet = await openWallet(app.url, '100.00');
    const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '1.00' });

    // hold the wallet row lock: the consumer hits lock_timeout (transient)
    const blocker = await env.db.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE', [wallet.id]);
    await sendToQueue(env, queueMessage(body), wallet.id);
    await waitFor(async () => /wagering_retries_total\{component="sqs",reason="lock-timeout"\}/.test(await (await fetch(`${app.url}/metrics`)).text()), {
      description: 'a lock-timeout retry',
    });
    await blocker.query('ROLLBACK');
    blocker.release();

    await waitFor(async () => (await processedCount(body.externalTransactionId)) === 1, { timeoutMs: 30_000 });
    const metrics = await (await fetch(`${app.url}/metrics`)).text();
    expect(metrics).toMatch(/wagering_lock_conflicts_total\{reason="lock-timeout"\} \d+/);
  });

  test('a message that keeps failing transiently goes to the DLQ after the attempt limit', async () => {
    const wallet = await openWallet(app.url, '100.00');
    const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '1.00', externalTransactionId: `stuck-${uuidv7()}` });
    const blocker = await env.db.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE', [wallet.id]);
    try {
      await sendToQueue(env, queueMessage(body), wallet.id);
      const dlq = await waitFor(async () => {
        const messages = await receiveAll(env, 'dlq', { visibility: 0, rounds: 1 });
        return messages.find((m) => m.Body?.includes(body.externalTransactionId));
      }, { timeoutMs: 45_000, description: 'message moved to DLQ' });
      expect(dlq.MessageAttributes?.reason?.StringValue).toBe('max-attempts');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect(await processedCount(body.externalTransactionId)).toBe(0);
    expect(await walletRow(env, wallet.id)).toEqual({ balance: '100.00', version: 1 });
  });
});
