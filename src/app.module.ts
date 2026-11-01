import { Module } from "@nestjs/common";
import { IdentityModule } from "./identity/identity.module";
import { MessagingRuntimeModule } from "./messaging/messaging-runtime.module";
import { ObservabilityModule } from "./observability/observability.module";
import { DatabaseModule } from "./shared/infrastructure/database.module";
import { WageringModule } from "./wagering/wagering.module";

@Module({
  imports: [
    DatabaseModule,
    ObservabilityModule,
    IdentityModule,
    WageringModule,
    MessagingRuntimeModule,
  ],
})
export class AppModule {}
