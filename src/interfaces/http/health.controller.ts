import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Readiness, ReadinessReport } from '../../infrastructure/health/readiness';
import { Public } from './public.decorator';
import { READINESS } from './tokens';

@Controller('health')
@Public()
export class HealthController {
  constructor(@Inject(READINESS) private readonly readiness: Readiness) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessReport> {
    const report = await this.readiness.check();
    if (report.status !== 'ok') res.status(503);
    return report;
  }
}
