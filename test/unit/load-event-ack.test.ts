import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Message } from "@aws-sdk/client-sqs";
import {
  ACK_BACKOFF_CAPS_MS,
  ACK_STATS,
  closedSdkFailure,
  createEventAcknowledger,
  FATAL_SENTINEL,
  LoadEventObserver,
  SENTINEL,
} from "../../load/event-observer";
import { parallelEach } from "../../load/model";
import type { SqsTransport } from "../../src/messaging/infrastructure/sqs-transport";
import { QUEUES } from "../../src/observability/health/dependencies";
import type { UnitOfWork } from "../../src/shared/application/unit-of-work";

const throttled = () =>
  Object.assign(new Error("suppressed fixture"), {
    name: "RequestThrottled",
    $metadata: { httpStatusCode: 403, attempts: 1 },
  });

function rig(sequence: unknown[], advance = 0) {
  let now = 0;
  const abort = new AbortController();
  const calls: { receiver: unknown; name: string; message: Message }[] = [];
  const waits: number[] = [];
  let afterWait: (() => void) | undefined;
  let afterAttempt: (() => void) | undefined;
  const transport = {
    async acknowledge(name: string, message: Message) {
      calls.push({ receiver: this, name, message });
      now += advance;
      afterAttempt?.();
      const next = sequence.shift();
      if (next instanceof Error) throw next;
    },
  };
  const ack = createEventAcknowledger(transport, abort.signal, {
    now: () => now,
    random: () => 1,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
      afterWait?.();
    },
  });
  return {
    ...ack,
    abort,
    calls,
    waits,
    transport,
    now: () => now,
    setAfterWait: (fn: () => void) => {
      afterWait = fn;
    },
    setAfterAttempt: (fn: () => void) => {
      afterAttempt = fn;
    },
  };
}

test("event observer retries only the same ACK after RequestThrottled403", async () => {
  const r = rig([throttled(), throttled(), undefined]);
  const message = { ReceiptHandle: "synthetic-receipt" };
  await r.acknowledge(QUEUES.events, message);
  expect(r.calls).toHaveLength(3);
  for (const call of r.calls) {
    expect(call.receiver).toBe(r.transport);
    expect(call.name).toBe(QUEUES.events);
    expect(call.message).toBe(message);
    expect(call.message.ReceiptHandle).toBe(message.ReceiptHandle);
  }
  expect(r.waits).toEqual([50, 100]);
  expect(r.stats).toEqual({
    calls: 1,
    attempts: 3,
    retries: 2,
    backoffMs: 150,
    acknowledged: 1,
    failed: 0,
    retryableErrors: 2,
    exhausted: 0,
    deadlineStopped: 0,
    maxAttemptsObserved: 3,
  });
});

test("event observer never retries other queues, AccessDenied or another HTTP status", async () => {
  for (const error of [
    Object.assign(new Error(), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }),
    Object.assign(new Error(), { name: "RequestThrottled", $metadata: { httpStatusCode: 400 } }),
    Object.assign(new Error(), { name: "AbortError" }),
  ]) {
    const r = rig([error]);
    await expect(r.acknowledge(QUEUES.events, {})).rejects.toBe(error);
    expect(r.calls).toHaveLength(1);
    expect(r.waits).toEqual([]);
    expect(r.stats.failed).toBe(1);
    expect(r.stats.retryableErrors).toBe(0);
    expect(r.stats.acknowledged).toBe(0);
  }
  const error = throttled(),
    other = rig([error]);
  await expect(other.acknowledge(QUEUES.requests, {})).rejects.toBe(error);
  expect(other.calls).toHaveLength(1);
  expect(other.stats.calls).toBe(0);
});

test("event observer preserves the seventh error with at most2550ms jitter", async () => {
  const errors = Array.from({ length: 7 }, throttled),
    r = rig([...errors], 2000);
  await expect(r.acknowledge(QUEUES.events, {})).rejects.toBe(errors[6]);
  expect(r.calls).toHaveLength(7);
  expect(r.waits).toEqual([...ACK_BACKOFF_CAPS_MS]);
  expect(r.stats.backoffMs).toBe(2550);
  expect(r.stats.maxAttemptsObserved).toBe(7);
  expect(r.now()).toBe(16550);
  expect(r.stats.exhausted).toBe(1);
  expect(r.stats.failed).toBe(1);
  expect(r.stats.acknowledged).toBe(0);
});

