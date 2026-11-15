import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidValueError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('normalises to a fixed scale of 2', () => {
    expect(brl('25').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(brl('25.5').toJSON()).toEqual({ amount: '25.50', currency: 'BRL' });
    expect(brl('0.01').toString()).toBe('0.01 BRL');
    expect(brl('999999999999999999.99').formatAmount()).toBe('999999999999999999.99');
  });

  test('never rounds: more than 2 decimals is rejected instead', () => {
    expect(() => brl('10.005')).toThrow(InvalidValueError);
    expect(() => brl('0.001')).toThrow(InvalidValueError);
  });

  test.each([
    ['', 'empty'],
    [' 1.00', 'whitespace'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['1e3', 'scientific notation'],
    ['1E-2', 'scientific notation'],
    ['-1.00', 'negative'],
    ['+1.00', 'explicit sign'],
    ['01.00', 'leading zero'],
    ['1.', 'dangling separator'],
    ['.5', 'missing integer part'],
    ['1,00', 'comma separator'],
    ['0x10', 'hex'],
    ['1000000000000000000.00', 'over numeric(20,2)'],
  ])('rejects %p (%s)', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidValueError);
  });

  test('rejects non-string amounts and invalid currencies', () => {
    expect(() => Money.from({ amount: 10 as unknown as string, currency: 'BRL' })).toThrow(InvalidValueError);
    expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(InvalidValueError);
    expect(() => Money.from({ amount: '1.00', currency: 'REAL' })).toThrow(InvalidValueError);
  });

  test('exact arithmetic (no binary floating point)', () => {
    expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
    expect(brl('100.00').subtract(brl('80.00')).formatAmount()).toBe('20.00');
    expect(brl('1.00').subtract(brl('1.01')).formatAmount()).toBe('-0.01');
    expect(brl('5.00').negate().formatAmount()).toBe('-5.00');
  });

  test('is immutable', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.formatAmount()).toBe('10.00');
    expect(b.formatAmount()).toBe('15.00');
  });

  test('predicates and comparison', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.00').subtract(brl('0.01')).isNegative()).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.01'))).toBe(false);
    expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
  });

  test('operations across currencies raise a domain error', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test('rehydrates signed persisted values', () => {
    expect(Money.fromPersisted('-12.30', 'BRL').formatAmount()).toBe('-12.30');
    expect(Money.fromPersisted('7', 'BRL ').toJSON()).toEqual({ amount: '7.00', currency: 'BRL' });
  });
});
