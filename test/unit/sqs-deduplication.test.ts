import { expect, test } from "bun:test";
import { deadLetterDeduplicationId } from "../../src/messaging/infrastructure/sqs-transport";

test("DLQ identities fit the AWS 128-character limit and remain stable across send-before-ack crashes", () => {
  for (const length of [1, 90, 128]) {
    const id = "m".repeat(length);
    const result = deadLetterDeduplicationId(id, "INBOX_PAYLOAD_CONFLICT");
    expect(result.length).toBeLessThanOrEqual(128);
    expect(result).toMatch(/^[!-~]+$/);
    expect(deadLetterDeduplicationId(id, "INBOX_PAYLOAD_CONFLICT")).toBe(result);
    expect(deadLetterDeduplicationId(id, "PROCESSING_FAILED")).not.toBe(result);
  }
  expect(deadLetterDeduplicationId("msg-123", "INVALID_JSON")).toBe("msg-123:INVALID_JSON");
});
