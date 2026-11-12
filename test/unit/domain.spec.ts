import { describe, expect, it } from "bun:test";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../src/domain/events/events";
import { InboxMessage } from "../../src/domain/messaging/inbox-message";
import { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import { Money } from "../../src/domain/money/money";
import {
  ConflictError,
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
  InvalidTransactionStateError,
  NotFoundError,
  TransientError,
  UnbalancedLedgerEntryError,
  ValidationError,
} from "../../src/domain/shared/errors";
import { FailureCode } from "../../src/domain/shared/failure-code";
import { newId } from "../../src/domain/shared/id";
import { canonicalJson, computePayloadHash } from "../../src/domain/wagering/payload-hash";
import { loadConfig } from "../../src/config/config";
import { isLockConflict, isTransientDatabaseError, isUniqueViolation, translateDatabaseError } from "../../src/database/database-errors";
import { GlobalHttpExceptionFilter } from "../../src/http/http-exception.filter";
import { parseWithSchema } from "../../src/http/zod-validation";
import { errorFields, NestPinoLogger } from "../../src/observability/logger";
import { HttpException, HttpStatus } from "@nestjs/common";
import { z } from "zod";
import { WagerRules } from "../../src/domain/wagering/wager-rules";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wagering/wager-transaction";
import { Wallet } from "../../src/domain/wallet/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../../src/domain/wallet/wallet-ledger-entry";

describe("Domain — Money", () => {
  it("creates immutable Money with fixed scale of 2 decimals and performs exact decimal math", () => {
    const a = Money.from({ amount: "0.10", currency: "BRL" });
    const b = Money.from({ amount: "0.20", currency: "BRL" });
    const sum = a.add(b);

    expect(sum.toString()).toBe("0.30");
    expect(sum.toJSON()).toEqual({ amount: "0.30", currency: "BRL" });
    // Immutability check
    expect(a.toString()).toBe("0.10");
    expect(b.toString()).toBe("0.20");

    const diff = sum.subtract(a);
    expect(diff.equals(b)).toBe(true);
    expect(diff.isPositive()).toBe(true);
    expect(diff.isZero()).toBe(false);
    expect(diff.isNegative()).toBe(false);
    expect(a.isLessThan(b)).toBe(true);
    expect(b.isLessThan(a)).toBe(false);

    const neg = a.negate();
    expect(neg.isNegative()).toBe(true);
    expect(neg.toString()).toBe("-0.10");

    const zero = Money.zero("BRL");
    expect(zero.isZero()).toBe(true);
    expect(zero.negate().toString()).toBe("0.00");
  });

  it("reconstructs persisted money values including negative reconciliation deltas", () => {
    const persisted = Money.fromPersistence("-12.5", "BRL");
    expect(persisted.isNegative()).toBe(true);
    expect(persisted.toString()).toBe("-12.50");

    expect(() => Money.fromPersistence("invalid", "BRL")).toThrow(InvalidMoneyError);
  });

  it("rejects invalid amount formats and invalid currencies", () => {
    const invalidAmounts = [
      "",
      "25",
      "25.0",
      "25.000",
      "-10.00",
      "NaN",
      "Infinity",
      "1e2",
      "01.00",
      " 10.00 ",
      "1234567890123456789.00", // > 18 integer digits
    ];
    for (const amount of invalidAmounts) {
      expect(() => Money.from({ amount, currency: "BRL" })).toThrow(InvalidMoneyError);
    }

    const invalidCurrencies = ["", "brl", "BR", "BRLX", "123", "US$"];
    for (const currency of invalidCurrencies) {
      expect(() => Money.from({ amount: "10.00", currency })).toThrow(InvalidMoneyError);
    }
  });

  it("throws CurrencyMismatchError when operating across different currencies", () => {
    const brl = Money.from({ amount: "10.00", currency: "BRL" });
    const usd = Money.from({ amount: "10.00", currency: "USD" });

    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl.equals(usd)).toBe(false);
  });
});

