import { describe, expect, test } from "bun:test";
import { classifySubmissionError } from "../../src/modules/wagering/application/submission-failures";
import {
  SubmissionFailure,
  SubmissionFailureCategory,
} from "../../src/modules/wagering/domain/submission-failure";
import {
  IdempotencyConflictError,
  TransientInfrastructureError,
  ValidationError,
  WalletNotFoundForSubmissionError,
} from "../../src/shared/application/errors";
import { T0 } from "../helpers/domain-fixtures";

const base = {
  id: "f-1",
  channel: "http" as const,
  reasonCode: "VALIDATION_ERROR",
  category: SubmissionFailureCategory.Validation,
  retryable: false,
  occurredAt: T0,
};

describe("SubmissionFailure", () => {
  test("keeps well-formed identifiers", () => {
    const f = SubmissionFailure.record({
      ...base,
      providerId: "provider-a",
      externalTransactionId: "tx-1",
      idempotencyKey: "provider-a:tx-1",
      walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
      messageId: "msg-1",
    });
    expect(f.toState()).toMatchObject({
      providerId: "provider-a",
      externalTransactionId: "tx-1",
      idempotencyKey: "provider-a:tx-1",
      walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
      messageId: "msg-1",
    });
  });

  test("drops untrusted identifiers instead of storing them as-is", () => {
    const f = SubmissionFailure.record({
      ...base,
      providerId: "<script>alert(1)</script>",
      externalTransactionId: "x".repeat(500),
      walletId: "not-a-uuid",
      idempotencyKey: "has spaces",
    });
    expect(f.providerId).toBeUndefined();
    expect(f.externalTransactionId).toBeUndefined();
    expect(f.walletId).toBeUndefined();
    expect(f.idempotencyKey).toBeUndefined();
  });

  test("truncates and normalises the detail", () => {
    const f = SubmissionFailure.record({ ...base, detail: `a\n\n  b ${"z".repeat(1000)}` });
    expect(f.detail?.startsWith("a b ")).toBe(true);
    expect(f.detail?.length).toBe(500);
  });

  test("rejects non-taxonomy reason codes", () => {
    expect(() => SubmissionFailure.record({ ...base, reasonCode: "free text" })).toThrow();
  });

  test("is immutable", () => {
    const f = SubmissionFailure.record(base);
    expect(Object.isFrozen(f)).toBe(true);
  });
});

describe("classifySubmissionError", () => {
  test.each([
    [new ValidationError("bad"), "VALIDATION_ERROR", SubmissionFailureCategory.Validation, false],
    [
      new IdempotencyConflictError("PAYLOAD_MISMATCH", {}),
      "IDEMPOTENCY_CONFLICT",
      SubmissionFailureCategory.Conflict,
      false,
    ],
    [
      new WalletNotFoundForSubmissionError("w"),
      "WALLET_NOT_FOUND",
      SubmissionFailureCategory.Unprocessable,
      true,
    ],
    [
      new TransientInfrastructureError("x", "lock"),
      "TRANSIENT_FAILURE",
      SubmissionFailureCategory.Infrastructure,
      true,
    ],
    [new Error("boom"), "INTERNAL_ERROR", SubmissionFailureCategory.Infrastructure, true],
  ])("%p → %s", (error, code, category, retryable) => {
    expect(classifySubmissionError(error)).toMatchObject({ reasonCode: code, category, retryable });
  });

  test("conflict detail carries the conflict reason", () => {
    const c = classifySubmissionError(new IdempotencyConflictError("EXTERNAL_ID_REUSED", {}));
    expect(c.detail.startsWith("EXTERNAL_ID_REUSED")).toBe(true);
  });
});
