import { IntegrationEvent } from '../domain/events';
import { WalletLedgerEntry } from '../domain/ledger-entry';
import { InboxMessage, OutboxMessage } from '../domain/messaging';
import { WagerTransaction } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';

/** Acesso a dados dentro de UMA transação SQL. Tudo que passa por aqui é atômico. */
export interface TxStore {
  /** `duplicate`: redelivery da mesma mensagem. `conflict`: mesmo messageId com outro conteúdo. */
  insertInbox(message: InboxMessage): Promise<'inserted' | 'duplicate' | 'conflict'>;
  markInboxProcessed(message: InboxMessage): Promise<void>;

  /** SELECT ... FOR UPDATE: serializa todas as operações da wallet entre instâncias. */
  lockWallet(walletId: string): Promise<Wallet | undefined>;
  saveWallet(wallet: Wallet): void;

  findTransactionById(id: string): Promise<WagerTransaction | undefined>;
  findTransactionByKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findTransactionByProviderRef(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  saveTransaction(transaction: WagerTransaction): void;
  findDuePendingReferences(limit: number, now: Date): Promise<{ id: string; walletId: string }[]>;

  addLedgerEntry(entry: WalletLedgerEntry): void;
  enqueue(event: IntegrationEvent<unknown>): void;

  /** FOR UPDATE SKIP LOCKED: publishers concorrentes nunca pegam a mesma linha. */
  claimDueOutbox(limit: number, now: Date): Promise<OutboxMessage[]>;
  saveOutbox(message: OutboxMessage): void;
}

/** Classe abstrata para servir de token de injeção. */
export abstract class UnitOfWork {
  /** Executa fn em uma transação SQL; commit ao final, rollback se lançar. */
  abstract run<T>(fn: (store: TxStore) => Promise<T>): Promise<T>;
}

/** Destino dos eventos de integração (SQS). Fronteira real de infraestrutura. */
export abstract class EventPublisher {
  /** Publica até 10 mensagens em uma chamada. Devolve os ids que o broker recusou. */
  abstract publish(messages: OutboxMessage[]): Promise<Set<string>>;
}
