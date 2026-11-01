import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { OutboxPublisher } from "../../src/messaging/application/outbox-publisher";
import { WagerConsumer } from "../../src/messaging/application/wager-consumer";
import { SqsTransport } from "../../src/messaging/infrastructure/sqs-transport";
import { QUEUES } from "../../src/observability/health/dependencies";
import { NoopSyncPoint } from "../../src/shared/application/sync-point";
import { BlockingSyncPoint } from "../../src/shared/infrastructure/blocking-sync-point";
import { assertLedgerInvariant, scratchDatabase, testDatabase } from "../support/database";
import { EventConsumer } from "../support/event-consumer";
import { sendWager, wagerMessage } from "../support/sqs";
import { command, compose, pollUntil, testEnvironment, testProject } from "../support/stack";
import { wageringHarness } from "../support/wagering";
import { reconcileAll } from "./reconciliation";
import { save } from "./tools";

const epoch = () => performance.timeOrigin + performance.now();
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing packet observation");
  return value;
}
type Marker = { timeMs: number; kind: string; phase?: string; command?: string; success?: boolean };
type Packet = {
  link: string;
  timeMs: number;
  interface: string | null;
  direction: string | null;
  source: string;
  destination: string;
  bytes: number;
};

test("manual tcpdump: confirmed financial commit precedes actual publish and request ack", async () => {
  const appIds = (
    await compose(["ps", "-q", "api", "consumer", "worker", "nginx", "prometheus"])
  ).trim();
  expect(appIds).toBe("");
  const fixture = await scratchDatabase();
  const h = wageringHarness(fixture);
  const observer = testDatabase({ dbName: fixture.values.database.dbName });
  const transport = new SqsTransport({ values: h.values });
  const eventConsumer = new EventConsumer(observer.uow, transport, `packet-${randomUUID()}`);
  const sql = async <T extends object>(query: string, parameters: unknown[] = []) =>
    (await observer.database.orm).em.getConnection().execute<T[]>(query, parameters);
  const markers: Marker[] = [];
  const packets: Packet[] = [];
  const mark = (kind: string, extra: Omit<Marker, "timeMs" | "kind"> = {}) => {
    const value = { timeMs: epoch(), kind, ...extra };
    markers.push(value);
    return value.timeMs;
  };
  let phase = "preparation";
  let measuring = false;
  let consumer: WagerConsumer | undefined;
  let consumerGate: BlockingSyncPoint | undefined;
  let publisherGate: BlockingSyncPoint | undefined;
  let publication: Promise<number> | undefined;
  let restoreLogger: (() => void) | undefined;
  let primary: unknown;
  let cleanupFailed = false;
  const captures: Array<{
    child: ReturnType<typeof Bun.spawn>;
    name: string;
    ready: boolean;
    captured: number;
    filtered: number;
    dropped: number;
    statisticsSeen: boolean;
    bytes: number;
    readers: Promise<void>[];
  }> = [];
  let rejectedLines = 0;
  let overflow = false;
  let captureStopped = false;
  async function stopCapture() {
    if (captureStopped) return;
    const stopped = await Promise.allSettled(
      captures.map(async (capture) => {
        let signalFailed = false;
        try {
          if (capture.child.exitCode === null)
            await command(["docker", "kill", "--signal", "SIGINT", capture.name]);
        } catch {
          signalFailed = true;
        }
        const exitCode = await capture.child.exited;
        await Promise.all(capture.readers);
        expect(signalFailed).toBe(false);
        expect(exitCode).toBe(0);
      }),
    );
    expect(stopped.every((result) => result.status === "fulfilled")).toBe(true);
    captureStopped = true;
  }
  try {
    await eventConsumer.initialize();
    const wallet = await h.open.handle({
      playerId: randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
      correlationId: randomUUID(),
    });
    const openingIds = (
      await sql<{ id: string }>("SELECT id FROM outbox_messages ORDER BY id")
    ).map((row) => row.id);
    const initialPublisher = new OutboxPublisher(
      { values: h.values },
      h.uow,
      h.outbox,
      transport,
      new NoopSyncPoint(),
      h.telemetry,
    );
    expect(await initialPublisher.publishDue()).toBe(2);
    await eventConsumer.waitFor(openingIds);
    await transport.queue(QUEUES.requests);
    await transport.queue(QUEUES.events);
    const envelope = wagerMessage(wallet);
    await sendWager(transport, envelope);
    const consumerConfig = {
      values: {
        ...h.values,
        role: "consumer" as const,
        consumer: {
          ...h.values.consumer,
          concurrency: 1,
          batchSize: 1,
          visibilitySeconds: 60,
          waitSeconds: 1,
        },
        sync: { points: ["consumer.after_commit_before_ack"], match: envelope.messageId },
      },
    };
    consumerGate = new BlockingSyncPoint(consumerConfig, h.telemetry.logger);
    consumer = new WagerConsumer(
      consumerConfig,
      transport,
      h.submit,
      h.database,
      consumerGate,
      h.telemetry,
    );
    let consumerReached = false;
    let publisherReached = false;
    let completed = false;
    let drained = false;
    const originalInfo = h.telemetry.logger.info.bind(h.telemetry.logger);
    const loggerSpy = spyOn(h.telemetry.logger, "info").mockImplementation((fields) => {
      originalInfo(fields);
      if (
        fields.event === "sync_point_reached" &&
        fields.point === "consumer.after_commit_before_ack"
      ) {
        consumerReached = true;
        mark("consumer_gate_reached");
      }
      if (
        fields.event === "sync_point_reached" &&
        fields.point === "publisher.after_claim_before_send"
      ) {
        publisherReached = true;
        mark("publisher_gate_reached");
      }
      if (fields.event === "consumer_message_completed" && fields.messageId === envelope.messageId)
        completed = true;
      if (fields.event === "consumer_stopped") drained = fields.drained === true;
    });
    restoreLogger = () => loggerSpy.mockRestore();
    (await h.database.orm).em.getEventManager().registerSubscriber({
      afterTransactionCommit() {
        if (measuring) mark("sql_commit_confirmed", { phase });
      },
    });
    transport.client.middlewareStack.add(
      (next, context) => async (args) => {
        const command = context.commandName;
        if (measuring) mark("sdk_start", { command });
        try {
          const result = await next(args);
          if (measuring) mark("sdk_end", { command, success: true });
          return result;
        } catch (error) {
          if (measuring) mark("sdk_end", { command, success: false });
          throw error;
        }
      },
      { step: "initialize", name: "task12Metadata", priority: "high" },
    );

    for (const link of ["postgres", "ministack"]) {
      const name = `wagering-verification-capture-${randomUUID().slice(0, 8)}`;
      const child = Bun.spawn(
        [
          "docker",
          "compose",
          "--env-file",
          "/dev/null",
          "-p",
          testProject,
          "--profile",
          "verification",
          "run",
          "--rm",
          "--no-deps",
          "-T",
          "--name",
          name,
          `verification-tcpdump-${link}`,
        ],
        { env: testEnvironment, stdout: "pipe", stderr: "pipe" },
      );
      const capture = {
        child,
        name,
        ready: false,
        captured: 0,
        filtered: 0,
        dropped: 0,
        statisticsSeen: false,
        bytes: 0,
        readers: [] as Promise<void>[],
      };
      captures.push(capture);
      capture.readers.push(
        (async () => {
          const decoder = new TextDecoder();
          let pending = "";
          const pattern =
            /^(\d+\.\d+)\s+(?:([A-Za-z0-9_.:@-]+)\s+(In|Out|B|M|P)\s+)?IP\s+(\d+(?:\.\d+){3}\.\d+)\s+>\s+(\d+(?:\.\d+){3}\.\d+):\s+tcp\s+(\d+)$/;
          for await (const chunk of child.stdout) {
            pending += decoder.decode(chunk, { stream: true });
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines) {
              const m = pattern.exec(line.trim());
              if (!m) {
                rejectedLines++;
                continue;
              }
              if (packets.length >= 10_000) {
                overflow = true;
                continue;
              }
              packets.push({
                link,
                timeMs: Number(m[1]) * 1000,
                interface: m[2] ?? null,
                direction: m[3] ?? null,
                source: required(m[4]),
                destination: required(m[5]),
                bytes: Number(m[6]),
              });
            }
            if (pending.length > 4096) {
              pending = "";
              rejectedLines++;
            }
          }
        })(),
      );
      capture.readers.push(
        (async () => {
          const decoder = new TextDecoder();
          let pending = "";
          for await (const chunk of child.stderr) {
            capture.bytes += chunk.byteLength;
            pending += decoder.decode(chunk, { stream: true });
            if (/listening on any/.test(pending)) capture.ready = true;
            capture.captured = Number(
              /(\d+) packets captured/.exec(pending)?.[1] ?? capture.captured,
            );
            capture.filtered = Number(
              /(\d+) packets received by filter/.exec(pending)?.[1] ?? capture.filtered,
            );
            const drops = /(\d+) packets dropped by kernel/.exec(pending);
            if (drops) {
              capture.dropped = Number(drops[1]);
              capture.statisticsSeen = true;
            }
            pending = pending.slice(-4096);
          }
        })(),
      );
    }
    await pollUntil(
      "both metadata-only sidecars ready",
      async () =>
        captures.length === 2 &&
        captures.every((capture) => capture.ready && capture.child.exitCode === null),
      15_000,
    );
    measuring = true;
    phase = "financial";
    mark("sample_start");
    consumer.onModuleInit();
    await pollUntil("sample consumer gate", async () => consumerReached, 15_000);
    const financialCommits = markers.filter(
      (m) => m.kind === "sql_commit_confirmed" && m.phase === "financial",
    );
    expect(financialCommits).toHaveLength(1);
    const tx = (
      await sql<{ transactionId: string; status: string }>(
        'SELECT id AS "transactionId", status FROM wager_transactions WHERE provider_id=? AND external_transaction_id=?',
        ["provider-a", envelope.data.externalTransactionId],
      )
    )[0];
    if (!tx) throw new Error("Sample transaction missing");
    expect(tx.status).toBe("PROCESSED");
    const snapshot = (
      await sql<{
        balance: string;
        version: number;
        ledger_count: number;
        inbox_count: number;
        outbox_count: number;
        unpublished_count: number;
      }>(
        `SELECT w.balance::text, w.version,
      (SELECT count(*)::int FROM wallet_ledger_entries l WHERE l.transaction_id=?) ledger_count,
      (SELECT count(*)::int FROM inbox_messages i WHERE i.message_id=? AND i.processed_at IS NOT NULL) inbox_count,
      (SELECT count(*)::int FROM outbox_messages o WHERE o.payload->>'causationId'=?) outbox_count,
      (SELECT count(*)::int FROM outbox_messages o WHERE o.payload->>'causationId'=? AND o.published_at IS NULL) unpublished_count
      FROM wallets w WHERE w.id=?`,
        [tx.transactionId, envelope.messageId, envelope.messageId, envelope.messageId, wallet.id],
      )
    )[0];
    expect(snapshot).toEqual({
      balance: "90.00",
      version: 2,
      ledger_count: 1,
      inbox_count: 1,
      outbox_count: 2,
      unpublished_count: 2,
    });
    const visibleAt = mark("independent_committed_snapshot_visible");
    expect(
      markers.filter(
        (m) =>
          m.kind === "sdk_start" &&
          ["SendMessageBatchCommand", "DeleteMessageCommand"].includes(m.command ?? ""),
      ),
    ).toHaveLength(0);
    const targetIds = (
      await sql<{ id: string }>(
        "SELECT id FROM outbox_messages WHERE payload->>'causationId'=? ORDER BY id",
        [envelope.messageId],
      )
    ).map((row) => row.id);
    expect(targetIds).toHaveLength(2);
    publisherGate = new BlockingSyncPoint(
      {
        values: {
          ...h.values,
          sync: { points: ["publisher.after_claim_before_send"], match: required(targetIds[0]) },
        },
      },
      h.telemetry.logger,
    );
    const publisher = new OutboxPublisher(
      { values: h.values },
      h.uow,
      h.outbox,
      transport,
      publisherGate,
      h.telemetry,
    );
    phase = "claim";
    publication = publisher.publishDue();
    await pollUntil("sample publisher gate", async () => publisherReached, 15_000);
    expect(
      markers.filter((m) => m.kind === "sql_commit_confirmed" && m.phase === "claim"),
    ).toHaveLength(1);
    const claimed = await sql<{ attempts: number; unpublished: boolean; leased: boolean }>(
      "SELECT attempts, published_at IS NULL AS unpublished, next_attempt_at > now() AS leased FROM outbox_messages WHERE payload->>'causationId'=?",
      [envelope.messageId],
    );
    expect(claimed).toHaveLength(2);
    for (const row of claimed)
      expect(row).toEqual({ attempts: 1, unpublished: true, leased: true });
    expect(
      markers.filter((m) => m.kind === "sdk_start" && m.command === "SendMessageBatchCommand"),
    ).toHaveLength(0);
    mark("publisher_gate_released");
    phase = "mark_published";
    publisherGate.shutdown();
    expect(await publication).toBe(2);
    expect(
      (
        await sql<{ count: number }>(
          "SELECT count(*)::int AS count FROM outbox_messages WHERE payload->>'causationId'=? AND published_at IS NOT NULL",
          [envelope.messageId],
        )
      )[0]?.count,
    ).toBe(2);
    mark("consumer_gate_released");
    phase = "ack";
    await consumer.onModuleDestroy();
    expect(completed).toBe(true);
    expect(drained).toBe(true);
    const publishStart = markers.filter(
      (m) => m.kind === "sdk_start" && m.command === "SendMessageBatchCommand",
    );
    const ackStart = markers.filter(
      (m) => m.kind === "sdk_start" && m.command === "DeleteMessageCommand",
    );
    expect(publishStart).toHaveLength(1);
    expect(ackStart).toHaveLength(1);
    for (const start of [...publishStart, ...ackStart]) {
      expect(start.timeMs).toBeGreaterThan(required(financialCommits[0]).timeMs);
      expect(start.timeMs).toBeGreaterThan(visibleAt);
    }
    for (const name of ["SendMessageBatchCommand", "DeleteMessageCommand"])
      expect(
        markers.filter((m) => m.kind === "sdk_end" && m.command === name && m.success),
      ).toHaveLength(1);
    measuring = false;
    await pollUntil(
      "completed SDK intervals visible in packet metadata",
      async () =>
        ["SendMessageBatchCommand", "DeleteMessageCommand"].every((name) => {
          const start = required(markers.find((m) => m.kind === "sdk_start" && m.command === name));
          const end = required(markers.find((m) => m.kind === "sdk_end" && m.command === name));
          return packets.some(
            (p) =>
              p.timeMs >= start.timeMs &&
              p.timeMs <= end.timeMs &&
              p.bytes > 0 &&
              /\.(?:14566|4566)$/.test(p.destination),
          );
        }),
      5000,
    );
    await stopCapture();
    expect(packets.length).toBeGreaterThan(0);
    for (const capture of captures) {
      expect(capture.captured).toBeGreaterThan(0);
      expect(capture.statisticsSeen).toBe(true);
      expect(capture.dropped).toBe(0);
    }
    expect(overflow).toBe(false);
    const sampleStart = required(markers.find((m) => m.kind === "sample_start")).timeMs;
    const financialPackets = packets.filter(
      (p) =>
        p.timeMs >= sampleStart &&
        p.timeMs <= required(financialCommits[0]).timeMs &&
        (/\.(?:15432|5432)$/.test(p.source) || /\.(?:15432|5432)$/.test(p.destination)),
    );
    expect(
      financialPackets.some((p) => p.bytes > 0 && /\.(?:15432|5432)$/.test(p.destination)),
    ).toBe(true);
    expect(financialPackets.some((p) => p.bytes > 0 && /\.(?:15432|5432)$/.test(p.source))).toBe(
      true,
    );
    const intervals = ["SendMessageBatchCommand", "DeleteMessageCommand"].map((name) => {
      const start = required(markers.find((m) => m.kind === "sdk_start" && m.command === name));
      const end = required(markers.find((m) => m.kind === "sdk_end" && m.command === name));
      const inWindow = packets.filter(
        (p) =>
          p.timeMs >= start.timeMs &&
          p.timeMs <= end.timeMs &&
          (/\.(?:14566|4566)$/.test(p.source) || /\.(?:14566|4566)$/.test(p.destination)),
      );
      expect(inWindow.length).toBeGreaterThan(0);
      expect(inWindow.some((p) => p.bytes > 0 && /\.(?:14566|4566)$/.test(p.destination))).toBe(
        true,
      );
      return {
        command: name,
        startMs: start.timeMs,
        endMs: end.timeMs,
        packets: inWindow.length,
        outbound: inWindow.filter((p) => /\.(?:14566|4566)$/.test(p.destination)).length,
        inbound: inWindow.filter((p) => /\.(?:14566|4566)$/.test(p.source)).length,
        outboundDataPackets: inWindow.filter(
          (p) => p.bytes > 0 && /\.(?:14566|4566)$/.test(p.destination),
        ).length,
        afterFinancialCommitMs: start.timeMs - required(financialCommits[0]).timeMs,
        afterVisibleSnapshotMs: start.timeMs - visibleAt,
      };
    });
    await eventConsumer.waitFor(targetIds);
    for (const id of targetIds) expect(await eventConsumer.effectCount(id)).toBe(1);
    await assertLedgerInvariant(h.database);
    expect((await h.reconcile.handle(wallet.id))?.consistent).toBe(true);
    expect(
      (
        await sql<{ count: number }>(
          "SELECT count(*)::int AS count FROM inbox_messages WHERE message_id=? AND processed_at IS NOT NULL",
          [envelope.messageId],
        )
      )[0]?.count,
    ).toBe(1);
    const finalReconciliation = await reconcileAll(h);
    await save("tcpdump", {
      observedAt: new Date().toISOString(),
      realInfrastructure: true,
      appReplicasAbsent: true,
      oneConsumerBatchOne: true,
      capture: {
        image: "wagering-verification:local",
        namespaces: ["service:postgres", "service:ministack"],
        capabilities: ["NET_RAW", "NET_ADMIN", "SETGID"],
        rawFilesCreated: false,
        metadataPackets: packets.length,
        rejectedLines,
        statistics: captures.map((c) => ({
          captured: c.captured,
          receivedByFilter: c.filtered,
          droppedByKernel: c.dropped,
          stderrBytes: c.bytes,
        })),
      },
      markers,
      intervals,
      financialPgPackets: financialPackets.length,
      packetMetadata: packets.map((p) => ({
        timeMs: p.timeMs,
        link: p.link,
        direction: /\.(?:5432|4566)$/.test(p.destination) ? "to-service" : "from-service",
      })),
      finalReconciliation,
      financialSnapshotCounts: { ledger: 1, processedInbox: 1, unpublishedEventsBeforePublish: 2 },
      acceptedTargetEventIds: targetIds,
      oneEffectEach: true,
      ledgerInvariantPassed: true,
      limitation:
        "Packet timing/direction correlated with ORM commit confirmation, independent SQL visibility and actual SDK command names; no payload or wire command decoding",
    });
  } catch (error) {
    primary = error;
  } finally {
    consumerGate?.shutdown();
    publisherGate?.shutdown();
    try {
      const cleanup = await Promise.allSettled([
        publication,
        consumer?.onModuleDestroy(),
        stopCapture(),
      ]);
      cleanupFailed = cleanup.some((result) => result.status === "rejected");
    } finally {
      restoreLogger?.();
      transport.close();
      const closed = await Promise.allSettled([observer.database.onModuleDestroy()]);
      if (closed.some((result) => result.status === "rejected")) cleanupFailed = true;
      try {
        await fixture.cleanup();
      } catch {
        cleanupFailed = true;
      }
    }
  }
  await save("packet-cleanup", { primaryFailed: Boolean(primary), cleanupFailed });
  if (primary) throw primary;
  if (cleanupFailed) throw new Error("Packet experiment cleanup failed");
}, 150_000);
