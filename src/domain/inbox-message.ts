import { InvariantError } from './errors';

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

/**
 * Registro de uma mensagem da fila já consumida. A chave (nome do consumidor,
 * messageId) é única no banco e é gravada na MESMA transação do efeito
 * financeiro: se a mensagem chegar de novo, o banco detecta a duplicata.
 */
export class InboxMessage {
  private constructor(private readonly state: InboxMessageState) {}

  /** Mensagem recém-chegada da fila, ainda não processada. */
  static receive(props: Omit<InboxMessageState, 'processadaEm'>): InboxMessage {
    return new InboxMessage({ ...props });
  }

  /** Reconstrói a mensagem lida do banco. */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage({ ...state });
  }

  get messageId() { return this.state.messageId; }
  get consumerName() { return this.state.consumerName; }
  get payloadHash() { return this.state.payloadHash; }
  get receivedAt() { return this.state.receivedAt; }
  get processedAt() { return this.state.processedAt; }

  isProcessed(): boolean {
    return this.state.processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) throw new InvariantError(`mensagem ${this.messageId} já processada`);
    this.state.processedAt = at;
  }
}
