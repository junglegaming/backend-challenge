/**
 * Teste de carga: `bun run test:load` (com `docker compose up --build` no ar).
 *
 * Gerador de carga em laço fechado: N "clientes" virtuais, cada um envia uma requisição, espera a
 * resposta e envia a próxima. As requisições são distribuídas em round-robin entre as instâncias.
 * Metodologia, ambiente e análise dos resultados: LOAD_TEST.md.
 */
import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { createSqsClient, ensureQueues } from '../../src/infra/sqs/queues';

const TARGETS = (process.env.LOAD_TARGETS ?? 'http://localhost:3000,http://localhost:3001,http://localhost:3002').split(',');
const SECONDS = Number(process.env.LOAD_SECONDS ?? 15);
const PROVIDER = `load-${Date.now()}`;

let sequence = 0;
const target = () => TARGETS[sequence++ % TARGETS.length]!;
const json = { 'content-type': 'application/json' };

interface Wallet {
  id: string;
  playerId: string;
}

async function openWallets(count: number): Promise<Wallet[]> {
  const open = async (): Promise<Wallet> => {
    const response = await fetch(`${target()}/wallets`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ playerId: crypto.randomUUID(), initialBalance: { amount: '1000000.00', currency: 'BRL' } }),
    });
    if (response.status !== 201) throw new Error(`could not open wallet: ${response.status}`);
    return (await response.json()) as Wallet;
  };
  const wallets: Wallet[] = [];
  for (let i = 0; i < count; i += 50) wallets.push(...(await Promise.all(Array.from({ length: Math.min(50, count - i) }, open))));
  return wallets;
}

const payloadFor = (wallet: Wallet) => {
  const roll = Math.random();
  return {
    providerId: PROVIDER,
    externalTransactionId: crypto.randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'load',
    gameId: 'load',
    kind: roll < 0.7 ? 'BET' : roll < 0.9 ? 'WIN' : 'LOSS', // 70% BET, 20% WIN, 10% LOSS
    money: { amount: '1.00', currency: 'BRL' },
  };
};

/** Soma, entre todas as instâncias, as séries de /metrics cujo nome (com labels) casa com o padrão. */
async function metric(pattern: RegExp, combine: 'sum' | 'max' = 'sum'): Promise<number> {
  const values = await Promise.all(
    TARGETS.map(async (base) => {
      const text = await fetch(`${base}/metrics`).then((r) => r.text());
      return text
        .split('\n')
        .filter((line) => !line.startsWith('#') && pattern.test(line))
        .reduce((total, line) => total + Number(line.slice(line.lastIndexOf(' ') + 1)), 0);
    }),
  );
  return combine === 'sum' ? values.reduce((a, b) => a + b, 0) : Math.max(...values);
}

const percentile = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
const ms = (value: number) => value.toFixed(1);

interface Row {
  scenario: string;
  clients: number;
  requests: number;
  rps: string;
  p50: string;
  p95: string;
  p99: string;
  max: string;
  errors: string;
  replays: number;
  lockConflicts: number;
  outboxLagMax: string;
  outboxDrain: string;
  consistent: string;
}

async function httpScenario(name: string, wallets: Wallet[], clients: number): Promise<Row> {
  const latencies: number[] = [];
  const statuses = new Map<number, number>();
  let replays = 0;
  let transportErrors = 0;
  const lockBefore = await metric(/^wager_lock_conflicts_total/);

  let lagMax = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      lagMax = Math.max(lagMax, await metric(/^wager_outbox_lag_seconds/, 'max').catch(() => 0));
      await Bun.sleep(500);
    }
  })();

  const deadline = performance.now() + SECONDS * 1000;
  const started = performance.now();
  const client = async () => {
    let previous: ReturnType<typeof payloadFor> | undefined;
    while (performance.now() < deadline) {
      // 5% das requisições repetem a anterior: exercita o caminho de replay idempotente.
      const payload = previous && Math.random() < 0.05 ? previous : payloadFor(wallets[Math.floor(Math.random() * wallets.length)]!);
      previous = payload;
      const begin = performance.now();
      try {
        const response = await fetch(`${target()}/wagering/transactions`, {
          method: 'POST',
          headers: { ...json, 'Idempotency-Key': `${payload.providerId}:${payload.externalTransactionId}` },
          body: JSON.stringify(payload),
        });
        const body = (await response.json()) as { idempotentReplay?: boolean };
        latencies.push(performance.now() - begin);
        statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
        if (body.idempotentReplay) replays += 1;
      } catch {
        transportErrors += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: clients }, client));
  const elapsed = (performance.now() - started) / 1000;

  // Quanto tempo a outbox leva para zerar depois que a carga para.
  const drainStart = performance.now();
  while ((await metric(/^wager_outbox_lag_seconds/, 'max')) > 0 && performance.now() - drainStart < 120_000) await Bun.sleep(200);
  const drain = (performance.now() - drainStart) / 1000;
  sampling = false;
  await sampler;

  // Todas as wallets do cenário são reconciliadas: saldo materializado == ledger.
  const reconciliations = await Promise.all(
    wallets.map((w) => fetch(`${target()}/wallets/${w.id}/reconciliation`, { method: 'POST' }).then((r) => r.json() as Promise<{ consistent: boolean }>)),
  );
  const consistent = reconciliations.filter((r) => r.consistent).length;

  latencies.sort((a, b) => a - b);
  const total = latencies.length + transportErrors;
  const failed = transportErrors + [...statuses].filter(([status]) => status >= 500).reduce((sum, [, count]) => sum + count, 0);
  const unexpected = [...statuses].filter(([status]) => status !== 200).map(([status, count]) => `${status}×${count}`);
  return {
    scenario: name,
    clients,
    requests: total,
    rps: (latencies.length / elapsed).toFixed(0),
    p50: ms(percentile(latencies, 50)),
    p95: ms(percentile(latencies, 95)),
    p99: ms(percentile(latencies, 99)),
    max: ms(latencies.at(-1) ?? 0),
    errors: `${((failed / Math.max(total, 1)) * 100).toFixed(2)}%${unexpected.length ? ` (${unexpected.join(', ')})` : ''}`,
    replays,
    lockConflicts: (await metric(/^wager_lock_conflicts_total/)) - lockBefore,
    outboxLagMax: `${lagMax.toFixed(2)}s`,
    outboxDrain: `${drain.toFixed(1)}s`,
    consistent: `${consistent}/${wallets.length}`,
  };
}

