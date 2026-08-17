import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';

/** Liveness probe — exempt from rate limiting and auth. */
@Controller('api/health')
export class HealthController {
  @Get()
  @Public()
  check() {
    return { status: 'ok', uptime: Math.floor(process.uptime()), timestamp: new Date().toISOString() };
  }
}
