import { Module } from "@nestjs/common";
import { IdentityModule } from "./identity/identity.module";
import { MessagingRuntimeModule } from "./messaging/messaging-runtime.module";
import { Dependencies } from "./observability/health/dependencies";
import { HealthController } from "./observability/health/health.controller";
import { MetricsController } from "./observability/metrics.controller";
import { DatabaseModule } from "./shared/infrastructure/database.module";
import { WageringModule } from "./wagering/wagering.module";

@Module({
  imports: [DatabaseModule, IdentityModule, WageringModule, MessagingRuntimeModule],
  controllers: [HealthController, MetricsController],
  providers: [Dependencies],
})
export class AppModule {}
