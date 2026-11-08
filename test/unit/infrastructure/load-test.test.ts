import { expect, test } from 'bun:test';
import { percentile } from '../../../scripts/load-test';

test('load test uses nearest-rank percentiles without mutating samples', () => {
  const samples = [5, 1, 3, 2, 4];
  expect(percentile(samples, 0.5)).toBe(3);
  expect(percentile(samples, 0.95)).toBe(5);
  expect(percentile(samples, 0.99)).toBe(5);
  expect(samples).toEqual([5, 1, 3, 2, 4]);
  expect(() => percentile([], 0.5)).toThrow();
});

test('load command exits nonzero and checks all wallets on ledger divergence', async () => {
  const transactions = new Map<string, string>();
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/health/ready') return Response.json({ status: 'ok' });
      if (path === '/metrics') return new Response('wager_lock_conflicts_total 0\nwager_outbox_oldest_unpublished_seconds 0\n');
      if (path === '/wallets') return Response.json({ id: crypto.randomUUID() }, { status: 201 });
      if (path === '/wagering/transactions') {
        const key = request.headers.get('idempotency-key')!;
        const existing = transactions.get(key);
        const id = existing ?? crypto.randomUUID();
        transactions.set(key, id);
        return Response.json({ status: 'PROCESSED', transactionId: id, idempotentReplay: Boolean(existing) });
      }
      if (path.endsWith('/ledger')) return Response.json({ items: [], nextCursor: null });
      return Response.json({ balance: { amount: '1.00', currency: 'BRL' } });
    },
  });
  try {
    const child = Bun.spawn(['bun', 'scripts/load-test.ts'], {
      env: { ...process.env, LOAD_BASE_URL: `http://127.0.0.1:${server.port}`, LOAD_REQUESTS: '2', LOAD_WALLETS: '1', LOAD_CONCURRENCY: '2' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(status).toBe(1);
    const report = JSON.parse(stdout) as { reconciliation: { walletsCreated: number; checked: number; failures: string[] } };
    expect(report.reconciliation.walletsCreated).toBe(3);
    expect(report.reconciliation.checked).toBe(3);
    expect(report.reconciliation.failures).toHaveLength(3);
  } finally {
    server.stop(true);
  }
});
