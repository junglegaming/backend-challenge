import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InsufficientFundsError, InvalidValueError, UnbalancedLedgerEntryError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-01-01T00:00:00Z');
let seq = 0;
const movement = (amount: string, currency = 'BRL') => ({
  entryId: `e-${++seq}`,
  transactionId: `t-${seq}`,
  money: Money.from({ amount, currency }),
  at: now,
});

const open = (initial = '100.00') =>
  Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(initial), openingTransactionId: 'open-tx', openingEntryId: 'open-entry', now });

describe('Wallet', () => {
  test('opens at version 1; a positive initial balance produces the OPENING credit entry', () => {
    const wallet = open('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.formatAmount()).toBe('100.00');
    const [entry] = wallet.uncommittedEntries;
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(entry?.balanceBefore.formatAmount()).toBe('0.00');
    expect(entry?.balanceAfter.formatAmount()).toBe('100.00');
    expect(entry?.walletVersion).toBe(1);
  });

  test('opening with zero creates no ledger entry', () => {
    const wallet = open('0.00');
    expect(wallet.version).toBe(1);
    expect(wallet.uncommittedEntries).toHaveLength(0);
  });

  test('a positive opening balance requires the OPENING transaction', () => {
    expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00'), now })).toThrow(InvalidValueError);
  });

  test('debit/credit keep balance and ledger consistent and bump version by 1', () => {
    const wallet = open('100.00');
    wallet.pullUncommittedEntries();
    const debit = wallet.debit(movement('30.00'));
    const credit = wallet.credit(movement('5.50'));
    expect(wallet.balance.formatAmount()).toBe('75.50');
    expect(wallet.version).toBe(3);
    expect(debit.balanceBefore.formatAmount()).toBe('100.00');
    expect(debit.balanceAfter.formatAmount()).toBe('70.00');
    expect(credit.balanceBefore.equals(debit.balanceAfter)).toBe(true);
    expect([debit.walletVersion, credit.walletVersion]).toEqual([2, 3]);
    expect(wallet.pullUncommittedEntries()).toHaveLength(2);
    expect(wallet.uncommittedEntries).toHaveLength(0);
  });

  test('balance can never become negative; a failed debit changes nothing', () => {
    const wallet = open('10.00');
    expect(() => wallet.debit(movement('10.01'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.formatAmount()).toBe('10.00');
    expect(wallet.version).toBe(1);
    expect(wallet.uncommittedEntries).toHaveLength(1); // only the opening one
    wallet.debit(movement('10.00'));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('operation currency must match the wallet currency', () => {
    const wallet = open('10.00');
    expect(() => wallet.debit(movement('1.00', 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(movement('1.00', 'USD'))).toThrow(CurrencyMismatchError);
  });

  test('rehydrate keeps persisted version for the conditional update', () => {
    const wallet = Wallet.rehydrate({ id: 'w', playerId: 'p', currency: 'BRL', balance: brl('5.00'), version: 7, createdAt: now, updatedAt: now });
    expect(wallet.isNew()).toBe(false);
    wallet.credit(movement('1.00'));
    expect([wallet.persistedVersion, wallet.version]).toEqual([7, 8]);
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e',
    walletId: 'w',
    transactionId: 't',
    walletVersion: 2,
    createdAt: now,
  };

  test('create verifies the arithmetic', () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: brl('1.00'), balanceBefore: brl('5.00'), balanceAfter: brl('5.00') }),
    ).toThrow(UnbalancedLedgerEntryError);
    const ok = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: brl('1.00'), balanceBefore: brl('5.00'), balanceAfter: brl('4.00') });
    expect(ok.isBalanced()).toBe(true);
  });

  test('is structurally immutable', () => {
    const entry = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('1.00'), balanceBefore: brl('0.00'), balanceAfter: brl('1.00') });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { walletId: string }).walletId = 'other';
    }).toThrow();
  });

  test('rejects zero amounts', () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('0.00'), balanceBefore: brl('1.00'), balanceAfter: brl('1.00') }),
    ).toThrow(InvalidValueError);
  });
});
