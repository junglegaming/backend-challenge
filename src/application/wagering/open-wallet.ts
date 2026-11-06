import { Money, type MoneyProps } from '../../domain/shared/money';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletAlreadyExistsError } from '../errors';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../events/wagering-events';
import type { Clock, IdGenerator } from '../ports/clock-and-ids.port';
import type { UnitOfWork } from '../ports/wagering-repositories.port';
import { assertStorableMoney, assertUuid } from './validation';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface OpenWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

const SYSTEM_PROVIDER = 'SYSTEM';

/** Wallet + (when the initial balance is positive) OPENING transaction + CREDIT ledger entry: one SQL transaction. */
export class OpenWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: OpenWalletCommand): Promise<OpenWalletResult> {
    assertUuid('playerId', command.playerId);
    const initialBalance = Money.from(command.initialBalance);
    assertStorableMoney('initialBalance.amount', initialBalance);

    const now = this.clock.now();
    const wallet = Wallet.open({ id: this.ids.next(), playerId: command.playerId, initialBalance, now });
    const entry = wallet.openingEntry({ entryId: this.ids.next(), transactionId: this.ids.next(), at: now });

    await this.unitOfWork.run(async ({ wallets, transactions, ledger, outbox }) => {
      if (!(await wallets.insertIfAbsent(wallet))) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      if (!entry) return;

      const opening = WagerTransaction.createOpening({
        id: entry.transactionId,
        providerId: SYSTEM_PROVIDER,
        externalTransactionId: `opening:${wallet.id}`,
        idempotencyKey: `opening:${wallet.id}`,
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: 'opening',
        gameId: 'opening',
        money: initialBalance,
        createdAt: now,
      });
      await transactions.insertIfAbsent(opening);
      opening.markProcessed(undefined, now);
      await ledger.append(entry);
      await transactions.saveOutcome(opening, wallet.balance);
      await outbox.enqueue(
        WagerTransactionProcessed.from(opening, wallet.balance.toJSON(), { eventId: this.ids.next(), occurredAt: now }),
      );
      await outbox.enqueue(WalletBalanceChanged.from(wallet, entry, { eventId: this.ids.next(), occurredAt: now }));
    });

    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }
}
