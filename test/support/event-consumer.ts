import { Message } from "@aws-sdk/client-sqs";
import { InboxMessage } from "../../src/messaging/domain/inbox-message";
import { SqlInboxStore } from "../../src/messaging/infrastructure/repositories";
import { SqsTransport } from "../../src/messaging/infrastructure/sqs-transport";
import { QUEUES } from "../../src/observability/health/dependencies";
import { canonicalHash } from "../../src/shared/application/canonical-json";
import { UnitOfWork } from "../../src/shared/application/unit-of-work";
import { managerFor } from "../../src/shared/infrastructure/unit-of-work";
import { pollUntil } from "./stack";

export interface ReceivedEvent {
  message: Message;
  payload: {
    eventId: string;
    aggregateId: string;
    eventType: string;
    version: number;
    data: Record<string, unknown> & { walletId: string; transactionId: string };
  };
}

export class EventConsumer {
  readonly deliveries = new Map<string, ReceivedEvent[]>();
  private readonly inbox = new SqlInboxStore();
  constructor(
    private readonly uow: UnitOfWork,
    private readonly transport: Pick<SqsTransport, "receive" | "acknowledge">,
    private readonly consumerName: string,
  ) {}

  async initialize(): Promise<void> {
    await this.uow.run((tx) =>
      managerFor(tx).execute(
        "CREATE TABLE test_event_effects (consumer_name text NOT NULL, event_id uuid NOT NULL, PRIMARY KEY (consumer_name, event_id))",
      ),
    );
  }

  async consume(message: Message): Promise<ReceivedEvent> {
    const payload: ReceivedEvent["payload"] = JSON.parse(message.Body ?? "{}");
    await this.uow.run(async (tx) => {
      const inbox = InboxMessage.receive({
        consumerName: this.consumerName,
        messageId: payload.eventId,
        payloadHash: canonicalHash(payload),
        receivedAt: new Date(),
      });
      const claim = await this.inbox.claim(tx, inbox);
      if (claim.inserted) {
        await managerFor(tx).execute(
          "INSERT INTO test_event_effects (consumer_name, event_id) VALUES (?, ?)",
          [this.consumerName, payload.eventId],
        );
        inbox.markProcessed(new Date());
        await this.inbox.markProcessed(tx, inbox);
      } else if (claim.existing.payloadHash !== inbox.payloadHash)
        throw new Error("Event payload conflict");
    });
    await this.transport.acknowledge(QUEUES.events, message);
    const received = { message, payload };
    this.deliveries.set(payload.eventId, [
      ...(this.deliveries.get(payload.eventId) ?? []),
      received,
    ]);
    return received;
  }

  async waitFor(
    eventIds: string[],
    minimumDeliveries = 1,
    timeoutMs = 40_000,
  ): Promise<ReceivedEvent[]> {
    return pollUntil(
      "committed integration events",
      async () => {
        if (eventIds.every((id) => (this.deliveries.get(id)?.length ?? 0) >= minimumDeliveries))
          return eventIds.map((id) => this.deliveries.get(id)?.at(-1) as ReceivedEvent);
        for (const message of await this.transport.receive(
          QUEUES.events,
          new AbortController().signal,
          1,
        ))
          await this.consume(message);
        return undefined;
      },
      timeoutMs,
    );
  }

  async effectCount(eventId: string): Promise<number> {
    return this.uow.run(
      async (tx) =>
        (
          await managerFor(tx).execute<{ count: number }[]>(
            "SELECT count(*)::int AS count FROM test_event_effects WHERE consumer_name = ? AND event_id = ?",
            [this.consumerName, eventId],
          )
        )[0]?.count ?? 0,
    );
  }
}
