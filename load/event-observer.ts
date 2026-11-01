import { SqsTransport } from "../src/messaging/infrastructure/sqs-transport";
import { QUEUES } from "../src/observability/health/dependencies";
import { UnitOfWork } from "../src/shared/application/unit-of-work";
import { EventConsumer } from "../test/support/event-consumer";
import { parallelEach } from "./model";

// A measurement instrument, never part of the application or delivered test prerequisites.
export class LoadEventObserver {
  private readonly abort = new AbortController();
  private readonly consumer: EventConsumer;
  private readonly acknowledged = new Set<string>();
  private loop: Promise<void> | undefined;
  private failure: unknown;
  private deliveries = 0;
  private active = 0;

  constructor(
    uow: UnitOfWork,
    private readonly transport: SqsTransport,
    readonly name: string,
  ) {
    this.consumer = new EventConsumer(uow, transport, name);
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
    await this.loop;
    return this.snapshot();
  }
}
