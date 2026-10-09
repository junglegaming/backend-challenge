import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RunningApplication } from "../../src/bootstrap";
import type { SqsGateway } from "../../src/infrastructure/messaging/sqs-gateway";
import { assertAllWalletsConsistent, assertWalletConsistent } from "../helpers/invariants";
import { sendWager, wagerMessage } from "../helpers/sqs-helpers";
import { ensureQueues, http, startTestApp, testEnv, testQueues, waitFor } from "../helpers/test-app";
import { createTestDatabase, type TestDatabase } from "../helpers/test-db";

/**
 * Multi-currency end to end (HTTP and real SQS): the challenge may run on BRL only, but the model must stay
 * multi-currency and currency conflicts must be tested.
 */
let db: TestDatabase;
let app: RunningApplication;
let sqs: SqsGateway;
let queues: ReturnType<typeof testQueues>;

beforeAll(async () => {
  db = await createTestDatabase();
  queues = testQueues("ccy");
  const env = testEnv(db, queues, { APP_ROLES: "api,consumer", SUPPORTED_CURRENCIES: "BRL,USD" });
  sqs = await ensureQueues(env);
  app = await startTestApp(env);
});
afterAll(async () => {
  await app.shutdown("test");
  sqs.destroy();
  await assertAllWalletsConsistent(db);
  await db.drop();
});

const uuid = () => Bun.randomUUIDv7();

const openWallet = (currency: string, playerId = uuid(), amount = "100.00") =>
  http<{ id: string; playerId: string; balance: { amount: string; currency: string } }>(
    app.url,
    "POST",
    "/wallets",
    { playerId, initialBalance: { amount, currency } },
  );

function wager(
  w: { id: string; playerId: string },
  kind: string,
  money: { amount: string; currency: string },
  extra: Record<string, unknown> = {},
) {
  return {
    providerId: "provider-a",
    externalTransactionId: `tx-${uuid()}`,
    playerId: w.playerId,
    walletId: w.id,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind,
    money,
    ...extra,
  };
}

const submit = (body: { externalTransactionId: string } & Record<string, unknown>) =>
  http<Record<string, unknown>>(app.url, "POST", "/wagering/transactions", body, {
    "Idempotency-Key": `provider-a:${body.externalTransactionId}`,
  });

describe("wallet opening", () => {
  test("enabled currencies open; a valid but disabled one is 422; a non-ISO code is 400", async () => {
    const usd = await openWallet("USD");
    expect(usd.status).toBe(201);
    expect(usd.body.balance).toEqual({ amount: "100.00", currency: "USD" });

    const jpy = await openWallet("JPY");
    expect(jpy.status).toBe(422);
    expect(jpy.body).toMatchObject({
      code: "CURRENCY_NOT_SUPPORTED",
      details: { currency: "JPY", supported: ["BRL", "USD"] },
    });

    expect((await openWallet("XYZ")).status).toBe(400);
    expect((await openWallet("brl")).status).toBe(400);
  });

  test("one player holds one wallet per currency, and each moves independently", async () => {
    const playerId = uuid();
    const brl = (await openWallet("BRL", playerId)).body;
    const usd = (await openWallet("USD", playerId)).body;
    expect((await openWallet("BRL", playerId)).status).toBe(409);

    expect((await submit(wager(brl, "BET", { amount: "30.00", currency: "BRL" }))).status).toBe(201);
    expect((await submit(wager(usd, "BET", { amount: "5.00", currency: "USD" }))).status).toBe(201);

    const balance = async (id: string) =>
      (await http<{ balance: { amount: string; currency: string } }>(app.url, "GET", `/wallets/${id}`)).body
        .balance;
    expect(await balance(brl.id)).toEqual({ amount: "70.00", currency: "BRL" });
    expect(await balance(usd.id)).toEqual({ amount: "95.00", currency: "USD" });

    // Double entry never mixes currencies: one clearing account per (provider, currency).
    const accounts = await db.query<{ account: string; currency: string }>(
      `SELECT DISTINCT account, currency FROM ledger_postings
        WHERE transaction_id IN (SELECT id FROM wager_transactions WHERE wallet_id = ANY($1))
          AND account LIKE 'provider:%' ORDER BY account`,
      [[brl.id, usd.id]],
    );
    expect(accounts).toEqual([
      { account: "provider:provider-a:BRL", currency: "BRL" },
      { account: "provider:provider-a:USD", currency: "USD" },
    ]);
    await assertWalletConsistent(db, brl.id);
    await assertWalletConsistent(db, usd.id);
  });
});

