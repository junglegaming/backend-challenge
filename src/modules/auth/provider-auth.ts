import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";

/**
 * Authentication extension point (section 2). Authentication is intentionally NOT implemented:
 * the port and the guard are real, the adapter is a no-op that trusts every caller.
 *
 * Intended production adapter (documented in ARCHITECTURE.md): each game provider is an OIDC client in
 * Keycloak/Zitadel using the client-credentials grant; the adapter validates the bearer JWT against the IdP's
 * JWKS (issuer, audience, expiry) and maps the `provider_id` claim and the token scopes to the principal below.
 */

/**
 * Authorisation scopes. Providers get the `wagers:*` scopes; wallet management (which creates money through the
 * opening balance) and wallet-wide reads belong to the operator's back office.
 */
export const Scope = {
  WagersSubmit: "wagers:submit",
  WagersRead: "wagers:read",
  WalletsRead: "wallets:read",
  WalletsManage: "wallets:manage",
} as const;
export type Scope = (typeof Scope)[keyof typeof Scope];

/** "*" (in providerId or scopes) means trusted internal caller: the no-op adapter. */
export const ANY = "*";

export interface ProviderPrincipal {
  /** The authenticated provider id, or "*" for a trusted internal caller. */
  providerId: string;
  subject: string;
  scopes: readonly string[];
}

export interface ProviderIdentityPort {
  /** Returns the authenticated principal, or undefined when the request carries no valid credentials. */
  resolve(request: Request): Promise<ProviderPrincipal | undefined>;
}

export const PROVIDER_IDENTITY = Symbol("PROVIDER_IDENTITY");
export const IS_PUBLIC = "auth:isPublic";
export const REQUIRED_SCOPE = "auth:requiredScope";

/** Marks routes that never require authentication (health, metrics). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Every non-public route must declare the scope it needs; routes without one are refused (fail closed). */
export const RequireScope = (scope: Scope) => SetMetadata(REQUIRED_SCOPE, scope);

/** Resource ownership: a provider only sees its own transactions; the internal principal sees everything. */
export const canAccessProvider = (principal: ProviderPrincipal, providerId: string) =>
  principal.providerId === ANY || principal.providerId === providerId;

type AuthenticatedRequest = Request & { principal?: ProviderPrincipal };

/** Injects the principal resolved by ProviderAuthGuard. */
export const Principal = createParamDecorator((_: unknown, context: ExecutionContext): ProviderPrincipal => {
  const principal = context.switchToHttp().getRequest<AuthenticatedRequest>().principal;
  if (!principal) throw new UnauthorizedException("missing or invalid credentials");
  return principal;
});

export class NoopProviderIdentity implements ProviderIdentityPort {
  async resolve(): Promise<ProviderPrincipal> {
    return { providerId: ANY, subject: "anonymous", scopes: [ANY] };
  }
}

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = await this.identity.resolve(request);
    if (!principal) throw new UnauthorizedException("missing or invalid credentials");
    request.principal = principal;

    // 1. Scope: declared per route, denied when missing (a new route without a policy is closed, not open).
    const required = this.reflector.getAllAndOverride<Scope | undefined>(REQUIRED_SCOPE, targets);
    if (!required) throw new ForbiddenException("route has no authorisation policy");
    if (!principal.scopes.includes(ANY) && !principal.scopes.includes(required)) {
      throw new ForbiddenException(`missing scope ${required}`);
    }

    // 2. Provider identity: a provider may only act on its own transactions (body or path).
    const bodyProvider = (request.body as { providerId?: unknown } | undefined)?.providerId;
    const paramProvider = request.params?.providerId;
    const claimed =
      typeof bodyProvider === "string"
        ? bodyProvider
        : typeof paramProvider === "string"
          ? paramProvider
          : undefined;
    if (claimed !== undefined && !canAccessProvider(principal, claimed)) {
      throw new ForbiddenException("provider mismatch");
    }
    return true;
  }
}
