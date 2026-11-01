import { expect, test } from "bun:test";
import { canonicalHash, canonicalJson } from "../../src/shared/application/canonical-json";
import {
  classifySqlError,
  sqlErrorFields,
  submissionRaceConstraints,
} from "../../src/shared/infrastructure/sql-error-classifier";
import { wageringPayloadHash } from "../../src/wagering/application/submit-wager-transaction";
import { WagerTransactionKind } from "../../src/wagering/domain/wager-transaction";

test("canonical JSON recursively sorts keys, omits absent fields and preserves array order", () => {
  expect(canonicalJson({ z: [{ b: 2, a: 1 }, 0], a: { z: undefined, x: "25.00" } })).toBe(
    '{"a":{"x":"25.00"},"z":[{"a":1,"b":2},0]}',
  );
  expect(canonicalHash({ b: 2, a: 1 })).toBe(canonicalHash({ a: 1, b: 2 }));
  expect(canonicalHash({ amount: "0.10" })).not.toBe(canonicalHash({ amount: "0.20" }));
});

test("business hash excludes transport metadata and idempotency key, and includes every business field", () => {
  const command = {
    providerId: "provider-a",
    externalTransactionId: "external",
    playerId: "player",
    walletId: "wallet",
    roundId: "round",
    gameId: "game",
    kind: WagerTransactionKind.Bet,
    money: { amount: "10.00", currency: "BRL" },
    referenceExternalTransactionId: undefined,
  };
  const hash = wageringPayloadHash(command);
  const metadata = {
    ...command,
    messageId: "message",
    occurredAt: "date",
    idempotencyKey: "key",
    correlationId: "correlation",
  };
  expect(wageringPayloadHash(metadata)).toBe(hash);
  for (const field of [
    "providerId",
    "externalTransactionId",
    "playerId",
    "walletId",
    "roundId",
    "gameId",
    "kind",
    "referenceExternalTransactionId",
  ])
    expect(wageringPayloadHash({ ...command, [field]: "other" })).not.toBe(hash);
  expect(wageringPayloadHash({ ...command, money: { amount: "11.00", currency: "BRL" } })).not.toBe(
    hash,
  );
  expect(wageringPayloadHash({ ...command, money: { amount: "10.00", currency: "USD" } })).not.toBe(
    hash,
  );
});

test("SQL classification uses native fields, retries only known unique races, and defaults transient", () => {
  for (const constraint of submissionRaceConstraints)
    expect(classifySqlError({ code: "23505", constraint })).toBe("known_unique_race");
  for (const code of ["22003", "22P02", "23503", "23514", "23502", "23505"])
    expect(classifySqlError({ code, constraint: "unknown" })).toBe("permanent");
  for (const code of [
    "08006",
    "40001",
    "40P01",
    "53000",
    "53300",
    "55P03",
    "57P01",
    "57P02",
    "57P03",
    "ECONNREFUSED",
    "ETIMEDOUT",
  ])
    expect(classifySqlError({ code })).toBe("transient");
  for (const error of [undefined, null, "22003", new Error("23514"), {}])
    expect(classifySqlError(error)).toBe("transient");
  const native = Object.defineProperties(new Error(), {
    code: { value: "23505" },
    constraint: { value: "uq_wager_transactions_provider_key" },
  });
  expect(sqlErrorFields(native)).toEqual({
    code: "23505",
    constraint: "uq_wager_transactions_provider_key",
  });
});
