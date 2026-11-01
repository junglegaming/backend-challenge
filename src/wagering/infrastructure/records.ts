import { DecimalType, EntitySchema } from "@mikro-orm/core";
import { FailureCode } from "../domain/failure-code";
import { WagerTransactionKind, WagerTransactionStatus } from "../domain/wager-transaction";
import { LedgerDirection } from "../domain/wallet-ledger-entry";

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

const decimal = {
  type: new DecimalType("string"),
  columnType: "numeric(18,2)",
  precision: 18,
  scale: 2,
  runtimeType: "string",
} as const;
const timestamp = { type: "Date", columnType: "timestamptz" } as const;
const uuid = { type: "string", columnType: "uuid" } as const;
export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: "wallets",
  properties: {
    id: { ...uuid, primary: true },
    playerId: { type: "string" },
    currency: { type: "string", columnType: "char(3)" },
    balance: decimal,
    version: { type: "integer" },
    createdAt: timestamp,
    updatedAt: timestamp,
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: WagerTransactionKind;
  amount!: string;
  currency!: string;
  status!: WagerTransactionStatus;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  observedBalance?: string;
  observedCurrency?: string;
  referenceDeadlineAt?: Date;
  nextReferenceAttemptAt?: Date;
  referenceAttempts!: number;
  createdAt!: Date;
  updatedAt!: Date;
  processedAt?: Date;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: "wager_transactions",
  properties: {
    id: { ...uuid, primary: true },
    providerId: { type: "string" },
    externalTransactionId: { type: "string" },
    idempotencyKey: { type: "string" },
    payloadHash: { type: "string", columnType: "char(64)" },
    walletId: uuid,
    playerId: { type: "string" },
    roundId: { type: "string" },
    gameId: { type: "string" },
    kind: { type: "string" },
    amount: decimal,
    currency: { type: "string", columnType: "char(3)" },
    status: { type: "string" },
    referenceExternalTransactionId: { type: "string", nullable: true },
    referenceTransactionId: { ...uuid, nullable: true },
    failureCode: { type: "string", nullable: true },
    observedBalance: { ...decimal, nullable: true },
    observedCurrency: { type: "string", columnType: "char(3)", nullable: true },
    referenceDeadlineAt: { ...timestamp, nullable: true },
    nextReferenceAttemptAt: { ...timestamp, nullable: true },
    referenceAttempts: { type: "integer" },
    createdAt: timestamp,
    updatedAt: timestamp,
    processedAt: { ...timestamp, nullable: true },
  },
});

export class LedgerRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  walletVersion!: number;
  direction!: LedgerDirection;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const LedgerSchema = new EntitySchema<LedgerRecord>({
  class: LedgerRecord,
  tableName: "wallet_ledger_entries",
  properties: {
    id: { ...uuid, primary: true },
    walletId: uuid,
    transactionId: uuid,
    walletVersion: { type: "integer" },
    direction: { type: "string" },
    amount: decimal,
    currency: { type: "string", columnType: "char(3)" },
    balanceBefore: decimal,
    balanceAfter: decimal,
    createdAt: timestamp,
  },
});
