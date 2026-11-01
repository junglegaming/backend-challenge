export interface ResponseEvidence {
  workload: "hot" | "distributed" | "replay";
  index: number;
  status: 200 | 503;
  transactionId: string | null;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const responseKey = (workload: string, index: number) => `${workload}:${index}`;

// Only request coordinates, HTTP status and transaction ID leave the generator.
// Never retain response bodies, headers, credentials or financial fields.
export function parseResponseEvidence(text: string): Map<string, ResponseEvidence> {
  const responses = new Map<string, ResponseEvidence>();
  for (const line of text.trim().split("\n")) {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid HTTP identity evidence");
    const row = value as Record<string, unknown>;
    if (
      Object.keys(row).sort().join(",") !== "index,status,transactionId,workload" ||
      typeof row.workload !== "string" ||
      !["hot", "distributed", "replay"].includes(row.workload) ||
      typeof row.index !== "number" ||
      !Number.isSafeInteger(row.index) ||
      row.index < 0 ||
      ![200, 503].includes(row.status as number) ||
      (row.status === 200
        ? typeof row.transactionId !== "string" || !uuid.test(row.transactionId)
        : row.transactionId !== null)
    )
      throw new Error("Invalid HTTP identity evidence");
    const response = row as unknown as ResponseEvidence;
    const key = responseKey(response.workload, response.index);
    if (responses.has(key)) throw new Error("Duplicate HTTP identity evidence");
    responses.set(key, response);
  }
  return responses;
}

export function assertResponseOutcome(
  response: ResponseEvidence | undefined,
  durableId: string | undefined,
) {
  if (
    !response ||
    (response.status === 200 ? response.transactionId !== durableId : durableId !== undefined)
  )
    throw new Error("Individual HTTP outcome differs from its durable transaction");
}
