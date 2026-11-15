import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { LogContext } from '../../application/log-context';

const HEADER = 'x-correlation-id';
const VALID = /^[A-Za-z0-9._:\-]{1,128}$/;

/** Opens the async log context of a request and echoes the correlation id. */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header(HEADER);
    const correlationId = incoming && VALID.test(incoming) ? incoming : randomUUID();
    res.setHeader(HEADER, correlationId);
    LogContext.run({ correlationId }, next);
  }
}
