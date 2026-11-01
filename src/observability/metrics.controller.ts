import { Controller, Get, Header } from "@nestjs/common";
import { Public } from "../identity/authorization";
import { WageringTelemetry } from "./wagering-telemetry";

@Controller("metrics")
@Public()
export class MetricsController {
  constructor(private readonly telemetry: WageringTelemetry) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  metrics() {
    return this.telemetry.registry.metrics();
  }
}
