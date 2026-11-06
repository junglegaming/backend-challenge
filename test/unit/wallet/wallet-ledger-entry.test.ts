import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError } from '../../../src/domain/shared/domain-error';
import { Money } from '../../../src/domain/shared/money';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';
import { WalletLedgerEntry } from '../../../src/domain/wallet/wallet-ledger-entry';
import { InvalidLedgerEntryError } from '../../../src/domain/wallet/wallet.errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00Z');

const props = (over: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {}) => ({
  id: 'e1',
  walletId: 'w1',
  transactionId: 't1',
  direction: LedgerDirection.Debit,
  money: brl('30.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('70.00'),
  createdAt: at,
  ...over,
});

describe('WalletLedgerEntry', () => {
  test('creates a balanced debit and credit', () => {
    const debit = WalletLedgerEntry.create(props());
    expect(debit.isBalanced()).toBe(true);
    expect(debit.signedAmount().toString()).toBe('-30.00');

    const credit = WalletLedgerEntry.create(
      props({ direction: LedgerDirection.Credit, balanceBefore: brl('70.00'), balanceAfter: brl('100.00') }),
    );
    expect(credit.isBalanced()).toBe(true);
    expect(credit.signedAmount().toString()).toBe('30.00');
  });

  test.each([
    ['debit that does not subtract', { balanceAfter: brl('100.00') }],
    ['debit that adds', { balanceAfter: brl('130.00') }],
    ['off by one cent', { balanceAfter: brl('70.01') }],
    ['credit with debit arithmetic', { direction: LedgerDirection.Credit }],
  ])('rejects inconsistent arithmetic: %s', (_name, over) => {
    expect(() => WalletLedgerEntry.create(props(over))).toThrow(InvalidLedgerEntryError);
  });

  test('rejects zero amount, negative balances, mixed currencies, bad ids and direction', () => {
    expect(() =>
      WalletLedgerEntry.create(props({ money: brl('0.00'), balanceAfter: brl('100.00') })),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create(props({ money: brl('150.00'), balanceAfter: brl('100.00').subtract(brl('150.00')) })),
    ).toThrow(InvalidLedgerEntryError);
    const usd = Money.from({ amount: '70.00', currency: 'USD' });
    expect(() => WalletLedgerEntry.create(props({ balanceAfter: usd }))).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create(props({ id: '' }))).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create(props({ walletId: '' }))).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create(props({ transactionId: '' }))).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create(props({ direction: 'SIDEWAYS' as LedgerDirection }))).toThrow(
      InvalidLedgerEntryError,
    );
  });

  test('is structurally immutable (frozen, no mutators)', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { id: string }).id = 'other';
    }).toThrow();
    expect(entry.id).toBe('e1');
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(entry)).filter((n) => n !== 'constructor');
    expect(methods.sort()).toEqual(['isBalanced', 'signedAmount']);
  });

  test('rehydrate does not re-validate persisted state', () => {
    const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl('1.00') }));
    expect(entry.isBalanced()).toBe(false);
  });

  test('createdAt is defensively copied', () => {
    const d = new Date(at);
    const entry = WalletLedgerEntry.create(props({ createdAt: d }));
    d.setFullYear(1999);
    expect(entry.createdAt.getTime()).toBe(at.getTime());
  });

  test('currency mismatch between entries does not leak through Money ops', () => {
    expect(() => brl('1.00').add(Money.from({ amount: '1.00', currency: 'USD' }))).toThrow(CurrencyMismatchError);
  });
});
