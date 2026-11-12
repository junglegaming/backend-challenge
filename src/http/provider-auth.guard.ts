import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from "@nestjs/common";

export const IS_PUBLIC_ROUTE = "IS_PUBLIC_ROUTE";
export const Public = () => SetMetadata(IS_PUBLIC_ROUTE, true);

export interface AuthenticatedPrincipal {
  subject: string;
  providerId?: string;
  scopes: readonly string[];
}

/**
 * Extension point for external Identity Provider (Keycloak / Zitadel OIDC JWT)
 * verification, as described in Section 2 of the challenge and ADR-09 in
 * `ARCHITECTURE.md`.
 */
export interface ProviderIdentityPort {
  verifyRequest(headers: Record<string, string | string[] | undefined>): Promise<AuthenticatedPrincipal | null>;
}

export const PROVIDER_IDENTITY_PORT = Symbol("PROVIDER_IDENTITY_PORT");

/**
 * Default no-op identity adapter used for the challenge evaluation.
 * In production, replace this provider with a JWKS/OIDC adapter validating
 * tokens issued by Keycloak or Zitadel.
 */
@Injectable()
export class NoopProviderIdentityAdapter implements ProviderIdentityPort {
  async verifyRequest(): Promise<AuthenticatedPrincipal | null> {
    return {
      subject: "noop-authenticated-client",
      scopes: ["wallets:write", "wallets:read", "wagering:write", "wagering:read"],
    };
  }
}

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    @Inject(PROVIDER_IDENTITY_PORT) private readonly identityPort: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const cls = context.getClass();
    const isPublic =
      Reflect.getMetadata(IS_PUBLIC_ROUTE, handler) === true ||
      Reflect.getMetadata(IS_PUBLIC_ROUTE, cls) === true;

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      principal?: AuthenticatedPrincipal;
    }>();
    const principal = await this.identityPort.verifyRequest(request.headers ?? {});
    if (!principal) {
      return false;
    }
    request.principal = principal;
    return true;
  }
}

