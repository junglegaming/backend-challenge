/**
 * Closed-loop HTTP load test.
 *
 *   bun run test:load                          # against http://localhost:8080 (compose gateway, 3 replicas)
 *   BASE_URL=http://localhost:3000 DURATION_S=30 CONCURRENCY=64 bun run test:load
 *
 * Workload: WALLETS wallets; HOT_RATIO of the requests target a single hot
 * wallet (lock contention), the rest are spread uniformly. Mix: 70% BET,
 * 20% WIN, 5% LOSS, 5% replays of an earlier request (idempotency path).
 * After the run it waits for the outbox to drain, reconciles every wallet and
 * prints throughput, latency percentiles, status breakdown and server metrics.
 */
import { v7 as uuidv7 } from 'uuid';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';
const DURATION_S = Number(process.env.DURATION_S ?? 20);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 32);
const WALLETS = Number(process.env.WALLETS ?? 200);
const HOT_RATIO = Number(process.env.HOT_RATIO ?? 0.1);

interface Wallet {
  id: string;
  playerId: string;
}

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined };
};

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

const scrape = async (): Promise<Map<string, number>> => {
  const text = await (await fetch(`${BASE_URL}/metrics`)).text();
  const out = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [key, value] = line.split(' ');
    if (key && value) out.set(key, (out.get(key) ?? 0) + Number(value));
  }
  return out;
};

const sumMatching = (metrics: Map<string, number>, prefix: string) =>
  [...metrics.entries()].filter(([k]) => k.startsWith(prefix)).reduce((acc, [, v]) => acc + v, 0);

const main = async () => {
  console.log(`target=${BASE_URL} duration=${DURATION_S}s concurrency=${CONCURRENCY} wallets=${WALLETS} hotRatio=${HOT_RATIO}`);

  const wallets: Wallet[] = [];
  for (let i = 0; i < WALLETS; i += 20) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(20, WALLETS - i) }, async () => {
        const playerId = uuidv7();
        const res = await post('/wallets', { playerId, initialBalance: { amount: '100000.00', currency: 'BRL' } });
        if (res.status !== 201) throw new Error(`wallet creation failed: ${res.status}`);
        return { id: res.body!.id as string, playerId };
      }),
    );
    wallets.push(...batch);
  }
  const hot = wallets[0]!;
  const sent: Array<{ body: Record<string, unknown>; key: string }> = [];

  const latencies: number[] = [];
  const statuses = new Map<number, number>();
  let networkErrors = 0;
  const deadline = Date.now() + DURATION_S * 1000;

  const nextRequest = () => {
    const r = Math.random();
    if (r < 0.05 && sent.length > 0) return sent[Math.floor(Math.random() * sent.length)]!; // replay
    const wallet = Math.random() < HOT_RATIO ? hot : wallets[1 + Math.floor(Math.random() * (wallets.length - 1))]!;
    const kind = r < 0.75 ? 'BET' : r < 0.95 ? 'WIN' : 'LOSS';
    const externalTransactionId = `load-${uuidv7()}`;
    const body = {
      providerId: 'load-provider',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${externalTransactionId}`,
      gameId: 'load-game',
      kind,
      money: { amount: (1 + Math.floor(Math.random() * 1000) / 100).toFixed(2), currency: 'BRL' },
    };
    const request = { body, key: `load-provider:${externalTransactionId}` };
    if (sent.length < 5_000) sent.push(request);
    return request;
  };

  const before = await scrape();
  const started = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (Date.now() < deadline) {
        const { body, key } = nextRequest();
        const t0 = performance.now();
        try {
          const res = await post('/wagering/transactions', body, { 'Idempotency-Key': key });
          statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
        } catch {
          networkErrors++;
        }
        latencies.push(performance.now() - t0);
      }
    }),
  );
  const elapsedS = (performance.now() - started) / 1000;

  // outbox lag: time until every committed event is published
  const drainStarted = performance.now();
  let lag = Infinity;
  for (let i = 0; i < 120; i++) {
    const m = await scrape();
    lag = m.get('wagering_outbox_pending') ?? 0;
    if (lag === 0) break;
    await Bun.sleep(500);
  }
  const drainS = (performance.now() - drainStarted) / 1000;
  const after = await scrape();

  let inconsistent = 0;
  for (const w of wallets) {
    const res = await post(`/wallets/${w.id}/reconciliation`, {});
    if (res.body?.consistent !== true) inconsistent++;
  }

  latencies.sort((a, b) => a - b);
  const total = latencies.length;
  const ok = (statuses.get(200) ?? 0) + (statuses.get(422) ?? 0);
  const delta = (prefix: string) => sumMatching(after, prefix) - sumMatching(before, prefix);

  console.log('\n=== results ===');
  console.log(`requests           ${total} in ${elapsedS.toFixed(1)}s  => ${(total / elapsedS).toFixed(1)} req/s`);
  console.log(`latency ms         p50=${percentile(latencies, 50).toFixed(1)} p95=${percentile(latencies, 95).toFixed(1)} p99=${percentile(latencies, 99).toFixed(1)} max=${(latencies[total - 1] ?? 0).toFixed(1)}`);
  console.log(`status             ${JSON.stringify(Object.fromEntries(statuses))} network-errors=${networkErrors}`);
  console.log(`error rate         ${(((total - ok) / Math.max(1, total)) * 100).toFixed(2)}%  (anything but 200/422; 503 = transient, retryable)`);
  console.log(`lock conflicts     ${delta('wagering_lock_conflicts_total')}  (lock timeouts / deadlocks / version guard, summed over instances behind the LB sample)`);
  console.log(`replays detected   ${delta('wagering_duplicates_detected_total')}`);
  console.log(`outbox drain       ${drainS.toFixed(1)}s after load stopped (pending now: ${lag})`);
  console.log(`reconciliation     ${wallets.length - inconsistent}/${wallets.length} wallets consistent`);
  if (inconsistent > 0) process.exitCode = 1;
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
