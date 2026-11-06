import Decimal from 'decimal.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}
  private static calculated(value: Decimal, currency: string): Money {
    if (value.abs().greaterThanOrEqualTo('1000000000000000000'))
      throw new DomainError('MONEY_OVERFLOW', 'Amount exceeds the supported precision');
    return new Money(value, currency);
  }
  static from(props: MoneyProps): Money {
    if (
      !props ||
      typeof props.amount !== 'string' ||
      typeof props.currency !== 'string' ||
      !/^(0|[1-9]\d{0,17})\.\d{2}$/.test(props.amount) ||
      !/^[A-Z]{3}$/.test(props.currency)
    )
      throw new DomainError(
        'INVALID_MONEY',
        'amount must fit NUMERIC(20,2), use exactly two decimal places, and currency must be an ISO code',
      );
    return new Money(new Decimal(props.amount), props.currency);
  }
  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }
  private same(other: Money): void {
    if (this.currency !== other.currency)
      throw new DomainError('CURRENCY_MISMATCH', 'Currencies must match');
  }
  add(other: Money): Money {
    this.same(other);
    return Money.calculated(this.value.plus(other.value), this.currency);
  }
  subtract(other: Money): Money {
    this.same(other);
    return Money.calculated(this.value.minus(other.value), this.currency);
  }
  negate(): Money {
    return Money.calculated(this.value.negated(), this.currency);
  }
  isZero(): boolean {
    return this.value.isZero();
  }
  isPositive(): boolean {
    return this.value.isPositive();
  }
  isNegative(): boolean {
    return this.value.isNegative();
  }
  isLessThan(other: Money): boolean {
    this.same(other);
    return this.value.lessThan(other.value);
  }
  equals(other: Money): boolean {
    this.same(other);
    return this.value.equals(other.value);
  }
  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }
  toString(): string {
    return this.value.toFixed(2);
  }
}
