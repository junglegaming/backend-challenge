export interface ProviderIdentity {
  providerId: string;
}

export interface ProviderIdentityPort {
  /** Resolves the caller from request credentials; `null` means unauthenticated. */
  authenticate(credentials: { authorization?: string | undefined }): Promise<ProviderIdentity | null>;
}

export const PROVIDER_IDENTITY_PORT = Symbol('ProviderIdentityPort');
