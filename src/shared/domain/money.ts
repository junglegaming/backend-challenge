import { CurrencyMismatchError, InvalidMoneyError } from "./domain-error";

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (
      typeof props?.amount !== "string" ||
      !/^(0|[1-9][0-9]{0,15})\.[0-9]{2}$/.test(props.amount) ||
      typeof props.currency !== "string" ||
      !/^[A-Z]{3}$/.test(props.currency)
    ) {
      throw new InvalidMoneyError("Expected a non-negative fixed-scale decimal and currency");
    }
    return new Money(BigInt(props.amount.replace(".", "")), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: "0.00", currency });
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
    this.assertSameCurrency(other);
    return this.minorUnits === other.minorUnits;
  }

  toString(): string {
    const absolute = this.minorUnits < 0n ? -this.minorUnits : this.minorUnits;
    return `${this.isNegative() ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new CurrencyMismatchError("Currencies differ");
  }
}
