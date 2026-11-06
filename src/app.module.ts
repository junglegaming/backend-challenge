import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PROVIDER_IDENTITY_PORT } from './application/ports/provider-identity.port';
import { NoopProviderIdentityAdapter } from './infrastructure/auth/noop-provider-identity.adapter';
import { loadConfig } from './infrastructure/config/app-config';
import { buildOrmConfig } from './infrastructure/persistence/mikro-orm.config';
import { AuthGuard } from './interfaces/http/auth.guard';
import { HealthController } from './interfaces/http/health.controller';

@Module({
  imports: [MikroOrmModule.forRoot({ ...buildOrmConfig(loadConfig().databaseUrl) })],
  controllers: [HealthController],
  providers: [
    { provide: PROVIDER_IDENTITY_PORT, useClass: NoopProviderIdentityAdapter },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
