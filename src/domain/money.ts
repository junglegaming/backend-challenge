import Decimal from 'decimal.js';
import { DomainError } from './errors';

export interface MoneyProps {
  amount: string; // sempre string decimal, ex.: "25.00" — nunca number
  currency: string; // ISO-4217, ex.: "BRL"
}

// Não negativo, até 2 casas, até 18 dígitos inteiros (cabe em NUMERIC(20,2)).
// Rejeita: '', '-1', '1e3', 'NaN', 'Infinity', '01', '.5', '1.005'.
const AMOUNT = /^(0|[1-9]\d{0,17})(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;
// Precisão folgada: somas de valores com 2 casas nunca são arredondadas.
const Dec = Decimal.clone({ precision: 40 });

/** Valor monetário imutável: toda operação devolve um novo Money. */
export class Money {
  private constructor(
    private readonly value: Decimal,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from({ amount, currency }: MoneyProps): Money {
    if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
      throw new DomainError('INVALID_MONEY', `currency inválida "${currency}"`);
    }
    if (typeof amount !== 'string' || !AMOUNT.test(amount)) {
      throw new DomainError('INVALID_MONEY', `amount inválido "${amount}": use string com até 2 casas, sem sinal`);
    }
    return new Money(new Dec(amount), currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0', currency });
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

  /** Sempre com 2 casas: "25.00" (ou "-25.00" em contas internas). */
  get amount(): string {
    return this.value.isZero() ? '0.00' : this.value.toFixed(2);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new DomainError('CURRENCY_MISMATCH', `moedas diferentes: ${this.currency} e ${other.currency}`);
    }
  }
}
