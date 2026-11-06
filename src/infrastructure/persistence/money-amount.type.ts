import { Type, type Platform } from '@mikro-orm/core';
import { Money } from '../../domain/shared/money';

const AMOUNT_RE = /^-?\d+(\.\d{1,2})?$/;

/**
 * Persists the amount of a Money as NUMERIC(20,2), always exchanged as an exact decimal string.
 * The currency lives in a sibling CHAR(3) column; mappers combine both into `Money`.
 * A JS `number` is never accepted, so float drift cannot reach the database.
 */
export class MoneyAmountType extends Type<string, string> {
  override convertToDatabaseValue(value: string | Money, _platform: Platform): string {
    const amount = value instanceof Money ? value.toString() : value;
    if (typeof amount !== 'string' || !AMOUNT_RE.test(amount)) {
      throw new TypeError('Money amount must be a decimal string with at most 2 decimals');
    }
    return Money.fromSigned({ amount, currency: 'XXX' }).toString();
  }

  override convertToJSValue(value: string | null, _platform: Platform): string {
    if (typeof value !== 'string') {
      throw new TypeError('NUMERIC must be read as string; configure the driver to avoid number parsing');
    }
    return Money.fromSigned({ amount: value, currency: 'XXX' }).toString();
  }

  override getColumnType(): string {
    return 'numeric(20,2)';
  }

  override compareAsType(): string {
    return 'string';
  }
}
