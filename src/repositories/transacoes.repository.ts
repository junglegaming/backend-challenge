import type { EntityManager } from '@mikro-orm/postgresql';
import { TransacaoEntity } from '../database/entidades';
import { Money } from '../domain/money';
import { FailureCode, WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';

/**
 * Tabela wager_transactions. As buscas por idempotency key e por
 * (providerId, externalTransactionId) são as que garantem a idempotência.
 */
export class TransacoesRepository {
  constructor(private readonly em: EntityManager) {}

  buscarPorId(id: string) {
    return this.buscarUma({ id });
  }

  buscarPorChaveDeIdempotencia(idempotencyKey: string) {
    return this.buscarUma({ idempotencyKey });
  }

  buscarPorIdExterno(providerId: string, externalTransactionId: string) {
    return this.buscarUma({ providerId, externalTransactionId });
  }

  /** Já existe REFUND ou ROLLBACK aplicado sobre esta transação? */
  async jaFoiRevertida(transactionId: string): Promise<boolean> {
    const quantidade = await this.em.count(TransacaoEntity, {
      referenceTransactionId: transactionId,
      kind: { $in: ['REFUND', 'ROLLBACK'] },
      status: 'PROCESSED',
    });
    return quantidade > 0;
  }

  async inserir(transacao: WagerTransaction): Promise<void> {
    await this.em.insert(TransacaoEntity, {
      id: transacao.id,
      providerId: transacao.providerId,
      externalTransactionId: transacao.externalTransactionId,
      idempotencyKey: transacao.idempotencyKey,
      payloadHash: transacao.payloadHash,
      walletId: transacao.walletId,
      playerId: transacao.playerId,
      roundId: transacao.roundId,
      gameId: transacao.gameId,
      kind: transacao.kind,
      amount: transacao.money.amount,
      currency: transacao.money.currency,
      referenceExternalTransactionId: transacao.referenceExternalTransactionId ?? null,
      correlationId: transacao.correlationId,
      createdAt: transacao.createdAt,
      ...colunasDeStatus(transacao),
    });
  }

  /** Atualiza só as colunas de status; os dados da aposta nunca mudam. */
  async atualizarStatus(transacao: WagerTransaction): Promise<void> {
    await this.em.nativeUpdate(TransacaoEntity, { id: transacao.id }, colunasDeStatus(transacao));
  }

  /** Transações PENDING_REFERENCE cuja próxima verificação já venceu. */
  async buscarReferenciasVencidas(agora: Date, limite: number): Promise<{ id: string; walletId: string }[]> {
    return this.em.find(
      TransacaoEntity,
      { status: 'PENDING_REFERENCE', nextReferenceCheckAt: { $lte: agora } },
      { orderBy: { nextReferenceCheckAt: 'asc' }, limit: limite, fields: ['id', 'walletId'] },
    );
  }

  private async buscarUma(filtro: Partial<TransacaoEntity>): Promise<WagerTransaction | undefined> {
    const linha = await this.em.findOne(TransacaoEntity, filtro, { refresh: true });
    return linha ? paraTransacao(linha) : undefined;
  }
}

function colunasDeStatus(transacao: WagerTransaction) {
  return {
    status: transacao.status,
    referenceTransactionId: transacao.referenceTransactionId ?? null,
    failureCode: transacao.failureCode ?? null,
    // o saldo observado é na moeda da wallet; em CURRENCY_MISMATCH não é gravado
    balanceAfter: transacao.balanceAfter?.currency === transacao.money.currency ? transacao.balanceAfter.amount : null,
    referenceAttempts: transacao.referenceAttempts,
    nextReferenceCheckAt: transacao.nextReferenceCheckAt ?? null,
    processedAt: transacao.processedAt ?? null,
    updatedAt: new Date(),
  };
}

function paraTransacao(linha: TransacaoEntity): WagerTransaction {
  const dinheiro = (valor: string) => Money.from({ amount: valor, currency: linha.currency });
  return WagerTransaction.rehydrate({
    id: linha.id,
    providerId: linha.providerId,
    externalTransactionId: linha.externalTransactionId,
    idempotencyKey: linha.idempotencyKey,
    payloadHash: linha.payloadHash,
    walletId: linha.walletId,
    playerId: linha.playerId,
    roundId: linha.roundId,
    gameId: linha.gameId,
    kind: linha.kind as WagerTransactionKind,
    money: dinheiro(linha.amount),
    referenceExternalTransactionId: linha.referenceExternalTransactionId ?? undefined,
    correlationId: linha.correlationId,
    createdAt: linha.createdAt,
    status: linha.status as WagerTransactionStatus,
    referenceTransactionId: linha.referenceTransactionId ?? undefined,
    failureCode: (linha.failureCode ?? undefined) as FailureCode | undefined,
    processedAt: linha.processedAt ?? undefined,
    balanceAfter: linha.balanceAfter != null ? dinheiro(linha.balanceAfter) : undefined,
    referenceAttempts: linha.referenceAttempts,
    nextReferenceCheckAt: linha.nextReferenceCheckAt ?? undefined,
  });
}
