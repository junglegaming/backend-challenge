import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/domain/ports/repositories';
import {
  createTestEnvironment,
  openWallet,
  type RunningApp,
  startApp,
  submitWager,
  type TestEnvironment,
  wagerBody,
} from '../support/harness';

/**
 * Pending-reference scheduling is decided by the database clock (like the
 * outbox lease), so instances whose clocks disagree still agree on what is
 * due. The worker is disabled: the test drives claim and wake-up directly.
 */
let env: TestEnvironment;
let app: RunningApp;
let uow: UnitOfWork;

beforeAll(async () => {
  env = await createTestEnvironment({ CONSUMER_ENABLED: 'false', OUTBOX_ENABLED: 'false', PENDING_REFERENCE_ENABLED: 'false' });
  app = await startApp(env);
  uow = app.app.get(UNIT_OF_WORK);
});
afterAll(async () => {
  await app.close();
  await env.teardown();
});

const parkRefund = async (referenceExternalTransactionId: string) => {
  const wallet = await openWallet(app.url, '10.00');
  const res = await submitWager(
    app.url,
    wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'REFUND', amount: '1.00', referenceExternalTransactionId }),
  );
  expect(res.body.status).toBe('PENDING_REFERENCE');
  return res.body.transactionId as string;
};

const setCheckAt = (id: string, sqlExpression: string) =>
  env.db.query(`UPDATE wager_transactions SET next_reference_check_at = ${sqlExpression} WHERE id = $1`, [id]);

const isDueByDatabaseClock = async (id: string) =>
  (await env.db.query(`SELECT next_reference_check_at <= now() AS due FROM wager_transactions WHERE id = $1`, [id])).rows[0].due as boolean;

describe('scheduling uses the database clock', () => {
  test('claim takes exactly the items that are due according to PostgreSQL, and leases them', async () => {
    const due = await parkRefund('ghost-due');
    const notDue = await parkRefund('ghost-not-due');
    await setCheckAt(due, `now() - interval '1 second'`);
    await setCheckAt(notDue, `now() + interval '1 minute'`);

    const claimed = await uow.run((s) => s.transactions.claimDuePendingReferences(30_000, 100));
    const ids = claimed.map((c) => c.id);
    expect(ids).toContain(due);
    expect(ids).not.toContain(notDue);
    // leased into the future (database clock): a second claimer does not get it
    expect(await isDueByDatabaseClock(due)).toBe(false);
    const again = await uow.run((s) => s.transactions.claimDuePendingReferences(30_000, 100));
    expect(again.map((c) => c.id)).not.toContain(due);
  });

  test('wake-up makes dependents due immediately according to PostgreSQL', async () => {
    const parked = await parkRefund('ghost-wake');
    await setCheckAt(parked, `now() + interval '1 hour'`);
    const woken = await uow.run((s) => s.transactions.wakeDependents('provider-a', 'ghost-wake'));
    expect(woken).toBe(1);
    expect(await isDueByDatabaseClock(parked)).toBe(true);
  });
});
