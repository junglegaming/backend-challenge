export interface TransactionContext {
  readonly __brand: "TransactionContext";
}

export abstract class UnitOfWork {
  abstract run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T>;
}
