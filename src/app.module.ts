import { Module } from "@nestjs/common";
import { Configuration } from "./config/config";
import { Dependencies } from "./observability/health/dependencies";
import { HealthController } from "./observability/health/health.controller";

@Module({
  controllers: [HealthController],
  providers: [Configuration, Dependencies],
})
export class AppModule {}
