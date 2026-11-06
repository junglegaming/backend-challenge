import { describe, expect, test } from 'bun:test';
import { Money } from '../src/domain/money';
import { Wallet } from '../src/domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../src/domain/ledger';
import { Kind, WagerTransaction } from '../src/domain/wager';
import { retryDelaySeconds } from '../src/retry-policy';

describe('Money', () => {
  test('keeps decimal precision and fixed scale', () => {
    const money = Money.from({ amount: '12.30', currency: 'BRL' });
    expect(money.add(Money.from({ amount: '0.70', currency: 'BRL' })).toJSON().amount).toBe(
      '13.00',
    );
    expect(money.toJSON().amount).toBe('12.30');
  });
  test('rejects malformed, negative, scientific and over-scale amounts', () => {
    for (const amount of ['', '-1.00', '1', '1.000', '1e2', 'NaN', 'Infinity'])
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow();
  });
  test('rejects cross-currency arithmetic', () =>
    expect(() =>
      Money.from({ amount: '1.00', currency: 'BRL' }).add(
        Money.from({ amount: '1.00', currency: 'USD' }),
      ),
    ).toThrow());
});

describe('Wallet and ledger', () => {
  test('increments version only when the balance changes', () => {
    const wallet = Wallet.open({
      id: 'w',
      playerId: 'p',
      initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    });
    wallet.debit(Money.from({ amount: '0.00', currency: 'BRL' }));
    expect(wallet.version).toBe(1);
    wallet.debit(Money.from({ amount: '2.00', currency: 'BRL' }));
    expect(wallet.balance.toJSON().amount).toBe('8.00');
    expect(wallet.version).toBe(2);
  });
  test('rejects overdrafts and currency mismatch', () => {
    const wallet = Wallet.open({
      id: 'w',
      playerId: 'p',
      initialBalance: Money.from({ amount: '1.00', currency: 'BRL' }),
    });
    expect(() => wallet.debit(Money.from({ amount: '2.00', currency: 'BRL' }))).toThrow();
    expect(() => wallet.credit(Money.from({ amount: '1.00', currency: 'USD' }))).toThrow();
  });
  test('validates ledger arithmetic', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'l',
        walletId: 'w',
        transactionId: 't',
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: '2.00', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '5.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '4.00', currency: 'BRL' }),
        createdAt: new Date(),
      }),
    ).toThrow();
  });
});

describe('Wager transaction', () => {
  test('cannot accept internal opening from providers', () =>
    expect(() =>
      WagerTransaction.create({
        id: 't',
        providerId: 'p',
        externalTransactionId: 'e',
        idempotencyKey: 'k',
        payloadHash: 'h',
        walletId: 'w',
        playerId: 'p',
        roundId: 'r',
        gameId: 'g',
        kind: Kind.Opening,
        money: Money.from({ amount: '1.00', currency: 'BRL' }),
        referenceExternalTransactionId: undefined,
        createdAt: new Date(),
      }),
    ).toThrow());
});

describe('SQS retry policy', () => {
  test('uses capped exponential backoff unless an explicit test/local override is configured', () => {
    expect([1, 2, 3, 8].map((attempt) => retryDelaySeconds(attempt))).toEqual([1, 2, 4, 128]);
    expect(retryDelaySeconds(12)).toBe(300);
    expect(retryDelaySeconds(8, 1)).toBe(1);
  });
});