describe("currency conflicts", () => {
  test("HTTP: a USD bet on a BRL wallet is REJECTED(CURRENCY_MISMATCH), persisted, replayable, no effect", async () => {
    const w = (await openWallet("BRL")).body;
    const body = wager(w, "BET", { amount: "10.00", currency: "USD" });

    const first = await submit(body);
    expect(first.status).toBe(422);
    expect(first.body).toMatchObject({
      status: "REJECTED",
      failureCode: "CURRENCY_MISMATCH",
      balance: { amount: "100.00", currency: "BRL" },
      idempotentReplay: false,
    });
    const replay = await submit(body);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({ idempotentReplay: true, transactionId: first.body.transactionId });

    const ledger = await http<{ items: unknown[] }>(app.url, "GET", `/wallets/${w.id}/ledger`);
    expect(ledger.body.items).toHaveLength(1); // the opening credit only
    await assertWalletConsistent(db, w.id);
  });

  test("HTTP: a reversal in another currency is rejected and never touches either wallet", async () => {
    const playerId = uuid();
    const brl = (await openWallet("BRL", playerId)).body;
    const usd = (await openWallet("USD", playerId)).body;
    const bet = wager(brl, "BET", { amount: "20.00", currency: "BRL" });
    expect((await submit(bet)).status).toBe(201);

    // Same player, same round, same amount — but the refund goes to the USD wallet in USD.
    const refund = await submit(
      wager(
        usd,
        "REFUND",
        { amount: "20.00", currency: "USD" },
        {
          referenceExternalTransactionId: bet.externalTransactionId,
        },
      ),
    );
    expect(refund.status).toBe(422);
    expect(refund.body).toMatchObject({ status: "REJECTED", failureCode: "REFERENCE_MISMATCH" });
    const balance = async (id: string) =>
      (await http<{ balance: { amount: string } }>(app.url, "GET", `/wallets/${id}`)).body.balance.amount;
    expect([await balance(brl.id), await balance(usd.id)]).toEqual(["80.00", "100.00"]);
  });

  test("SQS: a currency conflict is a business outcome (committed and acked), not a DLQ case", async () => {
    const w = (await openWallet("BRL")).body;
    const message = wagerMessage(w, "BET", "10.00", { money: { amount: "10.00", currency: "USD" } });
    await sendWager(sqs, message);

    const tx = await waitFor(
      async () => {
        const res = await http<{ status: string; failureCode: string | null }>(
          app.url,
          "GET",
          `/providers/provider-a/wagering/transactions/${message.data.externalTransactionId}`,
        );
        return res.status === 200 ? res.body : undefined;
      },
      { what: "SQS currency conflict processed", timeoutMs: 20_000 },
    );
    expect(tx).toMatchObject({ status: "REJECTED", failureCode: "CURRENCY_MISMATCH" });
    await waitFor(async () => (await sqs.queueDepth(queues.SQS_WAGER_QUEUE_NAME)) === 0, {
      what: "message acknowledged",
    });
    expect(await sqs.queueDepth(queues.SQS_WAGER_DLQ_NAME)).toBe(0);
    await assertWalletConsistent(db, w.id);
  });

  test("a non-ISO currency in a wager is a contract violation (400), on HTTP", async () => {
    const w = (await openWallet("BRL")).body;
    const res = await submit(wager(w, "BET", { amount: "10.00", currency: "XYZ" }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