test("event observer's20s deadline reserves the original2s ACK timeout", async () => {
  // At the third error: 3*5950 + 50 + 100 = 18000ms.
  // A fourth call fits without the 2s reserve, so this fixture detects its removal.
  const errors = Array.from({ length: 7 }, throttled),
    r = rig([...errors], 5950);
  await expect(r.acknowledge(QUEUES.events, {})).rejects.toBe(errors[2]);
  expect(r.calls).toHaveLength(3);
  expect(r.waits).toEqual([50, 100]);
  expect(r.now()).toBe(18000);
  expect(r.stats.deadlineStopped).toBe(1);
  expect(r.stats.exhausted).toBe(1);
  expect(r.stats.acknowledged).toBe(0);
});

test("runtime cancellation blocks a retry before backoff and preserves the last error", async () => {
  const error = throttled(),
    r = rig([error]);
  r.setAfterAttempt(() => r.abort.abort());
  await expect(r.acknowledge(QUEUES.events, {})).rejects.toBe(error);
  expect(r.calls).toHaveLength(1);
  expect(r.waits).toEqual([]);
  expect(r.stats.deadlineStopped).toBe(1);
});

test("runtime cancellation during backoff blocks the next ACK", async () => {
  const error = throttled(),
    r = rig([error]);
  r.setAfterWait(() => r.abort.abort());
  await expect(r.acknowledge(QUEUES.events, {})).rejects.toBe(error);
  expect(r.calls).toHaveLength(1);
  expect(r.waits).toEqual([50]);
  expect(r.stats.deadlineStopped).toBe(1);
});

test("an already aborted runtime signal blocks even the first event ACK", async () => {
  const r = rig([]);
  r.abort.abort();
  await expect(r.acknowledge(QUEUES.events, {})).rejects.toThrow("cutoff");
  expect(r.calls).toHaveLength(0);
  expect(r.waits).toEqual([]);
  expect(r.stats.attempts).toBe(0);
  expect(r.stats.failed).toBe(1);
  expect(r.stats.exhausted).toBe(0);
  expect(r.stats.deadlineStopped).toBe(1);
});

test("SDK diagnostic exports only closed operation/name/status/attempts", () => {
  const error = Object.assign(throttled(), {
    message: "DO_NOT_EXPORT",
    requestId: "DO_NOT_EXPORT",
    payload: "DO_NOT_EXPORT",
  });
  expect(closedSdkFailure("DeleteMessageCommand", error)).toEqual({
    operation: "DeleteMessageCommand",
    name: "RequestThrottled",
    httpStatus: 403,
    attempts: 1,
  });
  expect(
    closedSdkFailure("DO_NOT_EXPORT", {
      name: "DO_NOT_EXPORT",
      $metadata: { httpStatusCode: 999, attempts: 99 },
    }),
  ).toEqual({ operation: "UNKNOWN", name: "UNKNOWN", httpStatus: null, attempts: null });
  expect(JSON.stringify(closedSdkFailure("DeleteMessageCommand", error))).not.toContain(
    "DO_NOT_EXPORT",
  );
});

test("observer stop emits actual ACK stats in finally when snapshot rejects", async () => {
  const r = rig([throttled(), undefined]);
  await r.acknowledge(QUEUES.events, {});
  const failure = new Error("synthetic observer failure"),
    abort = new AbortController();
  // Exercise the real stop method without constructing a database, SDK client or run loop.
  const observer = Object.create(LoadEventObserver.prototype) as LoadEventObserver;
  Object.assign(observer, {
    abort,
    loop: Promise.resolve(),
    acknowledger: { stats: r.stats },
    snapshot: () => {
      throw failure;
    },
  });
  const lines: unknown[][] = [];
  const log = spyOn(console, "error").mockImplementation((...args) => {
    lines.push(args);
  });
  try {
    await expect(observer.stop()).rejects.toBe(failure);
    expect(abort.signal.aborted).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(1);
    const line = lines[0]![0];
    expect(typeof line).toBe("string");
    if (typeof line !== "string") throw new Error("Expected stats line");
    expect(line.startsWith(ACK_STATS)).toBe(true);
    expect(JSON.parse(line.slice(ACK_STATS.length))).toEqual(r.stats);
  } finally {
    log.mockRestore();
  }
});

