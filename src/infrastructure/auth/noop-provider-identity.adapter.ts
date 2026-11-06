import type { ProviderIdentity, ProviderIdentityPort } from '../../application/ports/provider-identity.port';

/**
 * Auth is out of scope for the challenge (see ARCHITECTURE.md ADR-002).
 * Swap this adapter for an OIDC implementation (Keycloak/Zitadel) without touching the guard.
 */
export class NoopProviderIdentityAdapter implements ProviderIdentityPort {
  async authenticate(): Promise<ProviderIdentity | null> {
    return { providerId: 'anonymous' };
  }
}
