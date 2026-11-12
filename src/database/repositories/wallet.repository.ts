import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { Money } from "../../domain/money/money";
import { TransientError } from "../../domain/shared/errors";
import { Wallet } from "../../domain/wallet/wallet";
import { WalletRow } from "../entities";

/** Reads and writes the Wallet aggregate. */
export class WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletRow, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toString(),
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
  }

  async findById(id: string): Promise<Wallet | null> {
    const row = await this.em.findOne(WalletRow, { id }, { disableIdentityMap: true });
    return row ? toDomain(row) : null;
  }

  /**
   * Loads the wallet with `SELECT ... FOR UPDATE`. This row lock is the unit
   * of concurrency: every operation on the same wallet is serialized, while
   * different wallets proceed in parallel. Waiting is bounded by lock_timeout.
   */
  async lockById(id: string): Promise<Wallet | null> {
    const row = await this.em.findOne(
      WalletRow,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
    );
    return row ? toDomain(row) : null;
  }

  /**
   * Persists a balance change. The `version = expected` condition is a second
   * guard against lost updates in case the row lock is ever bypassed.
   */
  async update(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletRow,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.toString(), version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) {
      throw new TransientError(`Concurrent modification of wallet ${wallet.id}`);
    }
  }
}

function toDomain(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: Money.fromPersistence(row.balance, row.currency),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

