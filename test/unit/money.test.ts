import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/shared/domain-error';
import { Money } from '../../src/domain/shared/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('normalises to scale 2', () => {
    expect(brl('25').toString()).toBe('25.00');
    expect(brl('25.5').toString()).toBe('25.50');
    expect(brl('0.05').toJSON()).toEqual({ amount: '0.05', currency: 'BRL' });
  });

  test('exact arithmetic (0.10 + 0.20 === 0.30)', () => {
    expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
    expect(brl('100.00').subtract(brl('80.00')).toString()).toBe('20.00');
  });

  test('handles very large values without precision loss', () => {
    expect(brl('999999999999999999.99').add(brl('0.01')).toString()).toBe('1000000000000000000.00');
  });

  test('is immutable: operations return new instances', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.toString()).toBe('10.00');
    expect(b.toString()).toBe('15.00');
    expect(a.negate().toString()).toBe('-10.00');
    expect(a.toString()).toBe('10.00');
  });

  test('sign predicates and comparison', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('1.00').isPositive()).toBe(true);
    expect(brl('1.00').subtract(brl('2.00')).isNegative()).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.00').negate().negate().equals(brl('1.00'))).toBe(true);
  });

  test('negative zero is zero', () => {
    expect(Money.zero('BRL').negate().toString()).toBe('0.00');
  });

  test.each(['', ' ', 'NaN', 'Infinity', '-Infinity', '1e3', '1E3', '1.234', '1.', '.5', '-1.00', '+1.00', '1,00', '1 .00', 'abc'])(
    'rejects invalid input %p',
    (amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    },
  );

  test('rejects non-string amounts and bad currency', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1.00', currency: '' })).toThrow(InvalidMoneyError);
    expect(() => Money.zero('XX')).toThrow(InvalidMoneyError);
  });

  test('fromSigned accepts negatives for rehydration only', () => {
    expect(Money.fromSigned({ amount: '-3.50', currency: 'BRL' }).isNegative()).toBe(true);
    expect(() => Money.fromSigned({ amount: '1e3', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  describe('scale and rounding edges', () => {
    test.each([
      ['0', '0.00'],
      ['0.0', '0.00'],
      ['0.00', '0.00'],
      ['0.01', '0.01'],
      ['0.1', '0.10'],
      ['00012.5', '12.50'],
      ['007', '7.00'],
      ['9.99', '9.99'],
    ])('normalises %p to %p', (input, expected) => {
      expect(brl(input).toString()).toBe(expected);
    });

    test.each(['0.001', '0.005', '0.009', '1.999', '1.005', '2.675', '0.000', '1.00000000000000000001'])(
      'never rounds: rejects %p (more than 2 decimals, even trailing zeros)',
      (amount) => {
        expect(() => brl(amount)).toThrow(InvalidMoneyError);
      },
    );

    test('classic float traps stay exact', () => {
      expect(brl('0.1').add(brl('0.2')).toString()).toBe('0.30');
      expect(brl('1.10').add(brl('2.20')).toString()).toBe('3.30');
      expect(brl('4.35').subtract(brl('4.34')).toString()).toBe('0.01');
      expect(brl('1.15').add(brl('1.15')).toString()).toBe('2.30');
    });

    test('negative results keep the sign and scale', () => {
      expect(brl('0.00').subtract(brl('0.01')).toString()).toBe('-0.01');
      expect(brl('1.00').subtract(brl('1.50')).toString()).toBe('-0.50');
      expect(brl('1.00').subtract(brl('1.00')).toString()).toBe('0.00');
    });

    test('crossing zero by 1 cent', () => {
      const m = brl('0.01').subtract(brl('0.02'));
      expect(m.isNegative()).toBe(true);
      expect(m.isZero()).toBe(false);
      expect(m.isPositive()).toBe(false);
    });

    test('addition is commutative/associative and subtract inverts add', () => {
      const a = brl('12.34');
      const b = brl('0.66');
      const c = brl('1000.01');
      expect(a.add(b).equals(b.add(a))).toBe(true);
      expect(a.add(b).add(c).equals(a.add(b.add(c)))).toBe(true);
      expect(a.add(b).subtract(b).equals(a)).toBe(true);
    });

    test('summing 1000 times 0.01 is exactly 10.00', () => {
      let total = Money.zero('BRL');
      for (let i = 0; i < 1000; i++) total = total.add(brl('0.01'));
      expect(total.toString()).toBe('10.00');
    });

    test('equals ignores input formatting', () => {
      expect(brl('5').equals(brl('5.00'))).toBe(true);
      expect(brl('5.10').equals(brl('5.1'))).toBe(true);
      expect(brl('5.10').equals(brl('5.11'))).toBe(false);
    });

    test('toJSON/JSON.stringify emit a string amount, never a number', () => {
      expect(JSON.stringify(brl('7.5'))).toBe('{"amount":"7.50","currency":"BRL"}');
      expect(typeof brl('7.5').toJSON().amount).toBe('string');
    });

    test('toJSON → from roundtrip', () => {
      const m = brl('123456.70');
      expect(Money.from(m.toJSON()).equals(m)).toBe(true);
    });
  });

  describe('invalid contract input (extended)', () => {
    test.each(['0x10', '0b1', '1_000', '１２', '١٢', '1\n', '\t1', '1.0.0', '--1', '1-', '(1)', 'null', 'undefined', '1e-2', '1e+2', '.', '-', '-0.00', '-0'])(
      'rejects %p',
      (amount) => {
        expect(() => brl(amount)).toThrow(InvalidMoneyError);
      },
    );

    test('rejects null/undefined/non-object props', () => {
      for (const bad of [null, undefined, 'BRL', 10]) {
        expect(() => Money.from(bad as never)).toThrow(InvalidMoneyError);
      }
      expect(() => Money.from({ currency: 'BRL' } as never)).toThrow(InvalidMoneyError);
    });

    test.each(['BR', 'BRLL', 'br1', '123', 'B R', 'ÁÉÍ'])('rejects currency %p', (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    });

    test('error carries a stable code', () => {
      try {
        brl('abc');
      } catch (e) {
        expect((e as InvalidMoneyError).code).toBe('INVALID_MONEY');
      }
    });
  });

  test('currency mismatch throws a domain error', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl('1.00').equals(usd)).toBe(false);
  });
});