/** Ingestão pela fila: publica N mensagens e mede até as três instâncias terem processado todas. */
async function sqsScenario(wallets: Wallet[], messages: number) {
  const sqs = createSqsClient();
  const queues = await ensureQueues(sqs);
  const processed = () => metric(/^wager_transactions_total\{.*status="PROCESSED"/);
  const before = await processed();
  const started = performance.now();
  for (let sent = 0; sent < messages; ) {
    const batches = Array.from({ length: 10 }, () => {
      const entries = Array.from({ length: Math.min(10, messages - sent) }, () => {
        const payload = payloadFor(wallets[Math.floor(Math.random() * wallets.length)]!);
        const messageId = crypto.randomUUID();
        return {
          Id: messageId,
          MessageGroupId: payload.walletId,
          MessageDeduplicationId: messageId,
          MessageBody: JSON.stringify({
            messageId,
            type: 'WagerTransactionRequested',
            occurredAt: new Date().toISOString(),
            data: { ...payload, idempotencyKey: `${payload.providerId}:${payload.externalTransactionId}` },
          }),
        };
      });
      sent += entries.length;
      return entries;
    }).filter((entries) => entries.length > 0);
    await Promise.all(batches.map((Entries) => sqs.send(new SendMessageBatchCommand({ QueueUrl: queues.input, Entries }))));
  }
  const enqueued = (performance.now() - started) / 1000;
  while ((await processed()) - before < messages && performance.now() - started < 300_000) await Bun.sleep(200);
  const elapsed = (performance.now() - started) / 1000;
  const done = (await processed()) - before;
  sqs.destroy();
  return { messages, done, enqueueSeconds: enqueued.toFixed(1), totalSeconds: elapsed.toFixed(1), perSecond: (done / elapsed).toFixed(0), dlq: await metric(/^wager_dlq_depth/, 'max') };
}

// ----------------------------------------------------------------------------------------------

for (const base of TARGETS) {
  const ready = await fetch(`${base}/health/ready`).then((r) => r.ok, () => false);
  if (!ready) throw new Error(`${base} is not ready — run \`docker compose up --build\` first`);
}

console.error(`targets: ${TARGETS.join(', ')} · ${SECONDS}s per scenario`);
const spread = await openWallets(500);
const hot = await openWallets(1);
await httpScenario('aquecimento (descartado)', spread, 16);

const rows: Row[] = [];
for (const clients of [16, 64, 256]) {
  console.error(`http · 500 wallets · ${clients} clients`);
  rows.push(await httpScenario('500 wallets', spread, clients));
}
for (const clients of [16, 64]) {
  console.error(`http · hot wallet · ${clients} clients`);
  rows.push(await httpScenario('1 wallet (hot)', hot, clients));
}
console.error('sqs · 5000 messages · 500 wallets');
const queue = await sqsScenario(spread, 5000);

const columns: [keyof Row, string][] = [
  ['scenario', 'Cenário'], ['clients', 'Clientes'], ['requests', 'Requisições'], ['rps', 'req/s'], ['p50', 'p50 (ms)'], ['p95', 'p95 (ms)'],
  ['p99', 'p99 (ms)'], ['max', 'máx (ms)'], ['errors', 'Erros'], ['replays', 'Replays'], ['lockConflicts', 'Conflitos de lock'],
  ['outboxLagMax', 'Outbox lag máx'], ['outboxDrain', 'Outbox zera em'], ['consistent', 'Wallets consistentes'],
];
console.log(`| ${columns.map(([, title]) => title).join(' | ')} |`);
console.log(`|${columns.map(() => '---').join('|')}|`);
for (const row of rows) console.log(`| ${columns.map(([key]) => row[key]).join(' | ')} |`);
console.log(`\nSQS: ${JSON.stringify(queue)}`);
