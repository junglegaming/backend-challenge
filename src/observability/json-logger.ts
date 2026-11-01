import { hostname } from "node:os";
import { Injectable, LoggerService } from "@nestjs/common";
import pino from "pino";
import { Configuration } from "../config/config";
import { LogContext, LogFields } from "./log-context";

const allowed = new Set([
  "event",
  "correlationId",
  "messageId",
  "transactionId",
  "walletId",
  "providerId",
  "role",
  "instanceId",
  "channel",
  "attempt",
  "outcome",
  "confirmed",
  "eventId",
  "eventType",
  "aggregateId",
  "visibilitySeconds",
  "drained",
  "reason",
  "operationId",
  "point",
  "moved",
  "statusCode",
]);

@Injectable()
export class JsonLogger implements LoggerService {
  private readonly output = pino({ base: undefined });
  private readonly instanceId = hostname();
  constructor(
    private readonly config: Configuration,
    private readonly context: LogContext,
  ) {}

  private fields(fields: LogFields): LogFields {
    return Object.fromEntries(
      Object.entries({
        ...this.context.current(),
        ...fields,
        role: this.config.values.role,
        instanceId: this.instanceId,
      }).filter(
        ([key, value]) =>
          allowed.has(key) &&
          (typeof value === "string" || typeof value === "number" || typeof value === "boolean"),
      ),
    );
  }
  info(fields: LogFields): void {
    this.output.info(this.fields(fields));
  }
  warning(fields: LogFields): void {
    this.output.warn(this.fields(fields));
  }
  failure(fields: LogFields): void {
    this.output.error(this.fields(fields));
  }

  // Framework messages and exceptions can contain headers or SQL values. Only stable events cross this boundary.
  log(_message: unknown, ..._params: unknown[]): void {
    this.info({ event: "nest_log" });
  }
  error(_message: unknown, ..._params: unknown[]): void {
    this.failure({ event: "nest_error" });
  }
  warn(_message: unknown, ..._params: unknown[]): void {
    this.warning({ event: "nest_warning" });
  }
  debug(_message: unknown, ..._params: unknown[]): void {
    this.info({ event: "nest_debug" });
  }
  verbose(_message: unknown, ..._params: unknown[]): void {
    this.info({ event: "nest_verbose" });
  }
  fatal(_message: unknown, ..._params: unknown[]): void {
    this.failure({ event: "nest_fatal" });
  }
}
