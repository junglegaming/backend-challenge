import type { Message } from "@aws-sdk/client-sqs";
import { SqsTransport } from "../src/messaging/infrastructure/sqs-transport";
import { QUEUES } from "../src/observability/health/dependencies";
import { UnitOfWork } from "../src/shared/application/unit-of-work";
import { EventConsumer } from "../test/support/event-consumer";
import { parallelEach } from "./model";

export const SENTINEL = "WAGERING_SAFE_SDK_FAILURE ";
export const FATAL_SENTINEL = "WAGERING_SAFE_SDK_FATAL ";
export const READY = "WAGERING_SAFE_SDK_READY";
const COMMANDS = [
  "GetQueueUrlCommand",
  "GetQueueAttributesCommand",
  "ReceiveMessageCommand",
  "DeleteMessageCommand",
  "SendMessageCommand",
  "SendMessageBatchCommand",
  "ChangeMessageVisibilityCommand",
];
const NAMES = [
  "RequestThrottled",
  "Throttling",
  "ThrottlingException",
  "TooManyRequestsException",
  "AccessDenied",
  "AccessDeniedException",
  "AWS.SimpleQueueService.AccessDenied",
  "ReceiptHandleIsInvalid",
  "InvalidParameterValue",
  "InvalidAddress",
  "InvalidSecurity",
  "QueueDoesNotExist",
  "AWS.SimpleQueueService.NonExistentQueue",
  "OverLimit",
  "KmsAccessDenied",
  "KmsThrottled",
  "ServiceUnavailable",
  "InternalError",
  "InvalidClientTokenId",
  "ExpiredToken",
  "ExpiredTokenException",
  "CredentialsProviderError",
  "TimeoutError",
  "AbortError",
  "TypeError",
  "Error",
];
export function closedSdkFailure(command: unknown, error: unknown) {
  const value = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number; attempts?: number };
  } | null;
  return {
    operation: COMMANDS.includes(command as string) ? command : "UNKNOWN",
    name: typeof value?.name === "string" && NAMES.includes(value.name) ? value.name : "UNKNOWN",
    httpStatus:
      typeof value?.$metadata?.httpStatusCode === "number" &&
      Number.isInteger(value.$metadata.httpStatusCode) &&
      value.$metadata.httpStatusCode >= 100 &&
      value.$metadata.httpStatusCode <= 599
        ? value.$metadata.httpStatusCode
        : null,
    attempts:
      typeof value?.$metadata?.attempts === "number" &&
      Number.isInteger(value.$metadata.attempts) &&
      value.$metadata.attempts >= 1 &&
      value.$metadata.attempts <= 10
        ? value.$metadata.attempts
        : null,
  };
}

export const ACK_READY = "WAGERING_EVENT_ACK_RETRY_READY";
export const ACK_STATS = "WAGERING_EVENT_ACK_RETRY_STATS ";
export const ACK_BACKOFF_CAPS_MS = [50, 100, 200, 400, 800, 1000] as const;
export function createEventAcknowledger(
  transport: Pick<SqsTransport, "acknowledge">,
  signal: AbortSignal,
  options: {
    now?: () => number;
    random?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const now = options.now ?? Date.now,
    random = options.random ?? Math.random;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stats = {
    calls: 0,
    attempts: 0,
    retries: 0,
    backoffMs: 0,
    acknowledged: 0,
    failed: 0,
    retryableErrors: 0,
    exhausted: 0,
    deadlineStopped: 0,
    maxAttemptsObserved: 0,
  };
  const acknowledge = async (name: string, message: Message) => {
    if (name !== QUEUES.events) return transport.acknowledge(name, message);
    stats.calls++;
    const limit = now() + 20_000;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 7; attempt++) {
      // The original ACK already has a 2s abort timeout. Never start one without its budget.
      if (signal.aborted || now() + 2000 >= limit) {
        stats.failed++;
        stats.deadlineStopped++;
        if (lastError) stats.exhausted++;
        if (lastError) throw lastError;
        throw new Error("Event ACK cutoff reached");
      }
      stats.attempts++;
      if (attempt > 1) stats.retries++;
      stats.maxAttemptsObserved = Math.max(stats.maxAttemptsObserved, attempt);
      try {
        const value = await transport.acknowledge(name, message);
        stats.acknowledged++;
        return value;
      } catch (error: unknown) {
        lastError = error;
        const failure = closedSdkFailure("DeleteMessageCommand", error);
        if (failure.name !== "RequestThrottled" || failure.httpStatus !== 403) {
          stats.failed++;
          throw error;
        }
        stats.retryableErrors++;
        if (attempt === 7) {
          stats.failed++;
          stats.exhausted++;
          throw error;
        }
        const cap = ACK_BACKOFF_CAPS_MS[attempt - 1]!;
        const sample = random();
        const delay = Math.floor(
          Math.max(0, Math.min(1, Number.isFinite(sample) ? sample : 0)) * cap,
        );
        if (signal.aborted || now() + delay + 2000 >= limit) {
          stats.failed++;
          stats.exhausted++;
          stats.deadlineStopped++;
          throw error;
        }
        stats.backoffMs += delay;
        await sleep(delay);
      }
    }
    throw lastError;
  };
  return { acknowledge, stats };
}

