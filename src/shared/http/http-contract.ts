import { HttpException } from "@nestjs/common";
import { ProviderIdentity } from "../../identity/provider-identity.port";

export interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
  correlationId: string;
  identity?: ProviderIdentity;
}
export interface HttpReply {
  status(code: number): HttpReply;
  header(name: string, value: string): HttpReply;
  send(body: unknown): unknown;
}
export class ApiError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message, status);
  }
}
