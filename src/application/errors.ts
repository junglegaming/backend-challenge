/** Erros de aplicação com significado para o chamador. Qualquer outro erro é tratado como transitório. */
export class ApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Mesma idempotency key (ou mesmo id externo) com payload diferente. Não é replay. */
export class IdempotencyConflictError extends ApplicationError {}
/** Wallet inexistente ou de outro player. Não persiste transação (não há FK possível). */
export class WalletNotFoundError extends ApplicationError {}
export class WalletAlreadyExistsError extends ApplicationError {}
export class NotFoundError extends ApplicationError {}

/** Violação de unique vinda do banco, traduzida pela infraestrutura. */
export class UniqueViolationError extends ApplicationError {
  constructor(public readonly constraint: string) {
    super(`unique constraint violated: ${constraint}`);
  }
}
