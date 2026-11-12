import Decimal from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyError } from "../shared/errors";

/** Wire/persistence representation of money. Amount is always a decimal string. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

/** Fixed scale used by every amount in the system. */
export const MONEY_SCALE = 2;

/**
 * Strict input format: digits, a dot and exactly two decimals ("25.00").
 * Rejects negatives, scientific notation, NaN/Infinity, blanks and any other scale.
 * The integer part is limited to 18 digits, matching the NUMERIC(20,2) columns.
 */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Immutable monetary value backed by an arbitrary-precision decimal.
 *
 * - Never uses JavaScript `number`, so there is no floating point drift.
 * - Every operation returns a new instance.
 * - Mixing currencies throws a domain error.
 * - Negative values can exist internally (e.g. a reconciliation difference),
 *   but are never accepted through `from()`, which parses external contracts.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /** Parses a contract value. Throws InvalidMoneyError for anything not strictly "#.##". */
  static from(props: MoneyProps): Money {
    if (typeof props?.amount !== "string" || !AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(
        'Amount must be a non-negative decimal string with exactly 2 decimal places, e.g. "25.00"',
      );
    }
    return new Money(new Decimal(props.amount), Money.assertCurrency(props.currency));
  }

  static zero(currency: string): Money {
    return new Money(new Decimal(0), Money.assertCurrency(currency));
  }

  /**
   * Rebuilds a value read from the database (NUMERIC(20,2) comes back as a
   * string). Accepts negatives and any scale up to 2, but never floats.
   */
  static fromPersistence(amount: string, currency: string): Money {
    if (typeof amount !== "string" || !/^-?\d+(\.\d{1,2})?$/.test(amount)) {
      throw new InvalidMoneyError(`Invalid persisted amount: ${String(amount)}`);
    }
    return new Money(new Decimal(amount), Money.assertCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Amount with the fixed scale, e.g. "25.00" or "-3.50". */
  toString(): string {
    // `+ 0` normalizes "-0.00" to "0.00".
    return this.value.plus(0).toFixed(MONEY_SCALE, Decimal.ROUND_HALF_EVEN);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: string): string {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError("Currency must be an ISO-4217 code with 3 uppercase letters");
    }
    return currency;
  }
}
