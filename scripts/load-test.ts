import { randomUUID } from 'node:crypto';

type Wallet = { id: string; playerId: string };
type RequestSpec = { wallet: Wallet; key: string };
type Observation = { latencyMs: number; status: number; error?: string; transactionId?: string; replay?: boolean };
type Metrics = { locks: number; lag: number };
type ScenarioReport = {
  scenario: string;
  requests: number;
  elapsedSeconds: number;
  throughputPerSecond: number;
  latencyMs: { p50: number; p95: number; p99: number };
  errors: number;
  errorRate: number;
  statuses: Record<string, number>;
  lockConflicts: number;
  outboxLagSeconds: { before: number; after: number; maxObserved: number };
  duplicates: { expected: number; observed: number; violations: number };
};

const url = (process.env.LOAD_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const parsedUrl = new URL(url);
if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('LOAD_BASE_URL must use HTTP or HTTPS');
if (!['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname) && process.env.LOAD_ALLOW_REMOTE !== '1') {
  throw new Error('Remote targets require LOAD_ALLOW_REMOTE=1; this test creates permanent financial data');
}

function positiveInt(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) > max) throw new Error(`${name} must be an integer between 1 and ${max}`);
  return Number(raw);
}

const count = positiveInt('LOAD_REQUESTS', 300, 100000);
const walletCount = positiveInt('LOAD_WALLETS', 30, 1000);
const concurrency = positiveInt('LOAD_CONCURRENCY', 30, 1000);
const timeoutMs = positiveInt('LOAD_TIMEOUT_MS', 15000, 120000);
const runId = randomUUID();
const wallets: Wallet[] = [];

export function percentile(values: number[], p: number): number {
  if (!values.length) throw new Error('Cannot compute percentile of an empty sample');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

async function parallelMap<T, R>(values: T[], width: number, work: (value: T) => Promise<R>): Promise<R[]> {
  let next = 0;
  const results: R[] = new Array(values.length);
  const errors: unknown[] = [];
  await Promise.all(Array.from({ length: Math.min(width, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      try {
        results[index] = await work(values[index]!);
      } catch (error) {
        errors.push(error);
      }
    }
  }));
  if (errors.length) throw new AggregateError(errors, `${errors.length} parallel operations failed`);
  return results;
}

async function jsonRequest(path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`Invalid JSON response for ${path}`);
  return { status: response.status, body: body as Record<string, unknown> };
}

async function createWallet(): Promise<Wallet> {
  const playerId = randomUUID();
  const result = await jsonRequest('/wallets', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: '1000000.00', currency: 'BRL' } }),
  });
  if (result.status !== 201 || typeof result.body.id !== 'string') throw new Error(`Wallet creation failed: HTTP ${result.status}`);
  const wallet = { id: result.body.id, playerId };
  wallets.push(wallet);
  return wallet;
}

async function submit(spec: RequestSpec): Promise<Observation> {
  const start = performance.now();
  try {
    const result = await jsonRequest('/wagering/transactions', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': spec.key },
      body: JSON.stringify({
        providerId: 'load-test', externalTransactionId: spec.key, walletId: spec.wallet.id,
        playerId: spec.wallet.playerId, roundId: 'load-test', gameId: 'load-test', kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      }),
    });
    const latencyMs = performance.now() - start;
    if (result.status !== 200 || result.body.status !== 'PROCESSED' ||
      typeof result.body.transactionId !== 'string' || typeof result.body.idempotentReplay !== 'boolean') {
      return { latencyMs, status: result.status, error: 'Unexpected HTTP status or transaction outcome' };
    }
    return { latencyMs, status: result.status, transactionId: result.body.transactionId, replay: result.body.idempotentReplay };
  } catch (error) {
    return { latencyMs: performance.now() - start, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

function sampleValue(text: string, name: string): number {
  const line = text.split('\n').find((entry) => entry.startsWith(`${name} `));
  if (!line) throw new Error(`Missing metric ${name}`);
  const value = Number(line.slice(name.length + 1));
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid metric ${name}`);
  return value;
}

async function metrics(): Promise<Metrics> {
  const response = await fetch(`${url}/metrics`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Metrics scrape failed: HTTP ${response.status}`);
  const text = await response.text();
  return {
    locks: sampleValue(text, 'wager_lock_conflicts_total'),
    lag: sampleValue(text, 'wager_outbox_oldest_unpublished_seconds'),
  };
}

async function scenario(name: string, specs: RequestSpec[]): Promise<ScenarioReport> {
  const before = await metrics();
  const lags = [before.lag];
  const samples: Promise<void>[] = [];
  const sampleErrors: unknown[] = [];
  const timer = setInterval(() => {
    samples.push(metrics().then((sample) => { lags.push(sample.lag); }).catch((error: unknown) => { sampleErrors.push(error); }));
  }, 1000);
  const started = performance.now();
  let observations: Observation[];
  try {
    observations = await parallelMap(specs, concurrency, submit);
  } finally {
    clearInterval(timer);
  }
  const elapsedSeconds = (performance.now() - started) / 1000;
  await Promise.all(samples);
  if (sampleErrors.length) throw new AggregateError(sampleErrors, 'Metrics sampling failed');
  const after = await metrics();
  if (after.locks < before.locks) throw new Error('Lock counter decreased; target process may have restarted');
  lags.push(after.lag);
  const statuses: Record<string, number> = {};
  const groups = new Map<string, Observation[]>();
  for (let i = 0; i < specs.length; i++) {
    const observation = observations[i]!;
    const code = observation.status ? String(observation.status) : 'network';
    statuses[code] = (statuses[code] ?? 0) + 1;
    const group = groups.get(specs[i]!.key) ?? [];
    group.push(observation);
    groups.set(specs[i]!.key, group);
  }
  let violations = 0;
  let expected = 0;
  for (const group of groups.values()) {
    expected += group.length - 1;
    const successes = group.filter((entry) => !entry.error);
    if (successes.length === group.length &&
      (successes.filter((entry) => !entry.replay).length !== 1 || new Set(successes.map((entry) => entry.transactionId)).size !== 1)) violations++;
  }
  const errors = observations.filter((entry) => entry.error).length;
  const latencies = observations.map((entry) => entry.latencyMs);
  return {
    scenario: name, requests: specs.length, elapsedSeconds,
    throughputPerSecond: specs.length / elapsedSeconds,
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99) },
    errors, errorRate: errors / specs.length, statuses, lockConflicts: after.locks - before.locks,
    outboxLagSeconds: { before: before.lag, after: after.lag, maxObserved: Math.max(...lags) },
    duplicates: { expected, observed: observations.filter((entry) => entry.replay).length, violations },
  };
}

