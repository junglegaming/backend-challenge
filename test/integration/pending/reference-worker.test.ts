import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SqsTransport } from "../../../src/messaging/infrastructure/sqs-transport";
import { managerFor } from "../../../src/shared/infrastructure/unit-of-work";
import { TransientProcessingError } from "../../../src/wagering/application/errors";
import { PendingReferenceWorker } from "../../../src/wagering/application/pending-reference-worker";
import { SubmissionResult } from "../../../src/wagering/application/submit-wager-transaction";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../../src/wagering/domain/wager-transaction";
import { assertLedgerInvariant, scratchDatabase, testDatabase } from "../../support/database";
import { openHttpWallet, submitHttp } from "../../support/http";
import { sendWager, wagerMessage } from "../../support/sqs";
import { compose, pollUntil } from "../../support/stack";
import { wagerCommand, wageringHarness } from "../../support/wagering";

const fixture = await scratchDatabase();
const h = wageringHarness(fixture);
const live = wageringHarness();
const transport = new SqsTransport({ values: live.values });
afterEach(async () => {
  await assertLedgerInvariant(h.database);
  await assertLedgerInvariant(live.database);
});
afterAll(async () => {
  transport.close();
  await fixture.cleanup();
  await live.database.onModuleDestroy();
});
function completed(result: SubmissionResult) {
  if (result.type !== "completed") throw new Error("Expected completed submission");
  return result.transaction;
}
const open = (harness = h) =>
  harness.open.handle({
    playerId: randomUUID(),
    initialBalance: { amount: "100.00", currency: "BRL" },
    correlationId: randomUUID(),
  });
async function acknowledged(messageId: string, outcome?: string) {
  return pollUntil("acknowledged pending request", async () => {
    const logs = await compose(["logs", "--no-color", "--no-log-prefix", "consumer"]);
    return logs.split("\n").some((line) => {
      try {
        const record = JSON.parse(line);
        return (
          record.event === "consumer_message_completed" &&
          record.messageId === messageId &&
          (!outcome || record.outcome === outcome)
        );
      } catch {
        return false;
      }
    });
  });
}
async function due(ids: string[], harness = h) {
  await harness.uow.run((tx) =>
    managerFor(tx).execute(
      "UPDATE wager_transactions SET next_reference_attempt_at = now() WHERE id IN (" +
        ids.map(() => "?").join(",") +
        ") AND status = 'PENDING_REFERENCE'",
      ids,
    ),
  );
}

test.each([Kind.Refund, Kind.Rollback, Kind.Win, Kind.Loss])(
  "SQS %s is acknowledged while pending, then active workers settle once after its reference arrives",
  async (kind) => {
    const wallet = await openHttpWallet();
    const bet = wagerMessage(wallet);
    const amount = kind === Kind.Loss ? "0.00" : kind === Kind.Win ? "5.00" : "10.00";
    const envelope = wagerMessage(wallet, {
      kind,
      money: { amount, currency: "BRL" },
      referenceExternalTransactionId: bet.data.externalTransactionId,
    });
    await sendWager(transport, envelope);
    await acknowledged(envelope.messageId, "PENDING_REFERENCE");
    const pending = await live.queries.providerTransaction(
      "provider-a",
      envelope.data.externalTransactionId,
    );
    expect(pending?.status).toBe("PENDING_REFERENCE");
    const inbox = await live.uow.run((tx) =>
      managerFor(tx).execute<{ processed: boolean }[]>(
        "SELECT processed_at IS NOT NULL AS processed FROM inbox_messages WHERE consumer_name = 'wager-transactions-processor' AND message_id = ?",
        [envelope.messageId],
      ),
    );
    expect(inbox[0]?.processed).toBe(true);
    const { idempotencyKey, ...body } = bet.data;
    expect((await submitHttp(body, idempotencyKey)).status).toBe(200);
    await pollUntil(
      "resolved SQS reference",
      async () =>
        (await live.queries.providerTransaction("provider-a", envelope.data.externalTransactionId))
          ?.status === "PROCESSED",
      25_000,
    );
    await sendWager(transport, envelope);
    await acknowledged(envelope.messageId, "duplicate_message");
    expect((await live.queries.wallet(wallet.id))?.balance.amount).toBe(
      kind === Kind.Win ? "95.00" : kind === Kind.Loss ? "90.00" : "100.00",
    );
    expect(await live.queries.ledgerPage(wallet.id, 0, 100)).toHaveLength(
      kind === Kind.Loss ? 2 : 3,
    );
    const events = await live.uow.run((tx) =>
      managerFor(tx).execute<{ event_type: string }[]>(
        "SELECT event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY event_type",
        [pending?.transactionId],
      ),
    );
    expect(events.map((row) => row.event_type)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionProcessed",
    ]);
  },
  35_000,
);

