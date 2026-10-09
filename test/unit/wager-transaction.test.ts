import { describe, expect, test } from "bun:test";
import { FailureCode } from "../../src/modules/wagering/domain/failure-code";
import { computeWagerPayloadHash } from "../../src/modules/wagering/domain/payload-hash";
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from "../../src/modules/wagering/domain/wager-errors";
import {
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from "../../src/modules/wagering/domain/wager-transaction-kind";
import { LedgerDirection } from "../../src/modules/wallet/domain/ledger-direction";
import { brl, openWallet, T0, wager } from "../helpers/domain-fixtures";

describe("WagerTransaction", () => {
  const wallet = openWallet("100.00");

  test("is born PENDING", () => {
    expect(wager(wallet, K.Bet, "10.00").status).toBe(S.Pending);
  });

  test.each([K.Refund, K.Rollback])("%s requires referenceExternalTransactionId", (kind) => {
    expect(() => wager(wallet, kind, "10.00")).toThrow(InvalidWagerTransactionError);
  });

  test("BET cannot reference another transaction", () => {
    expect(() => wager(wallet, K.Bet, "10.00", { referenceExternalTransactionId: "x" })).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test("cannot reference itself", () => {
    expect(() =>
      wager(wallet, K.Refund, "10.00", {
        externalTransactionId: "same",
        referenceExternalTransactionId: "same",
      }),
    ).toThrow(InvalidWagerTransactionError);
  });

  test("zero amount only allowed for LOSS", () => {
    expect(() => wager(wallet, K.Bet, "0.00")).toThrow(InvalidWagerTransactionError);
    expect(wager(wallet, K.Loss, "0.00").status).toBe(S.Pending);
  });

  describe("state machine", () => {
    test("terminal states cannot transition", () => {
      const tx = wager(wallet, K.Bet, "10.00");
      tx.markProcessed(undefined, T0, brl("90.00"));
      expect(tx.isTerminal()).toBe(true);
      expect(() => tx.reject(FailureCode.InsufficientFunds, T0, brl("90.00"))).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => tx.markProcessed(undefined, T0, brl("90.00"))).toThrow(InvalidTransactionStateError);
      expect(() => tx.fail(FailureCode.InfraPermanentFailure, T0)).toThrow(InvalidTransactionStateError);
    });

    test("REJECTED and FAILED are terminal", () => {
      const r = wager(wallet, K.Bet, "10.00");
      r.reject(FailureCode.InsufficientFunds, T0, brl("100.00"));
      expect(() => r.markProcessed(undefined, T0, brl("1.00"))).toThrow(InvalidTransactionStateError);
      const f = wager(wallet, K.Bet, "10.00");
      f.fail(FailureCode.InfraPermanentFailure, T0);
      expect(() => f.markPendingReference(T0, brl("1.00"))).toThrow(InvalidTransactionStateError);
    });

    test("PENDING_REFERENCE can be retried, then resolved", () => {
      const tx = wager(wallet, K.Refund, "10.00", { referenceExternalTransactionId: "bet-1" });
      tx.markPendingReference(new Date(T0.getTime() + 1000), brl("100.00"));
      tx.scheduleReferenceRetry(new Date(T0.getTime() + 3000));
      expect(tx.referenceAttempts).toBe(1);
      expect(() => tx.markPendingReference(T0, brl("100.00"))).toThrow(InvalidTransactionStateError);
      tx.markProcessed("ref-id", T0, brl("110.00"));
      expect(tx.status).toBe(S.Processed);
      expect(tx.nextReferenceRetryAt).toBeUndefined();
    });

    test("retry scheduling outside PENDING_REFERENCE is a programming error", () => {
      expect(() => wager(wallet, K.Bet, "1.00").scheduleReferenceRetry(T0)).toThrow(
        InvalidTransactionStateError,
      );
    });
  });

  test("domain queries", () => {
    expect(wager(wallet, K.Loss, "0.00").affectsBalance()).toBe(false);
    expect(wager(wallet, K.Bet, "1.00").affectsBalance()).toBe(true);
    expect(wager(wallet, K.Refund, "1.00", { referenceExternalTransactionId: "b" }).requiresReference()).toBe(
      true,
    );
    expect(wager(wallet, K.Win, "1.00").requiresReference()).toBe(false);
  });

  test("ledger directions", () => {
    const bet = wager(wallet, K.Bet, "10.00");
    const win = wager(wallet, K.Win, "10.00");
    const refund = wager(wallet, K.Refund, "10.00", {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const rollback = wager(wallet, K.Rollback, "10.00", { referenceExternalTransactionId: "x" });
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
    expect(() => wager(wallet, K.Loss, "0.00").ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });
});

describe("payload hash / idempotency", () => {
  const fields = {
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    playerId: "p",
    walletId: "w",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
  };

  test("is deterministic and independent of key order", () => {
    const shuffled = {
      money: { currency: "BRL", amount: "25.00" },
      kind: "BET",
      gameId: "fortune-chimp",
      roundId: "round-987",
      walletId: "w",
      playerId: "p",
      externalTransactionId: "transaction-123",
      providerId: "provider-a",
    };
    expect(computeWagerPayloadHash(fields)).toBe(computeWagerPayloadHash(shuffled));
    expect(computeWagerPayloadHash(fields)).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  test("absent and undefined reference hash identically", () => {
    expect(computeWagerPayloadHash(fields)).toBe(
      computeWagerPayloadHash({ ...fields, referenceExternalTransactionId: undefined }),
    );
  });

  test.each([
    ["amount", { money: { amount: "25.01", currency: "BRL" } }],
    ["currency", { money: { amount: "25.00", currency: "USD" } }],
    ["kind", { kind: "WIN" }],
    ["round", { roundId: "round-988" }],
    ["wallet", { walletId: "w2" }],
    ["reference", { referenceExternalTransactionId: "t-1" }],
  ])(
    "same idempotency key with divergent %s yields a different hash (conflict, not replay)",
    (_f, change) => {
      const wallet = openWallet("100.00");
      const original = wager(wallet, K.Bet, "25.00");
      const divergent = computeWagerPayloadHash({ ...fields, ...change });
      expect(computeWagerPayloadHash(fields)).not.toBe(divergent);
      expect(original.matchesPayload(original.payloadHash)).toBe(true);
      expect(original.matchesPayload(divergent)).toBe(false);
    },
  );
});
