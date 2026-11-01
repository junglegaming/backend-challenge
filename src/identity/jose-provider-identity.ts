import { Injectable } from "@nestjs/common";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import { Configuration } from "../config/config";
import {
  IdentityUnavailableError,
  InvalidIdentityError,
  ProviderIdentity,
  ProviderIdentityPort,
} from "./provider-identity.port";

@Injectable()
export class JoseProviderIdentity extends ProviderIdentityPort {
  private readonly jwks;

  constructor(private readonly configuration: Configuration) {
    super();
    this.jwks = createRemoteJWKSet(new URL(configuration.values.auth.jwksUrl), {
      cacheMaxAge: 600_000,
      cooldownDuration: 30_000,
      timeoutDuration: 2000,
    });
  }

  override async authenticate(bearerToken: string): Promise<ProviderIdentity> {
    try {
      const { payload } = await jwtVerify(
        bearerToken,
        async (header, token) => {
          try {
            return await this.jwks(header, token);
          } catch (error) {
            if (error instanceof errors.JWKSNoMatchingKey) throw new InvalidIdentityError();
            throw new IdentityUnavailableError();
          }
        },
        {
          algorithms: ["RS256"],
          issuer: this.configuration.values.auth.issuer,
          audience: "wagering-api",
          clockTolerance: 5,
          requiredClaims: ["exp"],
        },
      );
      if (
        typeof payload.azp !== "string" ||
        !payload.azp ||
        (payload.scope !== undefined && typeof payload.scope !== "string") ||
        (payload.provider_id !== undefined && typeof payload.provider_id !== "string")
      )
        throw new InvalidIdentityError();
      return {
        clientId: payload.azp,
        providerId: payload.provider_id as string | undefined,
        scopes: (payload.scope as string | undefined)?.split(/\s+/).filter(Boolean) ?? [],
      };
    } catch (error) {
      if (error instanceof IdentityUnavailableError) throw error;
      throw new InvalidIdentityError();
    }
  }
}
