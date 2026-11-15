import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../domain/errors';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/events/wagering-events';
import { Money, type MoneyProps } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { UNIT_OF_WORK, type UnitOfWork } from '../domain/ports/repositories';
import { CLOCK, type Clock, ID_GENERATOR, type IdGenerator } from '../domain/ports/system';
import { INTERNAL_PROVIDER_ID, WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { ConflictError, UniqueViolationError, ValidationError } from './errors';
import { LogContext } from './log-context';
import { sha256Canonical } from './payload-hash';
import { STRUCTURED_LOGGER, type StructuredLogger } from './ports';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export const toWalletView = (wallet: Wallet): WalletView => ({
  id: wallet.id,
  playerId: wallet.playerId,
  balance: wallet.balance.toJSON(),
  version: wallet.version,
});

export const WALLET_UNIQUE_CONSTRAINT = 'wallets_player_id_currency_key';

/**
 * Opens a wallet. A positive initial balance is booked as an internal OPENING
 * transaction + CREDIT ledger entry in the same SQL transaction.
 */
@Injectable()
export class OpenWallet {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(STRUCTURED_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  async execute(cmd: OpenWalletCommand, correlationId: string): Promise<WalletView> {
    const initialBalance = this.parseMoney(cmd.initialBalance);
    const walletId = this.ids.next();
    const now = this.clock.now();
    LogContext.assign({ walletId });

    const opening = initialBalance.isPositive()
      ? WagerTransaction.create({
          id: this.ids.next(),
          providerId: INTERNAL_PROVIDER_ID,
          externalTransactionId: `opening:${walletId}`,
          idempotencyKey: `${INTERNAL_PROVIDER_ID}:opening:${walletId}`,
          payloadHash: sha256Canonical({ walletId, playerId: cmd.playerId, money: initialBalance.toJSON() }),
          walletId,
          playerId: cmd.playerId,
          roundId: 'wallet-opening',
          gameId: 'internal',
          kind: WagerTransactionKind.Opening,
          money: initialBalance,
          createdAt: now,
        })
      : undefined;

    const wallet = Wallet.open({
      id: walletId,
      playerId: cmd.playerId,
      initialBalance,
      openingTransactionId: opening?.id,
      openingEntryId: this.ids.next(),
      now,
    });
    // Read before save(): the repository drains the uncommitted entries.
    const [openingEntry] = wallet.uncommittedEntries;
    opening?.markProcessed(undefined, now, wallet.balance);

    try {
      await this.uow.run(
        async (scope) => {
          // wallet row + opening ledger entry (its FK to the transaction is DEFERRABLE)
          await scope.wallets.save(wallet);
          if (opening && openingEntry) {
            await scope.transactions.save(opening);
            const ctx = { newId: () => this.ids.next(), correlationId, occurredAt: now };
            await scope.outbox.add([
              OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, ctx)),
              OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, ctx)),
            ]);
          }
        },
        { name: 'open-wallet' },
      );
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === WALLET_UNIQUE_CONSTRAINT) {
        throw new ConflictError('WALLET_ALREADY_EXISTS', 'A wallet already exists for this player and currency');
      }
      throw error;
    }
    this.logger.info('wallet opened', { currency: wallet.currency });
    return toWalletView(wallet);
  }

  private parseMoney(props: MoneyProps): Money {
    try {
      return Money.from(props);
    } catch (error) {
      if (error instanceof DomainError) throw new ValidationError(error.message, { field: 'initialBalance' });
      throw error;
    }
  }
}
