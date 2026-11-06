import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type TestApp, createTestApp, expectWalletMatchesLedger } from './support/http-app';
import { type TestDatabase, createTestDatabase } from './support/test-database';

let db: TestDatabase;
let api: TestApp;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await createTestApp(db);
});
afterAll(async () => {
  await api.close();
  await db.drop();
});

const money = (amount: string, currency = 'BRL') => ({ amount, currency });

async function openWallet(initial = '100.00', playerId = randomUUID()) {
  const res = await api.post('/wallets', { playerId, initialBalance: money(initial) });
  expect(res.status).toBe(201);
  return { id: res.body.id as string, playerId };
}

let seq = 0;
function wager(w: { id: string; playerId: string }, kind: string, amount: string, extra: Record<string, unknown> = {}) {
  const externalTransactionId = (extra.externalTransactionId as string | undefined) ?? `tx-${++seq}-${randomUUID()}`;
  const body = {
    providerId: 'provider-a',
    externalTransactionId,
    playerId: w.playerId,
    walletId: w.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: money(amount),
    ...extra,
  };
  return { body, key: `provider-a:${externalTransactionId}`, externalTransactionId };
}

const submit = (payload: ReturnType<typeof wager>, key = payload.key) =>
  api.post('/wagering/transactions', payload.body, { 'Idempotency-Key': key });

const outboxTypes = async (walletId: string) =>
  (await db.run<{ event_type: string }>('select event_type from outbox_messages where aggregate_id = ? order by id', [walletId])).map(
    (r) => r.event_type,
  );

describe('POST /wallets', () => {
  test('opens the wallet with OPENING + CREDIT ledger entry in the same transaction', async () => {
    const res = await api.post('/wallets', { playerId: randomUUID(), initialBalance: money('1000') });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ balance: money('1000.00'), version: 1 });

    const [opening] = await db.run<{ kind: string; status: string; balance_snapshot: string }>(
      'select kind, status, balance_snapshot from wagering_transactions where wallet_id = ?',
      [res.body.id],
    );
    expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED', balance_snapshot: '1000.00' });
    const [entry] = await db.run<{ direction: string; balance_before: string; balance_after: string }>(
      'select direction, balance_before, balance_after from wallet_ledger_entries where wallet_id = ?',
      [res.body.id],
    );
    expect(entry).toEqual({ direction: 'CREDIT', balance_before: '0.00', balance_after: '1000.00' });
    expect(await outboxTypes(res.body.id)).toEqual(expect.arrayContaining(['WagerTransactionProcessed', 'WalletBalanceChanged']));
    await expectWalletMatchesLedger(db, res.body.id);
  });

  test('zero initial balance: no OPENING, no ledger entry', async () => {
    const res = await api.post('/wallets', { playerId: randomUUID(), initialBalance: money('0.00') });
    expect(res.status).toBe(201);
    expect(await db.run('select 1 from wagering_transactions where wallet_id = ?', [res.body.id])).toHaveLength(0);
    await expectWalletMatchesLedger(db, res.body.id);
  });

  test('duplicate (playerId, currency) is 409 and leaves no trace of the second attempt', async () => {
    const w = await openWallet('10.00');
    const dup = await api.post('/wallets', { playerId: w.playerId, initialBalance: money('50.00') });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('WALLET_ALREADY_EXISTS');
    expect(await db.run('select 1 from wallets where player_id = ?', [w.playerId])).toHaveLength(1);
    expect(await db.run('select 1 from wagering_transactions where player_id = ?', [w.playerId])).toHaveLength(1);
    await expectWalletMatchesLedger(db, w.id);
  });

  test('same player may hold wallets in different currencies', async () => {
    const playerId = randomUUID();
    expect((await api.post('/wallets', { playerId, initialBalance: money('1.00', 'BRL') })).status).toBe(201);
    expect((await api.post('/wallets', { playerId, initialBalance: money('1.00', 'USD') })).status).toBe(201);
  });

  test.each([
    ['negative amount', { playerId: randomUUID(), initialBalance: money('-1.00') }],
    ['three decimals', { playerId: randomUUID(), initialBalance: money('1.005') }],
    ['scientific notation', { playerId: randomUUID(), initialBalance: money('1e3') }],
    ['amount as number', { playerId: randomUUID(), initialBalance: { amount: 10, currency: 'BRL' } }],
    ['missing money', { playerId: randomUUID() }],
    ['bad currency', { playerId: randomUUID(), initialBalance: money('1.00', 'br') }],
    ['playerId not a uuid', { playerId: 'abc', initialBalance: money('1.00') }],
    ['amount beyond numeric(20,2)', { playerId: randomUUID(), initialBalance: money('1'.padEnd(19, '0')) }],
  ])('400 for %s', async (_name, body) => {
    const res = await api.post('/wallets', body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBeString();
  });
});

