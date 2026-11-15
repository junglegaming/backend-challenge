import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { v7 as uuidv7 } from 'uuid';
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
  walletRow,
} from '../support/harness';

let env: TestEnvironment;
let app: RunningApp;

beforeAll(async () => {
  env = await createTestEnvironment({ CONSUMER_ENABLED: 'false', PENDING_REFERENCE_ENABLED: 'false' });
  app = await startApp(env);
});
afterEach(async () => {
  await assertLedgerInvariant(env);
});
afterAll(async () => {
  await app.close();
  await env.teardown();
});

describe('POST /wallets', () => {
  test('creates the wallet with an OPENING transaction and a CREDIT entry in the same transaction', async () => {
    const wallet = await openWallet(app.url, '1000.00');
    expect(wallet).toMatchObject({ balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
    const { rows } = await env.db.query(
      `SELECT t.kind, t.status, l.direction, l.amount::text AS amount, l.wallet_version
         FROM wager_transactions t JOIN wallet_ledger_entries l ON l.transaction_id = t.id WHERE t.wallet_id = $1`,
      [wallet.id],
    );
    expect(rows).toEqual([{ kind: 'OPENING', status: 'PROCESSED', direction: 'CREDIT', amount: '1000.00', wallet_version: 1 }]);
    expect(await countRows(env, 'SELECT 1 FROM outbox_messages WHERE aggregate_id = $1', [wallet.id])).toBe(1);
  });

  test('a zero initial balance creates no ledger entry', async () => {
    const wallet = await openWallet(app.url, '0.00');
    expect(await countRows(env, 'SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = $1', [wallet.id])).toBe(0);
  });

  test('duplicate (player, currency) is a 409 conflict; another currency is allowed', async () => {
    const wallet = await openWallet(app.url, '1.00');
    const dup = await http('POST', `${app.url}/wallets`, { playerId: wallet.playerId, initialBalance: { amount: '1.00', currency: 'BRL' } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('WALLET_ALREADY_EXISTS');
    await openWallet(app.url, '1.00', 'USD', wallet.playerId);
  });

  test.each<[unknown]>([
    [{ playerId: 'not-a-uuid', initialBalance: { amount: '1.00', currency: 'BRL' } }],
    [{ playerId: uuidv7(), initialBalance: { amount: '1.001', currency: 'BRL' } }],
    [{ playerId: uuidv7(), initialBalance: { amount: '-1.00', currency: 'BRL' } }],
    [{ playerId: uuidv7(), initialBalance: { amount: 10, currency: 'BRL' } }],
    [{ playerId: uuidv7(), initialBalance: { amount: '1e2', currency: 'BRL' } }],
  ])('invalid payload is a 400 (%#)', async (body) => {
    const res = await http('POST', `${app.url}/wallets`, body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'INVALID_PAYLOAD', retryable: false });
  });
});

describe('POST /wagering/transactions', () => {
  test('processes a BET (200) and replays the identical request with idempotentReplay=true', async () => {
    const wallet = await openWallet(app.url, '1000.00');
    const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '25.00' });
    const first = await submitWager(app.url, body);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false });

    // the balance moves on, but the replay returns the balance observed at the time
    await submitWager(app.url, wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '5.00' }));
    const replay = await submitWager(app.url, body);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(await countRows(env, `SELECT 1 FROM wallet_ledger_entries WHERE transaction_id = $1`, [first.body.transactionId])).toBe(1);
  });

  test('same Idempotency-Key with a different payload is a 409 conflict, not a replay', async () => {
    const wallet = await openWallet(app.url);
    const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '10.00' });
    await submitWager(app.url, body);
    const conflict = await submitWager(app.url, { ...body, money: { amount: '11.00', currency: 'BRL' } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect((await walletRow(env, wallet.id)).balance).toBe('90.00');
  });

  test('same external id under another Idempotency-Key is a 409 conflict', async () => {
    const wallet = await openWallet(app.url);
    const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '10.00' });
    await submitWager(app.url, body);
    const conflict = await submitWager(app.url, body, 'some-other-key');
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('EXTERNAL_TRANSACTION_CONFLICT');
  });

  test('business rejection is a 422 with a stable failureCode and is replayed identically', async () => {
    const wallet = await openWallet(app.url, '10.00');
    const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '10.01' });
    const res = await submitWager(app.url, body);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' } });
    const replay = await submitWager(app.url, body);
    expect(replay.status).toBe(422);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(await countRows(env, `SELECT 1 FROM wallet_ledger_entries WHERE transaction_id = $1`, [res.body.transactionId])).toBe(0);
  });

  test('currency conflict is rejected (422 CURRENCY_MISMATCH)', async () => {
    const wallet = await openWallet(app.url, '10.00');
    const res = await submitWager(app.url, wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'WIN', amount: '1.00', currency: 'USD' }));
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe('CURRENCY_MISMATCH');
  });

  test('LOSS is processed without ledger entry and without changing version', async () => {
    const wallet = await openWallet(app.url, '10.00');
    const res = await submitWager(app.url, wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'LOSS', amount: '5.00' }));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PROCESSED');
    expect(await walletRow(env, wallet.id)).toEqual({ balance: '10.00', version: 1 });
  });

  test('BET -> WIN -> ROLLBACK(WIN) -> REFUND(BET) full round', async () => {
    const wallet = await openWallet(app.url, '100.00');
    const base = { walletId: wallet.id, playerId: wallet.playerId, roundId: 'round-x' };
    const bet = wagerBody({ ...base, kind: 'BET', amount: '40.00' });
    const win = wagerBody({ ...base, kind: 'WIN', amount: '70.00', referenceExternalTransactionId: bet.externalTransactionId });
    expect((await submitWager(app.url, bet)).body.balance.amount).toBe('60.00');
    expect((await submitWager(app.url, win)).body.balance.amount).toBe('130.00');
    const rollback = await submitWager(app.url, wagerBody({ ...base, kind: 'ROLLBACK', amount: '70.00', referenceExternalTransactionId: win.externalTransactionId }));
    expect(rollback.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '60.00' } });
    const refund = await submitWager(app.url, wagerBody({ ...base, kind: 'REFUND', amount: '40.00', referenceExternalTransactionId: bet.externalTransactionId }));
    expect(refund.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
    // second reversal of the BET, through another kind, is refused
    const again = await submitWager(app.url, wagerBody({ ...base, kind: 'ROLLBACK', amount: '40.00', referenceExternalTransactionId: bet.externalTransactionId }));
    expect(again.body).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_ALREADY_REVERSED' });
    expect(await walletRow(env, wallet.id)).toEqual({ balance: '100.00', version: 5 });
  });

  test('a reversal that would go negative is rejected with REVERSAL_INSUFFICIENT_FUNDS and stays auditable', async () => {
    const wallet = await openWallet(app.url, '0.00');
    const base = { walletId: wallet.id, playerId: wallet.playerId };
    const win = wagerBody({ ...base, kind: 'WIN', amount: '50.00' });
    await submitWager(app.url, win);
    await submitWager(app.url, wagerBody({ ...base, kind: 'BET', amount: '45.00' }));
    const rollback = await submitWager(app.url, wagerBody({ ...base, kind: 'ROLLBACK', amount: '50.00', referenceExternalTransactionId: win.externalTransactionId }));
    expect(rollback.status).toBe(422);
    expect(rollback.body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    const stored = await http('GET', `${app.url}/wagering/transactions/${rollback.body.transactionId}`);
    expect(stored.body).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_INSUFFICIENT_FUNDS', kind: 'ROLLBACK' });
  });

  test('missing reference is accepted as PENDING_REFERENCE (202)', async () => {
    const wallet = await openWallet(app.url);
    const res = await submitWager(app.url, wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'REFUND', amount: '1.00', referenceExternalTransactionId: 'not-yet' }));
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('PENDING_REFERENCE');
  });

  test('validation: missing Idempotency-Key, OPENING kind, reserved provider, REFUND without reference', async () => {
    const wallet = await openWallet(app.url);
    const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '1.00' });
    expect((await http('POST', `${app.url}/wagering/transactions`, body)).status).toBe(400);
    expect((await submitWager(app.url, { ...body, kind: 'OPENING' as 'BET' })).status).toBe(400);
    expect((await submitWager(app.url, { ...body, providerId: 'internal' })).status).toBe(400);
    expect((await submitWager(app.url, { ...body, kind: 'REFUND' })).status).toBe(400);
    expect((await submitWager(app.url, { ...body, money: { amount: '1.234', currency: 'BRL' } })).status).toBe(400);
  });

  test('unknown wallet is a 404', async () => {
    const res = await submitWager(app.url, wagerBody({ walletId: uuidv7(), playerId: uuidv7(), kind: 'BET', amount: '1.00' }));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WALLET_NOT_FOUND');
  });
});

