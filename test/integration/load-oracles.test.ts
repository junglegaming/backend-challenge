import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { invalidLoadEventsSql } from "../../load/verification-query";
import { managerFor } from "../../src/shared/infrastructure/unit-of-work";
import { assertLedgerInvariant, scratchDatabase } from "../support/database";
import { wageringHarness } from "../support/wagering";

const fixture = await scratchDatabase();
const h = wageringHarness(fixture);
afterEach(() => assertLedgerInvariant(h.database));
afterAll(() => fixture.cleanup());

for (const eventType of ["WagerTransactionProcessed", "WalletBalanceChanged"])
  for (const mutation of ["both-types", "envelope-type", "missing-envelope-type"])
    test(`load SQL proof rejects ${eventType} mutation=${mutation}`, async () => {
      const wallet = await h.open.handle({
        playerId: randomUUID(),
        initialBalance: { amount: "100.00", currency: "BRL" },
        correlationId: randomUUID(),
      });
      const rollback = new Error("Rollback-only event proof probe");
      await expect(
        h.uow.run(async (tx) => {
          const em = managerFor(tx);
          expect((await em.execute<{ count: number }[]>(invalidLoadEventsSql))[0]?.count).toBe(0);
          await em.execute(
            `UPDATE outbox_messages SET
              ${mutation === "both-types" ? "event_type = 'WagerTransactionRejected'," : ""}
              payload = ${mutation === "missing-envelope-type" ? "payload - 'eventType'" : "jsonb_set(payload, '{eventType}', ?::jsonb)"}
              WHERE payload->'data'->>'walletId' = ? AND event_type = ?`,
            [
              ...(mutation === "missing-envelope-type"
                ? []
                : [JSON.stringify("WagerTransactionRejected")]),
              wallet.id,
              eventType,
            ],
          );
          expect((await em.execute<{ count: number }[]>(invalidLoadEventsSql))[0]?.count).toBe(1);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    });
