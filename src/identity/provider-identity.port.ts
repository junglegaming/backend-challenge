export interface ProviderIdentity {
  clientId: string;
  providerId?: string;
  scopes: readonly string[];
}

export abstract class ProviderIdentityPort {
  abstract authenticate(bearerToken: string): Promise<ProviderIdentity>;
}

export class InvalidIdentityError extends Error {}
export class IdentityUnavailableError extends Error {}
