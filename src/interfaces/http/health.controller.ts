import { Controller, Get } from '@nestjs/common';
import { Public } from './public.decorator';

@Controller('health')
@Public()
export class HealthController {
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