type Middleware = (
  next: (input: unknown) => Promise<unknown>,
  context: { commandName: string },
) => (input: unknown) => Promise<unknown>;
function diagnosticRig() {
  let middleware: Middleware | undefined;
  const transport = {
    client: {
      middlewareStack: {
        add: (value: Middleware) => {
          middleware = value;
        },
      },
    },
    async receive() {
      return [];
    },
    async acknowledge() {},
  } as unknown as SqsTransport;
  const observer = new LoadEventObserver({} as UnitOfWork, transport, "synthetic-observer");
  if (!middleware) throw new Error("Expected diagnostic middleware");
  const installed = middleware;
  return {
    observer,
    fail: (error: unknown, commandName: string) =>
      installed(
        async () => {
          throw error;
        },
        { commandName },
      )({}),
  };
}

test("a recovered first ACK cannot replace the exact propagated producer failure", async () => {
  const lines: unknown[] = [];
  const log = spyOn(console, "error").mockImplementation((line) => {
    lines.push(line);
  });
  try {
    const r = diagnosticRig(),
      first = throttled(),
      fatal = throttled();
    await expect(r.fail(first, "DeleteMessageCommand")).rejects.toBe(first);
    await expect(r.fail(fatal, "SendMessageBatchCommand")).rejects.toBe(fatal);
    // A later independent failure must not replace the chosen parallel worker's error either.
    const later = Object.assign(new Error(), { name: "TimeoutError" });
    await expect(r.fail(later, "ReceiveMessageCommand")).rejects.toBe(later);
    expect(r.observer.sdkFailureFor(fatal)).toEqual({
      operation: "SendMessageBatchCommand",
      name: "RequestThrottled",
      httpStatus: 403,
      attempts: 1,
    });
    expect(r.observer.sdkFailureFor(first)?.operation).toBe("DeleteMessageCommand");
    const firstLines = lines.filter(
      (value) => typeof value === "string" && value.startsWith(SENTINEL),
    );
    expect(firstLines).toHaveLength(1);
    expect(JSON.parse((firstLines[0] as string).slice(SENTINEL.length)).operation).toBe(
      "DeleteMessageCommand",
    );
  } finally {
    log.mockRestore();
  }
});

test("fatal lookup accepts one explicit Error cause and never walks unsafe or cyclic causes", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const r = diagnosticRig(),
      fatal = throttled();
    await expect(r.fail(fatal, "SendMessageBatchCommand")).rejects.toBe(fatal);
    const wrapper = new Error("synthetic wrapper", { cause: fatal });
    expect(r.observer.sdkFailureFor(wrapper)).toEqual(r.observer.sdkFailureFor(fatal));
    expect(r.observer.sdkFailureFor(new Error("outer", { cause: wrapper }))).toBe(null);
    expect(r.observer.sdkFailureFor({ cause: fatal })).toBe(null);
    expect(r.observer.sdkFailureFor(new Error("DO_NOT_EXPORT"))).toBe(null);
    expect(r.observer.sdkFailureFor(null)).toBe(null);
    const self = new Error();
    Object.defineProperty(self, "cause", { value: self });
    const a = new Error(),
      b = new Error();
    Object.defineProperty(a, "cause", { value: b });
    Object.defineProperty(b, "cause", { value: a });
    expect(r.observer.sdkFailureFor(self)).toBe(null);
    expect(r.observer.sdkFailureFor(a)).toBe(null);
    let reads = 0;
    const accessor = new Error();
    Object.defineProperty(accessor, "cause", {
      get() {
        reads++;
        throw new Error("DO_NOT_EXPORT");
      },
    });
    expect(r.observer.sdkFailureFor(accessor)).toBe(null);
    expect(reads).toBe(0);
    const unsafe = new Error();
    Object.defineProperty(unsafe, "name", {
      get() {
        throw new Error("DO_NOT_EXPORT");
      },
    });
    await expect(r.fail(unsafe, "SendMessageBatchCommand")).rejects.toBe(unsafe);
    expect(r.observer.sdkFailureFor(unsafe)).toBe(null);
    const unknown = throttled();
    await expect(r.fail(unknown, "UNRECOGNIZED_COMMAND")).rejects.toBe(unknown);
    expect(r.observer.sdkFailureFor(unknown)).toBe(null);
  } finally {
    log.mockRestore();
  }
});

