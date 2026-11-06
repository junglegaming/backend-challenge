import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/shared/money';
import { WagerTransactionKind as K } from '../../../src/domain/wagering/wager-enums';
import { canonicalJson, computePayloadHash, type WagerPayloadFields } from '../../../src/domain/wagering/payload-hash';
import { brl, tx } from './support';

const base = (): WagerPayloadFields => ({
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'p1',
  walletId: 'w1',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: K.Bet,
  money: brl('25.00'),
});

describe('canonicalJson', () => {
  test('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] }, u: undefined })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}',
    );
  });

  test('is independent of insertion order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  test('escapes strings safely (no delimiter injection)', () => {
    expect(canonicalJson({ a: 'x","b":"y' })).toBe('{"a":"x\\",\\"b\\":\\"y"}');
  });
});

describe('computePayloadHash (SHA-256 of canonical business JSON)', () => {
  test('is deterministic and hex-encoded', () => {
    expect(computePayloadHash(base())).toBe(computePayloadHash(base()));
    expect(computePayloadHash(base())).toMatch(/^[0-9a-f]{64}$/);
  });

  test('does not depend on field order of the input object', () => {
    const reordered: WagerPayloadFields = {
      money: brl('25.00'),
      kind: K.Bet,
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: 'w1',
      playerId: 'p1',
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    };
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(base()));
  });

  test('money is normalised: "25" and "25.00" are the same payload', () => {
    expect(computePayloadHash({ ...base(), money: Money.from({ amount: '25', currency: 'BRL' }) })).toBe(
      computePayloadHash(base()),
    );
  });

  test('absent and undefined reference hash the same', () => {
    expect(computePayloadHash({ ...base(), referenceExternalTransactionId: undefined })).toBe(computePayloadHash(base()));
  });

  test.each<[string, Partial<WagerPayloadFields>]>([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'other' }],
    ['playerId', { playerId: 'p2' }],
    ['walletId', { walletId: 'w2' }],
    ['roundId', { roundId: 'round-1' }],
    ['gameId', { gameId: 'other-game' }],
    ['kind', { kind: K.Win }],
    ['amount', { money: brl('25.01') }],
    ['currency', { money: Money.from({ amount: '25.00', currency: 'USD' }) }],
    ['reference', { referenceExternalTransactionId: 'r' }],
  ])('changing %s changes the hash', (_field, change) => {
    expect(computePayloadHash({ ...base(), ...change })).not.toBe(computePayloadHash(base()));
  });
});

describe('idempotency key vs payload', () => {
  test('the idempotency key is NOT part of the hash', () => {
    const a = tx(K.Bet, '25.00', { externalTransactionId: 'same', idempotencyKey: 'key-1' });
    const b = tx(K.Bet, '25.00', { externalTransactionId: 'same', idempotencyKey: 'key-2' });
    expect(a.payloadHash).toBe(b.payloadHash);
  });

  test('same key + identical payload matches (replay)', () => {
    const original = tx(K.Bet, '25.00', { externalTransactionId: 'same' });
    const retry = tx(K.Bet, '25', { externalTransactionId: 'same' });
    expect(original.matchesPayload(retry.payloadHash)).toBe(true);
  });

  test('same key + different payload does not match (conflict, not replay)', () => {
    const original = tx(K.Bet, '25.00', { externalTransactionId: 'same' });
    const divergent = tx(K.Bet, '26.00', { externalTransactionId: 'same' });
    const otherKind = tx(K.Win, '25.00', { externalTransactionId: 'same' });
    const otherRound = tx(K.Bet, '25.00', { externalTransactionId: 'same', roundId: 'round-2' });
    expect(original.matchesPayload(divergent.payloadHash)).toBe(false);
    expect(original.matchesPayload(otherKind.payloadHash)).toBe(false);
    expect(original.matchesPayload(otherRound.payloadHash)).toBe(false);
  });
});
