import { CurrencyMismatchError, InvalidValueError } from './errors';

/** Wire / persistence representation. */
export interface MoneyProps {
  amount: string; // decimal string with exactly 2 decimals, e.g. "25.00"
  currency: string; // ISO-4217 alpha-3
}

const SCALE = 2;
const FACTOR = 10n ** BigInt(SCALE);
/** numeric(20,2) => at most 18 integer digits. */
const MAX_INTEGER_DIGITS = 18;
/**
 * Strict decimal grammar: no sign, no exponent, no leading zeros, no
 * whitespace, at most 2 fraction digits. "25", "25.5" and "25.50" are valid
 * and normalised to "25.00" / "25.50".
 */
const AMOUNT_PATTERN = new RegExp(`^(0|[1-9]\\d{0,${MAX_INTEGER_DIGITS - 1}})(?:\\.(\\d{1,${SCALE}}))?$`);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Immutable monetary value. Internally stored as an exact integer amount of
 * minor units (bigint), so there is no binary floating point anywhere and no
 * implicit rounding: inputs with more than 2 decimals are rejected instead.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {}

  /** Parses an input contract. Rejects negatives, NaN, Infinity, exponents and > 2 decimals. */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidValueError('Money must be an object');
    }
    const currency = Money.parseCurrency(props.currency);
    if (typeof props.amount !== 'string') {
      throw new InvalidValueError('Money amount must be a decimal string');
    }
    const match = AMOUNT_PATTERN.exec(props.amount);
    if (!match) {
      throw new InvalidValueError(`Invalid money amount "${props.amount}"`);
    }
    const integer = BigInt(match[1]!);
    const fraction = BigInt((match[2] ?? '').padEnd(SCALE, '0'));
    return new Money(integer * FACTOR + fraction, currency);
  }

  /** Rehydrates a persisted value, which may be signed (e.g. a reconciliation difference). */
  static fromPersisted(amount: string, currency: string): Money {
    const negative = amount.startsWith('-');
    const money = Money.from({ amount: negative ? amount.slice(1) : amount, currency: currency.trim() });
    return negative ? money.negate() : money;
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  hasCurrency(currency: string): boolean {
    return this.currency === currency;
  }

  toJSON(): MoneyProps {
    return { amount: this.formatAmount(), currency: this.currency };
  }

  toString(): string {
    return `${this.formatAmount()} ${this.currency}`;
  }

  /** Exact decimal string with fixed scale 2 (may be signed). */
  formatAmount(): string {
    const negative = this.minorUnits < 0n;
    const abs = negative ? -this.minorUnits : this.minorUnits;
    const integer = abs / FACTOR;
    const fraction = (abs % FACTOR).toString().padStart(SCALE, '0');
    return `${negative ? '-' : ''}${integer}.${fraction}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidValueError(`Invalid ISO-4217 currency "${String(currency)}"`);
    }
    return currency;
  }
}