describe("Domain — Wallet & WalletLedgerEntry", () => {
  const now = new Date("2026-11-12T12:00:00.000Z");

  it("opens a wallet at version 1, applies openingCredit keeping version 1, and increments version on subsequent movements", () => {
    const walletId = newId();
    const playerId = newId();
    const wallet = Wallet.open({ id: walletId, playerId, currency: "BRL", at: now });

    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe("0.00");

    const openEntry = wallet.openingCredit(
      Money.from({ amount: "100.00", currency: "BRL" }),
      newId(),
      now,
    );
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe("100.00");
    expect(openEntry.isBalanced()).toBe(true);
    expect(openEntry.walletVersion).toBe(1);
    expect(openEntry.signedAmount().toString()).toBe("100.00");

    const debitEntry = wallet.debit(
      Money.from({ amount: "40.00", currency: "BRL" }),
      newId(),
      now,
    );
    expect(wallet.version).toBe(2);
    expect(wallet.balance.toString()).toBe("60.00");
    expect(debitEntry.balanceBefore.toString()).toBe("100.00");
    expect(debitEntry.balanceAfter.toString()).toBe("60.00");
    expect(debitEntry.signedAmount().toString()).toBe("-40.00");

    const creditEntry = wallet.credit(
      Money.from({ amount: "15.00", currency: "BRL" }),
      newId(),
      now,
    );
    expect(wallet.version).toBe(3);
    expect(wallet.balance.toString()).toBe("75.00");
    expect(creditEntry.toJSON().balanceAfter.amount).toBe("75.00");
    expect(wallet.toJSON().version).toBe(3);
  });

  it("enforces non-negative balance, currency matching, and balanced ledger entries", () => {
    const wallet = Wallet.open({ id: newId(), playerId: newId(), currency: "BRL", at: now });
    wallet.openingCredit(Money.from({ amount: "50.00", currency: "BRL" }), newId(), now);

    expect(() =>
      wallet.debit(Money.from({ amount: "50.01", currency: "BRL" }), newId(), now),
    ).toThrow(InsufficientFundsError);

    expect(() =>
      wallet.credit(Money.from({ amount: "10.00", currency: "USD" }), newId(), now),
    ).toThrow(CurrencyMismatchError);

    expect(() => wallet.credit(Money.zero("BRL"), newId(), now)).toThrow(InvalidMoneyError);

    expect(() =>
      WalletLedgerEntry.create({
        walletId: wallet.id,
        transactionId: newId(),
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: "10.00", currency: "BRL" }),
        balanceBefore: Money.from({ amount: "50.00", currency: "BRL" }),
        balanceAfter: Money.from({ amount: "45.00", currency: "BRL" }), // wrong math
        walletVersion: 2,
        createdAt: now,
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });
});

describe("Domain — WagerTransaction & WagerRules", () => {
  const now = new Date("2026-11-12T12:00:00.000Z");
  const walletId = newId();
  const playerId = newId();

  function makeWallet(amount = "100.00", currency = "BRL"): Wallet {
    const w = Wallet.open({ id: walletId, playerId, currency, at: now });
    if (amount !== "0.00") {
      w.openingCredit(Money.from({ amount, currency }), newId(), now);
    }
    return w;
  }

  function makeTx(overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}): WagerTransaction {
    return WagerTransaction.create({
      providerId: "provider-a",
      externalTransactionId: `ext-${newId()}`,
      idempotencyKey: `key-${newId()}`,
      payloadHash: "a".repeat(64),
      walletId,
      playerId,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "25.00", currency: "BRL" }),
      correlationId: "corr-1",
      createdAt: now,
      ...overrides,
    });
  }

  it("validates creation invariants and terminal state transitions", () => {
    expect(() =>
      makeTx({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: undefined }),
    ).toThrow(ValidationError);

    expect(() =>
      makeTx({
        kind: WagerTransactionKind.Bet,
        referenceExternalTransactionId: "some-ref",
      }),
    ).toThrow(ValidationError);

    expect(() =>
      makeTx({
        kind: WagerTransactionKind.Refund,
        externalTransactionId: "same-id",
        referenceExternalTransactionId: "same-id",
      }),
    ).toThrow(ValidationError);

    expect(() =>
      makeTx({
        kind: WagerTransactionKind.Bet,
        money: Money.zero("BRL"),
      }),
    ).toThrow(ValidationError);

    const tx = makeTx();
    tx.markProcessed(undefined, Money.from({ amount: "75.00", currency: "BRL" }), now);
    expect(tx.isTerminal()).toBe(true);

    expect(() => tx.reject(FailureCode.InsufficientFunds, Money.zero("BRL"), now)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.fail(FailureCode.InsufficientFunds, now)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.markPendingReference(Money.zero("BRL"), now)).toThrow(
      InvalidTransactionStateError,
    );
  });

  it("evaluates BET, WIN, LOSS, REFUND and ROLLBACK rules and distinguishes failure codes", () => {
    const wallet = makeWallet("100.00");

    // 1. BET within balance -> apply DEBIT
    const bet = makeTx({ externalTransactionId: "bet-1", money: Money.from({ amount: "80.00", currency: "BRL" }) });
    expect(
      WagerRules.decide({ transaction: bet, wallet, reference: null, referenceAlreadyReversed: false }),
    ).toEqual({ outcome: "apply", direction: LedgerDirection.Debit });
    wallet.debit(bet.money, bet.id, now);
    bet.markProcessed(undefined, wallet.balance, now);

    // 2. Second BET of 80.00 on 20.00 balance -> reject INSUFFICIENT_FUNDS
    const bet2 = makeTx({ externalTransactionId: "bet-2", money: Money.from({ amount: "80.00", currency: "BRL" }) });
    expect(
      WagerRules.decide({ transaction: bet2, wallet, reference: null, referenceAlreadyReversed: false }),
    ).toEqual({ outcome: "reject", failureCode: FailureCode.InsufficientFunds });

    // 3. LOSS with 0.00 -> apply with no balance direction
    const loss = makeTx({
      externalTransactionId: "loss-1",
      kind: WagerTransactionKind.Loss,
      money: Money.zero("BRL"),
      referenceExternalTransactionId: "bet-1",
    });
    expect(loss.affectsBalance()).toBe(false);
    expect(
      WagerRules.decide({ transaction: loss, wallet, reference: bet, referenceAlreadyReversed: false }),
    ).toEqual({ outcome: "apply" });

    // 4. WIN referencing BET -> apply CREDIT
    const win = makeTx({
      externalTransactionId: "win-1",
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: "50.00", currency: "BRL" }),
      referenceExternalTransactionId: "bet-1",
    });
    expect(
      WagerRules.decide({ transaction: win, wallet, reference: bet, referenceAlreadyReversed: false }),
    ).toEqual({ outcome: "apply", direction: LedgerDirection.Credit });
    wallet.credit(win.money, win.id, now);
    win.markProcessed(bet.id, wallet.balance, now);

    // 5. Spend the balance so ROLLBACK of WIN would drive balance negative -> REVERSAL_INSUFFICIENT_FUNDS
    const spendBet = makeTx({
      externalTransactionId: "bet-spend",
      money: Money.from({ amount: "60.00", currency: "BRL" }),
    });
    wallet.debit(spendBet.money, spendBet.id, now); // balance is now 10.00

    const rollbackWin = makeTx({
      externalTransactionId: "rb-win-1",
      kind: WagerTransactionKind.Rollback,
      money: Money.from({ amount: "50.00", currency: "BRL" }),
      referenceExternalTransactionId: "win-1",
    });
    expect(
      WagerRules.decide({ transaction: rollbackWin, wallet, reference: win, referenceAlreadyReversed: false }),
    ).toEqual({ outcome: "reject", failureCode: FailureCode.ReversalInsufficientFunds });

    // 6. Missing reference -> wait (PENDING_REFERENCE)
    const orphanRefund = makeTx({
      externalTransactionId: "refund-orphan",
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: "80.00", currency: "BRL" }),
      referenceExternalTransactionId: "missing-bet",
    });
    expect(
      WagerRules.decide({ transaction: orphanRefund, wallet, reference: null, referenceAlreadyReversed: false }),
    ).toEqual({ outcome: "wait" });

    // 7. Reference validations: invalid kind, amount mismatch, already reversed, player/currency/round mismatch
    const refundWin = makeTx({
      externalTransactionId: "refund-win",
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: "50.00", currency: "BRL" }),
      referenceExternalTransactionId: "win-1",
    });
    expect(
      WagerRules.decide({ transaction: refundWin, wallet, reference: win, referenceAlreadyReversed: false }),
    ).toEqual({ outcome: "reject", failureCode: FailureCode.ReferenceInvalidKind });

    const refundWrongAmount = makeTx({
      externalTransactionId: "refund-wrong-amt",
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: "10.00", currency: "BRL" }),
      referenceExternalTransactionId: "bet-1",
    });
    expect(
      WagerRules.decide({ transaction: refundWrongAmount, wallet, reference: bet, referenceAlreadyReversed: false }),
    ).toEqual({ outcome: "reject", failureCode: FailureCode.AmountMismatch });

    const refundAlreadyReversed = makeTx({
      externalTransactionId: "refund-dup",
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: "80.00", currency: "BRL" }),
      referenceExternalTransactionId: "bet-1",
    });
    expect(
      WagerRules.decide({ transaction: refundAlreadyReversed, wallet, reference: bet, referenceAlreadyReversed: true }),
    ).toEqual({ outcome: "reject", failureCode: FailureCode.ReferenceAlreadyReversed });

    const wrongRoundRefund = makeTx({
      externalTransactionId: "refund-wrong-round",
      kind: WagerTransactionKind.Refund,
      roundId: "different-round",
      money: Money.from({ amount: "80.00", currency: "BRL" }),
      referenceExternalTransactionId: "bet-1",
    });
    expect(
      WagerRules.decide({ transaction: wrongRoundRefund, wallet, reference: bet, referenceAlreadyReversed: false }),
    ).toEqual({ outcome: "reject", failureCode: FailureCode.ReferenceMismatch });

    const wrongPlayerBet = makeTx({ playerId: newId() });
    expect(
      WagerRules.decide({ transaction: wrongPlayerBet, wallet, reference: null, referenceAlreadyReversed: false }),
    ).toEqual({ outcome: "reject", failureCode: FailureCode.PlayerMismatch });

    const wrongCurrencyBet = makeTx({ money: Money.from({ amount: "10.00", currency: "USD" }) });
    expect(
      WagerRules.decide({ transaction: wrongCurrencyBet, wallet, reference: null, referenceAlreadyReversed: false }),
    ).toEqual({ outcome: "reject", failureCode: FailureCode.CurrencyMismatch });

    bet2.reject(FailureCode.InsufficientFunds, wallet.balance, now);
    const refundRejectedBet = makeTx({
      externalTransactionId: "refund-rejected",
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: "80.00", currency: "BRL" }),
      referenceExternalTransactionId: "bet-2",
    });
    expect(
      WagerRules.decide({ transaction: refundRejectedBet, wallet, reference: bet2, referenceAlreadyReversed: false }),
    ).toEqual({ outcome: "reject", failureCode: FailureCode.ReferenceNotProcessed });
  });
});

