import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MetricasService } from '../utils/metricas.service';
import { URLS_DAS_FILAS, type UrlsDasFilas } from '../utils/cliente-sqs';

/** Health checks e métricas: sem autenticação. */
@Controller()
export class SaudeController {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    @Inject(URLS_DAS_FILAS) private readonly filas: UrlsDasFilas,
    private readonly servicoDeMetricas: MetricasService,
  ) {}

  /** Processo vivo. */
  @Get('health/live')
  vivo() {
    return { status: 'ok' };
  }

  /** PostgreSQL e SQS alcançáveis. */
  @Get('health/ready')
  async pronto(@Res({ passthrough: true }) res: Response) {
    const postgres = await estaNoAr(() => this.orm.em.fork().execute('select 1'));
    const sqs = await estaNoAr(() =>
      this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: this.filas.apostas, AttributeNames: ['QueueArn'] })),
    );
    const ok = postgres === 'up' && sqs === 'up';
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'unavailable', postgres, sqs };
  }

  @Get('metrics')
  async metricas(@Res() res: Response) {
    res.setHeader('Content-Type', this.servicoDeMetricas.registro.contentType);
    res.send(await this.servicoDeMetricas.registro.metrics());
  }
}

async function estaNoAr(verificacao: () => Promise<unknown>): Promise<'up' | 'down'> {
  try {
    await verificacao();
    return 'up';
  } catch {
    return 'down';
  }
}
