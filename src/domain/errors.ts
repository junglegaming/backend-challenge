/** Dado inválido ou regra de negócio violada. A API responde 400 com o `code`. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** Bug de programação: uma regra que o próprio código nunca deveria quebrar. */
export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantError';
  }
}
