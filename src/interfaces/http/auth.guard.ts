import { type CanActivate, type ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PROVIDER_IDENTITY_PORT, type ProviderIdentityPort } from '../../application/ports/provider-identity.port';
import { PUBLIC_KEY } from './public.decorator';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(PROVIDER_IDENTITY_PORT) private readonly identity: ProviderIdentityPort,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    const identity = await this.identity.authenticate({ authorization: request.headers.authorization });
    if (!identity) throw new UnauthorizedException();
    return true;
  }
}
