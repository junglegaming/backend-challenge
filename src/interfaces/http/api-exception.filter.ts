import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import {
  ApplicationError,
  IdempotencyConflictError,
  InvalidRequestError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors';
import { DomainError } from '../../domain/shared/domain-error';

export const RETRY_AFTER_SECONDS = 1;

function statusFor(error: unknown): number {
  if (error instanceof IdempotencyConflictError || error instanceof WalletAlreadyExistsError) return HttpStatus.CONFLICT;
  if (error instanceof WalletNotFoundError) return HttpStatus.NOT_FOUND;
  if (error instanceof TransientInfrastructureError) return HttpStatus.SERVICE_UNAVAILABLE;
  if (error instanceof InvalidRequestError || error instanceof DomainError) return HttpStatus.BAD_REQUEST;
  if (error instanceof HttpException) return error.getStatus();
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

/** One error envelope for every endpoint: `{ error: { code, message } }`. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = statusFor(error);

    let code = 'INTERNAL_ERROR';
    let message = 'Unexpected error';
    if (error instanceof ApplicationError || error instanceof DomainError) {
      code = error.code;
      message = error.message;
    } else if (error instanceof HttpException) {
      code = status === HttpStatus.BAD_REQUEST ? 'INVALID_REQUEST' : 'HTTP_ERROR';
      message = error.message;
    }

    if (status >= 500) {
      const cause = error instanceof Error && error.cause instanceof Error ? ` (cause: ${error.cause.message})` : '';
      this.logger.error(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}${cause}`);
    }
    if (status === HttpStatus.SERVICE_UNAVAILABLE) response.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));

    response.status(status).json({ error: { code, message } });
  }
}
