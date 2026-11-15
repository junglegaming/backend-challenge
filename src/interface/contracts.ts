import { z } from 'zod';
import { ValidationError } from '../application/errors';
import type { SubmitWagerCommand } from '../application/submit-wager-transaction';
import { EXTERNAL_KINDS, INTERNAL_PROVIDER_ID } from '../domain/wager-transaction';

/*
 * Inbound contracts shared by HTTP and SQS. Structural validation only; the
 * money grammar (scale, sign, exponent) is enforced by the Money value object
 * so there is exactly one definition of a valid amount.
 */

const identifier = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9._:\-]+$/, 'only letters, digits and . _ : - are allowed');

export const moneySchema = z
  .object({
    amount: z.string().min(1).max(32),
    currency: z.string().length(3),
  })
  .strict();

export const providerIdSchema = identifier(128).refine((v) => v !== INTERNAL_PROVIDER_ID, 'reserved provider id');

export const wagerTransactionBodySchema = z
  .object({
    providerId: providerIdSchema,
    externalTransactionId: identifier(255),
    playerId: z.string().uuid(),
    walletId: z.string().uuid(),
    roundId: identifier(255),
    gameId: identifier(255),
    // OPENING is internal and therefore not part of the enum
    kind: z.enum(EXTERNAL_KINDS),
    money: moneySchema,
    referenceExternalTransactionId: identifier(255).optional(),
  })
  .strict();

export type WagerTransactionBody = z.infer<typeof wagerTransactionBodySchema>;

export const idempotencyKeySchema = z.string().min(1).max(512).regex(/^[\x21-\x7E]+$/, 'printable ASCII without spaces');

export const openWalletBodySchema = z
  .object({
    playerId: z.string().uuid(),
    initialBalance: moneySchema,
  })
  .strict();

export const queueEnvelopeSchema = z.object({
  messageId: identifier(255),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.string().datetime({ offset: true }),
  correlationId: z.string().max(255).optional(),
  data: wagerTransactionBodySchema.extend({ idempotencyKey: idempotencyKeySchema }).strict(),
});

export type QueueEnvelope = z.infer<typeof queueEnvelopeSchema>;

export const parseOrThrow = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError('Invalid payload', {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
};

export const toSubmitCommand = (body: WagerTransactionBody, idempotencyKey: string): SubmitWagerCommand => ({
  idempotencyKey,
  providerId: body.providerId,
  externalTransactionId: body.externalTransactionId,
  playerId: body.playerId,
  walletId: body.walletId,
  roundId: body.roundId,
  gameId: body.gameId,
  kind: body.kind,
  money: body.money,
  ...(body.referenceExternalTransactionId ? { referenceExternalTransactionId: body.referenceExternalTransactionId } : {}),
});