describe('POST /wagering/transactions: outcomes and status codes', () => {
  test('400 without the Idempotency-Key header', async () => {
    const w = await openWallet();
    const res = await api.post('/wagering/transactions', wager(w, 'BET', '1.00').body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
    await expectWalletMatchesLedger(db, w.id);
  });

  test.each([
    ['OPENING is not submittable', { kind: 'OPENING' }],
    ['unknown kind', { kind: 'TRANSFER' }],
    ['negative amount', { money: money('-5.00') }],
    ['zero BET', { money: money('0.00') }],
    ['REFUND without reference', { kind: 'REFUND' }],
    ['BET carrying a reference', { referenceExternalTransactionId: 'x' }],
    ['walletId not a uuid', { walletId: 'nope' }],
    ['missing roundId', { roundId: '' }],
  ])('400: %s (nothing persisted)', async (_name, override) => {
    const w = await openWallet();
    const p = wager(w, 'BET', '5.00', override);
    const res = await submit(p);
    expect(res.status).toBe(400);
    expect(await db.run('select 1 from wagering_transactions where idempotency_key = ?', [p.key])).toHaveLength(0);
    await expectWalletMatchesLedger(db, w.id);
  });

  test('404 for an unknown wallet, nothing persisted', async () => {
    const p = wager({ id: randomUUID(), playerId: randomUUID() }, 'BET', '5.00');
    const res = await submit(p);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WALLET_NOT_FOUND');
    expect(await db.run('select 1 from wagering_transactions where idempotency_key = ?', [p.key])).toHaveLength(0);
  });

  test('200 PROCESSED: balance, version, ledger and outbox move together', async () => {
    const w = await openWallet('100.00');
    const res = await submit(wager(w, 'BET', '25.00'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'PROCESSED', balance: money('75.00'), idempotentReplay: false });

    const [row] = await db.run<{ balance: string; version: number }>('select balance, version from wallets where id = ?', [w.id]);
    expect(row).toEqual({ balance: '75.00', version: 2 });
    expect(await outboxTypes(w.id)).toEqual(expect.arrayContaining(['WagerTransactionProcessed', 'WalletBalanceChanged']));
    await expectWalletMatchesLedger(db, w.id);
  });

  test('WIN credits; LOSS is processed without moving the balance, version or ledger', async () => {
    const w = await openWallet('10.00');
    expect((await submit(wager(w, 'WIN', '5.50'))).body.balance).toEqual(money('15.50'));
    const beforeLoss = await db.run('select count(*) as n from wallet_ledger_entries where wallet_id = ?', [w.id]);
    const loss = await submit(wager(w, 'LOSS', '0.00'));
    expect(loss.status).toBe(200);
    expect(loss.body.balance).toEqual(money('15.50'));
    expect(await db.run('select count(*) as n from wallet_ledger_entries where wallet_id = ?', [w.id])).toEqual(beforeLoss);
    const [row] = await db.run<{ version: number }>('select version from wallets where id = ?', [w.id]);
    expect(row!.version).toBe(2);
    await expectWalletMatchesLedger(db, w.id);
  });

  test('422 business rejection is COMMITTED (audit row + outbox), balance untouched', async () => {
    const w = await openWallet('10.00');
    const p = wager(w, 'BET', '80.00');
    const res = await submit(p);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', advice: 'RESUBMIT_LATER', idempotentReplay: false });

    const [row] = await db.run<{ status: string; failure_code: string }>(
      'select status, failure_code from wagering_transactions where idempotency_key = ?',
      [p.key],
    );
    expect(row).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await outboxTypes(w.id)).toContain('WagerTransactionRejected');
    const [wallet] = await db.run<{ balance: string; version: number }>('select balance, version from wallets where id = ?', [w.id]);
    expect(wallet).toEqual({ balance: '10.00', version: 1 });
    await expectWalletMatchesLedger(db, w.id);
  });

  test('422 for a wallet owned by another player and for another currency', async () => {
    const w = await openWallet('10.00');
    const otherPlayer = await submit(wager({ id: w.id, playerId: randomUUID() }, 'BET', '1.00'));
    expect(otherPlayer.body.failureCode).toBe('WALLET_PLAYER_MISMATCH');
    const usd = await submit(wager(w, 'BET', '1.00', { money: money('1.00', 'USD') }));
    expect(usd.status).toBe(422);
    expect(usd.body.failureCode).toBe('CURRENCY_MISMATCH');
    await expectWalletMatchesLedger(db, w.id);
  });

  test('202 pending reference, then the reference arrives: both outcomes are stored', async () => {
    const w = await openWallet('100.00');
    const refund = wager(w, 'REFUND', '10.00', { referenceExternalTransactionId: 'bet-not-here-yet' });
    const res = await submit(refund);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'PENDING_REFERENCE', idempotentReplay: false });
    expect(res.body.balance).toBeUndefined();
    expect(await outboxTypes(w.id)).toContain('WagerTransactionPendingReference');

    const replay = await submit(refund);
    expect(replay.status).toBe(202);
    expect(replay.body).toMatchObject({ transactionId: res.body.transactionId, idempotentReplay: true });
    await expectWalletMatchesLedger(db, w.id);
  });

  test('REFUND of a BET credits back; a second reversal (REFUND or ROLLBACK) is 422 ALREADY_REVERSED', async () => {
    const w = await openWallet('100.00');
    const bet = wager(w, 'BET', '30.00');
    await submit(bet);
    const refund = await submit(wager(w, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(refund.status).toBe(200);
    expect(refund.body.balance).toEqual(money('100.00'));

    for (const kind of ['REFUND', 'ROLLBACK']) {
      const again = await submit(wager(w, kind, '30.00', { referenceExternalTransactionId: bet.externalTransactionId }));
      expect(again.status).toBe(422);
      expect(again.body.failureCode).toBe('ALREADY_REVERSED');
    }
    await expectWalletMatchesLedger(db, w.id);
  });

  test('ROLLBACK runs in the inverse direction of its reference; amount divergence is 422', async () => {
    const w = await openWallet('100.00');
    const win = wager(w, 'WIN', '40.00');
    await submit(win);
    const wrongAmount = await submit(wager(w, 'ROLLBACK', '39.00', { referenceExternalTransactionId: win.externalTransactionId }));
    expect(wrongAmount.body.failureCode).toBe('AMOUNT_MISMATCH');
    const rollback = await submit(wager(w, 'ROLLBACK', '40.00', { referenceExternalTransactionId: win.externalTransactionId }));
    expect(rollback.status).toBe(200);
    expect(rollback.body.balance).toEqual(money('100.00'));
    await expectWalletMatchesLedger(db, w.id);
  });

  test('ROLLBACK of a WIN whose credit was already spent: 422 REVERSAL_WOULD_OVERDRAW, never negative', async () => {
    const w = await openWallet('0.00');
    const win = wager(w, 'WIN', '40.00');
    await submit(win);
    await submit(wager(w, 'BET', '35.00'));
    const rollback = await submit(wager(w, 'ROLLBACK', '40.00', { referenceExternalTransactionId: win.externalTransactionId }));
    expect(rollback.status).toBe(422);
    expect(rollback.body.failureCode).toBe('REVERSAL_WOULD_OVERDRAW');
    await expectWalletMatchesLedger(db, w.id);
  });
});

