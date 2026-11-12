import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { newId } from "../../src/domain/shared/id";
import { FailureCode } from "../../src/domain/shared/failure-code";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/wagering/wager-transaction";
import { SqsService } from "../../src/messaging/sqs.service";
import { WagerSqsConsumer } from "../../src/messaging/wager-sqs.consumer";
import { OutboxPublisherWorker } from "../../src/workers/outbox-publisher.worker";
import { PendingReferenceWorker } from "../../src/workers/pending-reference.worker";
import {
  assertAllWalletsReconciled,
  createTestApp,
  resetDatabase,
  type TestAppInstance,
} from "../helpers/test-harness";

describe("Integration — PostgreSQL Schema Constraints, HTTP API, SQS Inbox/Outbox & DLQ", () => {
  let srv: TestAppInstance;

  beforeAll(async () => {
    srv = await createTestApp({
      roles: ["api"],
      maxReceiveCount: 3,
      pendingRefMaxAttempts: 3,
      pendingRefBaseDelayMs: 20,
    });
  });

  beforeEach(async () => {
    await resetDatabase(srv.orm);
  });

  afterAll(async () => {
    await srv.close();
  });

  it("supports reversible migrations (down -> up) and enforces database-level constraints and triggers", async () => {
    const migrator = srv.orm.getMigrator();
    await migrator.down();
    await migrator.up();

    // Create a valid wallet via API (100.00 BRL)
    const playerId = newId();
    const createRes = await fetch(`${srv.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    });
    expect(createRes.status).toBe(201);
    const wallet = (await createRes.json()) as { id: string };

    const em = srv.orm.em.fork();

    // 1. Negative balance is rejected by CHECK constraint
    await expect(
      em.execute("UPDATE wallets SET balance = -0.01 WHERE id = ?", [wallet.id]),
    ).rejects.toThrow();

    // 2. Mutating wallet balance without inserting a matching ledger entry is rejected at COMMIT by deferred trigger
    await expect(
      em.transactional(async (tx) => {
        await tx.execute("UPDATE wallets SET balance = 999.00, version = 2 WHERE id = ?", [wallet.id]);
      }),
    ).rejects.toThrow(/diverges from its ledger/);

    // 3. Updating or deleting a ledger entry is blocked by append-only trigger
    await expect(
      em.execute("UPDATE wallet_ledger_entries SET amount = 50.00 WHERE wallet_id = ?", [wallet.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      em.execute("DELETE FROM wallet_ledger_entries WHERE wallet_id = ?", [wallet.id]),
    ).rejects.toThrow(/append-only/);

    // 4. Deleting or mutating a terminal wager_transaction is blocked by wager_tx_guard trigger
    await expect(
      em.execute("UPDATE wager_transactions SET amount = 500.00 WHERE wallet_id = ?", [wallet.id]),
    ).rejects.toThrow(/terminal/);
    await expect(
      em.execute("DELETE FROM wager_transactions WHERE wallet_id = ?", [wallet.id]),
    ).rejects.toThrow(/cannot be deleted/);

    await assertAllWalletsReconciled(srv);
  });

  it("executes full HTTP lifecycle: wallet creation, BET/WIN/LOSS/REFUND/ROLLBACK, idempotency, cursor ledger and reconciliation", async () => {
    const playerId = newId();

    // 1. Open wallet with 1000.00 BRL
    const openRes = await fetch(`${srv.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-correlation-id": "corr-open-1" },
      body: JSON.stringify({
        playerId: playerId.toUpperCase(), // verify uppercase UUID normalization
        initialBalance: { amount: "1000.00", currency: "BRL" },
      }),
    });
    expect(openRes.status).toBe(201);
    expect(openRes.headers.get("x-correlation-id")).toBe("corr-open-1");
    const wallet = (await openRes.json()) as { id: string; balance: { amount: string }; version: number };
    expect(wallet.balance.amount).toBe("1000.00");
    expect(wallet.version).toBe(1);

    // 2. Duplicate wallet for same playerId + currency -> 409 WALLET_ALREADY_EXISTS
    const dupWalletRes = await fetch(`${srv.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: "50.00", currency: "BRL" },
      }),
    });
    expect(dupWalletRes.status).toBe(409);
    const dupErr = (await dupWalletRes.json()) as { error: { code: string } };
    expect(dupErr.error.code).toBe("WALLET_ALREADY_EXISTS");

    // 3. Submit BET of 25.00 BRL
    const betPayload = {
      providerId: "provider-a",
      externalTransactionId: "tx-bet-1",
      playerId,
      walletId: wallet.id,
      roundId: "round-10",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    };
    const betRes = await fetch(`${srv.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "provider-a:tx-bet-1",
      },
      body: JSON.stringify(betPayload),
    });
    expect(betRes.status).toBe(201);
    const betBody = (await betRes.json()) as {
      transactionId: string;
      status: string;
      balance: { amount: string };
      idempotentReplay: boolean;
    };
    expect(betBody.status).toBe("PROCESSED");
    expect(betBody.balance.amount).toBe("975.00");
    expect(betBody.idempotentReplay).toBe(false);

    // 4. Submit WIN of 50.00 BRL referencing tx-bet-1
    const winRes = await fetch(`${srv.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "provider-a:tx-win-1",
      },
      body: JSON.stringify({
        ...betPayload,
        externalTransactionId: "tx-win-1",
        kind: "WIN",
        money: { amount: "50.00", currency: "BRL" },
        referenceExternalTransactionId: "tx-bet-1",
      }),
    });
    expect(winRes.status).toBe(201);
    const winBody = (await winRes.json()) as { balance: { amount: string } };
    expect(winBody.balance.amount).toBe("1025.00");

    // 5. Replay the first BET -> must return 200 OK, idempotentReplay: true, and the ORIGINAL balance (975.00)!
    const replayRes = await fetch(`${srv.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "provider-a:tx-bet-1",
      },
      body: JSON.stringify(betPayload),
    });
    expect(replayRes.status).toBe(200);
    const replayBody = (await replayRes.json()) as {
      transactionId: string;
      balance: { amount: string };
      idempotentReplay: boolean;
    };
    expect(replayBody.transactionId).toBe(betBody.transactionId);
    expect(replayBody.balance.amount).toBe("975.00");
    expect(replayBody.idempotentReplay).toBe(true);

    // 6. Reuse same Idempotency-Key with a different amount -> 409 IDEMPOTENCY_CONFLICT
    const conflictRes = await fetch(`${srv.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "provider-a:tx-bet-1",
      },
      body: JSON.stringify({
        ...betPayload,
        money: { amount: "30.00", currency: "BRL" },
      }),
    });
    expect(conflictRes.status).toBe(409);

    // 7. LOSS transaction -> 201 Created, does not alter balance or add a ledger entry
    const lossRes = await fetch(`${srv.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "provider-a:tx-loss-1",
      },
      body: JSON.stringify({
        ...betPayload,
        externalTransactionId: "tx-loss-1",
        kind: "LOSS",
        money: { amount: "0.00", currency: "BRL" },
        referenceExternalTransactionId: "tx-bet-1",
      }),
    });
    expect(lossRes.status).toBe(201);

    // 8. REFUND of tx-bet-1 -> credits 25.00 back (balance -> 1050.00); second REFUND is rejected (422)
    const refundRes = await fetch(`${srv.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "provider-a:tx-refund-1",
      },
      body: JSON.stringify({
        ...betPayload,
        externalTransactionId: "tx-refund-1",
        kind: "REFUND",
        money: { amount: "25.00", currency: "BRL" },
        referenceExternalTransactionId: "tx-bet-1",
      }),
    });
    expect(refundRes.status).toBe(201);
    const refundBody = (await refundRes.json()) as { balance: { amount: string } };
    expect(refundBody.balance.amount).toBe("1050.00");

    const dupRefundRes = await fetch(`${srv.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "provider-a:tx-refund-2",
      },
      body: JSON.stringify({
        ...betPayload,
        externalTransactionId: "tx-refund-2",
        kind: "REFUND",
        money: { amount: "25.00", currency: "BRL" },
        referenceExternalTransactionId: "tx-bet-1",
      }),
    });
    expect(dupRefundRes.status).toBe(422);
    const dupRefundBody = (await dupRefundRes.json()) as { failureCode: string };
    expect(dupRefundBody.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);

    // 9. Query transaction by id and by (providerId, externalTransactionId)
    const getTxById = await fetch(`${srv.baseUrl}/wagering/transactions/${betBody.transactionId}`);
    expect(getTxById.status).toBe(200);
    const getTxByExt = await fetch(`${srv.baseUrl}/providers/provider-a/wagering/transactions/tx-bet-1`);
    expect(getTxByExt.status).toBe(200);

    // 10. Cursor pagination on GET /wallets/:walletId/ledger (4 entries: OPENING, BET, WIN, REFUND)
    const page1Res = await fetch(`${srv.baseUrl}/wallets/${wallet.id}/ledger?limit=2`);
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as { items: unknown[]; nextCursor: string | null };
    expect(page1.items.length).toBe(2);
    expect(page1.nextCursor).toBeTruthy();

    const page2Res = await fetch(
      `${srv.baseUrl}/wallets/${wallet.id}/ledger?limit=2&cursor=${page1.nextCursor}`,
    );
    expect(page2Res.status).toBe(200);
    const page2 = (await page2Res.json()) as { items: unknown[]; nextCursor: string | null };
    expect(page2.items.length).toBe(2);
    expect(page2.nextCursor).toBeNull();

    // Invalid cursor -> 400
    const badCursorRes = await fetch(`${srv.baseUrl}/wallets/${wallet.id}/ledger?cursor=invalid`);
    expect(badCursorRes.status).toBe(400);

    // 11. Reconciliation -> consistent: true, checkedEntries: 4
    const reconRes = await fetch(`${srv.baseUrl}/wallets/${wallet.id}/reconciliation`, {
      method: "POST",
    });
    expect(reconRes.status).toBe(200);
    const recon = (await reconRes.json()) as {
      consistent: boolean;
      storedBalance: { amount: string };
      calculatedBalance: { amount: string };
      difference: { amount: string };
      checkedEntries: number;
    };
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe("1050.00");
    expect(recon.calculatedBalance.amount).toBe("1050.00");
    expect(recon.difference.amount).toBe("0.00");
    expect(recon.checkedEntries).toBe(4);

    // 12. Health & Metrics endpoints + 400/404 error filter paths
    const liveRes = await fetch(`${srv.baseUrl}/health/live`);
    expect(liveRes.status).toBe(200);
    const readyRes = await fetch(`${srv.baseUrl}/health/ready`);
    expect(readyRes.status).toBe(200);
    const metricsRes = await fetch(`${srv.baseUrl}/metrics`);
    expect(metricsRes.status).toBe(200);
    const metricsText = await metricsRes.text();
    expect(metricsText).toContain("wager_transactions_total");

    const notFoundWallet = await fetch(`${srv.baseUrl}/wallets/${newId()}`);
    expect(notFoundWallet.status).toBe(404);
    const notFoundTx = await fetch(`${srv.baseUrl}/wagering/transactions/${newId()}`);
    expect(notFoundTx.status).toBe(404);
    const notFoundExt = await fetch(`${srv.baseUrl}/providers/provider-a/wagering/transactions/missing-tx`);
    expect(notFoundExt.status).toBe(404);
    const badMoneyWallet = await fetch(`${srv.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId: newId(),
        initialBalance: { amount: "10.0", currency: "BRL" },
      }),
    });
    expect(badMoneyWallet.status).toBe(400);
    const missingKeyRes = await fetch(`${srv.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(betPayload),
    });
    expect(missingKeyRes.status).toBe(400);

    await assertAllWalletsReconciled(srv);
  });

  it("processes SQS messages with persistent inbox deduplication, publishes outbox events, and dead-letters poison messages", async () => {
    const playerId = newId();
    const openRes = await fetch(`${srv.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: "200.00", currency: "BRL" },
      }),
    });
    const wallet = (await openRes.json()) as { id: string };

    const sqs = srv.app.get(SqsService);
    const consumer = srv.app.get(WagerSqsConsumer);
    const outboxWorker = srv.app.get(OutboxPublisherWorker);

    const validEnvelope = {
      messageId: `msg-${newId()}`,
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data: {
        providerId: "provider-sqs",
        externalTransactionId: "sqs-bet-1",
        idempotencyKey: "provider-sqs:sqs-bet-1",
        playerId,
        walletId: wallet.id,
        roundId: "round-sqs-1",
        gameId: "fortune-chimp",
        kind: WagerTransactionKind.Bet,
        money: { amount: "45.00", currency: "BRL" },
      },
    };

    // 1. Send valid message to SQS and process it
    await sqs.sendWagerMessage(validEnvelope, wallet.id, `dedup-1-${Date.now()}`);
    const received1 = await sqs.receiveWagerMessages(1, 2);
    expect(received1.length).toBe(1);
    const outcome1 = await consumer.handleMessage(received1[0]!);
    expect(outcome1).toBe("acked");

    // 2. Redeliver the exact same SQS message (same messageId) -> deduplicated by inbox, balance stays 155.00
    await sqs.sendWagerMessage(validEnvelope, wallet.id, `dedup-2-${Date.now()}`);
    const received2 = await sqs.receiveWagerMessages(1, 2);
    expect(received2.length).toBe(1);
    const outcome2 = await consumer.handleMessage(received2[0]!);
    expect(outcome2).toBe("acked");

    const walletRes = await fetch(`${srv.baseUrl}/wallets/${wallet.id}`);
    const walletState = (await walletRes.json()) as { balance: { amount: string } };
    expect(walletState.balance.amount).toBe("155.00");

    // 3. Send a malformed message -> moved to DLQ
    const { wagerQueueUrl, wagerDlqUrl, eventsQueueUrl } = await sqs.ensureQueues();
    await sqs.sendWagerMessage(
      { invalid: "payload" },
      wallet.id,
      `dedup-bad-${Date.now()}`,
    );
    const receivedBad = await sqs.receiveFromQueue(wagerQueueUrl, 1, 2);
    expect(receivedBad.length).toBe(1);
    const badOutcome = await consumer.handleMessage(receivedBad[0]!);
    expect(badOutcome).toBe("dlq");

    const dlqMessages = await sqs.receiveFromQueue(wagerDlqUrl, 10, 1);
    expect(dlqMessages.length).toBeGreaterThanOrEqual(1);

    // 4. Outbox publisher publishes pending integration events to wallet-events.fifo
    const published = await outboxWorker.publishBatch("test-publisher-1");
    expect(published).toBeGreaterThanOrEqual(4); // 2 from OPENING + 2 from BET
    const eventMessages = await sqs.receiveFromQueue(eventsQueueUrl, 10, 1);
    expect(eventMessages.length).toBeGreaterThanOrEqual(1);

    await assertAllWalletsReconciled(srv);
  });

  it("expires PENDING_REFERENCE to REJECTED (REFERENCE_NOT_FOUND) when reference never arrives within maxAttempts", async () => {
    const playerId = newId();
    const openRes = await fetch(`${srv.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    });
    const wallet = (await openRes.json()) as { id: string };

    // Submit REFUND referencing a non-existent BET -> 202 PENDING_REFERENCE
    const refundRes = await fetch(`${srv.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "provider-a:orphan-refund",
      },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: "orphan-refund",
        playerId,
        walletId: wallet.id,
        roundId: "round-orphan",
        gameId: "fortune-chimp",
        kind: "REFUND",
        money: { amount: "20.00", currency: "BRL" },
        referenceExternalTransactionId: "never-arrives-bet",
      }),
    });
    expect(refundRes.status).toBe(202);
    const refundBody = (await refundRes.json()) as { transactionId: string; status: string };
    expect(refundBody.status).toBe(WagerTransactionStatus.PendingReference);

    const pendingWorker = srv.app.get(PendingReferenceWorker);
    // Run ticks until maxAttempts (3) is reached
    for (let i = 0; i < 4; i++) {
      await srv.orm.em
        .fork()
        .execute(
          "UPDATE wager_transactions SET next_reference_attempt_at = now() - interval '1 second' WHERE id = ? AND status = 'PENDING_REFERENCE'",
          [refundBody.transactionId],
        );
      await pendingWorker.tick();
    }

    const txRes = await fetch(`${srv.baseUrl}/wagering/transactions/${refundBody.transactionId}`);
    const txView = (await txRes.json()) as { status: string; failureCode: string };
    expect(txView.status).toBe(WagerTransactionStatus.Rejected);
    expect(txView.failureCode).toBe(FailureCode.ReferenceNotFound);

    // Verify worker start/stop lifecycle hooks
    const consumer = srv.app.get(WagerSqsConsumer);
    const outboxWorker = srv.app.get(OutboxPublisherWorker);
    consumer.start();
    outboxWorker.start();
    pendingWorker.start();
    await consumer.stop();
    await outboxWorker.stop();
    await pendingWorker.stop();

    await assertAllWalletsReconciled(srv);
  });
});
