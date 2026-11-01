import { TransactionContext } from "../../../shared/application/unit-of-work";
import { WagerTransaction } from "../../domain/wager-transaction";
import { Wallet } from "../../domain/wallet";
import { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";

export abstract class WalletRepository {
  abstract find(tx: TransactionContext, id: string): Promise<Wallet | null>;
  abstract lock(tx: TransactionContext, id: string): Promise<Wallet | null>;
  abstract insert(tx: TransactionContext, wallet: Wallet): Promise<void>;
  abstract save(tx: TransactionContext, wallet: Wallet): Promise<void>;
}

export abstract class WagerTransactionRepository {
  abstract find(tx: TransactionContext, id: string): Promise<WagerTransaction | null>;
  abstract findByKey(
    tx: TransactionContext,
    providerId: string,
    key: string,
  ): Promise<WagerTransaction | null>;
  abstract findByExternalId(
    tx: TransactionContext,
    providerId: string,
    externalId: string,
  ): Promise<WagerTransaction | null>;
  abstract insert(tx: TransactionContext, transaction: WagerTransaction): Promise<void>;
  abstract save(tx: TransactionContext, transaction: WagerTransaction): Promise<void>;
  abstract hasProcessedReversal(tx: TransactionContext, referenceId: string): Promise<boolean>;
}

export abstract class LedgerRepository {
  abstract insert(tx: TransactionContext, entry: WalletLedgerEntry): Promise<void>;
  abstract list(
    tx: TransactionContext,
    walletId: string,
    afterVersion?: number,
    limit?: number,
  ): Promise<WalletLedgerEntry[]>;
}
