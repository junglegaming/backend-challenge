import { expect, test } from "bun:test";
import { DomainError, InsufficientFundsError } from "../../src/shared/domain/domain-error";
import { Wallet } from "../../src/wagering/domain/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../../src/wagering/domain/wallet-ledger-entry";
import { assertUnitLedgerInvariant, money, now, open, walletId } from "./domain-fixtures";

test("opening is audited at version 1, zero opening emits no entry", () => {
  for (const amount of ["0.00", "100.00"]) {
    const { wallet, entries } = open(amount);
    expect(wallet.version).toBe(1);
    expect(entries).toHaveLength(amount === "0.00" ? 0 : 1);
    if (entries[0]) expect(entries[0].walletVersion).toBe(1);
    assertUnitLedgerInvariant(wallet, entries);
  }
});
test("only balance changes advance the version and every movement returns its entry", () => {
  const { wallet, entries } = open();
  const move = {
    transactionId: crypto.randomUUID(),
    entryId: crypto.randomUUID(),
    money: money("25.00"),
    at: now,
  };
  const debit = wallet.debit(move);
  if (!debit) throw new Error("Missing debit");
  entries.push(debit);
  expect(wallet.version).toBe(2);
  expect(wallet.balance.toString()).toBe("75.00");
  const credit = wallet.credit({
    ...move,
    transactionId: crypto.randomUUID(),
    entryId: crypto.randomUUID(),
  });
  if (!credit) throw new Error("Missing credit");
  entries.push(credit);
  expect(wallet.version).toBe(3);
  expect(wallet.credit({ ...move, money: money("0.00") })).toBeUndefined();
  expect(wallet.debit({ ...move, money: money("0.00") })).toBeUndefined();
  expect(wallet.version).toBe(3);
  expect(() => wallet.debit({ ...move, money: money("100.01") })).toThrow(InsufficientFundsError);
  expect(() => wallet.credit({ ...move, money: money("1.00").negate() })).toThrow(DomainError);
  expect(() => wallet.credit({ ...move, money: money("1.00", "USD") })).toThrow(DomainError);
  expect(wallet.version).toBe(3);
  assertUnitLedgerInvariant(wallet, entries);
});
test("ledger factory enforces arithmetic, currency, direction, positive amount and version", () => {
  const props = {
    id: crypto.randomUUID(),
    walletId,
    transactionId: crypto.randomUUID(),
    direction: LedgerDirection.Debit,
    money: money("10.00"),
    balanceBefore: money("100.00"),
    balanceAfter: money("90.00"),
    walletVersion: 2,
    createdAt: now,
  };
  expect(WalletLedgerEntry.create(props).isBalanced()).toBe(true);
  for (const override of [
    { balanceAfter: money("91.00") },
    { balanceBefore: money("0.00") },
    { money: money("0.00") },
    { balanceAfter: money("90.00", "USD") },
    { walletVersion: 0 },
    { walletVersion: 1.5 },
    { direction: "OTHER" as LedgerDirection },
  ])
    expect(() => WalletLedgerEntry.create({ ...props, ...override })).toThrow(DomainError);
});
test("rehydration reconstructs state without reapplying an opening or incrementing a version", () => {
  const { wallet, entries } = open();
  const date = wallet.createdAt;
  date.setUTCFullYear(2000);
  expect(wallet.createdAt.toISOString()).toBe(now.toISOString());
  const restored = Wallet.rehydrate({
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  });
  expect(restored.version).toBe(1);
  assertUnitLedgerInvariant(restored, entries);
});
