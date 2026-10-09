import { canonicalJson, sha256Hex } from "../../../shared/domain/canonical-json";
import type { MoneyProps } from "../../../shared/domain/money";

export const PAYLOAD_HASH_VERSION = "v1";

/** Business fields only. Idempotency-Key header, messageId and transport metadata are deliberately excluded. */
export interface WagerPayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

/**
 * payloadHash = "v1:" + hex(sha256(canonicalJson(fields)))
 * The amount is hashed as the received string; the contract enforces a canonical 2-decimal format,
 * so "25.00" is the only valid spelling of twenty-five.
 */
export function computeWagerPayloadHash(fields: WagerPayloadFields): string {
  const canonical = canonicalJson({
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: { amount: fields.money.amount, currency: fields.money.currency },
    referenceExternalTransactionId: fields.referenceExternalTransactionId,
  });
  return `${PAYLOAD_HASH_VERSION}:${sha256Hex(canonical)}`;
}
