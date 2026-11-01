import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable } from "@nestjs/common";

export type LogFields = Record<string, string | number | boolean | undefined>;
export type ProcessingChannel = "http" | "sqs" | "pending";

@Injectable()
export class LogContext {
  private readonly storage = new AsyncLocalStorage<LogFields>();

  run<T>(fields: LogFields, work: () => T): T {
    return this.storage.run({ ...this.current(), ...fields }, work);
  }
  current(): LogFields {
    return this.storage.getStore() ?? {};
  }
  add(fields: LogFields): void {
    const current = this.storage.getStore();
    if (current) Object.assign(current, fields);
  }
  channel(): ProcessingChannel {
    const channel = this.current().channel;
    return channel === "sqs" || channel === "pending" ? channel : "http";
  }
}
