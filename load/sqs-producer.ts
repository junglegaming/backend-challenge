import { randomUUID } from "node:crypto";
import { SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { SqsTransport } from "../src/messaging/infrastructure/sqs-transport";
import { QUEUES } from "../src/observability/health/dependencies";
import { LoadFixtures, loadCommand, parallelEach } from "./model";

export async function produceBacklog(
  transport: SqsTransport,
  fixtures: LoadFixtures,
  count: number,
) {
  const startedAt = Date.now();
  const QueueUrl = await transport.queue(QUEUES.requests);
  const batches = Array.from({ length: Math.ceil(count / 10) }, (_, batch) => batch);
  await parallelEach(batches, 5, async (batch) => {
    const Entries = Array.from({ length: Math.min(10, count - batch * 10) }, (_, offset) => {
      const index = batch * 10 + offset;
      const command = loadCommand(fixtures, "sqs_backlog", "distributed", index);
      const messageId = randomUUID();
      return {
        Id: String(index),
        MessageGroupId: command.body.walletId,
        MessageDeduplicationId: messageId,
        MessageBody: JSON.stringify({
          messageId,
          type: "WagerTransactionRequested",
          occurredAt: new Date().toISOString(),
          data: { ...command.body, idempotencyKey: command.key },
        }),
      };
    });
    const result = await transport.client.send(new SendMessageBatchCommand({ QueueUrl, Entries }), {
      abortSignal: AbortSignal.timeout(10_000),
    });
    const confirmed = new Set(result.Successful?.map((entry) => entry.Id));
    if (result.Failed?.length || Entries.some((entry) => !confirmed.has(entry.Id)))
      throw new Error("SQS load batch was not fully confirmed");
  });
  return { count, startedAt, enqueuedAt: Date.now(), groups: fixtures.distributed.length };
}