describe('queries', () => {
  test('GET transaction by id and by provider external id', async () => {
    const wallet = await openWallet(app.url);
    const body = wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '3.00' });
    const created = await submitWager(app.url, body);
    const byId = await http('GET', `${app.url}/wagering/transactions/${created.body.transactionId}`);
    const byExternal = await http('GET', `${app.url}/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`);
    expect(byId.status).toBe(200);
    expect(byExternal.body).toEqual(byId.body);
    expect(byId.body).toMatchObject({ kind: 'BET', status: 'PROCESSED', money: { amount: '3.00', currency: 'BRL' } });
    expect((await http('GET', `${app.url}/wagering/transactions/${uuidv7()}`)).status).toBe(404);
  });

  test('ledger pagination uses a stable opaque cursor', async () => {
    const wallet = await openWallet(app.url, '100.00');
    for (let i = 0; i < 6; i++) {
      await submitWager(app.url, wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '1.00' }));
    }
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const page: { body: { items: Array<{ walletVersion: number }>; nextCursor: string | null } } = await http(
        'GET',
        `${app.url}/wallets/${wallet.id}/ledger?limit=3${cursor ? `&cursor=${cursor}` : ''}`,
      );
      seen.push(...page.body.items.map((i) => i.walletVersion));
      cursor = page.body.nextCursor;
      // new entries arriving between pages must not shift what was already served
      if (cursor && seen.length === 3) {
        await submitWager(app.url, wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '1.00' }));
      }
    } while (cursor);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect((await http('GET', `${app.url}/wallets/${wallet.id}/ledger?cursor=garbage`)).status).toBe(400);
    expect((await http('GET', `${app.url}/wallets/${wallet.id}/ledger?limit=500`)).status).toBe(400);
  });

  test('reconciliation reports consistency', async () => {
    const wallet = await openWallet(app.url, '50.00');
    await submitWager(app.url, wagerBody({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount: '20.00' }));
    const res = await http('POST', `${app.url}/wallets/${wallet.id}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '30.00', currency: 'BRL' },
      calculatedBalance: { amount: '30.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });
});

describe('health & metrics', () => {
  test('liveness and readiness are open and report dependencies', async () => {
    expect((await http('GET', `${app.url}/health/live`)).body).toEqual({ status: 'ok' });
    const ready = await http('GET', `${app.url}/health/ready`);
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ postgres: { status: 'up' }, sqs: { status: 'up' } });
  });

  test('metrics expose the required series', async () => {
    const text = await (await fetch(`${app.url}/metrics`)).text();
    for (const name of [
      'wagering_transactions_total',
      'wagering_duplicates_detected_total',
      'wagering_processing_duration_seconds',
      'wagering_outbox_lag_seconds',
      'wagering_dlq_depth',
    ]) {
      expect(text).toContain(name);
    }
  });
});
