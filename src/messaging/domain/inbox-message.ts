import { DomainError } from "../../shared/domain/domain-error";

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export class InboxMessage {
  private constructor(private readonly state: InboxMessageState) {}

  static receive(props: Omit<InboxMessageState, "processedAt">): InboxMessage {
    if (!props.messageId || !props.consumerName || !/^[a-f0-9]{64}$/.test(props.payloadHash)) {
      throw new DomainError("Invalid inbox identity or hash");
    }
    return InboxMessage.rehydrate(props);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage({
      ...state,
      receivedAt: new Date(state.receivedAt),
      processedAt: state.processedAt && new Date(state.processedAt),
    });
  }

  get messageId() {
    return this.state.messageId;
  }
  get consumerName() {
    return this.state.consumerName;
  }
  get payloadHash() {
    return this.state.payloadHash;
  }
  get receivedAt() {
    return new Date(this.state.receivedAt);
  }
  get processedAt() {
    return this.state.processedAt && new Date(this.state.processedAt);
  }
  isProcessed(): boolean {
    return this.state.processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) throw new DomainError("Inbox message is already processed");
    this.state.processedAt = new Date(at);
  }
}
