import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { InboxMessage } from "../../../src/messaging/domain/inbox-message";
import { OutboxMessage } from "../../../src/messaging/domain/outbox-message";
import {
  SqlInboxStore,
  SqlOutboxRepository,
} from "../../../src/messaging/infrastructure/repositories";
import { TransactionContext } from "../../../src/shared/application/unit-of-work";
import { managerFor } from "../../../src/shared/infrastructure/unit-of-work";
import {
  SqlLedgerRepository,
  SqlWagerTransactionRepository,
  SqlWalletRepository,
} from "../../../src/wagering/infrastructure/repositories";
import { assertLedgerInvariant, scratchDatabase, seedOpening } from "../../support/database";

const fixture = await scratchDatabase();
const { database, uow } = fixture;
const wallets = new SqlWalletRepository();
const transactions = new SqlWagerTransactionRepository();
const ledger = new SqlLedgerRepository();
const inbox = new SqlInboxStore();
const outbox = new SqlOutboxRepository();
afterEach(async () => {
  await assertLedgerInvariant(database);
});
afterAll(async () => {
  await fixture.cleanup();
});

test("numeric(18,2) maximum is mapped to Money without numeric conversion", async () => {
  const id = await uow.run(async (tx) => (await seedOpening(tx, "9999999999999999.99")).wallet.id);
  await uow.run(async (tx) => {
    const wallet = await wallets.lock(tx, id);
    expect(wallet?.balance.toString()).toBe("9999999999999999.99");
    expect(wallet?.version).toBe(1);
    const entries = await ledger.list(tx, id);
    expect(entries[0]?.money.toString()).toBe("9999999999999999.99");
    const transaction = await transactions.find(tx, entries[0]?.transactionId ?? "");
    expect(transaction?.observedBalance?.toString()).toBe("9999999999999999.99");
    expect(transaction?.money.toString()).toBe("9999999999999999.99");
  });
});

test("UnitOfWork uses READ COMMITTED, a local timeout and an expiring opaque context", async () => {
  let captured: TransactionContext | undefined;
  await uow.run(async (tx) => {
    captured = tx;
    const rows = await managerFor(tx).execute<{ isolation: string; timeout: string }[]>(
      "SELECT current_setting('transaction_isolation') AS isolation, current_setting('lock_timeout') AS timeout",
    );
    expect(rows[0]).toEqual({ isolation: "read committed", timeout: "2s" });
    expect(Object.keys(tx)).toEqual(["__brand"]);
  });
  expect(() => captured && managerFor(captured)).toThrow("Transaction context is not active");
});

test("a failure rolls back wallet, wager, ledger, inbox and outbox together", async () => {
  let walletId = "";
  let eventId = "";
  const messageId = randomUUID();
  await expect(
    uow.run(async (tx) => {
      const seed = await seedOpening(tx);
      walletId = seed.wallet.id;
      if (!seed.event) throw new Error("Expected opening event");
      eventId = seed.event.eventId;
      const message = InboxMessage.receive({
        consumerName: "atomicity",
        messageId,
        payloadHash: "a".repeat(64),
        receivedAt: new Date(),
      });
      expect(await inbox.claim(tx, message)).toEqual({ inserted: true });
      message.markProcessed(new Date());
      await inbox.markProcessed(tx, message);
      await outbox.append(tx, OutboxMessage.enqueue(seed.event));
      throw new Error("forced transaction failure");
    }),
  ).rejects.toThrow("forced transaction failure");
  await uow.run(async (tx) => {
    expect(await wallets.find(tx, walletId)).toBeNull();
    for (const [table, column, id] of [
      ["wager_transactions", "wallet_id", walletId],
      ["wallet_ledger_entries", "wallet_id", walletId],
      ["inbox_messages", "message_id", messageId],
      ["outbox_messages", "id", eventId],
    ]) {
      const rows = await managerFor(tx).execute(`SELECT * FROM ${table} WHERE ${column} = ?`, [id]);
      expect(rows).toEqual([]);
    }
  });
});

test("inbox ON CONFLICT claim returns the stored hash and processed state", async () => {
  const messageId = randomUUID();
  await uow.run(async (tx) => {
    const message = InboxMessage.receive({
      consumerName: "dedup",
      messageId,
      payloadHash: "a".repeat(64),
      receivedAt: new Date(),
    });
    expect(await inbox.claim(tx, message)).toEqual({ inserted: true });
    message.markProcessed(new Date());
    await inbox.markProcessed(tx, message);
  });
  await uow.run(async (tx) => {
    const claim = await inbox.claim(
      tx,
      InboxMessage.receive({
        consumerName: "dedup",
        messageId,
        payloadHash: "b".repeat(64),
        receivedAt: new Date(),
      }),
    );
    expect(claim.inserted).toBe(false);
    if (!claim.inserted) {
      expect(claim.existing.payloadHash).toBe("a".repeat(64));
      expect(claim.existing.isProcessed()).toBe(true);
    }
  });
});

test("concurrent outbox claims SKIP LOCKED rather than claiming the same row", async () => {
  let eventId = "";
  await uow.run(async (tx) => {
    const seed = await seedOpening(tx);
    if (!seed.event) throw new Error("Expected opening event");
    eventId = seed.event.eventId;
    await outbox.append(tx, OutboxMessage.enqueue(seed.event));
  });
  let announceClaim: () => void = () => {};
  let release: () => void = () => {};
  const claimed = new Promise<void>((resolve) => {
    announceClaim = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = uow.run(async (tx) => {
    const rows = await outbox.claimDue(tx, new Date(), 100);
    expect(rows.map((row) => row.id)).toContain(eventId);
    announceClaim();
    await held;
  });
  await claimed;
  try {
    await uow.run(async (tx) => {
      const rows = await outbox.claimDue(tx, new Date(), 100);
      expect(rows.map((row) => row.id)).not.toContain(eventId);
    });
  } finally {
    release();
    await first;
  }
});
