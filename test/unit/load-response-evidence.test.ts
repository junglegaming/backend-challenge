import { expect, test } from "bun:test";
import { assertResponseOutcome, parseResponseEvidence } from "../../load/response-evidence";

const firstId = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";
const response = { workload: "hot", index: 0, status: 200, transactionId: firstId };

test("load evidence associates each HTTP success and absent 503 with its own SQL identity", () => {
  const evidence = parseResponseEvidence(
    [response, { ...response, index: 1, status: 503, transactionId: null }]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  expect(() => assertResponseOutcome(evidence.get("hot:0"), firstId)).not.toThrow();
  expect(() => assertResponseOutcome(evidence.get("hot:1"), undefined)).not.toThrow();
  expect(() => assertResponseOutcome(evidence.get("hot:0"), secondId)).toThrow();
  // Same aggregate totals, but the 200 is absent and the 503 is durable: both must fail.
  expect(() => assertResponseOutcome(evidence.get("hot:0"), undefined)).toThrow();
  expect(() => assertResponseOutcome(evidence.get("hot:1"), secondId)).toThrow();
  expect(() => assertResponseOutcome(undefined, firstId)).toThrow();
});

for (const invalid of [
  { ...response, transactionId: "" },
  { ...response, transactionId: secondId.slice(1) },
  { ...response, transactionId: null },
  { ...response, status: 503 },
  { ...response, status: 500 },
  { ...response, index: -1 },
  { ...response, index: 1.5 },
  { ...response, workload: "unknown" },
  { ...response, workload: ["hot"] },
  { ...response, extra: "unlisted field" },
])
  test(`load evidence rejects invalid coordinates or identity: ${JSON.stringify(invalid)}`, () => {
    expect(() => parseResponseEvidence(JSON.stringify(invalid))).toThrow();
  });

test("load evidence rejects duplicate response coordinates", () => {
  const line = JSON.stringify(response);
  expect(() => parseResponseEvidence(`${line}\n${line}\n`)).toThrow();
});