function cents(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d+\.\d{2}$/.test(value)) throw new Error('Invalid monetary amount');
  return BigInt(value.replace('.', ''));
}

async function verifyWallet(wallet: Wallet): Promise<void> {
  const result = await jsonRequest(`/wallets/${wallet.id}`);
  const balance = result.body.balance;
  if (result.status !== 200 || !balance || typeof balance !== 'object' || !('amount' in balance) ||
    !('currency' in balance) || typeof balance.currency !== 'string') {
    throw new Error(`Could not read wallet ${wallet.id}`);
  }
  let sum = 0n;
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const query = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : '?limit=100';
    const page = await jsonRequest(`/wallets/${wallet.id}/ledger${query}`);
    if (page.status !== 200 || !Array.isArray(page.body.items) ||
      !(page.body.nextCursor === null || typeof page.body.nextCursor === 'string')) throw new Error(`Invalid ledger page for ${wallet.id}`);
    for (const entry of page.body.items as unknown[]) {
      if (!entry || typeof entry !== 'object' || !('amount' in entry) || !('direction' in entry) ||
        !entry.amount || typeof entry.amount !== 'object' || !('amount' in entry.amount) ||
        !('currency' in entry.amount) || entry.amount.currency !== balance.currency) throw new Error(`Invalid ledger entry for ${wallet.id}`);
      const amount = cents(entry.amount.amount);
      if (entry.direction === 'CREDIT') sum += amount;
      else if (entry.direction === 'DEBIT') sum -= amount;
      else throw new Error(`Invalid ledger direction for ${wallet.id}`);
    }
    cursor = page.body.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error(`Repeated ledger cursor for ${wallet.id}`);
    if (cursor) seen.add(cursor);
  } while (cursor);
  if (cents(balance.amount) !== sum) throw new Error(`Balance differs from ledger for wallet ${wallet.id}`);
}

async function main(): Promise<void> {
  const ready = await jsonRequest('/health/ready');
  if (ready.status !== 200) throw new Error(`Target is not ready: HTTP ${ready.status}`);
  const reports: ScenarioReport[] = [];
  let failure: unknown;
  try {
    const created = await parallelMap(Array.from({ length: walletCount * 2 + 1 }), Math.min(concurrency, 20), createWallet);
    const distributed = created.slice(0, walletCount);
    const hot = created[walletCount]!;
    const mixed = created.slice(walletCount + 1);
    const unique = (i: number) => `load:${runId}:${i}`;
    reports.push(await scenario('many-wallets', Array.from({ length: count }, (_, i) => ({ wallet: distributed[i % distributed.length]!, key: unique(i) }))));
    reports.push(await scenario('hot-wallet', Array.from({ length: count }, (_, i) => ({ wallet: hot, key: unique(count + i) }))));
    const specs = Array.from({ length: count }, (_, i) => {
      const pair = Math.floor(i / 2);
      return { wallet: mixed[pair % mixed.length]!, key: unique(count * 2 + pair) };
    });
    reports.push(await scenario('mixed-duplicates', specs));
  } catch (error) {
    failure = error;
  }
  const checks = await parallelMap(wallets, Math.min(concurrency, 20), async (wallet) => {
    try { await verifyWallet(wallet); return undefined; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  });
  const inconsistencies = checks.filter((entry): entry is string => entry !== undefined);
  const result = {
    runId, target: url, requestsPerScenario: count, walletsPerDistributedScenario: walletCount, concurrency,
    scenarios: reports, reconciliation: { walletsCreated: wallets.length, checked: checks.length, failures: inconsistencies },
    ...(failure ? { failure: failure instanceof Error ? failure.message : String(failure) } : {}),
  };
  console.log(JSON.stringify(result, null, 2));
  if (failure || inconsistencies.length || reports.some((report) => report.errors || report.duplicates.violations)) process.exitCode = 1;
}

if (import.meta.main) await main();
