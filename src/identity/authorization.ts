import { CanActivate, ExecutionContext, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiError, HttpRequest } from "../shared/http/http-contract";
import { IdentityUnavailableError, ProviderIdentityPort } from "./provider-identity.port";

const PUBLIC = "identity.public";
const SCOPES = "identity.scopes";
export const Public = () => SetMetadata(PUBLIC, true);
export const Scopes = (...scopes: string[]) => SetMetadata(SCOPES, scopes);

@Injectable()
export class IdentityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;
    const request = context.switchToHttp().getRequest<HttpRequest>();
    const header = request.headers.authorization;
    if (typeof header !== "string" || !/^Bearer [^\s]+$/i.test(header))
      throw new ApiError(401, "UNAUTHENTICATED", "A valid bearer token is required");
    try {
      request.identity = await this.identity.authenticate(header.slice(7));
    } catch (error) {
      if (error instanceof IdentityUnavailableError)
        throw new ApiError(
          503,
          "TEMPORARILY_UNAVAILABLE",
          "Identity verification is temporarily unavailable",
        );
      throw new ApiError(401, "UNAUTHENTICATED", "A valid bearer token is required");
    }
    const scopes = this.reflector.getAllAndOverride<string[]>(SCOPES, targets) ?? [];
    if (!scopes.length || !scopes.some((scope) => request.identity?.scopes.includes(scope)))
      throw new ApiError(403, "INSUFFICIENT_SCOPE", "The token does not allow this operation");
    return true;
  }
}
