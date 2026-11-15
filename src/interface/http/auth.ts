import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

/**
 * Authentication extension point (see ARCHITECTURE.md, "Authentication").
 *
 * Authentication is intentionally NOT implemented in this delivery. The
 * intended design is OIDC client-credentials issued by an external IdP
 * (Keycloak/Zitadel): each game provider is a confidential client, the API
 * validates the JWT (issuer, audience, signature via JWKS) and maps a claim
 * (e.g. `provider_id`) to the ProviderIdentity below. Swapping the binding of
 * AUTHENTICATOR is the only change needed; controllers already enforce that
 * the authenticated provider matches the payload's providerId.
 */
export interface ProviderIdentity {
  subject: string;
  /** when present, the caller may only act on behalf of this provider */
  providerId?: string;
}

export interface Authenticator {
  authenticate(request: Request): Promise<ProviderIdentity | undefined>;
}

export const AUTHENTICATOR = Symbol('Authenticator');

/** Default binding: accepts every caller as an anonymous, unrestricted identity. */
export class NoopAuthenticator implements Authenticator {
  async authenticate(): Promise<ProviderIdentity> {
    return { subject: 'anonymous' };
  }
}

const IS_PUBLIC = 'isPublic';
/** Marks a route as open (health checks, metrics). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export type AuthenticatedRequest = Request & { identity?: ProviderIdentity };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTHENTICATOR) private readonly authenticator: Authenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const identity = await this.authenticator.authenticate(request);
    if (!identity) throw new UnauthorizedException();
    request.identity = identity;
    return true;
  }
}

/** Domain-level authorization: a provider can only submit its own transactions. */
export const assertActsFor = (identity: ProviderIdentity | undefined, providerId: string): void => {
  if (identity?.providerId !== undefined && identity.providerId !== providerId) {
    throw new ForbiddenException('Authenticated provider does not match providerId');
  }
};
