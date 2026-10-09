/**
 * Consumer drain benchmark: measures how fast the consumers empty a pre-filled queue, independent of how fast a
 * producer can enqueue. Two phases, orchestrated from the shell so consumers can be off while the queue fills:
 *
 *   APP_ROLES=api docker compose up -d                              # consumers OFF
 *   bun run load/sqs-drain.ts prepare --messages 3000 --wallets 10   # wallets + pre-filled queue
 *   docker compose up -d app                                         # consumers ON (default roles)
 *   bun run load/sqs-drain.ts measure
 *
 * Throughput = messages / (last − first inbox `received_at`), i.e. pure processing time as seen by the database.
 */
import { Client } from "pg";
import { SqsGateway } from "../src/infrastructure/messaging/sqs-gateway";

const [phase = "measure", ...rest] = process.argv.slice(2).filter((a) => a !== "--");
const arg = (k: string, d: string) => {
  const i = rest.indexOf(`--${k}`);
  return i >= 0 ? (rest[i + 1] ?? d) : d;
};
const API = arg("api", "http://localhost:8080");
const DB = arg("db", "postgres://wagering_migrator:migrator_dev_password@localhost:5433/wagering");
const STATE = "load/results/sqs-drain-state.json";

const sqs = new SqsGateway({
  region: "us-east-1",
  endpoint: arg("sqs", "http://localhost:4566"),
  verifyMd5: false,
  wagerQueueName: "wager-transactions.fifo",
  wagerDlqName: "wager-transactions-dlq.fifo",
  eventsQueueName: "wallet-events.fifo",
  maxReceiveCount: 5,
  visibilityTimeoutSeconds: 30,
});

if (phase === "prepare") {
  const messages = Number(arg("messages", "3000"));
  const walletCount = Number(arg("wallets", "10"));
  const wallets: { id: string; playerId: string }[] = [];
  for (let i = 0; i < walletCount; i++) {
    const playerId = Bun.randomUUIDv7();
    const res = await fetch(`${API}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId, initialBalance: { amount: "100000.00", currency: "BRL" } }),
    });
    wallets.push({ id: ((await res.json()) as { id: string }).id, playerId });
  }
  const ids: string[] = [];
  for (let i = 0; i < messages; i += 50) {
    await Promise.all(
      Array.from({ length: Math.min(50, messages - i) }, async (_, j) => {
        const w = wallets[(i + j) % wallets.length] as { id: string; playerId: string };
        const ext = `drain-${Bun.randomUUIDv7()}`;
        const messageId = `m-${ext}`;
        ids.push(messageId);
        await sqs.sendWager(
          JSON.stringify({
            messageId,
            type: "WagerTransactionRequested",
            occurredAt: new Date().toISOString(),
            data: {
              providerId: "load-provider",
              externalTransactionId: ext,
              idempotencyKey: `load-provider:${ext}`,
              playerId: w.playerId,
              walletId: w.id,
              roundId: "drain",
              gameId: "drain",
              kind: "BET",
              money: { amount: "0.10", currency: "BRL" },
            },
          }),
          w.id,
          Bun.randomUUIDv7(),
        );
      }),
    );
  }
  await Bun.write(STATE, JSON.stringify({ messages, wallets: walletCount, ids }));
  console.log(
    JSON.stringify({
      phase,
      messages,
      wallets: walletCount,
      queued: await sqs.queueDepth("wager-transactions.fifo"),
    }),
  );
} else {
  const state = (await Bun.file(STATE).json()) as { messages: number; wallets: number; ids: string[] };
  const db = new Client({ connectionString: DB });
  await db.connect();
  let processed = 0;
  const deadline = Date.now() + 600_000;
  while (processed < state.ids.length && Date.now() < deadline) {
    const { rows } = await db.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM inbox_messages WHERE message_id = ANY($1)",
      [state.ids],
    );
    processed = Number(rows[0]?.n);
    if (processed < state.ids.length) await Bun.sleep(250);
  }
  const { rows } = await db.query<{ seconds: string; commits: string }>(
    `SELECT EXTRACT(EPOCH FROM (MAX(received_at) - MIN(received_at)))::text AS seconds,
            COUNT(DISTINCT received_at)::text AS commits
       FROM inbox_messages WHERE message_id = ANY($1)`,
    [state.ids],
  );
  const seconds = Number(rows[0]?.seconds);
  const commits = Number(rows[0]?.commits);
  console.log(
    JSON.stringify({
      phase,
      messages: state.messages,
      wallets: state.wallets,
      processed,
      drainSeconds: Math.round(seconds * 10) / 10,
      throughputMsgPerS: Math.round(processed / seconds),
      sqlTransactions: commits,
      avgMessagesPerTransaction: Math.round((processed / commits) * 10) / 10,
    }),
  );
  await db.end();
}
sqs.destroy();
