import Decimal from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyError } from "./domain-error";

/** Wire/persistence representation. `amount` is always a decimal string with exactly 2 fraction digits. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

/**
 * Isolated Decimal constructor: 40 significant digits is far above NUMERIC(20,2),
 * so add/subtract of valid amounts are always exact. No operation in Money ever rounds.
 */
const Dec = Decimal.clone({ precision: 40, toExpNeg: -40, toExpPos: 40 });

export const MONEY_SCALE = 2;
/** NUMERIC(20,2) => at most 18 integer digits. */
const MAX_ABS = new Dec("999999999999999999.99");

/** Contract format: non-negative, no leading zeros, no sign, no exponent, exactly 2 decimals. */
const CONTRACT_AMOUNT = /^(0|[1-9]\d{0,17})\.\d{2}$/;
/** Persisted/derived format: same as contract but may be negative (e.g. reconciliation differences). */
const SIGNED_AMOUNT = /^-?(0|[1-9]\d{0,17})\.\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /**
   * Parses an input contract value. Rejects NaN, Infinity, scientific notation, empty strings,
   * more (or fewer) than 2 decimals and negative values.
   */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== "object") throw new InvalidMoneyError("money must be an object");
    const { amount, currency } = props;
    if (typeof amount !== "string") throw new InvalidMoneyError("amount must be a decimal string");
    if (!CONTRACT_AMOUNT.test(amount)) {
      throw new InvalidMoneyError(
        'amount must be a non-negative decimal string with exactly 2 fraction digits, e.g. "25.00"',
      );
    }
    return new Money(new Dec(amount), Money.assertCurrency(currency));
  }

  /** Parses a trusted value that may be negative (persistence aggregates, internal results). Same exactness rules. */
  static fromSigned(props: MoneyProps): Money {
    const { amount, currency } = props;
    if (typeof amount !== "string" || !SIGNED_AMOUNT.test(amount)) {
      throw new InvalidMoneyError(`malformed signed amount "${String(amount)}"`);
    }
    return Money.build(new Dec(amount), Money.assertCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(new Dec(0), Money.assertCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.build(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.build(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.build(this.value.negated(), this.currency);
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

  /** Decimal string with exactly 2 fraction digits (no currency), e.g. "25.00" or "-5.00". */
  toString(): string {
    // Normalise negative zero so "-0.00" never leaks.
    return (this.value.isZero() ? new Dec(0) : this.value).toFixed(MONEY_SCALE);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new CurrencyMismatchError(this.currency, other.currency);
  }

  private static build(value: Decimal, currency: string): Money {
    if (!value.isFinite()) throw new InvalidMoneyError("amount must be finite");
    if (value.decimalPlaces() > MONEY_SCALE)
      throw new InvalidMoneyError("scale above 2 is not representable");
    if (value.abs().greaterThan(MAX_ABS)) throw new InvalidMoneyError("amount exceeds NUMERIC(20,2) range");
    return new Money(value, currency);
  }

  private static assertCurrency(currency: unknown): string {
    if (typeof currency !== "string" || !CURRENCY.test(currency)) {
      throw new InvalidMoneyError("currency must be an ISO-4217 code (3 upper-case letters)");
    }
    return currency;
  }
}
