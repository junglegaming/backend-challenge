import { describe, expect, test } from "bun:test";
import { LedgerDirection } from "../../src/modules/wallet/domain/ledger-direction";
import { Wallet } from "../../src/modules/wallet/domain/wallet";
import {
  InsufficientFundsError,
  InvalidLedgerEntryError,
  InvalidWalletOperationError,
} from "../../src/modules/wallet/domain/wallet-errors";
import { WalletLedgerEntry } from "../../src/modules/wallet/domain/wallet-ledger-entry";
import { CurrencyMismatchError } from "../../src/shared/domain/domain-error";
import { Money } from "../../src/shared/domain/money";
import { brl, nextId, openWallet, PLAYER, T0 } from "../helpers/domain-fixtures";

const move = (amount: string, currency = "BRL") => ({
  ledgerEntryId: nextId("entry"),
  transactionId: nextId("tx"),
  money: Money.from({ amount, currency }),
  at: T0,
});

describe("Wallet", () => {
  test("open with positive balance yields version 1 and one OPENING credit entry", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: "w1",
      playerId: PLAYER,
      initialBalance: brl("1000.00"),
      at: T0,
      opening: { transactionId: "tx-open", ledgerEntryId: "e1" },
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe("1000.00");
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toString()).toBe("0.00");
    expect(openingEntry?.balanceAfter.toString()).toBe("1000.00");
    expect(openingEntry?.walletVersion).toBe(1);
  });

  test("open with zero balance yields version 1 and no ledger entry", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: "w2",
      playerId: PLAYER,
      initialBalance: brl("0.00"),
      at: T0,
    });
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test("open with positive balance requires an OPENING transaction", () => {
    expect(() => Wallet.open({ id: "w3", playerId: PLAYER, initialBalance: brl("1.00"), at: T0 })).toThrow(
      InvalidWalletOperationError,
    );
  });

  test("debit and credit move balance, bump version and chain ledger entries", () => {
    const wallet = openWallet("100.00");
    const d = wallet.debit(move("30.00"));
    const c = wallet.credit(move("5.50"));
    expect(wallet.balance.toString()).toBe("75.50");
    expect(wallet.version).toBe(3);
    expect(d.balanceAfter.equals(c.balanceBefore)).toBe(true);
    expect([d.walletVersion, c.walletVersion]).toEqual([2, 3]);
  });

  test("debit to exactly zero is allowed", () => {
    const wallet = openWallet("80.00");
    wallet.debit(move("80.00"));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("never goes negative: insufficient funds throws and leaves state untouched", () => {
    const wallet = openWallet("100.00");
    expect(() => wallet.debit(move("100.01"))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("currency of the operation must match the wallet", () => {
    const wallet = openWallet("100.00");
    expect(() => wallet.credit(move("1.00", "USD"))).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test("zero movements are rejected (version only changes when balance changes)", () => {
    const wallet = openWallet("100.00");
    expect(() => wallet.credit(move("0.00"))).toThrow(InvalidWalletOperationError);
    expect(wallet.version).toBe(1);
  });

  test("updatedAt stays monotonic when another instance's clock is behind (clock skew)", () => {
    const wallet = openWallet("100.00"); // created at T0 by "instance A"
    const skewed = new Date(T0.getTime() - 125); // "instance B" clock 125 ms behind
    wallet.debit({ ...move("1.00"), at: skewed });
    expect(wallet.updatedAt.getTime()).toBe(T0.getTime());
    expect(wallet.updatedAt >= wallet.createdAt).toBe(true);
    const later = new Date(T0.getTime() + 1000);
    wallet.debit({ ...move("1.00"), at: later });
    expect(wallet.updatedAt).toEqual(later);
  });

  test("rehydrate restores state without re-validating", () => {
    const wallet = Wallet.rehydrate({
      id: "w",
      playerId: PLAYER,
      currency: "BRL",
      balance: brl("42.00"),
      version: 7,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.toString()).toBe("42.00");
  });
});

describe("WalletLedgerEntry", () => {
  const base = {
    id: "e",
    walletId: "w",
    transactionId: "t",
    walletVersion: 2,
    createdAt: T0,
  };

  test("create validates arithmetic", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl("10.00"),
        balanceBefore: brl("100.00"),
        balanceAfter: brl("95.00"),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("is structurally immutable", () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl("10.00"),
      balanceBefore: brl("0.00"),
      balanceAfter: brl("10.00"),
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { walletVersion: number }).walletVersion = 9;
    }).toThrow();
    expect(entry.isBalanced()).toBe(true);
    expect(entry.signedAmount().toString()).toBe("10.00");
  });
});
