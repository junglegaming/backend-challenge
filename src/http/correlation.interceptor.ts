import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { newId } from "../domain/shared/id";
import { runWithContext } from "../observability/context";

/**
 * Wraps every HTTP request in a correlation context (`AsyncLocalStorage`) and
 * echoes `x-correlation-id` back in the response header.
 */
@Injectable()
export class CorrelationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<{ headers?: Record<string, string | string[] | undefined> }>();
    const res = http.getResponse<{ setHeader?: (name: string, value: string) => void }>();

    const headerValue = req.headers?.["x-correlation-id"];
    const incoming = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    const correlationId = incoming?.trim() || newId();

    if (typeof res.setHeader === "function") {
      res.setHeader("x-correlation-id", correlationId);
    }

    return new Observable((subscriber) => {
      runWithContext({ correlationId, channel: "http" }, () => {
        next.handle().subscribe(subscriber);
      });
    });
  }
}

