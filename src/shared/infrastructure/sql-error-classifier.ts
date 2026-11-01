export const submissionRaceConstraints = new Set([
  "uq_wager_transactions_provider_key",
  "uq_wager_transactions_provider_external",
  "uq_wager_single_processed_reversal",
]);

export function sqlErrorFields(error: unknown): { code?: string; constraint?: string } {
  if (!error || typeof error !== "object") return {};
  const fields = error as Record<string, unknown>;
  return {
    code: typeof fields.code === "string" ? fields.code : undefined,
    constraint: typeof fields.constraint === "string" ? fields.constraint : undefined,
  };
}

export function classifySqlError(error: unknown): "known_unique_race" | "permanent" | "transient" {
  const { code, constraint } = sqlErrorFields(error);
  if (code === "23505" && constraint && submissionRaceConstraints.has(constraint))
    return "known_unique_race";
  if (code?.startsWith("22") || code?.startsWith("23")) return "permanent";
  return "transient";
}
