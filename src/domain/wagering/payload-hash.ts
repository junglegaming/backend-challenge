import { createHash } from 'node:crypto';
import type { Money } from '../shared/money';
import type { WagerTransactionKind } from './wager-enums';

export interface WagerPayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
}

/** Deterministic JSON: object keys sorted recursively, no whitespace, `undefined` members omitted. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v ?? null)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * payloadHash = SHA-256 (hex) of the canonical JSON of the business fields only.
 * The Idempotency-Key header and transport metadata (messageId, occurredAt…) are excluded;
 * money is normalised through Money (so "25" and "25.00" hash alike).
 */
export function computePayloadHash(fields: WagerPayloadFields): string {
  const canonical = canonicalJson({
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: fields.money.toJSON(),
    referenceExternalTransactionId: fields.referenceExternalTransactionId,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
