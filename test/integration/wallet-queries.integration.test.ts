import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type TestApp, createTestApp } from './support/http-app';
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- bodies are asserted field by field
const get = async (path: string): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${api.url}${path}`);
  return { status: res.status, body: await res.json().catch(() => undefined) };
};

async function walletWithBets(bets: number) {
  const playerId = randomUUID();
  const created = await api.post('/wallets', { playerId, initialBalance: money('100.00') });
  const id = created.body.id as string;
  const external: string[] = [];
  for (let i = 0; i < bets; i++) {
    const externalTransactionId = `q-${randomUUID()}`;
    external.push(externalTransactionId);
    const res = await api.post(
      '/wagering/transactions',
      { providerId: 'prov', externalTransactionId, playerId, walletId: id, roundId: 'r', gameId: 'g', kind: 'BET', money: money('1.00') },
      { 'idempotency-key': externalTransactionId },
    );
    expect(res.status).toBe(200);
  }
  return { id, playerId, external };
}

describe('read endpoints', () => {
  test('GET /wallets/:id', async () => {
    const w = await walletWithBets(1);
    const res = await get(`/wallets/${w.id}`);
    expect(res.status).toBe(200);
    expect(res.body.balance).toEqual(money('99.00'));
    expect((await get(`/wallets/${randomUUID()}`)).status).toBe(404);
    expect((await get('/wallets/nope')).status).toBe(400);
  });

  test('ledger paginates with a stable opaque cursor', async () => {
    const w = await walletWithBets(4);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(`/wallets/${w.id}/ledger?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((i: { id: string }) => i.id));
      cursor = res.body.nextCursor;
      pages++;
      if (pages === 1) await walletBet(w); // new entries must not disturb already-issued cursors
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(6);

    expect((await get(`/wallets/${w.id}/ledger?limit=0`)).status).toBe(400);
    expect((await get(`/wallets/${w.id}/ledger?cursor=garbage`)).status).toBe(400);
    const other = await walletWithBets(0);
    const first = await get(`/wallets/${w.id}/ledger?limit=1`);
    expect((await get(`/wallets/${other.id}/ledger?cursor=${first.body.nextCursor}`)).status).toBe(400);
    expect((await get(`/wallets/${randomUUID()}/ledger`)).status).toBe(404);
  });

  test('transaction lookups', async () => {
    const w = await walletWithBets(1);
    const byProvider = await get(`/providers/prov/wagering/transactions/${w.external[0]}`);
    expect(byProvider.status).toBe(200);
    expect(byProvider.body.status).toBe('PROCESSED');
    const byId = await get(`/wagering/transactions/${byProvider.body.transactionId}`);
    expect(byId.body).toEqual(byProvider.body);
    expect((await get(`/wagering/transactions/${randomUUID()}`)).status).toBe(404);
    expect((await get('/providers/prov/wagering/transactions/missing')).status).toBe(404);
  });

  test('reconciliation: OK, then divergence is flagged and NOT corrected', async () => {
    const w = await walletWithBets(2);
    const ok = await api.post(`/wallets/${w.id}/reconciliation`, {});
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('OK');

    await db.run('update wallets set balance = 500.00, version = version + 1 where id = ?', [w.id]);
    const bad = await api.post(`/wallets/${w.id}/reconciliation`, {});
    expect(bad.status).toBe(200);
    expect(bad.body.status).toBe('DIVERGENT');
    expect(bad.body.difference).toEqual(money('402.00'));
    const [row] = await db.run<{ balance: string }>('select balance from wallets where id = ?', [w.id]);
    expect(row!.balance).toBe('500.00');

    const metrics = await (await fetch(`${api.url}/metrics`)).text();
    expect(metrics).toContain('wallet_reconciliation_divergence_total{currency="BRL"} 1');
    expect((await api.post(`/wallets/${randomUUID()}/reconciliation`, {})).status).toBe(404);
  });
});

async function walletBet(w: { id: string; playerId: string }) {
  const id = `q-${randomUUID()}`;
  await api.post(
    '/wagering/transactions',
    { providerId: 'prov', externalTransactionId: id, playerId: w.playerId, walletId: w.id, roundId: 'r', gameId: 'g', kind: 'BET', money: money('1.00') },
    { 'idempotency-key': id },
  );
}
