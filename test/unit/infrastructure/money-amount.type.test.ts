import { describe, expect, test } from 'bun:test';
import type { Platform } from '@mikro-orm/core';
import { Money } from '../../../src/domain/shared/money';
import { MoneyAmountType } from '../../../src/infrastructure/persistence/money-amount.type';

const platform = {} as Platform;
const type = new MoneyAmountType();

describe('MoneyAmountType', () => {
  test('column type is numeric(20,2)', () => {
    expect(type.getColumnType()).toBe('numeric(20,2)');
  });

  test('writes Money or strings with scale 2', () => {
    expect(type.convertToDatabaseValue(Money.from({ amount: '25', currency: 'BRL' }), platform)).toBe('25.00');
    expect(type.convertToDatabaseValue('0.5', platform)).toBe('0.50');
  });

  test('rejects numbers and malformed strings', () => {
    for (const bad of [25, 0.1, '1e3', 'NaN', '', '1.234', null, undefined]) {
      expect(() => type.convertToDatabaseValue(bad as never, platform)).toThrow(TypeError);
    }
  });

  test('reads exact strings back', () => {
    expect(type.convertToJSValue('1000.00', platform)).toBe('1000.00');
    expect(type.convertToJSValue('999999999999999999.99', platform)).toBe('999999999999999999.99');
  });

  test('refuses a JS number coming from the driver', () => {
    expect(() => type.convertToJSValue(25 as never, platform)).toThrow(TypeError);
  });

  test('roundtrip through Money is lossless', () => {
    const m = Money.from({ amount: '12345678901234567.89', currency: 'BRL' });
    const stored = type.convertToDatabaseValue(m, platform);
    const back = Money.from({ amount: type.convertToJSValue(stored, platform), currency: 'BRL' });
    expect(back.equals(m)).toBe(true);
  });
});
