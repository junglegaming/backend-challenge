import { describe, expect, test } from "bun:test";
import { InboxMessage } from "../../src/modules/messaging/domain/inbox-message";
import { OutboxMessage } from "../../src/modules/messaging/domain/outbox-message";
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from "../../src/modules/wagering/domain/events/wagering-events";
import { WagerTransactionKind as K } from "../../src/modules/wagering/domain/wager-transaction-kind";
import { computeBackoffMs } from "../../src/shared/domain/backoff";
import { nextId, openWallet, T0, wager } from "../helpers/domain-fixtures";

const ctx = () => ({ eventId: nextId("evt"), correlationId: "corr-1", causationId: "msg-1", occurredAt: T0 });

describe("IntegrationEvent", () => {
  test("WalletBalanceChanged envelope carries type/version from the class and MoneyProps data", () => {
    const wallet = openWallet("100.00");
    const entry = wallet.debit({
      ledgerEntryId: "e",
      transactionId: "t",
      money: wager(wallet, K.Bet, "1.00").money,
      at: T0,
    });
    const json = WalletBalanceChanged.from(wallet, entry, ctx()).toJSON();
    expect(json.eventType).toBe("WalletBalanceChanged");
    expect(json.version).toBe(1);
    expect(json.aggregateId).toBe(wallet.id);
    expect(json.occurredAt).toBe("2026-07-29T15:00:00.000Z");
    expect(json.data).toEqual({
      walletId: wallet.id,
      transactionId: "t",
      direction: "DEBIT" as never,
      money: { amount: "1.00", currency: "BRL" },
      balanceBefore: { amount: "100.00", currency: "BRL" },
      balanceAfter: { amount: "99.00", currency: "BRL" },
      walletVersion: 2,
    });
    // JSON round-trip is stable (no class instances inside data)
    expect(JSON.parse(JSON.stringify(json))).toEqual(json as never);
  });

  test("event data is frozen", () => {
    const wallet = openWallet("100.00");
    const tx = wager(wallet, K.Loss, "0.00");
    tx.markProcessed(undefined, T0, wallet.balance);
    const evt = WagerTransactionProcessed.from(tx, ctx());
    expect(Object.isFrozen(evt.data)).toBe(true);
  });
});

describe("OutboxMessage", () => {
  const event = () => {
    const wallet = openWallet("100.00");
    const tx = wager(wallet, K.Loss, "0.00");
    tx.markProcessed(undefined, T0, wallet.balance);
    return WagerTransactionProcessed.from(tx, ctx());
  };

  test("enqueue uses eventId as id and is immediately due", () => {
    const evt = event();
    const msg = OutboxMessage.enqueue(evt);
    expect(msg.id).toBe(evt.eventId);
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(T0)).toBe(true);
    expect(msg.payload).toEqual(evt.toJSON() as never);
  });

  test("scheduleRetry backs off exponentially and markPublished is final", () => {
    const msg = OutboxMessage.enqueue(event());
    const policy = { baseMs: 1000, maxMs: 10_000, jitter: 0 };
    msg.scheduleRetry(T0, "boom", policy);
    expect(msg.attempts).toBe(1);
    expect(msg.nextAttemptAt?.getTime()).toBe(T0.getTime() + 1000);
    expect(msg.isDue(T0)).toBe(false);
    msg.scheduleRetry(T0, "boom", policy);
    expect(msg.nextAttemptAt?.getTime()).toBe(T0.getTime() + 2000);
    msg.markPublished(T0);
    expect(msg.isPending()).toBe(false);
    expect(() => msg.scheduleRetry(T0)).toThrow();
  });
});

describe("InboxMessage", () => {
  test("markProcessed is idempotent", () => {
    const inbox = InboxMessage.receive({
      messageId: "m",
      consumerName: "c",
      payloadHash: "h",
      receivedAt: T0,
    });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(T0);
    inbox.markProcessed(new Date(T0.getTime() + 1));
    expect(inbox.processedAt).toEqual(T0);
  });
});

describe("computeBackoffMs", () => {
  test("is capped and jitter stays within bounds", () => {
    const policy = { baseMs: 100, maxMs: 1000, jitter: 0.5 };
    expect(computeBackoffMs(0, policy, () => 0)).toBe(100);
    expect(computeBackoffMs(20, policy, () => 0)).toBe(1000);
    expect(computeBackoffMs(20, policy, () => 1)).toBe(500);
  });
});
