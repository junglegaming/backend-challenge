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

const money = (amount: string) => ({ amount, currency: 'BRL' });

interface Wallet {
  id: string;
  playerId: string;
}

async function openWallet(initial: string): Promise<Wallet> {
  const playerId = randomUUID();
  const res = await api.post('/wallets', { playerId, initialBalance: money(initial) });
  expect(res.status).toBe(201);
  return { id: res.body.id, playerId };
}

function payload(w: Wallet, kind: string, amount: string, externalTransactionId = randomUUID()) {
  return {
    key: `provider-a:${externalTransactionId}`,
    body: {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: w.playerId,
      walletId: w.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind,
      money: money(amount),
    },
  };
}

const submit = (p: ReturnType<typeof payload>) => api.post('/wagering/transactions', p.body, { 'Idempotency-Key': p.key });

const walletRow = async (id: string) =>
  (await db.run<{ balance: string; version: number }>('select balance, version from wallets where id = ?', [id]))[0]!;

/** Ledger entries of the wallet in application order, excluding the OPENING credit. */
const movements = (walletId: string) =>
  db.run<{ direction: string; kind: string; status: string; balance_before: string; balance_after: string }>(
    `select e.direction, t.kind, t.status, e.balance_before, e.balance_after
       from wallet_ledger_entries e join wagering_transactions t on t.id = e.transaction_id
      where e.wallet_id = ? and t.kind <> 'OPENING' order by e.seq`,
    [walletId],
  );

/** Each entry must start exactly where the previous one ended: no lost update, no interleaving. */
async function expectContiguousLedger(walletId: string): Promise<void> {
  const rows = await db.run<{ balance_before: string; balance_after: string }>(
    'select balance_before, balance_after from wallet_ledger_entries where wallet_id = ? order by seq',
    [walletId],
  );
  for (let i = 1; i < rows.length; i++) expect(rows[i]!.balance_before).toBe(rows[i - 1]!.balance_after);
}

