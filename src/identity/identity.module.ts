import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { IdentityGuard } from "./authorization";
import { JoseProviderIdentity } from "./jose-provider-identity";
import { ProviderIdentityPort } from "./provider-identity.port";

@Module({
  providers: [
    { provide: ProviderIdentityPort, useClass: JoseProviderIdentity },
    { provide: APP_GUARD, useClass: IdentityGuard },
  ],
})
export class IdentityModule {}
