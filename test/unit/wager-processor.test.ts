import { describe, expect, test } from "bun:test";
import { FailureCode as F } from "../../src/modules/wagering/domain/failure-code";
import { type ReferenceLookup, WagerProcessor } from "../../src/modules/wagering/domain/wager-processor";
import type { WagerTransaction } from "../../src/modules/wagering/domain/wager-transaction";
import {
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from "../../src/modules/wagering/domain/wager-transaction-kind";
import { LedgerDirection } from "../../src/modules/wallet/domain/ledger-direction";
import type { Wallet } from "../../src/modules/wallet/domain/wallet";
import { brl, nextId, openWallet, T0, wager } from "../helpers/domain-fixtures";

const processor = new WagerProcessor();
const LATER = new Date(T0.getTime() + 2_000);

function run(
  wallet: Wallet,
  tx: WagerTransaction,
  reference?: WagerTransaction | "missing",
  opts: { alreadyReversed?: boolean; exhausted?: boolean } = {},
) {
  let lookup: ReferenceLookup | undefined;
  if (reference === "missing") lookup = { found: false };
  else if (reference)
    lookup = { found: true, transaction: reference, alreadyReversed: opts.alreadyReversed ?? false };
  return processor.process({
    wallet,
    transaction: tx,
    reference: lookup,
    ledgerEntryId: nextId("entry"),
    at: T0,
    nextReferenceRetryAt: LATER,
    referenceRetryExhausted: opts.exhausted ?? false,
  });
}

function processedBet(wallet: Wallet, amount = "10.00", overrides = {}) {
  const bet = wager(wallet, K.Bet, amount, overrides);
  expect(run(wallet, bet).type).toBe("PROCESSED");
  return bet;
}

describe("WagerProcessor — section 7 rules", () => {
  describe("BET", () => {
    test("debits and produces one DEBIT entry", () => {
      const wallet = openWallet("100.00");
      const bet = wager(wallet, K.Bet, "25.00");
      const out = run(wallet, bet);
      expect(out.type).toBe("PROCESSED");
      if (out.type !== "PROCESSED") return;
      expect(out.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
      expect(wallet.balance.toString()).toBe("75.00");
      expect(bet.status).toBe(S.Processed);
      expect(bet.resultBalance?.toString()).toBe("75.00");
    });

    test("insufficient funds → REJECTED(INSUFFICIENT_FUNDS), no entry, balance untouched", () => {
      const wallet = openWallet("10.00");
      const bet = wager(wallet, K.Bet, "10.01");
      expect(run(wallet, bet)).toEqual({ type: "REJECTED", failureCode: F.InsufficientFunds });
      expect(wallet.balance.toString()).toBe("10.00");
      expect(wallet.version).toBe(1);
      expect(bet.resultBalance?.toString()).toBe("10.00");
    });

    test("mandatory scenario (sequentialised): 100.00 and two 80.00 bets", () => {
      const wallet = openWallet("100.00");
      const a = wager(wallet, K.Bet, "80.00");
      const b = wager(wallet, K.Bet, "80.00");
      const results = [run(wallet, a).type, run(wallet, b).type];
      expect(results).toEqual(["PROCESSED", "REJECTED"]);
      expect(wallet.balance.toString()).toBe("20.00");
      expect(b.failureCode).toBe(F.InsufficientFunds);
    });
  });

  describe("WIN", () => {
    test("credits without reference", () => {
      const wallet = openWallet("0.00");
      expect(run(wallet, wager(wallet, K.Win, "50.00")).type).toBe("PROCESSED");
      expect(wallet.balance.toString()).toBe("50.00");
    });

    test("with a BET reference in the same round, links it", () => {
      const wallet = openWallet("100.00");
      const bet = processedBet(wallet);
      const win = wager(wallet, K.Win, "30.00", {
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      expect(run(wallet, win, bet).type).toBe("PROCESSED");
      expect(win.referenceTransactionId).toBe(bet.id);
      expect(wallet.balance.toString()).toBe("120.00");
    });

    test("referencing a bet of another round is rejected", () => {
      const wallet = openWallet("100.00");
      const bet = processedBet(wallet, "10.00", { roundId: "round-A" });
      const win = wager(wallet, K.Win, "30.00", {
        roundId: "round-B",
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      expect(run(wallet, win, bet)).toEqual({ type: "REJECTED", failureCode: F.ReferenceMismatch });
    });
  });

  describe("LOSS", () => {
    test("is PROCESSED without moving balance or creating entries", () => {
      const wallet = openWallet("100.00");
      const bet = processedBet(wallet);
      const versionBefore = wallet.version;
      const loss = wager(wallet, K.Loss, "0.00", {
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      expect(run(wallet, loss, bet)).toEqual({ type: "PROCESSED", ledgerEntry: undefined });
      expect(wallet.version).toBe(versionBefore);
      expect(wallet.balance.toString()).toBe("90.00");
    });
  });

  describe("REFUND", () => {
    test("credits back a PROCESSED BET", () => {
      const wallet = openWallet("100.00");
      const bet = processedBet(wallet, "40.00");
      const refund = wager(wallet, K.Refund, "40.00", {
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      const out = run(wallet, refund, bet);
      expect(out.type).toBe("PROCESSED");
      expect(wallet.balance.toString()).toBe("100.00");
    });

    test("only references BET", () => {
      const wallet = openWallet("100.00");
      const win = wager(wallet, K.Win, "5.00");
      run(wallet, win);
      const refund = wager(wallet, K.Refund, "5.00", {
        referenceExternalTransactionId: win.externalTransactionId,
      });
      expect(run(wallet, refund, win)).toEqual({ type: "REJECTED", failureCode: F.ReferenceKindNotAllowed });
    });

    test("amount must equal the reference (no partial reversal)", () => {
      const wallet = openWallet("100.00");
      const bet = processedBet(wallet, "40.00");
      const refund = wager(wallet, K.Refund, "39.99", {
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      expect(run(wallet, refund, bet)).toEqual({ type: "REJECTED", failureCode: F.ReferenceAmountMismatch });
    });

    test("cannot reverse twice", () => {
      const wallet = openWallet("100.00");
      const bet = processedBet(wallet);
      const refund = wager(wallet, K.Refund, "10.00", {
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      expect(run(wallet, refund, bet, { alreadyReversed: true })).toEqual({
        type: "REJECTED",
        failureCode: F.ReferenceAlreadyReversed,
      });
    });

    test("reference must be PROCESSED", () => {
      const wallet = openWallet("5.00");
      const bet = wager(wallet, K.Bet, "10.00");
      run(wallet, bet); // rejected: insufficient funds
      const refund = wager(wallet, K.Refund, "10.00", {
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      expect(run(wallet, refund, bet)).toEqual({ type: "REJECTED", failureCode: F.ReferenceNotProcessed });
      expect(wallet.balance.toString()).toBe("5.00");
    });

    test.each([
      ["player", { playerId: "other-player" }],
      ["provider", { providerId: "provider-b" }],
      ["round", { roundId: "round-x" }],
    ])("reference from another %s is rejected", (_label, override) => {
      const wallet = openWallet("100.00");
      const bet = processedBet(wallet);
      const refund = wager(wallet, K.Refund, "10.00", {
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      // Simulate a reference that resolved to a transaction with a different scope.
      const foreign = Object.assign(
        Object.create(Object.getPrototypeOf(bet)),
        bet,
        override,
      ) as WagerTransaction;
      expect(run(wallet, refund, foreign)).toEqual({ type: "REJECTED", failureCode: F.ReferenceMismatch });
    });
  });

  describe("ROLLBACK", () => {
    test("of a BET credits it back", () => {
      const wallet = openWallet("100.00");
      const bet = processedBet(wallet, "30.00");
      const rb = wager(wallet, K.Rollback, "30.00", {
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      const out = run(wallet, rb, bet);
      expect(out.type === "PROCESSED" && out.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
      expect(wallet.balance.toString()).toBe("100.00");
    });

    test("of a WIN debits it back", () => {
      const wallet = openWallet("0.00");
      const win = wager(wallet, K.Win, "50.00");
      run(wallet, win);
      const rb = wager(wallet, K.Rollback, "50.00", {
        referenceExternalTransactionId: win.externalTransactionId,
      });
      const out = run(wallet, rb, win);
      expect(out.type === "PROCESSED" && out.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
      expect(wallet.balance.toString()).toBe("0.00");
    });

    test("of a REFUND debits it back", () => {
      const wallet = openWallet("100.00");
      const bet = processedBet(wallet, "20.00");
      const refund = wager(wallet, K.Refund, "20.00", {
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      run(wallet, refund, bet);
      const rb = wager(wallet, K.Rollback, "20.00", {
        referenceExternalTransactionId: refund.externalTransactionId,
      });
      expect(run(wallet, rb, refund).type).toBe("PROCESSED");
      expect(wallet.balance.toString()).toBe("80.00");
    });

    test("that would make the balance negative → REVERSAL_INSUFFICIENT_FUNDS (distinct from BET)", () => {
      const wallet = openWallet("0.00");
      const win = wager(wallet, K.Win, "50.00");
      run(wallet, win);
      run(wallet, wager(wallet, K.Bet, "45.00"));
      const rb = wager(wallet, K.Rollback, "50.00", {
        referenceExternalTransactionId: win.externalTransactionId,
      });
      expect(run(wallet, rb, win)).toEqual({ type: "REJECTED", failureCode: F.ReversalInsufficientFunds });
      expect(wallet.balance.toString()).toBe("5.00");
      expect(rb.status).toBe(S.Rejected);
    });

    test("cannot reference a ROLLBACK", () => {
      const wallet = openWallet("100.00");
      const bet = processedBet(wallet);
      const rb1 = wager(wallet, K.Rollback, "10.00", {
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      run(wallet, rb1, bet);
      const rb2 = wager(wallet, K.Rollback, "10.00", {
        referenceExternalTransactionId: rb1.externalTransactionId,
      });
      expect(run(wallet, rb2, rb1)).toEqual({ type: "REJECTED", failureCode: F.ReferenceKindNotAllowed });
    });
  });

  describe("out-of-order references", () => {
    test("missing reference parks the transaction as PENDING_REFERENCE without touching balance", () => {
      const wallet = openWallet("100.00");
      const refund = wager(wallet, K.Refund, "10.00", { referenceExternalTransactionId: "not-yet" });
      expect(run(wallet, refund, "missing")).toEqual({ type: "PENDING_REFERENCE", firstTime: true });
      expect(refund.status).toBe(S.PendingReference);
      expect(refund.nextReferenceRetryAt).toEqual(LATER);
      expect(wallet.version).toBe(1);
    });

    test("still missing on retry reschedules; exhausted budget rejects with REFERENCE_NOT_FOUND", () => {
      const wallet = openWallet("100.00");
      const rb = wager(wallet, K.Rollback, "10.00", { referenceExternalTransactionId: "never" });
      run(wallet, rb, "missing");
      expect(run(wallet, rb, "missing")).toEqual({ type: "PENDING_REFERENCE", firstTime: false });
      expect(rb.referenceAttempts).toBe(1);
      expect(run(wallet, rb, "missing", { exhausted: true })).toEqual({
        type: "REJECTED",
        failureCode: F.ReferenceNotFound,
      });
    });

    test("reference arriving later resolves the pending transaction", () => {
      const wallet = openWallet("100.00");
      const refund = wager(wallet, K.Refund, "10.00", { referenceExternalTransactionId: "bet-late" });
      run(wallet, refund, "missing");
      const bet = processedBet(wallet, "10.00", { externalTransactionId: "bet-late" });
      expect(run(wallet, refund, bet).type).toBe("PROCESSED");
      expect(wallet.balance.toString()).toBe("100.00");
    });

    test("a reference that is itself PENDING_REFERENCE is not usable yet", () => {
      const wallet = openWallet("100.00");
      const refund = wager(wallet, K.Refund, "10.00", { referenceExternalTransactionId: "bet-x" });
      run(wallet, refund, "missing");
      const rb = wager(wallet, K.Rollback, "10.00", {
        referenceExternalTransactionId: refund.externalTransactionId,
      });
      expect(run(wallet, rb, refund).type).toBe("PENDING_REFERENCE");
    });
  });

  describe("wallet consistency", () => {
    test("currency conflict → REJECTED(CURRENCY_MISMATCH)", () => {
      const wallet = openWallet("100.00");
      const bet = wager(wallet, K.Bet, "10.00", { currency: "USD" });
      expect(run(wallet, bet)).toEqual({ type: "REJECTED", failureCode: F.CurrencyMismatch });
      expect(wallet.balance.equals(brl("100.00"))).toBe(true);
    });

    test("wallet of another player → REJECTED(WALLET_PLAYER_MISMATCH)", () => {
      const wallet = openWallet("100.00");
      const bet = wager(wallet, K.Bet, "10.00", { playerId: "someone-else" });
      expect(run(wallet, bet)).toEqual({ type: "REJECTED", failureCode: F.WalletPlayerMismatch });
    });
  });
});