describe('real parallelism (Promise.all, real PostgreSQL)', () => {
  test('balance 100, two simultaneous BETs of 80: one PROCESSED, one REJECTED, balance 20, one debit', async () => {
    const w = await openWallet('100.00');
    const results = await Promise.all([submit(payload(w, 'BET', '80.00')), submit(payload(w, 'BET', '80.00'))]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(results.map((r) => r.body.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.find((r) => r.status === 422)!.body.failureCode).toBe('INSUFFICIENT_FUNDS');

    expect(await walletRow(w.id)).toEqual({ balance: '20.00', version: 2 });
    const debits = await movements(w.id);
    expect(debits).toHaveLength(1);
    expect(debits[0]).toMatchObject({ direction: 'DEBIT', kind: 'BET', status: 'PROCESSED', balance_before: '100.00', balance_after: '20.00' });

    const statuses = await db.run<{ status: string }>(
      `select status from wagering_transactions where wallet_id = ? and kind = 'BET' order by status`,
      [w.id],
    );
    expect(statuses.map((s) => s.status)).toEqual(['PROCESSED', 'REJECTED']);
    await expectContiguousLedger(w.id);
    await expectWalletMatchesLedger(db, w.id);
  });

  test('the same BET 50x in parallel: one debit, one transaction, 49 replays', async () => {
    const w = await openWallet('100.00');
    const p = payload(w, 'BET', '30.00');
    const results = await Promise.all(Array.from({ length: 50 }, () => submit(p)));

    expect(results.every((r) => r.status === 200 && r.body.balance.amount === '70.00')).toBe(true);
    expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(results.filter((r) => r.body.idempotentReplay === true)).toHaveLength(49);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);

    expect(await movements(w.id)).toHaveLength(1);
    expect(await db.run('select 1 from wagering_transactions where wallet_id = ? and kind = ?', [w.id, 'BET'])).toHaveLength(1);
    expect(await walletRow(w.id)).toEqual({ balance: '70.00', version: 2 });
    await expectWalletMatchesLedger(db, w.id);
  });

  test('the same key with 25 identical + 25 divergent payloads: replays and 409s, still one debit', async () => {
    const w = await openWallet('100.00');
    const good = payload(w, 'BET', '10.00');
    const bad = { ...good, body: { ...good.body, money: money('11.00') } };
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(i % 2 === 0 ? good : bad)));

    // whoever wins the insert defines the "original"; the other payload then conflicts
    const ok = results.filter((r) => r.status === 200);
    const conflicts = results.filter((r) => r.status === 409);
    expect(ok.length + conflicts.length).toBe(50);
    expect(ok.length).toBeGreaterThan(0);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(await movements(w.id)).toHaveLength(1);
    await expectWalletMatchesLedger(db, w.id);
  });

  test('20 distinct wallets in parallel, 5 BETs each: independent, each ends at its own exact balance', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => openWallet('100.00')));
    const requests = wallets.flatMap((w) => Array.from({ length: 5 }, () => submit(payload(w, 'BET', '10.00'))));
    const results = await Promise.all(requests);

    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const w of wallets) {
      expect(await walletRow(w.id)).toEqual({ balance: '50.00', version: 6 });
      expect(await movements(w.id)).toHaveLength(5);
      await expectContiguousLedger(w.id);
      await expectWalletMatchesLedger(db, w.id);
    }
  });

  test('hot wallet: 60 mixed operations at once; processed + rejected add up and nothing is lost', async () => {
    const w = await openWallet('100.00');
    const ops = [
      ...Array.from({ length: 30 }, () => payload(w, 'BET', '7.00')),
      ...Array.from({ length: 20 }, () => payload(w, 'WIN', '3.00')),
      ...Array.from({ length: 10 }, () => payload(w, 'LOSS', '0.00')),
    ].sort(() => Math.random() - 0.5);
    const results = await Promise.all(ops.map(submit));

    expect(results.every((r) => [200, 422].includes(r.status))).toBe(true);
    expect(results.filter((r) => r.status === 202)).toHaveLength(0);
    const rejected = results.filter((r) => r.status === 422);
    expect(rejected.every((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);

    const applied = await movements(w.id);
    const processedBets = applied.filter((m) => m.kind === 'BET').length;
    const wins = applied.filter((m) => m.kind === 'WIN').length;
    expect(wins).toBe(20); // WINs are never rejected
    expect(applied.some((m) => m.kind === 'LOSS')).toBe(false); // LOSS does not touch the ledger
    expect(processedBets + rejected.length).toBe(30);

    const expected = 100 * 100 + wins * 300 - processedBets * 700; // cents: integer math, test-only
    const row = await walletRow(w.id);
    expect(row.balance).toBe((expected / 100).toFixed(2));
    expect(Number(row.balance)).toBeGreaterThanOrEqual(0);
    expect(row.version).toBe(1 + processedBets + wins); // one increment per balance change, none for LOSS/REJECTED

    const total = await db.run<{ n: string }>('select count(*) as n from wagering_transactions where wallet_id = ?', [w.id]);
    expect(Number(total[0]!.n)).toBe(61); // 60 submissions + OPENING: every outcome persisted, rejections included
    await expectContiguousLedger(w.id);
    await expectWalletMatchesLedger(db, w.id);
  });

  test('reversal race: REFUND and ROLLBACK of the same BET at once credit back exactly once', async () => {
    const w = await openWallet('100.00');
    const bet = payload(w, 'BET', '40.00');
    expect((await submit(bet)).status).toBe(200);
    const ref = bet.body.externalTransactionId;
    const reversal = (kind: string) => {
      const p = payload(w, kind, '40.00');
      p.body = { ...p.body, referenceExternalTransactionId: ref } as typeof p.body;
      return submit(p);
    };
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => reversal('REFUND')),
      ...Array.from({ length: 5 }, () => reversal('ROLLBACK')),
    ]);

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 422 && r.body.failureCode === 'ALREADY_REVERSED')).toHaveLength(9);
    expect((await walletRow(w.id)).balance).toBe('100.00');
    await expectContiguousLedger(w.id);
    await expectWalletMatchesLedger(db, w.id);
  });
});
