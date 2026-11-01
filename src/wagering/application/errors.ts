export class WalletAlreadyExistsError extends Error {}
export class InboxPayloadConflictError extends Error {}
export class TransientProcessingError extends Error {
  constructor(cause?: unknown) {
    super("Processing is temporarily unavailable", { cause });
  }
}
