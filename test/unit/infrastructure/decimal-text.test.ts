import { expect, test } from 'bun:test';
import { decimalText } from '../../../src/infrastructure/persistence/decimal-text';

test('raw NUMERIC reads require exact decimal strings and never round', () => {
  expect(decimalText('999999999999999999.99')).toBe('999999999999999999.99');
  expect(decimalText('0')).toBe('0.00');
  expect(decimalText('-12.3')).toBe('-12.30');
  expect(() => decimalText(1.23)).toThrow();
  expect(() => decimalText('1.234')).toThrow();
  expect(() => decimalText(null)).toThrow();
});
