import { Module } from "@nestjs/common";
import { Dependencies } from "./observability/health/dependencies";
import { HealthController } from "./observability/health/health.controller";
import { DatabaseModule } from "./shared/infrastructure/database.module";
import { WageringModule } from "./wagering/wagering.module";

@Module({
  imports: [DatabaseModule, WageringModule],
  controllers: [HealthController],
  providers: [Dependencies],
})
export class AppModule {}
