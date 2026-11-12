import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { ProcessWagerTransactionUseCase } from "../../src/application/process-wager-transaction.use-case";
import { FailureCode } from "../../src/domain/shared/failure-code";
import { newId } from "../../src/domain/shared/id";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/wagering/wager-transaction";
import { SqsService } from "../../src/messaging/sqs.service";
import { SQS_CONSUMER_NAME, WagerSqsConsumer } from "../../src/messaging/wager-sqs.consumer";
import { OutboxPublisherWorker } from "../../src/workers/outbox-publisher.worker";
import { PendingReferenceWorker } from "../../src/workers/pending-reference.worker";
import {
  assertAllWalletsReconciled,
  createTestApp,
  resetDatabase,
  type TestAppInstance,
} from "../helpers/test-harness";

describe("Concurrency — 8 Mandatory Real Parallelism Scenarios", () => {
  let instance1: TestAppInstance;
  let instance2: TestAppInstance;
  let instance3: TestAppInstance;

  beforeAll(async () => {
    instance1 = await createTestApp({ roles: ["api"], instanceId: "node-1", lockTimeoutMs: 5000 });
    instance2 = await createTestApp({ roles: ["api"], instanceId: "node-2", lockTimeoutMs: 5000 });
    instance3 = await createTestApp({ roles: ["api"], instanceId: "node-3", lockTimeoutMs: 5000 });
  });

  beforeEach(async () => {
    await resetDatabase(instance1.orm);
  });

  afterAll(async () => {
    await Promise.all([instance1.close(), instance2.close(), instance3.close()]);
  });

  async function openWallet(baseUrl: string, amount = "100.00", currency = "BRL") {
    const playerId = newId();
    const res = await fetch(`${baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount, currency },
      }),
    });
    expect(res.status).toBe(201);
    const wallet = (await res.json()) as { id: string; playerId: string };
    return wallet;
  }

  it("Scenario 1: Same bet sent 50 times in parallel -> exactly one debit and 49 idempotent replays", async () => {
    const wallet = await openWallet(instance1.baseUrl, "100.00");
    const urls = [instance1.baseUrl, instance2.baseUrl, instance3.baseUrl];

    const payload = {
      providerId: "provider-a",
      externalTransactionId: "bet-50x",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-50x",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    };

    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, idx) =>
        fetch(`${urls[idx % urls.length]}/wagering/transactions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "provider-a:bet-50x",
          },
          body: JSON.stringify(payload),
        }).then(async (r) => ({
          status: r.status,
          body: (await r.json()) as {
            transactionId: string;
            status: string;
            balance: { amount: string };
            idempotentReplay: boolean;
          },
        })),
      ),
    );

    const created = responses.filter((r) => r.status === 201 && !r.body.idempotentReplay);
    const replays = responses.filter((r) => r.status === 200 && r.body.idempotentReplay);

    expect(created.length).toBe(1);
    expect(replays.length).toBe(49);

    for (const r of responses) {
      expect(r.body.status).toBe("PROCESSED");
      expect(r.body.balance.amount).toBe("75.00");
      expect(r.body.transactionId).toBe(created[0]!.body.transactionId);
    }

    const ledgerRes = await fetch(`${instance1.baseUrl}/wallets/${wallet.id}/ledger`);
    const ledger = (await ledgerRes.json()) as { items: Array<{ direction: string }> };
    const debits = ledger.items.filter((i) => i.direction === "DEBIT");
    expect(debits.length).toBe(1);

    await assertAllWalletsReconciled(instance1);
  });

  it("Scenario 2: Mandatory Section 8 race — 100.00 BRL wallet with two simultaneous 80.00 BRL bets", async () => {
    const wallet = await openWallet(instance1.baseUrl, "100.00");

    const makeBet = (baseUrl: string, extId: string) =>
      fetch(`${baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `provider-a:${extId}`,
        },
        body: JSON.stringify({
          providerId: "provider-a",
          externalTransactionId: extId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: "round-race-80",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "80.00", currency: "BRL" },
        }),
      }).then(async (r) => ({
        httpStatus: r.status,
        body: (await r.json()) as {
          status: string;
          failureCode?: string;
          balance: { amount: string };
        },
      }));

    const [resA, resB] = await Promise.all([
      makeBet(instance1.baseUrl, "bet-80-a"),
      makeBet(instance2.baseUrl, "bet-80-b"),
    ]);

    const outcomes = [resA, resB];
    const processed = outcomes.filter((o) => o.body.status === WagerTransactionStatus.Processed);
    const rejected = outcomes.filter((o) => o.body.status === WagerTransactionStatus.Rejected);

    expect(processed.length).toBe(1);
    expect(processed[0]!.httpStatus).toBe(201);
    expect(processed[0]!.body.balance.amount).toBe("20.00");

    expect(rejected.length).toBe(1);
    expect(rejected[0]!.httpStatus).toBe(422);
    expect(rejected[0]!.body.failureCode).toBe(FailureCode.InsufficientFunds);

    // Retrying both bets does not duplicate the debit
    await Promise.all([
      makeBet(instance1.baseUrl, "bet-80-a"),
      makeBet(instance2.baseUrl, "bet-80-b"),
    ]);

    const walletRes = await fetch(`${instance1.baseUrl}/wallets/${wallet.id}`);
    const walletState = (await walletRes.json()) as { balance: { amount: string } };
    expect(walletState.balance.amount).toBe("20.00");

    const ledgerRes = await fetch(`${instance1.baseUrl}/wallets/${wallet.id}/ledger`);
    const ledger = (await ledgerRes.json()) as { items: Array<{ direction: string }> };
    expect(ledger.items.filter((i) => i.direction === "DEBIT").length).toBe(1);

    await assertAllWalletsReconciled(instance1);
  });

  it("Scenario 3: Distinct wallets processed in parallel without cross-wallet contention", async () => {
    const wallets = await Promise.all(
      Array.from({ length: 12 }, () => openWallet(instance1.baseUrl, "100.00")),
    );

    await Promise.all(
      wallets.flatMap((w, wIdx) => [
        fetch(`${instance1.baseUrl}/wagering/transactions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `provider-a:w-${wIdx}-bet-1`,
          },
          body: JSON.stringify({
            providerId: "provider-a",
            externalTransactionId: `w-${wIdx}-bet-1`,
            playerId: w.playerId,
            walletId: w.id,
            roundId: `r-${wIdx}`,
            gameId: "fortune-chimp",
            kind: "BET",
            money: { amount: "30.00", currency: "BRL" },
          }),
        }),
        fetch(`${instance2.baseUrl}/wagering/transactions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `provider-a:w-${wIdx}-win-1`,
          },
          body: JSON.stringify({
            providerId: "provider-a",
            externalTransactionId: `w-${wIdx}-win-1`,
            playerId: w.playerId,
            walletId: w.id,
            roundId: `r-${wIdx}`,
            gameId: "fortune-chimp",
            kind: "WIN",
            money: { amount: "15.00", currency: "BRL" },
          }),
        }),
      ]),
    );

    for (const w of wallets) {
      const res = await fetch(`${instance3.baseUrl}/wallets/${w.id}`);
      const state = (await res.json()) as { balance: { amount: string }; version: number };
      expect(state.balance.amount).toBe("85.00");
      expect(state.version).toBe(3); // 1 (OPENING) + 1 (BET) + 1 (WIN)
    }

    await assertAllWalletsReconciled(instance1);
  });

  it("Scenario 4: >= 3 instances simultaneously mutating the same hot wallet -> zero lost updates", async () => {
    const wallet = await openWallet(instance1.baseUrl, "500.00");
    const urls = [instance1.baseUrl, instance2.baseUrl, instance3.baseUrl];

    // 30 concurrent bets of 10.00 BRL distributed across 3 distinct NestJS instances
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, idx) =>
        fetch(`${urls[idx % 3]}/wagering/transactions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `provider-hot:bet-${idx}`,
          },
          body: JSON.stringify({
            providerId: "provider-hot",
            externalTransactionId: `bet-${idx}`,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: `round-${idx}`,
            gameId: "fortune-chimp",
            kind: "BET",
            money: { amount: "10.00", currency: "BRL" },
          }),
        }),
      ),
    );

    for (const r of results) {
      expect(r.status).toBe(201);
    }

    const walletRes = await fetch(`${instance1.baseUrl}/wallets/${wallet.id}`);
    const state = (await walletRes.json()) as { balance: { amount: string }; version: number };
    expect(state.balance.amount).toBe("200.00");
    expect(state.version).toBe(31);

    await assertAllWalletsReconciled(instance1);
  });

  it("Scenario 5: Worker dies AFTER SQL commit and BEFORE SQS ack -> redelivery is safely deduplicated", async () => {
    const wallet = await openWallet(instance1.baseUrl, "100.00");
    const sqs = instance1.app.get(SqsService);
    const useCaseOnNode1 = instance1.app.get(ProcessWagerTransactionUseCase);
    const consumerOnNode2 = instance2.app.get(WagerSqsConsumer);

    const messageId = `msg-crash-${newId()}`;
    const envelope = {
      messageId,
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data: {
        providerId: "provider-crash",
        externalTransactionId: "tx-crash-1",
        idempotencyKey: "provider-crash:tx-crash-1",
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "round-crash",
        gameId: "fortune-chimp",
        kind: WagerTransactionKind.Bet,
        money: { amount: "40.00", currency: "BRL" },
      },
    };

    // Enqueue message in SQS
    await sqs.sendWagerMessage(envelope, wallet.id, `dedup-crash-${Date.now()}`);
    const fetched = await sqs.receiveWagerMessages(1, 2);
    expect(fetched.length).toBe(1);
    const wireMsg = fetched[0]!;

    // Simulate Node 1 committing the SQL transaction (including inbox) and then crashing BEFORE calling sqs.ackWagerMessage()
    await useCaseOnNode1.execute({
      ...envelope.data,
      channel: "sqs",
      inbox: {
        consumerName: SQS_CONSUMER_NAME,
        messageId,
      },
    });

    // Release visibility timeout to 0 so SQS immediately redelivers the un-acked message to Node 2
    await sqs.changeWagerMessageVisibility(wireMsg.ReceiptHandle!, 0);
    const redelivered = await sqs.receiveWagerMessages(1, 2);
    expect(redelivered.length).toBe(1);

    const outcome = await consumerOnNode2.handleMessage(redelivered[0]!);
    expect(outcome).toBe("acked");

    // Balance was debited only ONCE (100 - 40 = 60.00)
    const walletRes = await fetch(`${instance2.baseUrl}/wallets/${wallet.id}`);
    const state = (await walletRes.json()) as { balance: { amount: string }; version: number };
    expect(state.balance.amount).toBe("60.00");
    expect(state.version).toBe(2);

    await assertAllWalletsReconciled(instance2);
  });

  it("Scenario 6: Two concurrent publishers over the same outbox (with lease recovery) -> no lost events", async () => {
    const wallet = await openWallet(instance1.baseUrl, "200.00");

    // Produce several transactions so multiple events sit in outbox_messages
    for (let i = 0; i < 6; i++) {
      await fetch(`${instance1.baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `provider-outbox:bet-${i}`,
        },
        body: JSON.stringify({
          providerId: "provider-outbox",
          externalTransactionId: `bet-${i}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: `r-${i}`,
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "10.00", currency: "BRL" },
        }),
      });
    }

    // Simulate a crashed publisher that claimed one row with an already-expired lease
    await instance1.orm.em
      .fork()
      .execute(
        "UPDATE outbox_messages SET locked_by = 'dead-worker', locked_until = now() - interval '5 seconds' WHERE published_at IS NULL",
      );

    const pub1 = instance1.app.get(OutboxPublisherWorker);
    const pub2 = instance2.app.get(OutboxPublisherWorker);

    await Promise.all([pub1.publishBatch("publisher-A"), pub2.publishBatch("publisher-B")]);

    const [remaining] = await instance1.orm.em
      .fork()
      .execute<{ pending: number }[]>(
        "SELECT COUNT(*)::int AS pending FROM outbox_messages WHERE published_at IS NULL",
      );
    expect(remaining?.pending).toBe(0);

    await assertAllWalletsReconciled(instance1);
  });

  it("Scenario 7: ROLLBACK or REFUND delivered BEFORE the referenced BET -> parked then resolved", async () => {
    const wallet = await openWallet(instance1.baseUrl, "100.00");

    // 1. ROLLBACK arrives first, before bet-out-of-order exists -> 202 PENDING_REFERENCE
    const rollbackRes = await fetch(`${instance1.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "provider-ooo:rb-1",
      },
      body: JSON.stringify({
        providerId: "provider-ooo",
        externalTransactionId: "rb-1",
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "round-ooo",
        gameId: "fortune-chimp",
        kind: "ROLLBACK",
        money: { amount: "35.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-ooo-1",
      }),
    });
    expect(rollbackRes.status).toBe(202);
    const rollbackBody = (await rollbackRes.json()) as { transactionId: string; status: string };
    expect(rollbackBody.status).toBe(WagerTransactionStatus.PendingReference);

    // 2. Referenced BET arrives and debits 35.00 (balance -> 65.00)
    const betRes = await fetch(`${instance2.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "provider-ooo:bet-ooo-1",
      },
      body: JSON.stringify({
        providerId: "provider-ooo",
        externalTransactionId: "bet-ooo-1",
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "round-ooo",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "35.00", currency: "BRL" },
      }),
    });
    expect(betRes.status).toBe(201);

    // 3. Make the pending reference immediately due and run the worker tick
    await instance1.orm.em
      .fork()
      .execute(
        "UPDATE wager_transactions SET next_reference_attempt_at = now() - interval '1 second' WHERE id = ?",
        [rollbackBody.transactionId],
      );

    const pendingWorker = instance3.app.get(PendingReferenceWorker);
    const resolvedCount = await pendingWorker.tick();
    expect(resolvedCount).toBe(1);

    // 4. Verify ROLLBACK is now PROCESSED and wallet balance is restored to 100.00 BRL
    const txCheck = await fetch(`${instance1.baseUrl}/wagering/transactions/${rollbackBody.transactionId}`);
    const txView = (await txCheck.json()) as { status: string };
    expect(txView.status).toBe(WagerTransactionStatus.Processed);

    const walletCheck = await fetch(`${instance1.baseUrl}/wallets/${wallet.id}`);
    const walletView = (await walletCheck.json()) as { balance: { amount: string }; version: number };
    expect(walletView.balance.amount).toBe("100.00");
    expect(walletView.version).toBe(3); // 1 (OPENING) + 1 (BET) + 1 (ROLLBACK)

    await assertAllWalletsReconciled(instance1);
  });

  it("Scenario 8: Service restart preserves state, idempotency, pending references and ledger consistency", async () => {
    const ephemeral = await createTestApp({ roles: ["api"], instanceId: "ephemeral-1" });
    const wallet = await openWallet(ephemeral.baseUrl, "150.00");

    const betRes = await fetch(`${ephemeral.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "provider-restart:bet-1",
      },
      body: JSON.stringify({
        providerId: "provider-restart",
        externalTransactionId: "bet-1",
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "round-restart",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "50.00", currency: "BRL" },
      }),
    });
    expect(betRes.status).toBe(201);

    // Shut down the ephemeral instance completely and start a brand new instance
    await ephemeral.close();
    const restarted = await createTestApp({ roles: ["api"], instanceId: "restarted-1" });

    try {
      // Replay against the new instance returns the original result without re-debiting
      const replayRes = await fetch(`${restarted.baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "provider-restart:bet-1",
        },
        body: JSON.stringify({
          providerId: "provider-restart",
          externalTransactionId: "bet-1",
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: "round-restart",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "50.00", currency: "BRL" },
        }),
      });
      expect(replayRes.status).toBe(200);
      const replayBody = (await replayRes.json()) as {
        idempotentReplay: boolean;
        balance: { amount: string };
      };
      expect(replayBody.idempotentReplay).toBe(true);
      expect(replayBody.balance.amount).toBe("100.00");

      await assertAllWalletsReconciled(restarted);
    } finally {
      await restarted.close();
    }
  });
});