// A measurement instrument, never part of the application or delivered test prerequisites.
export class LoadEventObserver {
  private readonly abort = new AbortController();
  private readonly consumer: EventConsumer;
  private readonly acknowledged = new Set<string>();
  private loop: Promise<void> | undefined;
  private failure: unknown;
  private deliveries = 0;
  private active = 0;
  private readonly acknowledger: ReturnType<typeof createEventAcknowledger>;
  private readonly sdkFailures = new WeakMap<object, ReturnType<typeof closedSdkFailure>>();

  constructor(
    uow: UnitOfWork,
    private readonly transport: SqsTransport,
    readonly name: string,
    cancellation?: AbortSignal,
  ) {
    // Normal observer.stop() drains existing handlers; only the load runtime signal cancels ACK retries.
    const signal = cancellation ?? new AbortController().signal;
    this.acknowledger = createEventAcknowledger(transport, signal);
    this.consumer = new EventConsumer(
      uow,
      {
        receive: (...args) => transport.receive(...args),
        acknowledge: this.acknowledger.acknowledge,
      },
      name,
    );
    let firstFailure = false;
    transport.client.middlewareStack.add(
      (next, context) => async (input) => {
        try {
          return await next(input);
        } catch (error) {
          const isFirstFailure = !firstFailure;
          firstFailure = true;
          try {
            const failure = closedSdkFailure(context.commandName, error);
            if (typeof error === "object" && error !== null && failure.operation !== "UNKNOWN")
              this.sdkFailures.set(error, failure);
            if (isFirstFailure) console.error(SENTINEL + JSON.stringify(failure));
          } catch {}
          throw error;
        }
      },
      { name: "closedLoadSdkDiagnostic", step: "initialize", priority: "high" },
    );
    try {
      console.error(READY);
      console.error(ACK_READY);
    } catch {}
  }

  sdkFailureFor(error: unknown): ReturnType<typeof closedSdkFailure> | null {
    try {
      if (typeof error !== "object" || error === null) return null;
      const direct = this.sdkFailures.get(error);
      if (direct) return direct;
      // snapshot() wraps the actual observer error once. Never walk arbitrary cause chains.
      if (!(error instanceof Error)) return null;
      const cause = Object.getOwnPropertyDescriptor(error, "cause");
      return cause && "value" in cause && typeof cause.value === "object" && cause.value !== null
        ? (this.sdkFailures.get(cause.value) ?? null)
        : null;
    } catch {
      return null;
    }
  }

  async start() {
    if (this.loop) throw new Error("Event observer already started");
    await this.consumer.initialize();
    this.loop = this.run().catch((error: unknown) => {
      this.failure = error;
    });
  }

  private async run() {
    while (!this.abort.signal.aborted) {
      let messages: Awaited<ReturnType<SqsTransport["receive"]>>;
      try {
        messages = await this.transport.receive(QUEUES.events, this.abort.signal);
      } catch (error) {
        if (this.abort.signal.aborted) return;
        throw error;
      }
      await parallelEach(messages, 10, async (message) => {
        this.active++;
        try {
          const received = await this.consumer.consume(message);
          this.acknowledged.add(received.payload.eventId);
          this.deliveries++;
          // Keep technical identities/counts only, not financial envelopes or receipt handles.
          this.consumer.deliveries.delete(received.payload.eventId);
        } finally {
          this.active--;
        }
      });
    }
  }

  snapshot() {
    if (this.failure) throw new Error("Event observer failed", { cause: this.failure });
    return {
      distinctAcknowledged: this.acknowledged.size,
      deliveries: this.deliveries,
      duplicates: this.deliveries - this.acknowledged.size,
      activeHandlers: this.active,
    };
  }

  async stop() {
    this.abort.abort();
    try {
      await this.loop;
      return this.snapshot();
    } finally {
      // Emit only counts, even when snapshot rethrows the original observer failure.
      try {
        console.error(ACK_STATS + JSON.stringify(this.acknowledger.stats));
      } catch {}
    }
  }
}
