import { CurrencyMismatchError, InvalidMoneyError } from './errors';

export interface MoneyProps {
  amount: string; // decimal string com escala fixa 2, ex.: "25.00"
  currency: string; // ISO-4217
}

// 18 dígitos inteiros + 2 decimais = numeric(20,2) no banco.
const AMOUNT = /^\d{1,18}\.\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

/**
 * Valor monetário imutável. Internamente é um bigint em centavos: com escala fixa de 2 casas
 * a aritmética é exata e não há arredondamento possível. Nunca passa por `number`.
 */
export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {}

  /** Contrato de entrada: rejeita negativo, escala != 2, notação científica, NaN, Infinity, vazio. */
  static from(props: MoneyProps): Money {
    if (typeof props?.amount !== 'string' || !AMOUNT.test(props.amount)) {
      throw new InvalidMoneyError('amount must be a non-negative decimal string with exactly 2 decimal places');
    }
    if (typeof props.currency !== 'string' || !CURRENCY.test(props.currency)) {
      throw new InvalidMoneyError('currency must be an ISO-4217 code');
    }
    return new Money(BigInt(props.amount.replace('.', '')), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    const abs = this.cents < 0n ? -this.cents : this.cents;
    const digits = abs.toString().padStart(3, '0');
    const sign = this.cents < 0n ? '-' : '';
    return { amount: `${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`, currency: this.currency };
  }

  toString(): string {
    return `${this.toJSON().amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`cannot operate ${this.currency} with ${other.currency}`);
    }
  }
}
