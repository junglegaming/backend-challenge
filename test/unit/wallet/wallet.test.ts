import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError } from '../../../src/domain/shared/domain-error';
import { Money } from '../../../src/domain/shared/money';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';
import { Wallet } from '../../../src/domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../../src/domain/wallet/wallet-ledger-entry';
import {
  InsufficientFundsError,
  InvalidAmountError,
  InvalidWalletError,
} from '../../../src/domain/wallet/wallet.errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const t0 = new Date('2026-01-01T00:00:00Z');
let seq = 0;
const mv = (amount: string, at = new Date(t0.getTime() + ++seq * 1000)) => ({
  entryId: `e${seq}`,
  transactionId: `t${seq}`,
  money: brl(amount),
  at,
});

const open = (initial: string) => Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(initial), now: t0 });

/** Final invariant of every test: stored balance == balance rebuilt from the ledger. */
function expectLedgerConsistent(wallet: Wallet, ledger: WalletLedgerEntry[]): void {
  const rebuilt = ledger.reduce((acc, e) => acc.add(e.signedAmount()), Money.zero(wallet.currency));
  expect(wallet.balance.toString()).toBe(rebuilt.toString());
  ledger.forEach((e, i) => {
    expect(e.isBalanced()).toBe(true);
    if (i > 0) expect(e.balanceBefore.equals(ledger[i - 1]!.balanceAfter)).toBe(true);
  });
}

function openedWithLedger(initial: string): { wallet: Wallet; ledger: WalletLedgerEntry[] } {
  const wallet = open(initial);
  const opening = wallet.openingEntry({ entryId: 'opening', transactionId: 'opening-tx', at: t0 });
  return { wallet, ledger: opening ? [opening] : [] };
}

