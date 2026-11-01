import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SqsTransport } from "../../../src/messaging/infrastructure/sqs-transport";
import { QUEUES } from "../../../src/observability/health/dependencies";
import { canonicalHash } from "../../../src/shared/application/canonical-json";
import { TransientProcessingError } from "../../../src/wagering/application/errors";
import { WagerTransactionKind as Kind } from "../../../src/wagering/domain/wager-transaction";
import { assertLedgerInvariant } from "../../support/database";
import { openHttpWallet, submitHttp } from "../../support/http";
import { receiveDeadLetter, sendWager, wagerMessage } from "../../support/sqs";
import { compose, pollUntil } from "../../support/stack";
import { wagerCommand, wageringHarness } from "../../support/wagering";

const h = wageringHarness();
const { values } = h;
const transport = new SqsTransport({ values });
afterEach(() => assertLedgerInvariant(h.database));
afterAll(async () => {
  transport.close();
  await h.database.onModuleDestroy();
});

async function rows(messageId: string) {
  const orm = await h.database.orm;
  return orm.em
    .getConnection()
    .execute<{ processed_at: Date }[]>(
      "SELECT processed_at FROM inbox_messages WHERE consumer_name = 'wager-transactions-processor' AND message_id = ?",
      [messageId],
    );
}
async function committed(messageId: string) {
  await pollUntil(
    `committed inbox ${messageId}`,
    async () => (await rows(messageId))[0]?.processed_at,
  );
}
async function completedDelivery(messageId: string) {
  await pollUntil(`acknowledged delivery ${messageId}`, async () => {
    const logs = await compose(["logs", "--no-log-prefix", "--no-color", "consumer"]);
    return logs.split("\n").some((line) => {
      try {
        const value = JSON.parse(line);
        return value.event === "consumer_message_completed" && value.messageId === messageId;
      } catch {
        return false;
      }
    });
  });
}
async function transaction(externalId: string) {
  return h.queries.providerTransaction("provider-a", externalId);
}

test("persistent inbox makes redelivery harmless and divergent reuse reaches the DLQ", async () => {
  const wallet = await openHttpWallet();
  const envelope = wagerMessage(wallet);
  envelope.occurredAt = "2026-11-01T00:00:00Z";
  await sendWager(transport, envelope);
  await completedDelivery(envelope.messageId);
  expect((await transaction(envelope.data.externalTransactionId))?.status).toBe("PROCESSED");
  await sendWager(transport, { ...envelope, occurredAt: "2026-11-01T00:00:00.000Z" });
  await pollUntil("duplicate-message acknowledgement despite timestamp formatting", async () => {
    const logs = await compose(["logs", "--no-log-prefix", "--no-color", "consumer"]);
    return logs.split("\n").some((line) => {
      try {
        const value = JSON.parse(line);
        return value.messageId === envelope.messageId && value.outcome === "duplicate_message";
      } catch {
        return false;
      }
    });
  });
  expect(await rows(envelope.messageId)).toHaveLength(1);
  expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("90.00");
  const divergent = {
    ...envelope,
    data: { ...envelope.data, money: { amount: "11.00", currency: "BRL" } },
  };
  await sendWager(transport, divergent);
  const dead = await receiveDeadLetter(transport, envelope.messageId);
  expect(dead.MessageAttributes?.reason?.StringValue).toBe("INBOX_PAYLOAD_CONFLICT");
  expect(dead.Body).toBe(JSON.stringify(divergent));
  await transport.acknowledge(QUEUES.deadLetters, dead);
  expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("90.00");
});

test.each(["HTTP-first", "SQS-first"])(
  "%s shares provider idempotency across both inputs",
  async (order) => {
    const wallet = await openHttpWallet();
    const envelope = wagerMessage(wallet);
    const { idempotencyKey, ...body } = envelope.data;
    if (order === "HTTP-first") expect((await submitHttp(body, idempotencyKey)).status).toBe(200);
    await sendWager(transport, envelope);
    await completedDelivery(envelope.messageId);
    const replay = await submitHttp(body, idempotencyKey);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ status: "PROCESSED", idempotentReplay: true });
    expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("90.00");
    const entries = await h.queries.ledgerPage(wallet.id, 0, 100);
    expect(entries).toHaveLength(2);
  },
);

test.each(["json", "type", "money", "opening", "missing", "reference"])(
  "invalid SQS %s goes to DLQ without financial or inbox rows",
  async (variant) => {
    const wallet = await openHttpWallet();
    const envelope = wagerMessage(wallet);
    const value: Record<string, unknown> = structuredClone(envelope);
    if (variant === "type") value.type = "Unknown";
    if (variant === "money")
      value.data = { ...envelope.data, money: { amount: 1, currency: "BRL" } };
    if (variant === "opening") value.data = { ...envelope.data, kind: "OPENING" };
    if (variant === "missing") value.data = { ...envelope.data, walletId: undefined };
    if (variant === "reference") value.data = { ...envelope.data, kind: "REFUND" };
    const body = variant === "json" ? envelope.messageId : JSON.stringify(value);
    await sendWager(transport, envelope, body);
    const dead = await receiveDeadLetter(transport, envelope.messageId);
    expect(dead.MessageAttributes?.reason?.StringValue).toBe(
      variant === "json" ? "INVALID_JSON" : "INVALID_MESSAGE",
    );
    expect(dead.Body).toBe(body);
    await transport.acknowledge(QUEUES.deadLetters, dead);
    expect(await rows(envelope.messageId)).toHaveLength(0);
    expect(await transaction(envelope.data.externalTransactionId)).toBeNull();
    expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("100.00");
  },
);

