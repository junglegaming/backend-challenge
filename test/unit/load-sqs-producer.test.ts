import { expect, test } from "bun:test";
import type { SendMessageBatchCommandOutput } from "@aws-sdk/client-sqs";
import {
  assertRemoteQueueModes,
  createBacklogSender,
  produceBacklog,
  readRemoteQueueModes,
} from "../../load/sqs-producer";
import type { SqsTransport } from "../../src/messaging/infrastructure/sqs-transport";

const entries = ["a", "b"].map((Id) => ({
  Id,
  MessageGroupId: `group-${Id}`,
  MessageDeduplicationId: `dedup-${Id}`,
  MessageBody: `synthetic-${Id}`,
}));
const success = (ids = ["a", "b"]) => ({ Successful: ids.map((Id) => ({ Id })) });
const throttle = (status = 400) =>
  Object.assign(new Error("synthetic failure"), {
    name: "RequestThrottled",
    $metadata: { httpStatusCode: status },
  });
function rig(sequence: unknown[], advance = 0) {
  let time = 0;
  const abort = new AbortController();
  const calls: unknown[] = [];
  const waits: number[] = [];
  const transport = {
    client: {
      async send(command: { input: unknown }) {
        calls.push(command.input);
        time += advance;
        const result = sequence.shift();
        if (result instanceof Error) throw result;
        return result as SendMessageBatchCommandOutput;
      },
    },
  } as unknown as SqsTransport;
  const sender = createBacklogSender(transport, abort.signal, {
    now: () => time,
    random: () => 1,
    sleep: async (ms) => {
      waits.push(ms);
      time += ms;
    },
  });
  return { sender, calls, waits, abort };
}

test("remote backlog retries throttling400/403 with identical message identities", async () => {
  const r = rig([throttle(), throttle(403), success()]);
  await r.sender.send("synthetic-queue", entries);
  expect(r.calls).toEqual(Array(3).fill({ QueueUrl: "synthetic-queue", Entries: entries }));
  expect(r.waits).toEqual([50, 100]);
  expect(r.sender.stats.confirmed).toBe(2);
  expect(r.sender.stats.retries).toBe(2);
  expect(r.sender.stats.failedBatches).toBe(0);
});

test("remote backlog retries only unconfirmed throttle entries from partial success", async () => {
  const r = rig([
    { ...success(["a"]), Failed: [{ Id: "b", Code: "RequestThrottled", SenderFault: false }] },
    success(["b"]),
  ]);
  await r.sender.send("synthetic-queue", entries);
  expect(r.calls[1]).toEqual({ QueueUrl: "synthetic-queue", Entries: [entries[1]] });
  expect(r.sender.stats.confirmed).toBe(2);
});

test("remote backlog preserves exhausted SDK error and stops subsequent batches", async () => {
  const errors = Array.from({ length: 7 }, () => throttle());
  const r = rig([...errors]);
  await expect(r.sender.send("synthetic-queue", entries)).rejects.toBe(errors[6]);
  await expect(r.sender.send("synthetic-queue", entries)).rejects.toBe(errors[6]);
  expect(r.calls).toHaveLength(7);
  expect(r.sender.stats.failedBatches).toBe(1);
  expect(r.sender.stats.exhausted).toBe(1);
});

test("remote backlog does not retry permanent failures or malformed confirmations", async () => {
  const denied = Object.assign(new Error("synthetic denial"), {
    name: "AccessDenied",
    $metadata: { httpStatusCode: 403 },
  });
  for (const result of [
    denied,
    {},
    success(["a"]),
    success(["a", "a"]),
    success(["a", "b", "foreign"]),
    { ...success(), Failed: [{ Id: "b", Code: "RequestThrottled", SenderFault: false }] },
    { ...success(["a"]), Failed: [{ Id: "b", Code: "RequestThrottled", SenderFault: true }] },
    { ...success(["a"]), Failed: [{ Id: "b", Code: "AccessDenied", SenderFault: false }] },
  ]) {
    const r = rig([result]);
    await expect(r.sender.send("synthetic-queue", entries)).rejects.toBeInstanceOf(Error);
    expect(r.calls).toHaveLength(1);
    expect(r.waits).toEqual([]);
  }
});

