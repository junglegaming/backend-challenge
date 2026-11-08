import { InvariantError } from './errors';
import { IntegrationEvent } from './events';

export interface OutboxMessageState {
  id: string; // = eventId
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

/**
 * Evento esperando publicação. É gravado na mesma transação da mudança de
 * estado; o PublicadorOutboxWorker publica depois. O id é o eventId, então
 * quem consome consegue ignorar cópias repetidas.
 */
export class OutboxMessage {
  private constructor(private readonly state: OutboxMessageState) {}

  /** Cria a mensagem a partir do evento, pronta para publicar já. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: JSON.parse(JSON.stringify(event.toJSON())),
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
    });
  }

  /** Reconstrói a mensagem lida do banco. */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage({ ...state });
  }

  get id() { return this.state.id; }
  get aggregateId() { return this.state.aggregateId; }
  get eventType() { return this.state.eventType; }
  get payload() { return this.state.payload; }
  get occurredAt() { return this.state.occurredAt; }
  get attempts() { return this.state.attempts; }
  get nextAttemptAt() { return this.state.nextAttemptAt; }
  get publishedAt() { return this.state.publishedAt; }

  /** Ainda não foi publicada? */
  isPending(): boolean {
    return this.state.publishedAt === undefined;
  }

  /** Pendente e já passou da hora da próxima tentativa? */
  isDue(now: Date): boolean {
    return this.isPending() && (!this.nextAttemptAt || this.nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) throw new InvariantError(`evento ${this.id} já publicado`);
    this.state.publishedAt = at;
  }

  /** Falhou ao publicar: tenta de novo com backoff (1s, 2s, 4s... até 5 min). */
  scheduleRetry(now: Date): void {
    this.state.attempts += 1;
    const delayMs = Math.min(1_000 * 2 ** (this.state.attempts - 1), 5 * 60_000);
    this.state.nextAttemptAt = new Date(now.getTime() + delayMs);
  }
}
