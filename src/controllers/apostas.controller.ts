import { Body, Controller, Get, Headers, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AutenticacaoGuard } from '../utils/autenticacao.guard';
import { correlationIdAtual } from '../utils/logger';
import type { WagerTransaction } from '../domain/wager-transaction';
import { validarAposta } from '../dto/aposta.dto';
import { ApostasService } from '../services/apostas.service';

const STATUS_HTTP: Record<string, number> = {
  PROCESSED: 200,
  PENDING_REFERENCE: 202,
  REJECTED: 422,
  FAILED: 422,
};

@Controller()
@UseGuards(AutenticacaoGuard)
export class ApostasController {
  constructor(private readonly apostasService: ApostasService) {}

  /**
   * Recebe uma operação do provedor.
   */
  @Post('wagering/transactions')
  async enviar(
    @Body() corpo: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const dto = validarAposta(corpo, idempotencyKey);
    const resultado = await this.apostasService.processarAposta(dto, {
      origem: 'HTTP',
      correlationId: correlationIdAtual(),
    });

    switch (resultado.tipo) {
      case 'RESULTADO': {
        const transacao = resultado.transacao;
        res.status(STATUS_HTTP[transacao.status] ?? 200);
        return {
          transactionId: transacao.id,
          status: transacao.status,
          balance: resultado.saldo.toJSON(),
          idempotentReplay: resultado.repetida,
          failureCode: transacao.failureCode,
        };
      }
      case 'CONFLITO_DE_IDEMPOTENCIA':
        res.status(409);
        return {
          error: {
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'idempotency key ou externalTransactionId já usados com outro payload',
          },
          transactionId: resultado.transactionId,
        };
      case 'CARTEIRA_NAO_ENCONTRADA':
        res.status(422);
        return { status: 'REJECTED', failureCode: 'WALLET_NOT_FOUND', idempotentReplay: false };
      case 'MENSAGEM_DUPLICADA':
        // só acontece na fila (o HTTP não usa inbox); está aqui para o switch cobrir todos os casos
        res.status(409);
        return { error: { code: 'DUPLICATE_MESSAGE', message: 'mensagem já processada' } };
    }
  }

  /** Consulta pelo id interno. */
  @Get('wagering/transactions/:transactionId')
  async buscarPorId(@Param('transactionId') transactionId: string) {
    return transacaoParaResposta(await this.apostasService.buscarPorId(transactionId));
  }

  /** Consulta pelo id do provedor. */
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async buscarPorIdExterno(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return transacaoParaResposta(await this.apostasService.buscarPorIdExterno(providerId, externalTransactionId));
  }
}

function transacaoParaResposta(transacao: WagerTransaction) {
  return {
    id: transacao.id,
    providerId: transacao.providerId,
    externalTransactionId: transacao.externalTransactionId,
    walletId: transacao.walletId,
    playerId: transacao.playerId,
    roundId: transacao.roundId,
    gameId: transacao.gameId,
    kind: transacao.kind,
    money: transacao.money.toJSON(),
    status: transacao.status,
    failureCode: transacao.failureCode,
    referenceExternalTransactionId: transacao.referenceExternalTransactionId,
    referenceTransactionId: transacao.referenceTransactionId,
    balanceAfter: transacao.balanceAfter?.toJSON(),
    createdAt: transacao.createdAt.toISOString(),
    processedAt: transacao.processedAt?.toISOString(),
  };
}