test("remote backlog honors cancellation and twenty-second batch deadline", async () => {
  const error = throttle();
  const r = rig([error], 20_000);
  await expect(r.sender.send("synthetic-queue", entries)).rejects.toBe(error);
  expect(r.calls).toHaveLength(1);
  const cancelled = rig([]);
  cancelled.abort.abort();
  await expect(cancelled.sender.send("synthetic-queue", entries)).rejects.toBeInstanceOf(Error);
  expect(cancelled.calls).toHaveLength(0);
});

test("remote backlog cancels a real backoff before another request starts", async () => {
  const abort = new AbortController();
  let calls = 0;
  const transport = {
    client: {
      send: async () => {
        calls++;
        throw throttle();
      },
    },
  } as unknown as SqsTransport;
  const sender = createBacklogSender(transport, abort.signal, { random: () => 1 });
  const pending = sender.send("synthetic-queue", entries);
  const timer = setTimeout(() => abort.abort(), 5);
  try {
    await expect(pending).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(1);
    expect(sender.stats.failedBatches).toBe(1);
  } finally {
    clearTimeout(timer);
  }
});

test("remote backlog bounds the next in-flight request by the remaining deadline", async () => {
  let time = 0;
  let calls = 0;
  const transport = {
    client: {
      send: async (_command: unknown, { abortSignal }: { abortSignal: AbortSignal }) => {
        calls++;
        if (calls === 1) {
          time = 19_980;
          throw throttle();
        }
        return new Promise((_resolve, reject) => {
          abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
        });
      },
    },
  } as unknown as SqsTransport;
  const sender = createBacklogSender(transport, new AbortController().signal, {
    now: () => time,
    random: () => 0,
    sleep: async () => {},
  });
  await expect(sender.send("synthetic-queue", entries)).rejects.toBeInstanceOf(Error);
  expect(calls).toBe(2);
}, 1000);

test("Compose backlog keeps its original single-attempt failure behavior", async () => {
  let calls = 0;
  const error = throttle();
  const transport = {
    queue: async () => "synthetic-queue",
    client: {
      send: async () => {
        calls++;
        throw error;
      },
    },
  } as unknown as SqsTransport;
  const wallet = { id: "synthetic-wallet", playerId: "synthetic-player" };
  await expect(
    produceBacklog(
      transport,
      {
        runId: "synthetic-run",
        profile: "quick",
        hot: wallet,
        distributed: [wallet],
        replays: [],
      },
      1,
    ),
  ).rejects.toBe(error);
  expect(calls).toBe(1);
});

test("remote queue preflight projects only closed attributes and rejects missing HT", async () => {
  const attributes = {
    FifoQueue: "true",
    ContentBasedDeduplication: "false",
    DeduplicationScope: "messageGroup",
    FifoThroughputLimit: "perMessageGroupId",
    QueueArn: "DO_NOT_EXPORT",
    Unexpected: "DO_NOT_EXPORT",
  };
  const transport = {
    queue: async (name: string) => name,
    client: { send: async () => ({ Attributes: attributes }) },
  } as unknown as SqsTransport;
  const result = await readRemoteQueueModes(transport, new AbortController().signal);
  expect(Object.keys(result)).toEqual(["requests", "events"]);
  expect(JSON.stringify(result)).not.toContain("DO_NOT_EXPORT");
  expect(() => assertRemoteQueueModes(result)).not.toThrow();
  attributes.FifoThroughputLimit = "perQueue";
  const normal = await readRemoteQueueModes(transport, new AbortController().signal);
  expect(() => assertRemoteQueueModes(normal)).toThrow();
  attributes.FifoThroughputLimit = "unexpected-sensitive-value";
  const invalid = await readRemoteQueueModes(transport, new AbortController().signal);
  expect(invalid.requests.FifoThroughputLimit).toBe(null);
  expect(JSON.stringify(invalid)).not.toContain("unexpected-sensitive-value");
  expect(() => assertRemoteQueueModes(invalid)).toThrow();
});
