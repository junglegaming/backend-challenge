import { Global, Module } from "@nestjs/common";
import { Dependencies } from "./health/dependencies";
import { HealthController } from "./health/health.controller";
import { JsonLogger } from "./json-logger";
import { LogContext } from "./log-context";
import { MetricSampler } from "./metric-sampler";
import { MetricsController } from "./metrics.controller";
import { WageringTelemetry } from "./wagering-telemetry";

@Global()
@Module({
  controllers: [HealthController, MetricsController],
  providers: [Dependencies, JsonLogger, LogContext, MetricSampler, WageringTelemetry],
  exports: [Dependencies, JsonLogger, LogContext, WageringTelemetry],
})
export class ObservabilityModule {}
