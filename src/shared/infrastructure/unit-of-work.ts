import { IsolationLevel } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { TransactionContext, UnitOfWork } from "../application/unit-of-work";
import { Database } from "./database";

const managers = new WeakMap<TransactionContext, EntityManager>();

export function managerFor(tx: TransactionContext): EntityManager {
  const manager = managers.get(tx);
  if (!manager) throw new Error("Transaction context is not active");
  return manager;
}

@Injectable()
export class MikroOrmUnitOfWork extends UnitOfWork {
  constructor(private readonly database: Database) {
    super();
  }

  override async run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const orm = await this.database.orm;
    return orm.em.fork().transactional(
      async (em) => {
        await em.execute("SET LOCAL lock_timeout = '2s'");
        const tx: TransactionContext = Object.freeze({ __brand: "TransactionContext" });
        managers.set(tx, em);
        try {
          return await work(tx);
        } finally {
          managers.delete(tx);
        }
      },
      { isolationLevel: IsolationLevel.READ_COMMITTED },
    );
  }
}
