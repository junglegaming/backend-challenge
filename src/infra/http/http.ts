import { ArgumentsHost, CanActivate, Catch, ExceptionFilter, HttpException, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  IdempotencyConflictError,
  NotFoundError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors';
import { ValidationError } from '../../domain/errors';
import { newId } from '../../domain/id';
import { logger } from '../../observability/logger';

/**
 * Ponto de extensão de autenticação — hoje um no-op deliberado (ver ARCHITECTURE.md, "Autenticação").
 * O desenho previsto: validar um JWT emitido por um IdP externo (Keycloak/Zitadel, client
 * credentials por provedor) e exigir que o claim do provedor seja igual ao `providerId` do payload.
 * Health e métricas não passam por este guard.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

export const correlationIdOf = (req: Request): string => {
  const header = req.headers['x-correlation-id'];
  return typeof header === 'string' && header.length > 0 && header.length <= 100 ? header : newId();
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const uuidParam = (value: string, name: string): string => {
  if (!UUID.test(value)) throw new ValidationError(`${name} must be a UUID`);
  return value;
};

/**
 * Mapeamento único de erro → HTTP, igual em todos os endpoints. O provedor decide pelo status:
 *   400 corrija o payload · 404 não existe · 409 conflito (não reenvie igual) ·
 *   422 recusado por regra de negócio · 503 falha transitória (reenvie com a mesma key)
 */
const STATUS: [new (...args: any[]) => Error, number, string][] = [
  [ValidationError, 400, 'INVALID_PAYLOAD'],
  [NotFoundError, 404, 'NOT_FOUND'],
  [IdempotencyConflictError, 409, 'IDEMPOTENCY_CONFLICT'],
  [WalletAlreadyExistsError, 409, 'WALLET_ALREADY_EXISTS'],
  [WalletNotFoundError, 422, 'WALLET_NOT_FOUND'],
];

@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();

    const known = STATUS.find(([type]) => error instanceof type);
    if (known) {
      res.status(known[1]).json({ error: { code: known[2], message: (error as Error).message } });
      return;
    }
    if (error instanceof HttpException) {
      // erros do próprio framework: rota inexistente, JSON malformado, corpo grande demais
      const status = error.getStatus();
      res.status(status).json({ error: { code: status === 404 ? 'NOT_FOUND' : 'INVALID_PAYLOAD', message: error.message } });
      return;
    }
    // Todo o resto é tratado como transitório: nada foi confirmado, reenviar é seguro.
    logger.error({ err: error, path: req.path }, 'request failed with a transient error');
    res.status(503).setHeader('Retry-After', '1').json({ error: { code: 'TEMPORARILY_UNAVAILABLE', message: 'try again with the same Idempotency-Key' } });
  }
}
