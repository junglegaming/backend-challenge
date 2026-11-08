import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { DomainError } from '../../src/domain/errors';

const brl = (valor: string) => Money.from({ amount: valor, currency: 'BRL' });

describe('Money', () => {
  test('serializa sempre com escala fixa de 2 casas', () => {
    expect(brl('25').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(brl('25.5').amount).toBe('25.50');
    expect(brl('0').amount).toBe('0.00');
  });

  test('aritmética é exata (sem erro de ponto flutuante)', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
    expect(brl('100.00').subtract(brl('80.00')).amount).toBe('20.00');
    expect(brl('999999999999999999.99').subtract(brl('0.01')).amount).toBe('999999999999999999.98');
  });

  test('é imutável: operações retornam nova instância', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.amount).toBe('10.00');
    expect(b.amount).toBe('15.00');
    expect(Object.isFrozen(a)).toBe(true);
  });

  test('negate e comparações', () => {
    expect(brl('5.00').negate().amount).toBe('-5.00');
    expect(brl('5.00').negate().isNegative()).toBe(true);
    expect(brl('0.00').negate().amount).toBe('0.00');
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('1.00').isPositive()).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.00').equals(brl('1'))).toBe(true);
  });

  test.each([
    ['', 'string vazia'],
    ['abc', 'texto'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['1e3', 'notação científica'],
    ['-1.00', 'negativo'],
    ['+1.00', 'sinal explícito'],
    ['1.005', 'mais de 2 casas (não arredonda)'],
    ['01.00', 'zero à esquerda'],
    ['.50', 'sem parte inteira'],
    ['1.', 'ponto sem casas'],
    [' 1.00', 'espaço'],
    ['1234567890123456789.00', 'mais de 18 dígitos inteiros'],
  ])('rejeita amount inválido %p (%s)', (valor) => {
    expect(() => brl(valor)).toThrow(DomainError);
  });

  test('rejeita amount numérico (dinheiro nunca é number)', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(DomainError);
  });

  test.each(['brl', 'BR', 'BRLL', '', '123'])('rejeita moeda inválida %p', (moeda) => {
    expect(() => Money.from({ amount: '1.00', currency: moeda })).toThrow(DomainError);
  });

  test('operações entre moedas diferentes lançam erro de domínio', () => {
    const dolar = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(dolar)).toThrow(DomainError);
    expect(() => brl('1.00').subtract(dolar)).toThrow(DomainError);
    expect(() => brl('1.00').isLessThan(dolar)).toThrow(DomainError);
    expect(brl('1.00').equals(dolar)).toBe(false);
  });
});