describe('Wallet', () => {
  describe('open / rehydrate', () => {
    test('starts at version 1 with the initial balance and currency', () => {
      const { wallet, ledger } = openedWithLedger('1000.00');
      expect(wallet.version).toBe(1);
      expect(wallet.balance.toString()).toBe('1000.00');
      expect(wallet.currency).toBe('BRL');
      expect(wallet.createdAt).toEqual(t0);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.direction).toBe(LedgerDirection.Credit);
      expect(ledger[0]!.balanceBefore.toString()).toBe('0.00');
      expectLedgerConsistent(wallet, ledger);
    });

    test('zero initial balance produces no opening entry', () => {
      const { wallet, ledger } = openedWithLedger('0.00');
      expect(wallet.version).toBe(1);
      expect(ledger).toHaveLength(0);
      expectLedgerConsistent(wallet, ledger);
    });

    test('rejects negative initial balance and missing ids', () => {
      expect(() =>
        Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00').subtract(brl('2.00')) }),
      ).toThrow(InvalidWalletError);
      expect(() => Wallet.open({ id: '', playerId: 'p', initialBalance: brl('1.00') })).toThrow(InvalidWalletError);
      expect(() => Wallet.open({ id: 'w', playerId: '', initialBalance: brl('1.00') })).toThrow(InvalidWalletError);
    });

    test('opening entry is only valid before any movement', () => {
      const wallet = open('10.00');
      wallet.credit(mv('1.00'));
      expect(() => wallet.openingEntry({ entryId: 'x', transactionId: 'y', at: t0 })).toThrow(InvalidWalletError);
    });

    test('rehydrate restores state without validation or version change', () => {
      const wallet = Wallet.rehydrate({
        id: 'w1',
        playerId: 'p1',
        currency: 'BRL',
        balance: brl('50.00'),
        version: 7,
        createdAt: t0,
        updatedAt: t0,
      });
      expect(wallet.version).toBe(7);
      expect(wallet.balance.toString()).toBe('50.00');
    });
  });

  describe('debit', () => {
    test('returns the matching ledger entry and updates balance, version, updatedAt', () => {
      const { wallet, ledger } = openedWithLedger('100.00');
      const m = mv('30.00');
      const entry = wallet.debit(m);
      ledger.push(entry);

      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.walletId).toBe('w1');
      expect(entry.transactionId).toBe(m.transactionId);
      expect(entry.money.toString()).toBe('30.00');
      expect(entry.balanceBefore.toString()).toBe('100.00');
      expect(entry.balanceAfter.toString()).toBe('70.00');
      expect(wallet.balance.toString()).toBe('70.00');
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toEqual(m.at);
      expectLedgerConsistent(wallet, ledger);
    });

    test('allows draining the wallet to exactly zero', () => {
      const { wallet, ledger } = openedWithLedger('80.00');
      ledger.push(wallet.debit(mv('80.00')));
      expect(wallet.balance.isZero()).toBe(true);
      expectLedgerConsistent(wallet, ledger);
    });

    test('insufficient funds (even by one cent) throws and leaves state untouched', () => {
      const { wallet, ledger } = openedWithLedger('100.00');
      const before = { balance: wallet.balance.toString(), version: wallet.version, updatedAt: wallet.updatedAt };

      expect(() => wallet.debit(mv('100.01'))).toThrow(InsufficientFundsError);

      expect(wallet.balance.toString()).toBe(before.balance);
      expect(wallet.version).toBe(before.version);
      expect(wallet.updatedAt).toBe(before.updatedAt);
      expectLedgerConsistent(wallet, ledger);
    });

    test('two bets of 80.00 over 100.00: only the first fits', () => {
      const { wallet, ledger } = openedWithLedger('100.00');
      ledger.push(wallet.debit(mv('80.00')));
      expect(() => wallet.debit(mv('80.00'))).toThrow(InsufficientFundsError);
      expect(wallet.balance.toString()).toBe('20.00');
      expect(ledger.filter((e) => e.direction === LedgerDirection.Debit)).toHaveLength(1);
      expectLedgerConsistent(wallet, ledger);
    });
  });

  describe('credit', () => {
    test('returns a credit entry and increments version', () => {
      const { wallet, ledger } = openedWithLedger('10.00');
      const entry = wallet.credit(mv('0.05'));
      ledger.push(entry);
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.balanceBefore.toString()).toBe('10.00');
      expect(entry.balanceAfter.toString()).toBe('10.05');
      expect(wallet.version).toBe(2);
      expectLedgerConsistent(wallet, ledger);
    });

    test('works from a zero-balance wallet', () => {
      const { wallet, ledger } = openedWithLedger('0.00');
      ledger.push(wallet.credit(mv('25.00')));
      expect(wallet.balance.toString()).toBe('25.00');
      expectLedgerConsistent(wallet, ledger);
    });
  });

  describe('currency and amount validation', () => {
    test('debit and credit in another currency throw and change nothing', () => {
      const { wallet, ledger } = openedWithLedger('100.00');
      const usd = { ...mv('1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) };
      expect(() => wallet.debit(usd)).toThrow(CurrencyMismatchError);
      expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);
      expect(wallet.version).toBe(1);
      expect(wallet.balance.toString()).toBe('100.00');
      expectLedgerConsistent(wallet, ledger);
    });

    test('zero and negative amounts are rejected without bumping version', () => {
      const { wallet, ledger } = openedWithLedger('100.00');
      expect(() => wallet.debit(mv('0.00'))).toThrow(InvalidAmountError);
      expect(() => wallet.credit(mv('0.00'))).toThrow(InvalidAmountError);
      const negative = { ...mv('1.00'), money: brl('1.00').negate() };
      expect(() => wallet.debit(negative)).toThrow(InvalidAmountError);
      expect(() => wallet.credit(negative)).toThrow(InvalidAmountError);
      expect(wallet.version).toBe(1);
      expectLedgerConsistent(wallet, ledger);
    });
  });

  describe('version', () => {
    test('increments by one per successful balance change and never on failures', () => {
      const { wallet, ledger } = openedWithLedger('100.00');
      ledger.push(wallet.debit(mv('10.00')));
      expect(wallet.version).toBe(2);
      expect(() => wallet.debit(mv('1000.00'))).toThrow(InsufficientFundsError);
      expect(wallet.version).toBe(2);
      ledger.push(wallet.credit(mv('5.00')));
      expect(wallet.version).toBe(3);
      expectLedgerConsistent(wallet, ledger);
    });

    test('a rehydrated wallet keeps counting from the stored version', () => {
      const wallet = Wallet.rehydrate({
        id: 'w1',
        playerId: 'p1',
        currency: 'BRL',
        balance: brl('50.00'),
        version: 7,
        createdAt: t0,
        updatedAt: t0,
      });
      const entry = wallet.credit(mv('1.00'));
      expect(wallet.version).toBe(8);
      expect(entry.balanceAfter.toString()).toBe('51.00');
    });
  });

  test('long deterministic sequence stays equal to the ledger and never goes negative', () => {
    const { wallet, ledger } = openedWithLedger('50.00');
    let state = 12345;
    const rand = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
    let applied = 0;
    for (let i = 0; i < 500; i++) {
      const cents = 1 + Math.floor(rand() * 5000);
      const amount = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
      try {
        ledger.push(rand() < 0.5 ? wallet.debit(mv(amount)) : wallet.credit(mv(amount)));
        applied++;
      } catch (e) {
        expect(e).toBeInstanceOf(InsufficientFundsError);
      }
      expect(wallet.balance.isNegative()).toBe(false);
    }
    expect(wallet.version).toBe(1 + applied);
    expectLedgerConsistent(wallet, ledger);
  });
});
