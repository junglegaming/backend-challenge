import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError } from '../domain/errors';
import { ErroDeConcorrencia, ErroHttp, ErroTemporario } from './erros';
import type { Logger } from './logger';

/**
 * Transforma qualquer erro em resposta HTTP, do mesmo jeito em todos os endpoints:
 *   400 dado inválido · 404 não encontrado · 409 conflito
 *   503 falha temporária (pode reenviar) · 500 erro inesperado
 * (422 rejeição de negócio e 202 pendente são devolvidos pelo controller.)
 */
@Catch()
export class FiltroDeErros implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(erro: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const enviar = (status: number, codigo: string, mensagem: string, detalhes?: unknown) =>
      res.status(status).json({ error: { code: codigo, message: mensagem, details: detalhes } });

    if (erro instanceof ErroHttp) {
      enviar(erro.status, erro.codigo, erro.message, erro.detalhes);
    } else if (erro instanceof DomainError) {
      enviar(400, erro.code, erro.message);
    } else if (erro instanceof ErroTemporario || erro instanceof ErroDeConcorrencia) {
      res.setHeader('Retry-After', '1');
      enviar(503, 'TRANSIENT_FAILURE', erro.message);
    } else if (erro instanceof HttpException) {
      enviar(erro.getStatus(), 'HTTP_ERROR', erro.message);
    } else {
      this.logger.error({ err: (erro as Error)?.message, stack: (erro as Error)?.stack }, 'erro inesperado');
      enviar(500, 'INTERNAL_ERROR', 'erro interno');
    }
  }
}
