import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  Message,
} from "@aws-sdk/client-sqs";
import { LoadEventObserver } from "../../load/event-observer";
import { completeEventCoverage, eventCoverage } from "../../load/event-verification";
import { SqsTransport } from "../../src/messaging/infrastructure/sqs-transport";
import { QUEUES } from "../../src/observability/health/dependencies";
import { managerFor } from "../../src/shared/infrastructure/unit-of-work";
import { assertLedgerInvariant, scratchDatabase } from "../support/database";
import { pollUntil } from "../support/stack";
import { wageringHarness } from "../support/wagering";

test("remote observer proves exact identities, duplicate effects, ack completion and abortable shutdown", async () => {
  const fixture = await scratchDatabase();
  const h = wageringHarness(fixture);
  const queue = `load-observer-${randomUUID()}.fifo`;
  class IsolatedTransport extends SqsTransport {
    override queue(name: string) {
      return super.queue(name === QUEUES.events ? queue : name);
    }
    failAck = false;
    beforeAck: (() => Promise<void>) | undefined;
    afterAck: (() => void) | undefined;
    override async acknowledge(name: string, message: Message) {
      if (this.failAck) throw new Error("Deliberate observer ack failure");
      await this.beforeAck?.();
      await super.acknowledge(name, message);
      this.afterAck?.();
    }
  }
  const transport = new IsolatedTransport({
    values: { ...h.values, consumer: { ...h.values.consumer, waitSeconds: 20 } },
  });
  let url: string | undefined;
  let observer: LoadEventObserver | undefined;
  const ackEntered = Promise.withResolvers<void>();
  const ackRelease = Promise.withResolvers<void>();
  try {
    url = (
      await transport.client.send(
        new CreateQueueCommand({
          QueueName: queue,
          Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
        }),
      )
    ).QueueUrl;
    await h.open.handle({
      playerId: randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
      correlationId: randomUUID(),
    });
    const connection = (await h.database.orm).em.getConnection();
    const rows = await connection.execute<{ id: string; payload: Record<string, unknown> }[]>(
      "SELECT id,payload FROM outbox_messages ORDER BY id",
    );
    expect(rows).toHaveLength(2);
    observer = new LoadEventObserver(h.uow, transport, "load-observer");
    await observer.start();
    expect(completeEventCoverage(await eventCoverage(connection, "load-observer"))).toBe(false);
    // Reverse order and a second distinct SQS delivery of the same eventId.
    for (const [index, row] of [...rows].reverse().concat(rows.slice(0, 1)).entries())
      await transport.send(
        QUEUES.events,
        JSON.stringify(row.payload),
        `group-${index}`,
        randomUUID(),
      );
    await pollUntil(
      "all observer acknowledgments",
      async () => observer?.snapshot().deliveries === 3,
      30_000,
    );
    expect(observer.snapshot()).toEqual({
      deliveries: 3,
      distinctAcknowledged: 2,
      duplicates: 1,
      activeHandlers: 0,
    });
    expect(completeEventCoverage(await eventCoverage(connection, "load-observer"))).toBe(true);
    for (const mutation of [
      "missing",
      "missing_inbox",
      "substituted",
      "extra",
      "unprocessed",
      "unknown",
    ]) {
      const rollback = new Error("Rollback-only observer oracle mutation");
      await expect(
        h.uow.run(async (tx) => {
          const em = managerFor(tx);
          if (mutation === "missing")
            await em.execute("DELETE FROM test_event_effects WHERE event_id = ?", [rows[0]?.id]);
          if (mutation === "extra")
            await em.execute(
              "INSERT INTO test_event_effects (consumer_name,event_id) VALUES (?,?)",
              ["load-observer", randomUUID()],
            );
          if (mutation === "missing_inbox")
            await em.execute("DELETE FROM inbox_messages WHERE consumer_name=? AND message_id=?", [
              "load-observer",
              rows[0]?.id,
            ]);
          if (mutation === "substituted") {
            const replacement = randomUUID();
            await em.execute(
              "UPDATE test_event_effects SET event_id=? WHERE consumer_name=? AND event_id=?",
              [replacement, "load-observer", rows[0]?.id],
            );
            await em.execute(
              "UPDATE inbox_messages SET message_id=? WHERE consumer_name=? AND message_id=?",
              [replacement, "load-observer", rows[0]?.id],
            );
            const coverage = await eventCoverage(em, "load-observer");
            expect(coverage.effects).toBe(coverage.outbox);
            expect(coverage.missing).toBe(1);
            expect(coverage.extra).toBe(1);
          }
          if (mutation === "unprocessed")
            await em.execute("UPDATE inbox_messages SET processed_at=NULL WHERE consumer_name=?", [
              "load-observer",
            ]);
          if (mutation === "unknown")
            await em.execute(
              "INSERT INTO inbox_messages (consumer_name,message_id,payload_hash,received_at,processed_at) SELECT 'unknown',message_id,payload_hash,received_at,processed_at FROM inbox_messages WHERE consumer_name=? LIMIT 1",
              ["load-observer"],
            );
          expect(completeEventCoverage(await eventCoverage(em, "load-observer"))).toBe(false);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    }
    const order: string[] = [];
    transport.afterAck = () => order.push("ack");
    transport.beforeAck = async () => {
      ackEntered.resolve();
      await ackRelease.promise;
    };
    const row = rows[0];
    if (!row) throw new Error("Missing event");
    await transport.send(QUEUES.events, JSON.stringify(row.payload), "busy-shutdown", randomUUID());
    await ackEntered.promise;
    expect(observer.snapshot().activeHandlers).toBe(1);
    const stop = observer.stop().then((state) => {
      order.push("stop");
      return state;
    });
    // This real DeleteMessage must complete before stop resolves, even when shutdown starts at the ack gate.
    ackRelease.resolve();
    expect((await stop).deliveries).toBe(4);
    expect(order).toEqual(["ack", "stop"]);
    transport.beforeAck = undefined;
    transport.afterAck = undefined;
    const shutdown = performance.now();
    expect((await observer.stop()).activeHandlers).toBe(0);
    expect(performance.now() - shutdown).toBeLessThan(3000);
    // A committed SQL effect cannot be mistaken for a completed SQS acknowledgment.
    // Reuse the table already created by the first observer; the failure case exercises consume directly.
    const { EventConsumer } = await import("../support/event-consumer");
    const consumer = new EventConsumer(h.uow, transport, "load-observer-failing");
    transport.failAck = true;
    await expect(
      consumer.consume({ Body: JSON.stringify(row.payload), ReceiptHandle: "deliberate-failure" }),
    ).rejects.toThrow("ack failure");
    expect(await consumer.effectCount(row.id)).toBe(1);
    expect(consumer.deliveries.size).toBe(0);
  } finally {
    ackRelease.resolve();
    transport.failAck = false;
    await observer?.stop();
    if (url) await transport.client.send(new DeleteQueueCommand({ QueueUrl: url }));
    transport.close();
    await assertLedgerInvariant(h.database);
    await fixture.cleanup();
  }
}, 60_000);

test("event ACK throttle recovery preserves one committed SQL effect and drains before shutdown", async () => {
  const fixture = await scratchDatabase();
  const h = wageringHarness(fixture);
  const queue = `load-observer-ack-${randomUUID()}.fifo`;
  const ackRelease = Promise.withResolvers<void>();
  let secondAckEntered = false;
  let ackCalls = 0;
  let deleted = 0;
  const order: string[] = [];
  class IsolatedTransport extends SqsTransport {
    override queue(name: string) {
      return super.queue(name === QUEUES.events ? queue : name);
    }
    override async acknowledge(name: string, message: Message) {
      ackCalls++;
      if (ackCalls === 1)
        throw Object.assign(new Error("Deliberate event ACK throttle"), {
          name: "RequestThrottled",
          $metadata: { httpStatusCode: 403, attempts: 1 },
        });
      secondAckEntered = true;
      await ackRelease.promise;
      await super.acknowledge(name, message);
      deleted++;
      order.push("delete");
    }
  }
  const transport = new IsolatedTransport({
    values: { ...h.values, consumer: { ...h.values.consumer, waitSeconds: 20 } },
  });
  let url: string | undefined;
  let observer: LoadEventObserver | undefined;
  let uowRuns = 0;
  try {
    url = (
      await transport.client.send(
        new CreateQueueCommand({
          QueueName: queue,
          Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
        }),
      )
    ).QueueUrl;
    await h.open.handle({
      playerId: randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
      correlationId: randomUUID(),
    });
    const connection = (await h.database.orm).em.getConnection();
    const rows = await connection.execute<{ id: string; payload: Record<string, unknown> }[]>(
      "SELECT id,payload FROM outbox_messages ORDER BY id",
    );
    expect(rows).toHaveLength(2);
    const row = rows[0];
    if (!row) throw new Error("Missing event");
    observer = new LoadEventObserver(
      {
        run: (work) => {
          uowRuns++;
          return h.uow.run(work);
        },
      },
      transport,
      "load-observer-ack",
    );
    await observer.start();
    const initializedRuns = uowRuns;
    await transport.send(QUEUES.events, JSON.stringify(row.payload), "ack-gate", randomUUID());
    await pollUntil("second event ACK attempt entered", async () => secondAckEntered, 10_000);
    expect(ackCalls).toBe(2);
    expect(deleted).toBe(0);
    expect(uowRuns - initializedRuns).toBe(1);
    const committed = () =>
      connection.execute<{ effects: number; inbox: number; processed: number }[]>(
        `SELECT
          (SELECT count(*)::int FROM test_event_effects WHERE consumer_name=? AND event_id=?) AS effects,
          (SELECT count(*)::int FROM inbox_messages WHERE consumer_name=? AND message_id=?) AS inbox,
          (SELECT count(*)::int FROM inbox_messages WHERE consumer_name=? AND message_id=? AND processed_at IS NOT NULL) AS processed`,
        ["load-observer-ack", row.id, "load-observer-ack", row.id, "load-observer-ack", row.id],
      );
    expect(await committed()).toEqual([{ effects: 1, inbox: 1, processed: 1 }]);
    expect(observer.snapshot()).toEqual({
      deliveries: 0,
      distinctAcknowledged: 0,
      duplicates: 0,
      activeHandlers: 1,
    });
    const stop = observer.stop().then((state) => {
      order.push("stop");
      return state;
    });
    ackRelease.resolve();
    expect(await stop).toEqual({
      deliveries: 1,
      distinctAcknowledged: 1,
      duplicates: 0,
      activeHandlers: 0,
    });
    expect(order).toEqual(["delete", "stop"]);
    expect(ackCalls).toBe(2);
    expect(deleted).toBe(1);
    expect(uowRuns - initializedRuns).toBe(1);
    expect(await committed()).toEqual([{ effects: 1, inbox: 1, processed: 1 }]);
    await pollUntil(
      "real isolated event queue empty after ACK",
      async () => {
        const { Attributes } = await transport.client.send(
          new GetQueueAttributesCommand({
            QueueUrl: url,
            AttributeNames: [
              "ApproximateNumberOfMessages",
              "ApproximateNumberOfMessagesNotVisible",
            ],
          }),
        );
        return (
          Attributes?.ApproximateNumberOfMessages === "0" &&
          Attributes?.ApproximateNumberOfMessagesNotVisible === "0"
        );
      },
      5000,
    );
  } finally {
    ackRelease.resolve();
    try {
      await observer?.stop();
    } finally {
      try {
        if (url) await transport.client.send(new DeleteQueueCommand({ QueueUrl: url }));
      } finally {
        transport.close();
        try {
          await assertLedgerInvariant(h.database);
        } finally {
          await fixture.cleanup();
        }
      }
    }
  }
}, 30_000);
