import { createHash } from "node:crypto";
import type { MoneyProps } from "../money/money";

/** Business fields that identify *what* the provider asked for. */
export interface WagerPayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/**
 * Hash used to tell an idempotent replay from a conflicting reuse of the same key.
 *
 * Algorithm: SHA-256 (hex) of a canonical JSON built from the business fields
 * only, with keys sorted recursively and absent optional fields omitted.
 * Transport metadata (Idempotency-Key header, SQS messageId, timestamps) is
 * deliberately excluded, so the same operation sent via HTTP or SQS has the
 * same hash.
 */
export function computePayloadHash(fields: WagerPayloadFields): string {
  const businessFields = {
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: { amount: fields.money.amount, currency: fields.money.currency },
    referenceExternalTransactionId: fields.referenceExternalTransactionId,
  };
  return createHash("sha256").update(canonicalJson(businessFields)).digest("hex");
}

/** JSON with recursively sorted keys; `undefined` values are dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