describe("Domain — Canonical Payload Hash, Inbox, Outbox & Integration Events", () => {
  const now = new Date("2026-11-12T12:00:00.000Z");

  it("computes identical canonical hashes regardless of property insertion order and detects changes", () => {
    expect(canonicalJson({ b: 1, a: [true, null, { d: "x", c: undefined }] })).toBe(
      '{"a":[true,null,{"d":"x"}],"b":1}',
    );

    const base = {
      providerId: "provider-a",
      externalTransactionId: "tx-1",
      playerId: "p-1",
      walletId: "w-1",
      roundId: "r-1",
      gameId: "g-1",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    };
    const hash1 = computePayloadHash(base);
    const hash2 = computePayloadHash({ ...base, referenceExternalTransactionId: undefined });
    const hashDifferentAmount = computePayloadHash({
      ...base,
      money: { amount: "30.00", currency: "BRL" },
    });

    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hashDifferentAmount);
  });

  it("manages InboxMessage, OutboxMessage backoff and IntegrationEvent envelopes", () => {
    expect(() =>
      InboxMessage.receive({ messageId: "", consumerName: "c1", payloadHash: "h", receivedAt: now }),
    ).toThrow(ValidationError);

    const inbox = InboxMessage.receive({
      messageId: "m-1",
      consumerName: "c1",
      payloadHash: "h",
      receivedAt: now,
    });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(now);
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt).toEqual(now);

    const wallet = Wallet.open({ id: newId(), playerId: newId(), currency: "BRL", at: now });
    const entry = wallet.openingCredit(Money.from({ amount: "100.00", currency: "BRL" }), newId(), now);
    const tx = WagerTransaction.create({
      providerId: "provider-a",
      externalTransactionId: "tx-100",
      idempotencyKey: "provider-a:tx-100",
      payloadHash: "h".repeat(64),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: "r-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: "25.00", currency: "BRL" }),
      referenceExternalTransactionId: "bet-100",
      correlationId: "corr-100",
      createdAt: now,
    });

    const ctx = { correlationId: "corr-100", causationId: tx.id, occurredAt: now };
    const evProcessed = WagerTransactionProcessed.from(tx, wallet, ctx);
    const evRejected = WagerTransactionRejected.from(tx, FailureCode.InsufficientFunds, ctx);
    const evPending = WagerTransactionPendingReference.from(tx, ctx);
    const evBalance = WalletBalanceChanged.from(wallet, entry, ctx);

    expect(evProcessed.toJSON().eventType).toBe("WagerTransactionProcessed");
    expect(evRejected.toJSON().data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(evPending.toJSON().data.referenceExternalTransactionId).toBe("bet-100");
    expect(evBalance.toJSON().data.balanceAfter).toEqual({ amount: "100.00", currency: "BRL" });

    const outbox = OutboxMessage.enqueue(evBalance);
    expect(outbox.isPending()).toBe(true);
    expect(outbox.isDue(now)).toBe(true);

    outbox.scheduleRetry(now);
    expect(outbox.attempts).toBe(1);
    expect(outbox.isDue(now)).toBe(false);

    outbox.markPublished(now);
    expect(outbox.isPending()).toBe(false);

    // Application/Infrastructure error classes sanity check
    expect(new NotFoundError("WALLET_NOT_FOUND", "missing").code).toBe("WALLET_NOT_FOUND");
    expect(new ConflictError("IDEMPOTENCY_CONFLICT", "conflict", tx.id).transactionId).toBe(tx.id);
    expect(new TransientError("temp").code).toBe("TRANSIENT_FAILURE");

    const rehydratedInbox = InboxMessage.rehydrate({
      messageId: "m-2",
      consumerName: "c1",
      payloadHash: "h",
      receivedAt: now,
      processedAt: now,
    });
    expect(rehydratedInbox.isProcessed()).toBe(true);
  });

  it("covers config validation, zod validation helper, logger, database error translation and exception filter", () => {
    expect(() => loadConfig({ PORT: "not-a-number" })).toThrow(/Invalid configuration/);
    expect(() => parseWithSchema(z.object({ name: z.string() }), { name: 123 })).toThrow(ValidationError);

    const pinoLogger = new NestPinoLogger();
    pinoLogger.log("info msg", "Test");
    pinoLogger.warn("warn msg", "Test");
    pinoLogger.debug("debug msg", "Test");
    pinoLogger.verbose("verbose msg", "Test");
    pinoLogger.error("err msg", "stack", "Test");
    expect(errorFields("plain-string")).toEqual({ errorMessage: "plain-string" });
    expect(errorFields(new Error("boom"), true).stack).toBeDefined();

    expect(isTransientDatabaseError({ code: "55P03" })).toBe(true);
    expect(isTransientDatabaseError({ sqlState: "40P01" })).toBe(true);
    expect(isTransientDatabaseError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isLockConflict({ code: "55P03" })).toBe(true);
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ code: "23505", message: "wallets_player_currency_uq" }, "wallets_player_currency_uq")).toBe(true);
    expect(translateDatabaseError({ code: "55P03" })).toBeInstanceOf(TransientError);

    const filter = new GlobalHttpExceptionFilter();
    const captured: Array<{ status: number; body: unknown }> = [];
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({
          setHeader: () => undefined,
          status: (code: number) => ({
            json: (body: unknown) => {
              captured.push({ status: code, body });
            },
          }),
        }),
      }),
    } as never;

    filter.catch(new TransientError("db busy"), host);
    filter.catch(new HttpException("bad", HttpStatus.BAD_REQUEST), host);
    filter.catch(new Error("unexpected crash"), host);

    expect(captured.map((c) => c.status)).toEqual([503, 400, 500]);
  });
});
