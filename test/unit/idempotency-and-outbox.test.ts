import { describe, expect, test } from 'bun:test';
import { canonicalJson, sha256Canonical } from '../../src/application/payload-hash';
import { type SubmitWagerCommand, wagerPayloadHash } from '../../src/application/submit-wager-transaction';
import { WalletBalanceChanged } from '../../src/domain/events/wagering-events';
import { Money } from '../../src/domain/money';
import { backoffDelayMs, OutboxMessage } from '../../src/domain/outbox-message';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';

const command: SubmitWagerCommand = {
  idempotencyKey: 'provider-a:transaction-123',
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: WagerTransactionKind.Bet,
  money: { amount: '25.00', currency: 'BRL' },
};
const hash = (cmd: SubmitWagerCommand) => wagerPayloadHash(cmd, Money.from(cmd.money));

describe('canonical JSON payload hash', () => {
  test('sorts keys recursively and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"x":2,"y":1}]},"b":1}');
  });

  test('is independent of key order', () => {
    expect(sha256Canonical({ a: 1, b: 2 })).toBe(sha256Canonical({ b: 2, a: 1 }));
  });

  test('identical business payloads hash identically; the idempotency key is not part of it', () => {
    expect(hash(command)).toBe(hash({ ...command, idempotencyKey: 'another-key' }));
    expect(hash(command)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('amount is hashed in canonical scale ("25" == "25.00")', () => {
    expect(hash({ ...command, money: { amount: '25', currency: 'BRL' } })).toBe(hash(command));
  });

  test.each<[string, Partial<SubmitWagerCommand>]>([
    ['money', { money: { amount: '25.01', currency: 'BRL' } }],
    ['kind', { kind: WagerTransactionKind.Win }],
    ['walletId', { walletId: '0192f291-27dd-7d3f-8071-5f8685deef38' }],
    ['roundId', { roundId: 'round-988' }],
    ['reference', { referenceExternalTransactionId: 'x' }],
  ])('a different %s yields a different hash (=> idempotency conflict, not replay)', (_field, change) => {
    expect(hash({ ...command, ...change })).not.toBe(hash(command));
  });
});

describe('OutboxMessage', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const wallet = Wallet.open({
    id: 'w',
    playerId: 'p',
    initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    openingTransactionId: 't',
    openingEntryId: 'e',
    now,
  });
  const entry = wallet.uncommittedEntries[0]!;
  const event = WalletBalanceChanged.from(wallet, entry, { newId: () => 'event-1', correlationId: 'c', occurredAt: now });

  test('enqueue stores the serialized envelope with MoneyProps (never Money instances)', () => {
    const message = OutboxMessage.enqueue(event);
    expect(message.id).toBe('event-1');
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.payload).toMatchObject({
      eventId: 'event-1',
      eventType: 'WalletBalanceChanged',
      version: 1,
      occurredAt: '2026-01-01T00:00:00.000Z',
      data: { balanceAfter: { amount: '10.00', currency: 'BRL' }, walletVersion: 1 },
    });
    expect(JSON.parse(JSON.stringify(message.payload))).toEqual(message.payload as Record<string, unknown>);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(now)).toBe(true);
  });

  test('scheduleRetry increments attempts and pushes nextAttemptAt with exponential backoff', () => {
    const message = OutboxMessage.enqueue(event);
    message.scheduleRetry(now);
    expect(message.attempts).toBe(1);
    expect(message.isDue(now)).toBe(false);
    expect(message.nextAttemptAt!.getTime()).toBeGreaterThan(now.getTime());
    message.markPublished(now);
    expect(message.isPending()).toBe(false);
  });

  test('backoff grows exponentially, is capped and jittered', () => {
    const policy = { baseDelayMs: 1000, maxDelayMs: 8000 };
    expect(backoffDelayMs(1, policy, () => 0)).toBe(500);
    expect(backoffDelayMs(1, policy, () => 1)).toBe(1000);
    expect(backoffDelayMs(3, policy, () => 1)).toBe(4000);
    expect(backoffDelayMs(10, policy, () => 1)).toBe(8000);
  });
});
