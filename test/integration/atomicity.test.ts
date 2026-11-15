import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SubmitWagerTransaction } from '../../src/application/submit-wager-transaction';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import {
  assertLedgerInvariant,
  countRows,
  createTestEnvironment,
  openWallet,
  type RunningApp,
  startApp,
  type TestEnvironment,
  walletRow,
} from '../support/harness';

/**
 * Inbox + transaction + wallet + ledger + outbox are one SQL transaction.
 * We make the LAST write of the unit (the outbox insert) fail inside
 * PostgreSQL and check that nothing of the unit survived.
 */
let env: TestEnvironment;
let app: RunningApp;

beforeAll(async () => {
  env = await createTestEnvironment({ CONSUMER_ENABLED: 'false', OUTBOX_ENABLED: 'false', PENDING_REFERENCE_ENABLED: 'false' });
  app = await startApp(env);
});
afterAll(async () => {
  await app.close();
  await env.teardown();
});

describe('atomicity of wallet, ledger, inbox and outbox', () => {
  test('a failure on the outbox insert rolls back inbox, transaction, wallet and ledger', async () => {
    const wallet = await openWallet(app.url, '100.00');
    // sabotage: outbox writes for this wallet's balance change explode
    await env.db.query(`
      CREATE FUNCTION sabotage_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'WalletBalanceChanged' AND NEW.aggregate_id = '${wallet.id}' THEN
          RAISE EXCEPTION 'simulated outbox failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER sabotage_outbox BEFORE INSERT ON outbox_messages FOR EACH ROW EXECUTE FUNCTION sabotage_outbox();
    `);
    const outboxBefore = await countRows(env, 'SELECT 1 FROM outbox_messages');

    const submit = app.app.get(SubmitWagerTransaction);
    const attempt = submit.execute(
      {
        idempotencyKey: 'provider-a:atomic-1',
        providerId: 'provider-a',
        externalTransactionId: 'atomic-1',
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'r',
        gameId: 'g',
        kind: WagerTransactionKind.Bet,
        money: { amount: '30.00', currency: 'BRL' },
      },
      { source: 'sqs', correlationId: 'c', inbox: { consumerName: 'test-consumer', messageId: 'atomic-msg-1' } },
    );
    await expect(attempt).rejects.toThrow();

    expect(await walletRow(env, wallet.id)).toEqual({ balance: '100.00', version: 1 });
    expect(await countRows(env, `SELECT 1 FROM wager_transactions WHERE external_transaction_id = 'atomic-1'`)).toBe(0);
    expect(await countRows(env, `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = $1`, [wallet.id])).toBe(1); // opening only
    expect(await countRows(env, `SELECT 1 FROM inbox_messages WHERE message_id = 'atomic-msg-1'`)).toBe(0);
    expect(await countRows(env, 'SELECT 1 FROM outbox_messages')).toBe(outboxBefore);

    // once the fault is gone the same message is applied exactly once
    await env.db.query('DROP TRIGGER sabotage_outbox ON outbox_messages; DROP FUNCTION sabotage_outbox();');
    const retry = await submit.execute(
      {
        idempotencyKey: 'provider-a:atomic-1',
        providerId: 'provider-a',
        externalTransactionId: 'atomic-1',
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'r',
        gameId: 'g',
        kind: WagerTransactionKind.Bet,
        money: { amount: '30.00', currency: 'BRL' },
      },
      { source: 'sqs', correlationId: 'c', inbox: { consumerName: 'test-consumer', messageId: 'atomic-msg-1' } },
    );
    expect(retry.type === 'outcome' && retry.outcome.status).toBe(WagerTransactionStatus.Processed);
    expect(await walletRow(env, wallet.id)).toEqual({ balance: '70.00', version: 2 });
    expect(await countRows(env, `SELECT 1 FROM inbox_messages WHERE message_id = 'atomic-msg-1' AND processed_at IS NOT NULL`)).toBe(1);
    expect(await countRows(env, `SELECT 1 FROM outbox_messages WHERE aggregate_id = $1 AND event_type = 'WalletBalanceChanged'`, [wallet.id])).toBe(2);
    await assertLedgerInvariant(env);
  });

  test('every committed balance change has its outbox events (no publish before commit)', async () => {
    const { rows } = await env.db.query(`
      SELECT l.transaction_id
        FROM wallet_ledger_entries l
        LEFT JOIN outbox_messages o
               ON o.event_type = 'WalletBalanceChanged' AND o.payload -> 'data' ->> 'transactionId' = l.transaction_id::text
       WHERE o.id IS NULL`);
    expect(rows).toEqual([]);
  });
});
