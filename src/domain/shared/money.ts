import { CurrencyMismatchError, InvalidMoneyError } from './domain-error';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const CURRENCY_RE = /^[A-Z]{3}$/;
const UNSIGNED_RE = /^\d+(\.\d{1,2})?$/;
const SIGNED_RE = /^-?\d+(\.\d{1,2})?$/;

/** Immutable money. Stored internally as BigInt minor units (cents); never a JS number. */
export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {}

  /** Contract input: rejects negatives. Accepts "25", "25.5", "25.00"; serialises with scale 2. */
  static from(props: MoneyProps): Money {
    return Money.parse(props, UNSIGNED_RE, 'amount must be a non-negative decimal string with at most 2 decimals');
  }

  /** For rehydration from storage or derived values where a negative amount is legitimate. */
  static fromSigned(props: MoneyProps): Money {
    return Money.parse(props, SIGNED_RE, 'amount must be a decimal string with at most 2 decimals');
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Decimal string with scale 2, e.g. "25.00" or "-3.50". */
  toString(): string {
    const negative = this.minor < 0n;
    const abs = negative ? -this.minor : this.minor;
    const whole = abs / 100n;
    const frac = (abs % 100n).toString().padStart(SCALE, '0');
    return `${negative ? '-' : ''}${whole}.${frac}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !CURRENCY_RE.test(currency)) {
      throw new InvalidMoneyError('currency must be an ISO-4217 code (3 uppercase letters)');
    }
  }

  private static parse(props: MoneyProps, re: RegExp, message: string): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('money must be an object');
    }
    Money.assertCurrency(props.currency);
    if (typeof props.amount !== 'string' || !re.test(props.amount)) {
      throw new InvalidMoneyError(message);
    }
    const negative = props.amount.startsWith('-');
    const [whole = '0', frac = ''] = props.amount.replace('-', '').split('.');
    const minor = BigInt(whole) * 100n + BigInt(frac.padEnd(SCALE, '0'));
    return new Money(negative ? -minor : minor, props.currency);
  }
}