describe('idempotency', () => {
  test('replay returns the original result with idempotentReplay=true and applies the effect once', async () => {
    const w = await openWallet('100.00');
    const p = wager(w, 'BET', '25.00');
    const first = await submit(p);
    const second = await submit(p);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ...first.body, idempotentReplay: true });
    // the snapshot is returned, not the current balance
    await submit(wager(w, 'BET', '5.00'));
    const third = await submit(p);
    expect(third.body.balance).toEqual(money('75.00'));
    expect(await db.run('select 1 from wallet_ledger_entries where transaction_id = ?', [first.body.transactionId])).toHaveLength(1);
    await expectWalletMatchesLedger(db, w.id);
  });

  test('a rejection is replayed as the same 422', async () => {
    const w = await openWallet('1.00');
    const p = wager(w, 'BET', '50.00');
    const first = await submit(p);
    await submit(wager(w, 'WIN', '100.00')); // balance would now allow it, but the outcome is final
    const replay = await submit(p);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    await expectWalletMatchesLedger(db, w.id);
  });

  test('409 same key with a different payload (not a replay), original effect intact', async () => {
    const w = await openWallet('100.00');
    const p = wager(w, 'BET', '25.00');
    await submit(p);
    const conflict = await submit(wager(w, 'BET', '26.00', { externalTransactionId: p.externalTransactionId }), p.key);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const [row] = await db.run<{ balance: string }>('select balance from wallets where id = ?', [w.id]);
    expect(row!.balance).toBe('75.00');
    await expectWalletMatchesLedger(db, w.id);
  });

  test('409 same provider transaction under another key', async () => {
    const w = await openWallet('100.00');
    const p = wager(w, 'BET', '25.00');
    await submit(p);
    const res = await submit(p, 'another-key');
    expect(res.status).toBe(409);
    await expectWalletMatchesLedger(db, w.id);
  });

  test('key is the source of truth: the same payload under key header equal to default is a replay', async () => {
    const w = await openWallet('10.00');
    const p = wager(w, 'BET', '1.00');
    expect((await submit(p, 'custom-key-1')).status).toBe(200);
    const again = await submit(p, 'custom-key-1');
    expect(again.body.idempotentReplay).toBe(true);
    await expectWalletMatchesLedger(db, w.id);
  });
});

