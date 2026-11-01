import { afterAll, afterEach, expect, test } from "bun:test";
import type { PostgreSqlConnection } from "@mikro-orm/postgresql";
import { managerFor } from "../../../src/shared/infrastructure/unit-of-work";
import { assertLedgerInvariant, scratchDatabase, seedOpening } from "../../support/database";

const fixture = await scratchDatabase();
afterEach(() => assertLedgerInvariant(fixture.database));
afterAll(() => fixture.cleanup());

test("fatal checked-out PostgreSQL clients leave no pool checkout or partial financial state across repeated recovery", async () => {
  const orm = await fixture.database.orm;
  const connection = orm.em.getConnection() as PostgreSqlConnection;
  const pool = await connection.getNativeClient();
  const observer = await pool.connect();
  try {
    // More failures than the configured ten-client pool: a leaked checkout
    // would eventually prevent every new financial operation from starting.
    for (let attempt = 0; attempt < 12; attempt++) {
      let borrower: typeof observer | undefined;
      const disconnected = Promise.withResolvers<void>();
      const acquired = (client: typeof observer) => {
        borrower = client;
        client.once("error", () => disconnected.resolve());
      };
      pool.once("acquire", acquired);
      const entered = Promise.withResolvers<{ pid: number; walletId: string }>();
      const release = Promise.withResolvers<void>();
      const work = fixture.uow.run(async (tx) => {
        const { wallet } = await seedOpening(tx);
        const pid = (
          await managerFor(tx).execute<{ pid: number }[]>("SELECT pg_backend_pid() AS pid")
        )[0]?.pid;
        if (pid === undefined) throw new Error("Missing owned transaction PID");
        entered.resolve({ pid, walletId: wallet.id });
        await release.promise;
      });
      void work.catch(entered.reject);
      try {
        const { pid, walletId } = await entered.promise;
        await observer.query("SELECT pg_terminate_backend($1::int)", [pid]);
        await disconnected.promise;
        release.resolve();
        await expect(work).rejects.toThrow();
        expect(pool.totalCount - pool.idleCount).toBe(1); // Only the owned observer remains.
        expect(
          (await observer.query("SELECT id FROM wallets WHERE id = $1", [walletId])).rows,
        ).toHaveLength(0);
      } finally {
        pool.removeListener("acquire", acquired);
        release.resolve();
        await work.catch(() => undefined);
        // Keep the diagnostic regression safe even when the protection is removed.
        if (pool.totalCount - pool.idleCount > 1) borrower?.release(true);
      }
    }
  } finally {
    observer.release();
  }
  expect(pool.totalCount).toBe(pool.idleCount);
}, 30_000);
