import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "../../src/shared/domain/domain-error";
import { Money, MoneyProps } from "../../src/shared/domain/money";
import { money } from "./domain-fixtures";

describe("Money", () => {
  test.each([
    "025.00",
    "25",
    "25.5",
    "1e3",
    "-1.00",
    "",
    "NaN",
    "Infinity",
    "1.001",
    "1.005",
    " 1.00",
    "1.00 ",
    "+1.00",
    ".50",
    "00.00",
    "10000000000000000.00",
    "1.00\n",
    25,
    0,
    null,
    undefined,
    {},
    true,
  ])("rejects invalid decimal input %#", (amount) => {
    expect(() => Money.from({ amount, currency: "BRL" } as MoneyProps)).toThrow(InvalidMoneyError);
  });
  test.each(["brl", "BR", "BRLL", "123", "", null, 123])(
    "rejects invalid currency %#",
    (currency) => {
      expect(() => Money.from({ amount: "1.00", currency } as MoneyProps)).toThrow(
        InvalidMoneyError,
      );
    },
  );
  test("is exact, immutable, fixed scale, and supports the numeric(18,2) maximum", () => {
    const left = money("0.10");
    expect(left.add(money("0.20")).toJSON()).toEqual({ amount: "0.30", currency: "BRL" });
    expect(left.toString()).toBe("0.10");
    expect(money("9999999999999999.99").toString()).toBe("9999999999999999.99");
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(left.isPositive()).toBe(true);
    expect(left.isNegative()).toBe(false);
    expect(left.isLessThan(money("0.20"))).toBe(true);
    expect(left.equals(money("0.10"))).toBe(true);
    expect(Object.isFrozen(left)).toBe(true);
  });
  test("subtract and negate produce exact negatives without signed zero or rounding", () => {
    expect(money("0.10").subtract(money("0.20")).toJSON()).toEqual({
      amount: "-0.10",
      currency: "BRL",
    });
    expect(money("5.00").negate().toString()).toBe("-5.00");
    expect(Money.zero("BRL").negate().toString()).toBe("0.00");
    expect(money("1.00").subtract(money("2.00")).isNegative()).toBe(true);
  });
  test("all binary operations reject mixed currencies", () => {
    const left = money("1.00");
    const right = money("1.00", "USD");
    for (const operation of ["add", "subtract", "equals", "isLessThan"] as const) {
      expect(() => left[operation](right)).toThrow(CurrencyMismatchError);
    }
  });
});
