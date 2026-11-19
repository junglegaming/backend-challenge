import { z } from 'zod';
import { ValidationError } from '../domain/errors';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/events';
import { newId } from '../domain/id';
import { Money, MoneyProps } from '../domain/money';
import { WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { logger } from '../observability/logger';
import { UniqueViolationError, WalletAlreadyExistsError } from './errors';
import { payloadHash } from './payload-hash';
import { UnitOfWork } from './ports';

const openWalletSchema = z.strictObject({
  playerId: z.uuid(),
  initialBalance: z.strictObject({ amount: z.string(), currency: z.string() }),
});

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export class OpenWallet {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(payload: unknown, correlationId: string): Promise<WalletView> {
    const parsed = openWalletSchema.safeParse(payload);
    if (!parsed.success) throw new ValidationError(z.prettifyError(parsed.error));
    const initialBalance = Money.from(parsed.data.initialBalance);
    const { playerId } = parsed.data;

    try {
      return await this.uow.run(async (store) => {
        const now = new Date();
        const walletId = newId();
        const openingTransactionId = newId();
        const { wallet, openingEntry } = Wallet.open({ id: walletId, playerId, initialBalance, openingTransactionId, at: now });
        store.saveWallet(wallet);

        // Saldo inicial > 0: transação interna OPENING + lançamento CREDIT, na mesma transação SQL.
        if (openingEntry) {
          const opening = WagerTransaction.create({
            id: openingTransactionId,
            providerId: 'internal',
            externalTransactionId: `opening:${walletId}`,
            idempotencyKey: `internal:opening:${walletId}`,
            payloadHash: payloadHash(parsed.data),
            walletId,
            playerId,
            roundId: 'opening',
            gameId: 'opening',
            kind: WagerTransactionKind.Opening,
            money: initialBalance,
            createdAt: now,
          });
          opening.markProcessed(undefined, now, wallet.balance);
          store.saveTransaction(opening);
          store.addLedgerEntry(openingEntry);
          const ctx = { correlationId };
          store.enqueue(WalletBalanceChanged.from(wallet, openingEntry, ctx));
          store.enqueue(WagerTransactionProcessed.from(opening, wallet, now, ctx));
        }
        logger.info({ correlationId, walletId }, 'wallet opened');
        return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
      });
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === 'wallets_player_currency_uq') {
        throw new WalletAlreadyExistsError(`player ${playerId} already has a ${initialBalance.currency} wallet`);
      }
      throw error;
    }
  }
}
