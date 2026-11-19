import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InsufficientFundsError, UnbalancedLedgerEntryError } from '../../src/domain/errors';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00Z');
const open = (initial: string) =>
  Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(initial), openingTransactionId: 'opening', at });

describe('Wallet', () => {
  test('opens at version 1 with an opening CREDIT entry when the initial balance is positive', () => {
    const { wallet, openingEntry } = open('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.isZero()).toBe(true);
    expect(openingEntry?.balanceAfter.equals(wallet.balance)).toBe(true);
  });

  test('opens without a ledger entry when the initial balance is zero', () => {
    const { wallet, openingEntry } = open('0.00');
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test('every balance change returns its ledger entry and increments version', () => {
    const { wallet } = open('100.00');
    const debit = wallet.debit(brl('30.00'), 't1', at);
    expect(wallet.balance.toJSON().amount).toBe('70.00');
    expect(wallet.version).toBe(2);
    expect(debit.balanceBefore.toJSON().amount).toBe('100.00');
    expect(debit.balanceAfter.toJSON().amount).toBe('70.00');
    const credit = wallet.credit(brl('5.50'), 't2', at);
    expect(wallet.balance.toJSON().amount).toBe('75.50');
    expect(wallet.version).toBe(3);
    expect(credit.isBalanced()).toBe(true);
  });

  test('never goes negative: an overdraft throws and leaves state untouched', () => {
    const { wallet } = open('10.00');
    expect(() => wallet.debit(brl('10.01'), 't1', at)).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe('10.00');
    expect(wallet.version).toBe(1);
    wallet.debit(brl('10.00'), 't2', at);
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('rejects operations in another currency', () => {
    const { wallet } = open('10.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => wallet.debit(usd, 't1', at)).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd, 't1', at)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });
});

describe('WalletLedgerEntry', () => {
  const base = { id: 'e1', walletId: 'w1', transactionId: 't1', createdAt: at };

  test('create validates the arithmetic', () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: brl('10.00'), balanceBefore: brl('50.00'), balanceAfter: brl('45.00') }),
    ).toThrow(UnbalancedLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('0.00'), balanceBefore: brl('50.00'), balanceAfter: brl('50.00') }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test('is structurally immutable', () => {
    const entry = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('1.00'), balanceBefore: brl('0.00'), balanceAfter: brl('1.00') });
    const mutators = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter((m) => /^(mark|set|update|apply)/.test(m));
    expect(mutators).toEqual([]);
    expect(entry.isBalanced()).toBe(true);
  });
});
