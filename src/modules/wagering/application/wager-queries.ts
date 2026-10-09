import { NotFoundError } from "../../../shared/application/errors";
import type { UnitOfWork } from "../../../shared/application/unit-of-work";
import type { MoneyProps } from "../../../shared/domain/money";
import type { WagerTransaction } from "../domain/wager-transaction";

export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode: string | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  balance: MoneyProps | null;
  referenceAttempts: number;
  nextReferenceRetryAt: string | null;
  createdAt: string;
  processedAt: string | null;
}

export const toWagerView = (tx: WagerTransaction): WagerTransactionView => ({
  transactionId: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  idempotencyKey: tx.idempotencyKey,
  walletId: tx.walletId,
  playerId: tx.playerId,
  roundId: tx.roundId,
  gameId: tx.gameId,
  kind: tx.kind,
  money: tx.money.toJSON(),
  status: tx.status,
  failureCode: tx.failureCode ?? null,
  referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
  referenceTransactionId: tx.referenceTransactionId ?? null,
  balance: tx.resultBalance?.toJSON() ?? null,
  referenceAttempts: tx.referenceAttempts,
  nextReferenceRetryAt: tx.nextReferenceRetryAt?.toISOString() ?? null,
  createdAt: tx.createdAt.toISOString(),
  processedAt: tx.processedAt?.toISOString() ?? null,
});

export class GetWagerTransaction {
  constructor(private readonly uow: UnitOfWork) {}

  async byId(id: string): Promise<WagerTransactionView> {
    const tx = await this.uow.snapshot((s) => s.wagers.findById(id), { label: "get-wager" });
    if (!tx) throw new NotFoundError("transaction", id);
    return toWagerView(tx);
  }

  async byProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    const tx = await this.uow.snapshot(
      (s) => s.wagers.findByProviderExternalId(providerId, externalTransactionId),
      {
        label: "get-wager-by-external",
      },
    );
    if (!tx) throw new NotFoundError("transaction", `${providerId}/${externalTransactionId}`);
    return toWagerView(tx);
  }
}
