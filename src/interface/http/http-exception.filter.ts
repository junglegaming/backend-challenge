import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Inject } from '@nestjs/common';
import type { Response } from 'express';
import { ApplicationError, type ErrorCategory } from '../../application/errors';
import { STRUCTURED_LOGGER, type StructuredLogger } from '../../application/ports';
import { DomainError } from '../../domain/errors';

const STATUS: Record<ErrorCategory, number> = {
  validation: HttpStatus.BAD_REQUEST,
  'not-found': HttpStatus.NOT_FOUND,
  conflict: HttpStatus.CONFLICT,
  transient: HttpStatus.SERVICE_UNAVAILABLE,
  integrity: HttpStatus.INTERNAL_SERVER_ERROR,
};

interface ErrorBody {
  error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
}

/**
 * Uniform error envelope for every endpoint. `retryable` mirrors the status
 * code so providers never need to parse messages:
 *   400 INVALID_PAYLOAD          fix the request
 *   404 *_NOT_FOUND              unknown wallet / transaction
 *   409 *_CONFLICT               idempotency key / external id reused with another payload
 *   422 (body status REJECTED)   business rejection — returned by the controller, not here
 *   202 (PENDING_REFERENCE)      accepted, processing pending
 *   503 TEMPORARILY_UNAVAILABLE  transient infrastructure failure — retry (Retry-After)
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(@Inject(STRUCTURED_LOGGER) private readonly logger: StructuredLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const [status, body] = this.map(exception);
    if (status === HttpStatus.SERVICE_UNAVAILABLE) response.setHeader('Retry-After', '1');
    if (status >= 500) {
      this.logger.error('request failed', {
        status,
        code: body.error.code,
        error: exception instanceof Error ? exception.message : String(exception),
        stack: exception instanceof Error ? exception.stack : undefined,
      });
    }
    response.status(status).json(body);
  }

  private map(exception: unknown): [number, ErrorBody] {
    if (exception instanceof ApplicationError) {
      const status = STATUS[exception.category];
      return [status, this.body(exception.code, exception.message, exception.category === 'transient', exception.details)];
    }
    if (exception instanceof DomainError) {
      return [HttpStatus.BAD_REQUEST, this.body('INVALID_PAYLOAD', exception.message, false)];
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = HttpStatus[status] ?? 'HTTP_ERROR';
      return [status, this.body(String(code), exception.message, status >= 500)];
    }
    return [HttpStatus.INTERNAL_SERVER_ERROR, this.body('INTERNAL_ERROR', 'Internal error', true)];
  }

  private body(code: string, message: string, retryable: boolean, details?: Record<string, unknown>): ErrorBody {
    return { error: { code, message, retryable, ...(details ? { details } : {}) } };
  }
}
