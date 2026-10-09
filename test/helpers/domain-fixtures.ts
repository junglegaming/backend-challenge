import { computeWagerPayloadHash } from "../../src/modules/wagering/domain/payload-hash";
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
} from "../../src/modules/wagering/domain/wager-transaction";
import { WagerTransactionKind } from "../../src/modules/wagering/domain/wager-transaction-kind";
import { Wallet } from "../../src/modules/wallet/domain/wallet";
import { Money } from "../../src/shared/domain/money";

let seq = 0;
export const nextId = (prefix = "id") => `${prefix}-${++seq}`;
export const T0 = new Date("2026-07-29T15:00:00.000Z");
export const PLAYER = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";

export const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

export function openWallet(initial = "100.00", currency = "BRL", playerId = PLAYER): Wallet {
  const { wallet } = Wallet.open({
    id: nextId("wallet"),
    playerId,
    initialBalance: Money.from({ amount: initial, currency }),
    at: T0,
    opening: { transactionId: nextId("opening"), ledgerEntryId: nextId("entry") },
  });
  return wallet;
}

export function wager(
  wallet: Wallet,
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<Omit<CreateWagerTransactionProps, "money">> & { currency?: string } = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? nextId("ext");
  const money = Money.from({ amount, currency: overrides.currency ?? wallet.currency });
  const base = {
    providerId: overrides.providerId ?? "provider-a",
    externalTransactionId,
    walletId: overrides.walletId ?? wallet.id,
    playerId: overrides.playerId ?? wallet.playerId,
    roundId: overrides.roundId ?? "round-1",
    gameId: overrides.gameId ?? "fortune-chimp",
    kind,
    money: money.toJSON(),
    referenceExternalTransactionId: overrides.referenceExternalTransactionId,
  };
  return WagerTransaction.create({
    ...base,
    id: overrides.id ?? nextId("tx"),
    idempotencyKey: overrides.idempotencyKey ?? `${base.providerId}:${externalTransactionId}`,
    payloadHash: computeWagerPayloadHash(base),
    money,
    createdAt: overrides.createdAt ?? T0,
  });
}
