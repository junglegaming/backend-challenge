import { createHash } from 'node:crypto';
import { InvalidRequestError } from '../errors';
import { canonicalJson } from '../../domain/wagering/payload-hash';
import type { WagerTransactionKind } from '../../domain/wagering/wager-enums';
import type { ProcessWagerTransaction, ProcessWagerTransactionCommand } from './process-wager-transaction';

const CONSUMER_NAME = 'wager-transactions';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidRequestError('Expected JSON object');
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new InvalidRequestError(`${field} is required`);
  return value;
}

export class ConsumeWagerMessage {
  constructor(private readonly process: ProcessWagerTransaction) {}

  async execute(body: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new InvalidRequestError('Message is not valid JSON');
    }
    const message = object(parsed);
    const messageId = text(message.messageId, 'messageId');
    if (text(message.type, 'type') !== 'WagerTransactionRequested') throw new InvalidRequestError('Unsupported message type');
    const occurredAt = text(message.occurredAt, 'occurredAt');
    if (!Number.isFinite(Date.parse(occurredAt))) throw new InvalidRequestError('Invalid occurredAt');
    const data = object(message.data);
    const money = object(data.money);
    const reference = data.referenceExternalTransactionId;
    if (reference !== undefined && (typeof reference !== 'string' || !reference.trim())) {
      throw new InvalidRequestError('Invalid referenceExternalTransactionId');
    }
    const command: ProcessWagerTransactionCommand = {
      providerId: text(data.providerId, 'providerId'),
      externalTransactionId: text(data.externalTransactionId, 'externalTransactionId'),
      idempotencyKey: text(data.idempotencyKey, 'idempotencyKey'),
      playerId: text(data.playerId, 'playerId'),
      walletId: text(data.walletId, 'walletId'),
      roundId: text(data.roundId, 'roundId'),
      gameId: text(data.gameId, 'gameId'),
      kind: text(data.kind, 'kind') as WagerTransactionKind,
      money: { amount: text(money.amount, 'money.amount'), currency: text(money.currency, 'money.currency') },
      referenceExternalTransactionId: reference,
    };
    const payloadHash = createHash('sha256').update(canonicalJson(message)).digest('hex');
    await this.process.executeMessage(command, { consumerName: CONSUMER_NAME, messageId, payloadHash });
  }
}
