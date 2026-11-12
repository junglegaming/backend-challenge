import { newId } from "../src/domain/shared/id";
import { createTestApp, resetDatabase } from "../test/helpers/test-harness";

/**
 * Self-contained load test (`bun run test:load`).
 *
 * Boots 3 real application instances against PostgreSQL and MiniStack, executes:
 *  1. Distributed load across 20 distinct wallets (300 requests, concurrency 30);
 *  2. Contended load against a single "hot wallet" (100 requests, concurrency 20);
 *  3. Verifies 100% ledger reconciliation across all 21 wallets at the end.
 */
async function runLoadTest(): Promise<void> {
  const nodes = await Promise.all([
    createTestApp({ roles: ["api", "outbox"], instanceId: "load-node-1", lockTimeoutMs: 5000 }),
    createTestApp({ roles: ["api", "outbox"], instanceId: "load-node-2", lockTimeoutMs: 5000 }),
    createTestApp({ roles: ["api", "outbox"], instanceId: "load-node-3", lockTimeoutMs: 5000 }),
  ]);

  try {
    await resetDatabase(nodes[0]!.orm);

    // 1. Create 20 distributed wallets + 1 hot wallet
    const distributedWallets = await Promise.all(
      Array.from({ length: 20 }, async (_, idx) => {
        const baseUrl = nodes[idx % nodes.length]!.baseUrl;
        const playerId = newId();
        const res = await fetch(`${baseUrl}/wallets`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            playerId,
            initialBalance: { amount: "10000.00", currency: "BRL" },
          }),
        });
        const body = (await res.json()) as { id: string };
        return { id: body.id, playerId };
      }),
    );

    const hotPlayerId = newId();
    const hotWalletRes = await fetch(`${nodes[0]!.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId: hotPlayerId,
        initialBalance: { amount: "10000.00", currency: "BRL" },
      }),
    });
    const hotWallet = (await hotWalletRes.json()) as { id: string };

    // 2. Run distributed workload (300 requests, concurrency 30)
    const distStats = await runScenario("Distributed (20 wallets, 3 replicas)", 300, 30, async (i) => {
      const targetWallet = distributedWallets[i % distributedWallets.length]!;
      const baseUrl = nodes[i % nodes.length]!.baseUrl;
      const extId = `dist-tx-${i}`;
      return fetch(`${baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `load-provider:${extId}`,
        },
        body: JSON.stringify({
          providerId: "load-provider",
          externalTransactionId: extId,
          playerId: targetWallet.playerId,
          walletId: targetWallet.id,
          roundId: `round-${i}`,
          gameId: "fortune-chimp",
          kind: i % 3 === 0 ? "WIN" : "BET",
          money: { amount: "10.00", currency: "BRL" },
        }),
      });
    });

    // 3. Run hot-wallet workload (100 requests on 1 wallet, concurrency 20)
    const hotStats = await runScenario("Hot Wallet (1 wallet, 3 replicas)", 100, 20, async (i) => {
      const baseUrl = nodes[i % nodes.length]!.baseUrl;
      const extId = `hot-tx-${i}`;
      return fetch(`${baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `load-provider:${extId}`,
        },
        body: JSON.stringify({
          providerId: "load-provider",
          externalTransactionId: extId,
          playerId: hotPlayerId,
          walletId: hotWallet.id,
          roundId: `hot-round-${i}`,
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "10.00", currency: "BRL" },
        }),
      });
    });

    // 4. Reconcile all 21 wallets
    let reconciledCount = 0;
    for (const w of [...distributedWallets, { id: hotWallet.id }]) {
      const res = await fetch(`${nodes[0]!.baseUrl}/wallets/${w.id}/reconciliation`, {
        method: "POST",
      });
      const body = (await res.json()) as { consistent: boolean };
      if (!body.consistent) {
        throw new Error(`Reconciliation failed for wallet ${w.id}`);
      }
      reconciledCount += 1;
    }

    console.log(
      JSON.stringify(
        {
          summary: "Load test completed with 100% financial consistency",
          reconciledWallets: `${reconciledCount}/21`,
          scenarios: [distStats, hotStats],
        },
        null,
        2,
      ),
    );
  } finally {
    await Promise.all(nodes.map((n) => n.close()));
  }
}

async function runScenario(
  name: string,
  totalRequests: number,
  concurrency: number,
  workerFn: (index: number) => Promise<Response>,
) {
  const latenciesMs: number[] = [];
  let cursor = 0;
  let successes = 0;
  let errors = 0;
  const startWall = performance.now();

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= totalRequests) {
          break;
        }
        const t0 = performance.now();
        try {
          const res = await workerFn(idx);
          await res.arrayBuffer();
          latenciesMs.push(performance.now() - t0);
          if (res.status >= 200 && res.status < 300) {
            successes += 1;
          } else {
            errors += 1;
          }
        } catch {
          latenciesMs.push(performance.now() - t0);
          errors += 1;
        }
      }
    }),
  );

  const elapsedSeconds = (performance.now() - startWall) / 1000;
  latenciesMs.sort((a, b) => a - b);

  return {
    name,
    totalRequests,
    concurrency,
    successes,
    errors,
    errorRatePct: Number(((errors / totalRequests) * 100).toFixed(2)),
    throughputRps: Number((totalRequests / elapsedSeconds).toFixed(1)),
    p50Ms: percentile(latenciesMs, 0.5),
    p95Ms: percentile(latenciesMs, 0.95),
    p99Ms: percentile(latenciesMs, 0.99),
  };
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const pos = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return Number((sorted[pos] ?? 0).toFixed(2));
}

if (import.meta.main) {
  runLoadTest().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

