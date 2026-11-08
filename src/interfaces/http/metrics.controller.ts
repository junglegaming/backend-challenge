import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { PrometheusMetrics } from '../../infrastructure/observability/prometheus-metrics';
import { METRICS } from '../../application/ports/wallet-queries.port';
import { Public } from './public.decorator';

@Controller('metrics')
@Public()
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: PrometheusMetrics) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  render(): Promise<string> {
    return this.metrics.render();
  }
}
