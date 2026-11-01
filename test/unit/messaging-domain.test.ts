import { expect, test } from "bun:test";
import { InboxMessage } from "../../src/messaging/domain/inbox-message";
import { OutboxMessage } from "../../src/messaging/domain/outbox-message";
import { DomainError } from "../../src/shared/domain/domain-error";
import {
  WagerTransactionFailed,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../src/wagering/domain/events";
import { FailureCode } from "../../src/wagering/domain/failure-code";
import { settle } from "../../src/wagering/domain/settlement";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus,
} from "../../src/wagering/domain/wager-transaction";
import { assertUnitLedgerInvariant, money, now, open, transaction } from "./domain-fixtures";

const context = () => ({
  eventId: crypto.randomUUID(),
  correlationId: "correlation-1",
  causationId: "message-1",
  occurredAt: now,
});

test("inbox reconstructs persisted processing without applying it again", () => {
  const props = {
    messageId: "message-1",
    consumerName: "wagering",
    payloadHash: "a".repeat(64),
    receivedAt: now,
  };
  const inbox = InboxMessage.receive(props);
  expect(inbox.isProcessed()).toBe(false);
  inbox.markProcessed(now);
  expect(inbox.isProcessed()).toBe(true);
  expect(() => inbox.markProcessed(now)).toThrow(DomainError);
  const restored = InboxMessage.rehydrate({ ...props, processedAt: now });
  expect(restored.processedAt?.toISOString()).toBe(now.toISOString());
  expect(() => InboxMessage.receive({ ...props, payloadHash: "bad" })).toThrow(DomainError);
});

test("outbox grows and caps jittered exponential retries and rehydrates its persisted lease", () => {
  const { wallet, entries } = open();
  const tx = transaction({ kind: Kind.Loss, money: money("0.00") });
  settle({
    transaction: tx,
    wallet,
    reference: null,
    referenceHasProcessedReversal: false,
    deadlineReached: false,
    now,
  });
  const event = WagerTransactionProcessed.from(tx, context());
  const outbox = OutboxMessage.enqueue(event);
  expect(outbox.id).toBe(event.eventId);
  expect(outbox.aggregateId).toBe(tx.id);
  expect(outbox.isDue(now)).toBe(true);
  expect(outbox.attempts).toBe(0);
  const delays: number[] = [];
  for (let count = 0; count < 10; count++) {
    outbox.scheduleRetry(now, { random: () => 0 });
    delays.push(outbox.nextAttemptAt.getTime() - now.getTime());
  }
  expect(delays).toEqual([
    30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000, 300_000, 300_000, 300_000,
  ]);
  expect(outbox.isDue(now)).toBe(false);
  const restored = OutboxMessage.rehydrate({
    id: outbox.id,
    aggregateId: outbox.aggregateId,
    eventType: outbox.eventType,
    payload: outbox.payload,
    occurredAt: outbox.occurredAt,
    attempts: outbox.attempts,
    nextAttemptAt: outbox.nextAttemptAt,
  });
  expect(restored.attempts).toBe(10);
  expect(restored.isDue(new Date(now.getTime() + 300_000))).toBe(true);
  restored.markPublished(now);
  expect(restored.isDue(now)).toBe(false);
  expect(restored.isPending()).toBe(false);
  expect(() => restored.scheduleRetry(now)).toThrow(DomainError);
  expect(() => restored.markPublished(now)).toThrow(DomainError);
  const jittered = OutboxMessage.enqueue(event);
  jittered.scheduleRetry(now, { leaseMs: 1000, maxMs: 2100, random: () => 1 });
  expect(jittered.nextAttemptAt.getTime() - now.getTime()).toBe(2100);
  assertUnitLedgerInvariant(wallet, entries);
});

test("each event serializes a stable versioned envelope with MoneyProps and correct aggregate", () => {
  const { wallet, entries } = open();
  const tx = transaction();
  const outcome = settle({
    transaction: tx,
    wallet,
    reference: null,
    referenceHasProcessedReversal: false,
    deadlineReached: false,
    now,
  });
  if (outcome.type !== "processed" || !outcome.ledgerEntry) throw new Error("Expected movement");
  entries.push(outcome.ledgerEntry);
  const ctx = context();
  const processed = WagerTransactionProcessed.from(tx, ctx);
  const changed = WalletBalanceChanged.from(wallet, outcome.ledgerEntry, ctx);
  expect(processed.toJSON()).toEqual({
    ...ctx,
    occurredAt: now.toISOString(),
    aggregateId: tx.id,
    eventType: "WagerTransactionProcessed",
    version: 1,
    data: {
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      walletId: wallet.id,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: Kind.Bet,
      status: WagerTransactionStatus.Processed,
      money: { amount: "10.00", currency: "BRL" },
      balance: { amount: "90.00", currency: "BRL" },
    },
  });
  expect(changed.aggregateId).toBe(wallet.id);
  expect(changed.data.walletVersion).toBe(2);
  expect(changed.data.money).toEqual({ amount: "10.00", currency: "BRL" });
  const original = JSON.stringify(processed);
  const copy = processed.data;
  copy.money.amount = "999.00";
  const date = processed.occurredAt;
  date.setUTCFullYear(2000);
  expect(JSON.stringify(processed)).toBe(original);
  const serialized = OutboxMessage.enqueue(processed);
  const payload = serialized.payload;
  (payload as Record<string, unknown>).eventType = "corrupt";
  expect(serialized.payload.eventType).toBe("WagerTransactionProcessed");

  const rejected = transaction();
  rejected.reject(FailureCode.InsufficientFunds, now, wallet.balance);
  const pending = transaction({ kind: Kind.Refund, referenceExternalTransactionId: "missing" });
  pending.markPendingReference(now, wallet.balance);
  const failed = transaction();
  failed.fail(FailureCode.PermanentProcessingError, now, wallet.balance);
  for (const event of [
    WagerTransactionRejected.from(rejected, context()),
    WagerTransactionPendingReference.from(pending, context()),
    WagerTransactionFailed.from(failed, context()),
  ]) {
    expect(event.aggregateId).toBe(event.data.transactionId);
    expect(event.version).toBe(1);
    expect(event.data.money).toEqual({ amount: "10.00", currency: "BRL" });
    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
  }
  const noCause = WagerTransactionProcessed.from(tx, {
    eventId: crypto.randomUUID(),
    correlationId: "c",
    occurredAt: now,
  });
  expect(noCause.toJSON()).not.toHaveProperty("causationId");
  assertUnitLedgerInvariant(wallet, entries);
});
