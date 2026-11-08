import { z } from 'zod';
import { ErroHttp } from '../utils/erros';
import { hashDoJson } from '../utils/utilitarios';
import { schemaDinheiro, validar, texto } from '../utils/validacao';
import { Money } from '../domain/money';
import { PROVIDER_KINDS } from '../domain/wager-transaction';

/** Dados de negócio de uma aposta (iguais no HTTP e na fila). */
export const schemaDaAposta = z.object({
  providerId: texto(64),
  externalTransactionId: texto(128),
  playerId: z.string().uuid(),
  walletId: z.string().uuid(),
  roundId: texto(128),
  gameId: texto(128),
  kind: z.enum(PROVIDER_KINDS), // OPENING é interno e não é aceito
  money: schemaDinheiro,
  referenceExternalTransactionId: texto(128).optional(),
});

export type DadosDaAposta = z.infer<typeof schemaDaAposta>;
export type ApostaDto = DadosDaAposta & { idempotencyKey: string };

/** HTTP: o header Idempotency-Key é obrigatório. */
export function validarAposta(corpo: unknown, idempotencyKey: string | undefined): ApostaDto {
  if (!idempotencyKey || !texto(256).safeParse(idempotencyKey).success) {
    throw new ErroHttp(400, 'VALIDATION_ERROR', 'header Idempotency-Key é obrigatório');
  }
  return { ...validar(schemaDaAposta, corpo), idempotencyKey };
}

/**
 * Hash usado para saber se duas requisições com a mesma key são iguais:
 * SHA-256 do JSON (chaves em ordem alfabética) dos dados de negócio, com o
 * amount normalizado para 2 casas. A idempotency key e os dados de transporte
 * (headers, messageId) não entram.
 */
export function hashDaAposta(dto: DadosDaAposta & { idempotencyKey?: string }): string {
  const { idempotencyKey: _ignored, ...dadosDeNegocio } = dto;
  return hashDoJson({ ...dadosDeNegocio, money: Money.from(dto.money).toJSON() });
}