test("two independent worker instances skip a locked wallet, then settle every due transaction once", async () => {
  const second = testDatabase({ dbName: h.values.database.dbName });
  const other = wageringHarness(second);
  const wallets = (await Promise.all(Array.from({ length: 12 }, () => open()))).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const ids: string[] = [];
  for (const wallet of wallets) {
    const bet = wagerCommand(wallet);
    ids.push(
      completed(
        await h.submit.handle(
          wagerCommand(wallet, {
            kind: Kind.Refund,
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
        ),
      ).transactionId,
    );
    completed(await h.submit.handle(bet));
  }
  await due(ids);
  const lock = (await h.database.orm).em.fork();
  await lock.begin();
  try {
    await lock.execute("SELECT id FROM wallets WHERE id = ? FOR UPDATE", [wallets[0]?.id]);
    const selected = await other.resolve.handleNextDue();
    expect(selected?.status).toBe("PROCESSED");
    expect(selected?.transactionId).not.toBe(ids[0]);
    expect((await h.queries.transaction(ids[0] ?? ""))?.status).toBe("PENDING_REFERENCE");
  } finally {
    await lock.rollback();
  }
  const config = { values: { ...h.values, role: "worker" as const } };
  const workers = [
    new PendingReferenceWorker(config, h.resolve, h.telemetry),
    new PendingReferenceWorker(config, other.resolve, other.telemetry),
  ];
  try {
    for (const worker of workers) worker.onModuleInit();
    await pollUntil("two worker instances drain due references", async () => {
      const rows = await Promise.all(ids.map((id) => h.queries.transaction(id)));
      return rows.every((row) => row?.status === "PROCESSED");
    });
  } finally {
    await Promise.all(workers.map((worker) => worker.onModuleDestroy()));
    await second.database.onModuleDestroy();
  }
  for (const wallet of wallets) {
    expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("100.00");
    expect(await h.queries.ledgerPage(wallet.id, 0, 100)).toHaveLength(3);
  }
  const rows = await h.uow.run((tx) =>
    managerFor(tx).execute<{ count: number }[]>(
      "SELECT count(*)::int AS count FROM outbox_messages WHERE event_type = 'WagerTransactionProcessed' AND aggregate_id IN (" +
        ids.map(() => "?").join(",") +
        ")",
      ids,
    ),
  );
  expect(rows[0]?.count).toBe(ids.length);
});

test("expiry preserves the first deadline across replay/restart and atomically rejects with its event", async () => {
  const short = await scratchDatabase({ referenceTtlMs: 1500 });
  const local = wageringHarness(short);
  try {
    const wallet = await open(local);
    const command = wagerCommand(wallet, {
      kind: Kind.Refund,
      referenceExternalTransactionId: randomUUID(),
    });
    const pending = completed(await local.submit.handle(command));
    const read = () => local.uow.run((tx) => local.transactions.find(tx, pending.transactionId));
    const deadline = (await read())?.referenceDeadlineAt;
    expect(deadline).toBeInstanceOf(Date);
    expect(completed(await local.submit.handle(command)).status).toBe("PENDING_REFERENCE");
    await due([pending.transactionId], local);
    const config = { values: { ...local.values, role: "worker" as const } };
    const firstWorker = new PendingReferenceWorker(config, local.resolve, local.telemetry);
    try {
      firstWorker.onModuleInit();
      await pollUntil(
        "scheduled retry before restart",
        async () => ((await read())?.referenceAttempts ?? 0) >= 2,
      );
    } finally {
      await firstWorker.onModuleDestroy();
    }
    expect((await read())?.referenceDeadlineAt?.toISOString()).toBe(deadline?.toISOString());
    const restarted = wageringHarness(short);
    await pollUntil(
      "reference deadline",
      async () => Date.now() >= (deadline?.getTime() ?? Infinity),
    );
    const original = restarted.outbox.append.bind(restarted.outbox);
    const fault = spyOn(restarted.outbox, "append").mockImplementation(async (...args) => {
      await original(...args);
      throw new Error("failure after rejection event");
    });
    try {
      await expect(restarted.resolve.handle(pending.transactionId)).rejects.toBeInstanceOf(
        TransientProcessingError,
      );
    } finally {
      fault.mockRestore();
    }
    expect((await read())?.status).toBe(Status.PendingReference);
    await due([pending.transactionId], restarted);
    const restartedWorker = new PendingReferenceWorker(
      config,
      restarted.resolve,
      restarted.telemetry,
    );
    try {
      restartedWorker.onModuleInit();
      await pollUntil(
        "expiry after worker restart",
        async () => (await read())?.status === Status.Rejected,
      );
    } finally {
      await restartedWorker.onModuleDestroy();
    }
    const stored = await read();
    expect(stored?.failureCode).toBe("REFERENCE_NOT_FOUND");
    expect(stored?.referenceDeadlineAt?.toISOString()).toBe(deadline?.toISOString());
    const events = await local.uow.run((tx) =>
      managerFor(tx).execute<{ event_type: string }[]>(
        "SELECT event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY event_type",
        [pending.transactionId],
      ),
    );
    expect(events.map((row) => row.event_type)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionRejected",
    ]);
    await assertLedgerInvariant(local.database);
  } finally {
    await short.cleanup();
  }
});

test.each([
  "SELECT * FROM deliberately_missing_reference_test_relation",
  "SELECT 'invalid'::integer",
])("a real SQL query error at the deadline remains retryable: %s", async (query) => {
  const short = await scratchDatabase({ referenceTtlMs: 100 });
  const local = wageringHarness(short);
  try {
    const wallet = await open(local);
    const pending = completed(
      await local.submit.handle(
        wagerCommand(wallet, { kind: Kind.Refund, referenceExternalTransactionId: randomUUID() }),
      ),
    );
    const stored = await local.uow.run((tx) => local.transactions.find(tx, pending.transactionId));
    await pollUntil(
      "reference deadline before SQL failure",
      async () => Date.now() >= (stored?.referenceDeadlineAt?.getTime() ?? Infinity),
    );
    const fault = spyOn(local.transactions, "findByExternalId").mockImplementation(async (tx) => {
      await managerFor(tx).execute(query);
      throw new Error("Expected actual SQL failure");
    });
    try {
      await expect(local.resolve.handle(pending.transactionId)).rejects.toBeInstanceOf(
        TransientProcessingError,
      );
    } finally {
      fault.mockRestore();
    }
    const unchanged = await local.uow.run((tx) =>
      local.transactions.find(tx, pending.transactionId),
    );
    expect(unchanged?.status).toBe(Status.PendingReference);
    expect(unchanged?.referenceAttempts).toBe(stored?.referenceAttempts);
    expect(unchanged?.referenceDeadlineAt?.toISOString()).toBe(
      stored?.referenceDeadlineAt?.toISOString(),
    );
    expect(await local.resolve.handle(pending.transactionId)).toMatchObject({
      status: "REJECTED",
      failureCode: "REFERENCE_NOT_FOUND",
    });
    await assertLedgerInvariant(local.database);
  } finally {
    await short.cleanup();
  }
});

test("persisted high attempt counts still retry with capped backoff and the original deadline", async () => {
  const wallet = await open();
  const pending = completed(
    await h.submit.handle(
      wagerCommand(wallet, { kind: Kind.Refund, referenceExternalTransactionId: randomUUID() }),
    ),
  );
  const before = await h.uow.run((tx) => h.transactions.find(tx, pending.transactionId));
  await h.uow.run((tx) =>
    managerFor(tx).execute("UPDATE wager_transactions SET reference_attempts = 100 WHERE id = ?", [
      pending.transactionId,
    ]),
  );
  expect(await h.resolve.handle(pending.transactionId)).toMatchObject({
    status: "PENDING_REFERENCE",
  });
  const after = await h.uow.run((tx) => h.transactions.find(tx, pending.transactionId));
  expect(after?.referenceAttempts).toBe(101);
  expect(after?.referenceDeadlineAt?.toISOString()).toBe(
    before?.referenceDeadlineAt?.toISOString(),
  );
  expect(after?.nextAttemptAt?.getTime()).toBeLessThanOrEqual(Date.now() + 300_000);
  expect(after?.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now() + 290_000);
});

test.each([true, false])(
  "ROLLBACK of pending REFUND resolves in order when chain completes=%s",
  async (completes) => {
    const short = completes ? undefined : await scratchDatabase({ referenceTtlMs: 200 });
    const local = short ? wageringHarness(short) : h;
    try {
      const wallet = await open(local);
      const bet = wagerCommand(wallet);
      const refund = wagerCommand(wallet, {
        kind: Kind.Refund,
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      const refundTx = completed(await local.submit.handle(refund));
      const rollback = completed(
        await local.submit.handle(
          wagerCommand(wallet, {
            kind: Kind.Rollback,
            referenceExternalTransactionId: refund.externalTransactionId,
          }),
        ),
      );
      expect(await local.resolve.handle(rollback.transactionId)).toMatchObject({
        status: "PENDING_REFERENCE",
      });
      if (completes) {
        completed(await local.submit.handle(bet));
        expect(await local.resolve.handle(refundTx.transactionId)).toMatchObject({
          status: "PROCESSED",
        });
        expect(await local.resolve.handle(rollback.transactionId)).toMatchObject({
          status: "PROCESSED",
        });
        expect((await local.queries.wallet(wallet.id))?.balance.amount).toBe("90.00");
        expect(await local.queries.ledgerPage(wallet.id, 0, 100)).toHaveLength(4);
      } else {
        const stored = await local.uow.run((tx) =>
          local.transactions.find(tx, rollback.transactionId),
        );
        await pollUntil(
          "incomplete chain expiry",
          async () => Date.now() >= (stored?.referenceDeadlineAt?.getTime() ?? Infinity),
        );
        expect(await local.resolve.handle(rollback.transactionId)).toMatchObject({
          status: "REJECTED",
          failureCode: "REFERENCE_NOT_PROCESSED",
        });
        expect(await local.resolve.handle(refundTx.transactionId)).toMatchObject({
          status: "REJECTED",
          failureCode: "REFERENCE_NOT_FOUND",
        });
        expect((await local.queries.wallet(wallet.id))?.balance.amount).toBe("100.00");
      }
      await assertLedgerInvariant(local.database);
    } finally {
      await short?.cleanup();
    }
  },
);
