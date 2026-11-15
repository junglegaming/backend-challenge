import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Response } from 'express';
import { SqsGateway } from '../../infrastructure/messaging/sqs-gateway';
import { PrometheusMetrics } from '../../infrastructure/observability/metrics';
import { Public } from './auth';

export const MIKRO_ORM = Symbol('MikroORM');

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms))]);

const probe = async (check: () => Promise<unknown>): Promise<{ status: 'up' | 'down'; error?: string }> => {
  try {
    await withTimeout(check(), 2_000);
    return { status: 'up' };
  } catch (error) {
    return { status: 'down', error: error instanceof Error ? error.message : String(error) };
  }
};

@Public()
@Controller()
export class HealthController {
  constructor(
    @Inject(MIKRO_ORM) private readonly orm: MikroORM,
    private readonly sqs: SqsGateway,
    private readonly metrics: PrometheusMetrics,
  ) {}

  /** Liveness: the process and its event loop respond. No dependency checks. */
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL and SQS are reachable. 503 otherwise. */
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    const [postgres, sqs] = await Promise.all([
      probe(() => this.orm.em.fork().execute('SELECT 1')),
      probe(() => this.sqs.ping()),
    ]);
    const ok = postgres.status === 'up' && sqs.status === 'up';
    response.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'unavailable', checks: { postgres, sqs } };
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  metricsText() {
    return this.metrics.registry.metrics();
  }
}
