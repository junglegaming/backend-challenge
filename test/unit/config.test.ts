import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config/config";

const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db" };

describe("SUPPORTED_CURRENCIES", () => {
  test("defaults to BRL, USD and EUR", () => {
    expect(loadConfig(base).SUPPORTED_CURRENCIES).toEqual(["BRL", "USD", "EUR"]);
  });

  test("accepts any ISO-4217 list, trimmed and de-duplicated", () => {
    expect(loadConfig({ ...base, SUPPORTED_CURRENCIES: " BRL, JPY ,BRL" }).SUPPORTED_CURRENCIES).toEqual([
      "BRL",
      "JPY",
    ]);
  });

  test.each([
    ["not ISO-4217", "BRL,XYZ"],
    ["lower case", "brl"],
    ["empty", " , "],
  ])("fails the boot when %s", (_name, value) => {
    expect(() => loadConfig({ ...base, SUPPORTED_CURRENCIES: value })).toThrow(/SUPPORTED_CURRENCIES/);
  });
});

describe("FAULT_INJECTION", () => {
  test("is honoured only with NODE_ENV=test", () => {
    const faults = "after-commit-before-ack";
    expect(loadConfig({ ...base, NODE_ENV: "test", FAULT_INJECTION: faults }).FAULT_INJECTION).toEqual([
      faults,
    ]);
    expect(loadConfig({ ...base, NODE_ENV: "development", FAULT_INJECTION: faults }).FAULT_INJECTION).toEqual(
      [],
    );
    expect(loadConfig({ ...base, NODE_ENV: "production", FAULT_INJECTION: faults }).FAULT_INJECTION).toEqual(
      [],
    );
  });
});
