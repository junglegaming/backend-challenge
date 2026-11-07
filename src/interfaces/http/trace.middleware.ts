import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { correlationId, runWithContext, validCorrelationId } from '../../application/observability/context';
import type { Telemetry } from '../../application/observability/telemetry';
import { METRICS } from '../../application/ports/wallet-queries.port';
import { JsonLogger } from '../../infrastructure/observability/json-logger';

@Injectable()
export class TraceMiddleware implements NestMiddleware {
  private readonly logger = new JsonLogger(TraceMiddleware.name);
  constructor(@Inject(METRICS) private readonly metrics: Telemetry) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const header = req.headers['x-correlation-id'];
    if (header !== undefined && !validCorrelationId(header)) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid X-Correlation-Id' } });
      return;
    }
    const id = correlationId(header);
    res.setHeader('X-Correlation-Id', id);
    const started = performance.now();
    const context = { correlationId: id };
    runWithContext(context, () => {
      res.once('finish', () => runWithContext(context, () => {
        this.metrics.latency('http', (performance.now() - started) / 1000);
        this.logger.log(`HTTP ${req.method} ${res.statusCode}`);
      }));
      next();
    });
  }
}
