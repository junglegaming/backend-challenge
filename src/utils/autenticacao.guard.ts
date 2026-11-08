import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/**
 * Hoje é no-op: autenticação não vale pontos no desafio. O desenho previsto é
 * validar um JWT (client credentials) emitido por um IdP externo (Keycloak),
 * via JWKS, e exigir que o claim do provedor seja igual ao `providerId` do
 * payload. Endpoints de health ficam abertos (não usam este guard).
 */
@Injectable()
export class AutenticacaoGuard implements CanActivate {
  canActivate(_contexto: ExecutionContext): boolean {
    return true;
  }
}