test("business rejection, pending reference and both persistent conflicts are acknowledged", async () => {
  const wallet = await openHttpWallet();
  const rejected = wagerMessage(wallet, { money: { amount: "200.00", currency: "BRL" } });
  const pending = wagerMessage(wallet, {
    kind: "WIN",
    referenceExternalTransactionId: randomUUID(),
  });
  const original = wagerMessage(wallet);
  for (const envelope of [rejected, pending, original]) {
    await sendWager(transport, envelope);
    await completedDelivery(envelope.messageId);
  }
  expect((await transaction(rejected.data.externalTransactionId))?.status).toBe("REJECTED");
  expect((await transaction(pending.data.externalTransactionId))?.status).toBe("PENDING_REFERENCE");
  const keyConflict = {
    ...original,
    messageId: randomUUID(),
    data: { ...original.data, money: { amount: "11.00", currency: "BRL" } },
  };
  const externalConflict = {
    ...original,
    messageId: randomUUID(),
    data: { ...original.data, idempotencyKey: randomUUID() },
  };
  for (const envelope of [keyConflict, externalConflict]) {
    await sendWager(transport, envelope);
    await completedDelivery(envelope.messageId);
    await committed(envelope.messageId);
  }
  expect(await transport.receive(QUEUES.deadLetters, new AbortController().signal, 1)).toEqual([]);
  expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("90.00");
});

test("real wallet lock exhausts native receives without FAILED/inbox and CLI redrive applies once", async () => {
  const wallet = await openHttpWallet();
  const envelope = wagerMessage(wallet);
  const orm = await h.database.orm;
  const lock = orm.em.fork();
  await lock.begin();
  try {
    await lock.execute("SET LOCAL idle_in_transaction_session_timeout = '60s'");
    await lock.execute("SELECT id FROM wallets WHERE id = ? FOR UPDATE", [wallet.id]);
    await sendWager(transport, envelope);
    const dead = await receiveDeadLetter(transport, envelope.messageId);
    expect(Number(dead.Attributes?.ApproximateReceiveCount)).toBeGreaterThanOrEqual(6);
    expect(dead.MessageAttributes?.reason).toBeUndefined();
    expect(await rows(envelope.messageId)).toHaveLength(0);
    expect(await transaction(envelope.data.externalTransactionId)).toBeNull();
    await transport.visibility(QUEUES.deadLetters, dead, 0);
  } finally {
    await lock.rollback();
  }
  const output = await compose([
    "run",
    "--rm",
    "--no-deps",
    "consumer",
    "bun",
    "run",
    "dlq:redrive",
  ]);
  expect(output).toContain('"moved":1');
  await completedDelivery(envelope.messageId);
  expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("90.00");
  // A stale DLQ copy after commit is harmless through the exact same redrive command.
  await transport.send(
    QUEUES.deadLetters,
    JSON.stringify(envelope),
    wallet.id,
    randomUUID(),
    "TEST_STALE_COPY",
  );
  expect(
    await compose(["run", "--rm", "--no-deps", "consumer", "bun", "run", "dlq:redrive"]),
  ).toContain('"moved":1');
  await pollUntil("stale redrive inbox remains unique", async () => {
    const logs = await compose(["logs", "--no-log-prefix", "--no-color", "consumer"]);
    return logs.split("\n").some((line) => {
      try {
        const event = JSON.parse(line);
        return event.messageId === envelope.messageId && event.outcome === "duplicate_message";
      } catch {
        return false;
      }
    });
  });
  expect(await rows(envelope.messageId)).toHaveLength(1);
  expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("90.00");
});

test("committed FAILED is recovered when redelivery precedes the DLQ handoff", async () => {
  const wallet = await h.open.handle({
    playerId: randomUUID(),
    initialBalance: { amount: "9999999999999999.99", currency: "BRL" },
    correlationId: randomUUID(),
  });
  const bet = wagerCommand(wallet, { money: { amount: "0.01", currency: "BRL" } });
  await h.submit.handle(bet);
  const envelope = wagerMessage(wallet, {
    kind: "WIN",
    referenceExternalTransactionId: bet.externalTransactionId,
    money: { amount: "0.02", currency: "BRL" },
  });
  // Reproduce a commit followed by process loss before the DLQ handoff. No broker call is replaced.
  await h.submit.handle(
    {
      ...envelope.data,
      kind: Kind.Win,
      correlationId: envelope.messageId,
      causationId: envelope.messageId,
    },
    {
      inbox: { messageId: envelope.messageId, payloadHash: canonicalHash(envelope.data) },
    },
  );
  expect((await transaction(envelope.data.externalTransactionId))?.status).toBe("FAILED");
  expect(await rows(envelope.messageId)).toHaveLength(1);
  await sendWager(transport, envelope);
  const dead = await receiveDeadLetter(transport, envelope.messageId);
  expect(dead.MessageAttributes?.reason?.StringValue).toBe("PROCESSING_FAILED");
  await transport.acknowledge(QUEUES.deadLetters, dead);
  expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("9999999999999999.98");
});

test("failure after real inbox insertion rolls back inbox and every financial effect", async () => {
  const wallet = await openHttpWallet();
  const command = wagerCommand(wallet);
  const messageId = randomUUID();
  const claim = h.inbox.claim.bind(h.inbox);
  const fault = spyOn(h.inbox, "claim").mockImplementation(async (...args) => {
    await claim(...args);
    throw new Error("Injected after inbox write");
  });
  try {
    await expect(
      h.submit.handle(command, { inbox: { messageId, payloadHash: "a".repeat(64) } }),
    ).rejects.toBeInstanceOf(TransientProcessingError);
  } finally {
    fault.mockRestore();
  }
  expect(await rows(messageId)).toHaveLength(0);
  expect(await transaction(command.externalTransactionId)).toBeNull();
  expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("100.00");
});
