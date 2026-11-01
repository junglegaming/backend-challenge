import { Module } from "@nestjs/common";
import { Dependencies } from "./observability/health/dependencies";
import { HealthController } from "./observability/health/health.controller";
import { DatabaseModule } from "./shared/infrastructure/database.module";

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController],
  providers: [Dependencies],
})
export class AppModule {}
