import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "../../src/shared/domain/domain-error";
import { Money } from "../../src/shared/domain/money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money", () => {
  describe("from (input contract)", () => {
    test.each(["0.00", "25.00", "0.01", "1000.10", "999999999999999999.99"])("accepts %p", (amount) => {
      expect(brl(amount).toString()).toBe(amount);
    });

    test.each([
      ["empty", ""],
      ["no decimals", "25"],
      ["one decimal", "25.5"],
      ["three decimals", "25.001"],
      ["negative", "-1.00"],
      ["explicit plus", "+1.00"],
      ["scientific", "1e3"],
      ["scientific with decimals", "1.00e2"],
      ["NaN", "NaN"],
      ["Infinity", "Infinity"],
      ["leading zero", "01.00"],
      ["whitespace", " 1.00"],
      ["comma separator", "1,00"],
      ["hex", "0x10"],
      ["too many integer digits", "1000000000000000000.00"],
    ])("rejects %s (%p)", (_label, amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    });

    test("rejects non-string amounts (numbers are never money)", () => {
      expect(() => Money.from({ amount: 25 as unknown as string, currency: "BRL" })).toThrow(
        InvalidMoneyError,
      );
      expect(() => Money.from({ amount: Number.NaN as unknown as string, currency: "BRL" })).toThrow(
        InvalidMoneyError,
      );
    });

    test.each(["brl", "BR", "BRLL", "", "12A"])("rejects invalid currency %p", (currency) => {
      expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
    });
  });

  describe("arithmetic is exact (no rounding, no float drift)", () => {
    test("0.10 + 0.20 === 0.30", () => {
      expect(brl("0.10").add(brl("0.20")).equals(brl("0.30"))).toBe(true);
    });

    test("adding one cent a thousand times", () => {
      let total = Money.zero("BRL");
      for (let i = 0; i < 1000; i++) total = total.add(brl("0.01"));
      expect(total.toString()).toBe("10.00");
    });

    test("large values keep every cent", () => {
      expect(brl("999999999999999998.99").add(brl("1.00")).toString()).toBe("999999999999999999.99");
    });

    test("overflow beyond NUMERIC(20,2) is rejected, not rounded", () => {
      expect(() => brl("999999999999999999.99").add(brl("0.01"))).toThrow(InvalidMoneyError);
    });

    test("subtract may produce negatives internally", () => {
      const diff = brl("10.00").subtract(brl("25.50"));
      expect(diff.isNegative()).toBe(true);
      expect(diff.toString()).toBe("-15.50");
    });

    test("negate and zero normalisation", () => {
      expect(brl("5.00").negate().toString()).toBe("-5.00");
      expect(Money.zero("BRL").negate().toString()).toBe("0.00");
    });
  });

  test("is immutable: operations return new instances", () => {
    const a = brl("10.00");
    const b = a.add(brl("5.00"));
    expect(a.toString()).toBe("10.00");
    expect(b.toString()).toBe("15.00");
    expect(b).not.toBe(a);
  });

  test("predicates and comparisons", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("1.00").isLessThan(brl("1.01"))).toBe(true);
    expect(brl("1.01").isLessThan(brl("1.00"))).toBe(false);
    expect(brl("1.00").equals(Money.from({ amount: "1.00", currency: "USD" }))).toBe(false);
  });

  describe("currency conflicts", () => {
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    test.each([
      ["add", () => brl("1.00").add(usd)],
      ["subtract", () => brl("1.00").subtract(usd)],
      ["isLessThan", () => brl("1.00").isLessThan(usd)],
    ])("%s across currencies throws CurrencyMismatchError", (_name, op) => {
      expect(op).toThrow(CurrencyMismatchError);
    });
  });

  test("serialises as MoneyProps with fixed scale", () => {
    expect(JSON.stringify({ m: brl("25.00") })).toBe('{"m":{"amount":"25.00","currency":"BRL"}}');
  });

  test("fromSigned parses persisted negatives but keeps strict scale", () => {
    expect(Money.fromSigned({ amount: "-5.00", currency: "BRL" }).toString()).toBe("-5.00");
    expect(() => Money.fromSigned({ amount: "-5.0", currency: "BRL" })).toThrow(InvalidMoneyError);
  });
});
