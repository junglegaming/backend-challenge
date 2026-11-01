export type Workload = "hot" | "distributed";
export interface LoadWallet {
  id: string;
  playerId: string;
}
export interface LoadFixtures {
  runId: string;
  profile: "quick" | "full";
  hot: LoadWallet;
  distributed: LoadWallet[];
  replays: { index: number; transactionId: string }[];
}

// The k6 generator uses this same deterministic identity/body contract. No monetary arithmetic.
export function loadCommand(
  fixtures: LoadFixtures,
  phase: string,
  workload: Workload,
  index: number,
) {
  const wallet =
    workload === "hot" ? fixtures.hot : fixtures.distributed[index % fixtures.distributed.length];
  if (!wallet) throw new Error("Missing load wallet");
  const key = `${fixtures.runId}:${phase}:${workload}:${index}`;
  return {
    key,
    body: {
      providerId: "provider-a",
      externalTransactionId: key,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: "load-round",
      gameId: "load-game",
      kind: index % 2 === 0 ? "BET" : "WIN",
      money: { amount: "1.00", currency: "BRL" },
    },
  };
}

export async function parallelEach<T>(
  items: T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
) {
  let next = 0;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        if (item !== undefined) await work(item);
      }
    }),
  );
  // Complete every started request before stack teardown on a failed run.
  for (const result of results) if (result.status === "rejected") throw result.reason;
}
