import { newId } from "../shared/id";

/** Correlation data propagated from the request/message that caused the event. */
export interface EventContext {
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

/** Serialized envelope stored in the outbox and published to SQS. */
export interface IntegrationEventEnvelope<T = unknown> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

/**
 * Base class for every event published to other services.
 *
 * `eventType` and `version` live in each subclass type (not as loose strings
 * at the call site). `data` only holds JSON-stable values (MoneyProps strings,
 * never Money instances) so the payload is versionable.
 *
 * Consumers must deduplicate by `eventId`: the outbox guarantees at-least-once.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = { ...props.data };
  }

  /** Builds the common props for subclasses' factories. */
  protected static baseProps<T>(aggregateId: string, ctx: EventContext, data: T): IntegrationEventProps<T> {
    return {
      eventId: newId(),
      aggregateId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data,
    };
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: { ...this.data } as T,
    };
  }
}