test("the main catch projects only its captured error before partial verification", async () => {
  const source = readFileSync(new URL("../../scripts/load-test.ts", import.meta.url), "utf8");
  const marker = "} catch (error) {",
    start = source.lastIndexOf(marker);
  const end = source.indexOf('  await write("failure", {', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const emit = new Function(
    "observer",
    "error",
    "FATAL_SENTINEL",
    "console",
    new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(
      source.slice(start + marker.length, end),
    ),
  ) as (
    observer: LoadEventObserver | undefined,
    error: unknown,
    prefix: string,
    output: { error: (line: string) => void },
  ) => void;
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const r = diagnosticRig(),
      fatal = throttled();
    await expect(r.fail(fatal, "SendMessageBatchCommand")).rejects.toBe(fatal);
    const lines: string[] = [];
    emit(r.observer, new Error("wrapper", { cause: fatal }), FATAL_SENTINEL, {
      error: (line) => {
        lines.push(line);
      },
    });
    expect(lines).toEqual([FATAL_SENTINEL + JSON.stringify(r.observer.sdkFailureFor(fatal))]);
    lines.length = 0;
    emit(r.observer, new Error("DO_NOT_EXPORT"), FATAL_SENTINEL, {
      error: (line) => {
        lines.push(line);
      },
    });
    expect(lines).toEqual([FATAL_SENTINEL + "null"]);
    expect(lines.join()).not.toContain("DO_NOT_EXPORT");
    expect(() =>
      emit(undefined, fatal, FATAL_SENTINEL, {
        error: () => {
          throw new Error("synthetic log failure");
        },
      }),
    ).not.toThrow();
  } finally {
    log.mockRestore();
  }
});

test("parallel workers preserve the exact selected SDK error association", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const r = diagnosticRig();
    const errors = [
      throttled(),
      Object.assign(new Error("synthetic parallel failure"), { name: "TimeoutError" }),
    ];
    const operations = ["SendMessageBatchCommand", "ReceiveMessageCommand"];
    let release: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    let caught: unknown;
    try {
      await parallelEach([0, 1], 2, async (index) => {
        started++;
        if (started === 2) release!();
        await bothStarted;
        await r.fail(errors[index], operations[index]!);
      });
    } catch (error) {
      caught = error;
    }
    expect(started).toBe(2);
    const selected = errors.findIndex((error) => error === caught);
    expect(selected).toBeGreaterThanOrEqual(0);
    expect(r.observer.sdkFailureFor(caught)).toEqual(
      closedSdkFailure(operations[selected], caught),
    );
    expect(r.observer.sdkFailureFor(caught)?.operation).toBe(operations[selected]);
    expect(r.observer.sdkFailureFor(caught)).not.toBe(null);
  } finally {
    log.mockRestore();
  }
});

test("a throwing first-sentinel log cannot replace or lose the SDK error", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {
    throw new Error("synthetic logging failure");
  });
  try {
    const r = diagnosticRig(),
      fatal = throttled();
    await expect(r.fail(fatal, "SendMessageBatchCommand")).rejects.toBe(fatal);
    expect(r.observer.sdkFailureFor(fatal)).toEqual({
      operation: "SendMessageBatchCommand",
      name: "RequestThrottled",
      httpStatus: 403,
      attempts: 1,
    });
  } finally {
    log.mockRestore();
  }
});
