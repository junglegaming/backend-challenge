import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  GetQueueAttributesCommand,
  SendMessageBatchCommand,
  type SendMessageBatchCommandOutput,
  type SendMessageBatchRequestEntry,
} from "@aws-sdk/client-sqs";
import { SqsTransport } from "../src/messaging/infrastructure/sqs-transport";
import { QUEUES } from "../src/observability/health/dependencies";
import { LoadFixtures, loadCommand, parallelEach } from "./model";

// Only the remote load generator uses these retries; application retries have their own owners.
export function createBacklogSender(
  transport: SqsTransport,
  signal: AbortSignal,
  options: {
    now?: () => number;
    random?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms: number) => delay(ms, undefined, { signal }));
  const caps = [50, 100, 200, 400, 800, 1000];
  const stats = {
    batches: 0,
    attempts: 0,
    retries: 0,
    confirmed: 0,
    throttled: 0,
    backoffMs: 0,
    failedBatches: 0,
    exhausted: 0,
  };
  let terminalError: unknown;
  const send = async (QueueUrl: string, entries: SendMessageBatchRequestEntry[]) => {
    if (terminalError) throw terminalError;
    signal.throwIfAborted();
    stats.batches++;
    const deadline = now() + 20_000;
    let pending = entries;
    let lastError: unknown;
    try {
      for (let attempt = 0; attempt < 7; attempt++) {
        if (terminalError) throw terminalError;
        signal.throwIfAborted();
        const remaining = deadline - now();
        if (remaining <= 0) {
          stats.exhausted++;
          throw lastError ?? new Error("SQS backlog batch deadline reached");
        }
        stats.attempts++;
        if (attempt) stats.retries++;
        let result: SendMessageBatchCommandOutput | undefined;
        try {
          result = await transport.client.send(
            new SendMessageBatchCommand({ QueueUrl, Entries: pending }),
            {
              abortSignal: AbortSignal.any([
                signal,
                AbortSignal.timeout(Math.min(10_000, remaining)),
              ]),
            },
          );
        } catch (error) {
          const value = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
          if (
            value?.name !== "RequestThrottled" ||
            ![400, 403].includes(value.$metadata?.httpStatusCode ?? 0)
          )
            throw error;
          lastError = error;
        }
        if (result) {
          const expected = new Set(pending.map((entry) => entry.Id));
          const seen = new Set<string>();
          for (const entry of [...(result.Successful ?? []), ...(result.Failed ?? [])]) {
            if (!entry.Id || !expected.has(entry.Id) || seen.has(entry.Id))
              throw new Error("SQS backlog batch has invalid confirmations");
            seen.add(entry.Id);
          }
          if (seen.size !== expected.size)
            throw new Error("SQS backlog batch has missing confirmations");
          stats.confirmed += result.Successful?.length ?? 0;
          if (!result.Failed?.length) return;
          if (
            result.Failed.some(
              (entry) => entry.Code !== "RequestThrottled" || entry.SenderFault !== false,
            )
          )
            throw new Error("SQS backlog batch has a non-retryable failure");
          const retry = new Set(result.Failed.map((entry) => entry.Id));
          pending = pending.filter((entry) => retry.has(entry.Id));
          lastError = new Error("SQS backlog batch entries remain throttled");
        }
        stats.throttled++;
        if (attempt === 6 || now() >= deadline) {
          stats.exhausted++;
          throw lastError;
        }
        const sample = random();
        const wait = Math.floor(
          Math.max(0, Math.min(1, Number.isFinite(sample) ? sample : 0)) * (caps[attempt] ?? 1000),
        );
        if (now() + wait >= deadline) {
          stats.exhausted++;
          throw lastError;
        }
        stats.backoffMs += wait;
        await sleep(wait);
      }
    } catch (error) {
      stats.failedBatches++;
      terminalError ??= error;
      throw error;
    }
  };
  return { send, stats };
}

export async function readRemoteQueueModes(transport: SqsTransport, signal: AbortSignal) {
  const read = async (name: string) => {
    signal.throwIfAborted();
    const { Attributes: values = {} } = await transport.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: await transport.queue(name),
        AttributeNames: [
          "FifoQueue",
          "ContentBasedDeduplication",
          "DeduplicationScope",
          "FifoThroughputLimit",
        ],
      }),
      { abortSignal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) },
    );
    const closed = (value: string | undefined, allowed: string[]) =>
      value && allowed.includes(value) ? value : null;
    return {
      FifoQueue: closed(values.FifoQueue, ["true", "false"]),
      ContentBasedDeduplication: closed(values.ContentBasedDeduplication, ["true", "false"]),
      DeduplicationScope: closed(values.DeduplicationScope, ["queue", "messageGroup"]),
      FifoThroughputLimit: closed(values.FifoThroughputLimit, ["perQueue", "perMessageGroupId"]),
    };
  };
  return { requests: await read(QUEUES.requests), events: await read(QUEUES.events) };
}

export function assertRemoteQueueModes(modes: Awaited<ReturnType<typeof readRemoteQueueModes>>) {
  for (const attributes of Object.values(modes)) {
    if (
      attributes.FifoQueue !== "true" ||
      attributes.ContentBasedDeduplication !== "false" ||
      attributes.DeduplicationScope !== "messageGroup" ||
      attributes.FifoThroughputLimit !== "perMessageGroupId"
    )
      throw new Error("Remote load requires verified high-throughput FIFO requests and events");
  }
}

export async function produceBacklog(
  transport: SqsTransport,
  fixtures: LoadFixtures,
  count: number,
  signal?: AbortSignal,
  sender?: ReturnType<typeof createBacklogSender>,
) {
  signal?.throwIfAborted();
  const startedAt = Date.now();
  const QueueUrl = await transport.queue(QUEUES.requests);
  const batches = Array.from({ length: Math.ceil(count / 10) }, (_, batch) => batch);
  await parallelEach(batches, 5, async (batch) => {
    signal?.throwIfAborted();
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
    if (sender) return sender.send(QueueUrl, Entries);
    const result = await transport.client.send(new SendMessageBatchCommand({ QueueUrl, Entries }), {
      abortSignal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
    });
    const confirmed = new Set(result.Successful?.map((entry) => entry.Id));
    if (result.Failed?.length || Entries.some((entry) => !confirmed.has(entry.Id)))
      throw new Error("SQS load batch was not fully confirmed");
  });
  return { count, startedAt, enqueuedAt: Date.now(), groups: fixtures.distributed.length };
}