describe('concurrency', () => {
  test('the same BET sent 50 times in parallel debits exactly once', async () => {
    const w = await openWallet('100.00');
    const p = wager(w, 'BET', '10.00');
    const results = await Promise.all(Array.from({ length: 50 }, () => submit(p)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    const [row] = await db.run<{ balance: string; version: number }>('select balance, version from wallets where id = ?', [w.id]);
    expect(row).toEqual({ balance: '90.00', version: 2 });
    await expectWalletMatchesLedger(db, w.id);
  });

  test('two BETs of 80 on a 100 balance: exactly one PROCESSED, the other REJECTED', async () => {
    const w = await openWallet('100.00');
    const results = await Promise.all([submit(wager(w, 'BET', '80.00')), submit(wager(w, 'BET', '80.00'))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    const [row] = await db.run<{ balance: string }>('select balance from wallets where id = ?', [w.id]);
    expect(row!.balance).toBe('20.00');
    await expectWalletMatchesLedger(db, w.id);
  });

  test('many distinct BETs on one wallet never overdraw and the version counts every movement', async () => {
    const w = await openWallet('100.00');
    const results = await Promise.all(Array.from({ length: 30 }, () => submit(wager(w, 'BET', '7.00'))));
    const processed = results.filter((r) => r.status === 200).length;
    expect(processed).toBe(14);
    expect(results.filter((r) => r.status === 422)).toHaveLength(16);
    const [row] = await db.run<{ balance: string; version: number }>('select balance, version from wallets where id = ?', [w.id]);
    expect(row).toEqual({ balance: '2.00', version: 1 + processed });
    await expectWalletMatchesLedger(db, w.id);
  });

  test('different wallets do not block each other (no global lock)', async () => {
    const a = await openWallet('100.00');
    const b = await openWallet('100.00');
    const holder = db.orm.em.fork();
    await holder.begin();
    await holder.getConnection().execute('select id from wallets where id = ? for update', [a.id], 'all', holder.getTransactionContext());
    try {
      const started = Date.now();
      const res = await submit(wager(b, 'BET', '10.00'));
      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(250);
    } finally {
      await holder.rollback();
    }
    await expectWalletMatchesLedger(db, a.id);
    await expectWalletMatchesLedger(db, b.id);
  });

  test('concurrent wallet creation for the same player: one 201, the rest 409', async () => {
    const playerId = randomUUID();
    const results = await Promise.all(Array.from({ length: 10 }, () => api.post('/wallets', { playerId, initialBalance: money('5.00') })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    const rows = await db.run<{ id: string }>('select id from wallets where player_id = ?', [playerId]);
    expect(rows).toHaveLength(1);
    await expectWalletMatchesLedger(db, rows[0]!.id);
  });
});

describe('503 transient failure rolls everything back', () => {
  test('a contended wallet lock times out as 503 + Retry-After, leaving no PENDING row behind; a retry succeeds', async () => {
    const w = await openWallet('100.00');
    const holder = db.orm.em.fork();
    await holder.begin();
    await holder.getConnection().execute('select id from wallets where id = ? for update', [w.id], 'all', holder.getTransactionContext());

    const p = wager(w, 'BET', '10.00');
    const impatient = await createTestApp(db, { lockTimeoutMs: 300 });
    let res: Awaited<ReturnType<typeof submit>>;
    try {
      res = await impatient.post('/wagering/transactions', p.body, { 'Idempotency-Key': p.key });
    } finally {
      await holder.rollback();
      await impatient.close();
    }
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('TRANSIENT_INFRASTRUCTURE_FAILURE');
    expect(res.headers.get('retry-after')).toBe('1');
    expect(await db.run('select 1 from wagering_transactions where idempotency_key = ?', [p.key])).toHaveLength(0);

    const retry = await submit(p);
    expect(retry.status).toBe(200);
    expect(retry.body.idempotentReplay).toBe(false);
    await expectWalletMatchesLedger(db, w.id);
  });
});
