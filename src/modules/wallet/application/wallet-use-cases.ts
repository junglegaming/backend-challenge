import {
  CurrencyNotSupportedError,
  NotFoundError,
  ValidationError,
} from "../../../shared/application/errors";
import type { AppLogger, AppMetrics } from "../../../shared/application/observability";
import type { UnitOfWork } from "../../../shared/application/unit-of-work";
import { DomainError } from "../../../shared/domain/domain-error";
import { Money, type MoneyProps } from "../../../shared/domain/money";
import type { Clock, IdGenerator } from "../../../shared/domain/ports";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import { counterpartyAccountFor } from "../../wagering/domain/counterparty";
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from "../../wagering/domain/events/wagering-events";
import { computeWagerPayloadHash } from "../../wagering/domain/payload-hash";
import { WagerTransaction } from "../../wagering/domain/wager-transaction";
import { WagerTransactionKind } from "../../wagering/domain/wager-transaction-kind";
import { Wallet } from "../domain/wallet";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export const toWalletView = (w: Wallet): WalletView => ({
  id: w.id,
  playerId: w.playerId,
  balance: w.balance.toJSON(),
  version: w.version,
});

/** Internal provider id used by OPENING transactions; external submissions can never use it (contract rejects it). */
export const SYSTEM_PROVIDER_ID = "system";

export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: AppLogger,
    /** Currencies in which wallets may be opened (SUPPORTED_CURRENCIES). */
    private readonly supportedCurrencies: readonly string[],
  ) {}

  /**
   * Opens a wallet in one of the enabled currencies. A positive initial balance is an internal OPENING transaction
   * with its CREDIT ledger entry, committed in the same SQL transaction as the wallet row (plus its outbox events).
   */
  async execute(cmd: {
    playerId: string;
    initialBalance: MoneyProps;
    correlationId: string;
  }): Promise<WalletView> {
    // UUIDs are compared as strings in the domain; PostgreSQL returns them lower-case.
    const playerId = cmd.playerId.toLowerCase();
    let initial: Money;
    try {
      initial = Money.from(cmd.initialBalance);
    } catch (error) {
      if (error instanceof DomainError) throw new ValidationError(error.message, { field: "initialBalance" });
      throw error;
    }
    if (!this.supportedCurrencies.includes(initial.currency)) {
      throw new CurrencyNotSupportedError(initial.currency, this.supportedCurrencies);
    }

    const view = await this.uow.transaction(
      async (scope) => {
        const now = this.clock.now();
        const walletId = this.ids.next();
        const opening = initial.isPositive()
          ? this.openingTransaction(walletId, playerId, initial, now)
          : undefined;
        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId,
          initialBalance: initial,
          at: now,
          opening: opening ? { transactionId: opening.id, ledgerEntryId: this.ids.next() } : undefined,
        });

        await scope.wallets.insert(wallet);
        if (opening && openingEntry) {
          opening.markProcessed(undefined, now, wallet.balance);
          await scope.wagers.insertMany([opening]);
          await scope.ledger.insertMany([
            { entry: openingEntry, counterpartyAccount: counterpartyAccountFor(opening) },
          ]);
          await scope.outbox.add(this.openingEvents(wallet, opening, openingEntry, cmd.correlationId, now));
        }
        return toWalletView(wallet);
      },
      { label: "create-wallet" },
    );
    this.logger.info({ walletId: view.id }, "wallet created");
    return view;
  }

  private openingTransaction(walletId: string, playerId: string, money: Money, now: Date): WagerTransaction {
    const fields = {
      providerId: SYSTEM_PROVIDER_ID,
      externalTransactionId: `opening:${walletId}`,
      playerId,
      walletId,
      roundId: "wallet-opening",
      gameId: "system",
      kind: WagerTransactionKind.Opening,
      money: money.toJSON(),
    };
    return WagerTransaction.create({
      ...fields,
      id: this.ids.next(),
      idempotencyKey: `${SYSTEM_PROVIDER_ID}:opening:${walletId}`,
      payloadHash: computeWagerPayloadHash(fields),
      money,
      createdAt: now,
    });
  }

  private openingEvents(
    wallet: Wallet,
    tx: WagerTransaction,
    entry: WalletLedgerEntry,
    correlationId: string,
    now: Date,
  ): OutboxMessage[] {
    const ctx = () => ({ eventId: this.ids.next(), correlationId, occurredAt: now });
    return [
      OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, ctx())),
      OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, ctx())),
    ];
  }
}

export class GetWallet {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.snapshot((scope) => scope.wallets.findById(walletId), {
      label: "get-wallet",
    });
    if (!wallet) throw new NotFoundError("wallet", walletId);
    return toWalletView(wallet);
  }
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

/** Opaque cursor: base64url({"v":<wallet_version>}). Stable because versions are immutable and monotonic per wallet. */
export const ledgerCursor = {
  encode: (version: number) => Buffer.from(JSON.stringify({ v: version })).toString("base64url"),
  decode(cursor: string): number {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown };
      if (typeof parsed.v === "number" && Number.isInteger(parsed.v) && parsed.v > 0) return parsed.v;
    } catch {
      // fall through
    }
    throw new ValidationError("invalid cursor", { field: "cursor" });
  },
};

export class ListWalletLedger {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    const beforeVersion = cursor ? ledgerCursor.decode(cursor) : undefined;
    return this.uow.snapshot(
      async (scope) => {
        const wallet = await scope.wallets.findById(walletId);
        if (!wallet) throw new NotFoundError("wallet", walletId);
        // Fetch one extra row to know whether another page exists.
        const rows = await scope.ledger.page(walletId, wallet.currency, beforeVersion, limit + 1);
        const items = rows.slice(0, limit);
        const last = items.at(-1);
        return {
          items: items.map(toLedgerEntryView),
          nextCursor: rows.length > limit && last ? ledgerCursor.encode(last.walletVersion) : null,
        };
      },
      { label: "list-ledger" },
    );
  }
}

const toLedgerEntryView = (e: WalletLedgerEntry): LedgerEntryView => ({
  id: e.id,
  transactionId: e.transactionId,
  direction: e.direction,
  money: e.money.toJSON(),
  balanceBefore: e.balanceBefore.toJSON(),
  balanceAfter: e.balanceAfter.toJSON(),
  walletVersion: e.walletVersion,
  createdAt: e.createdAt.toISOString(),
});

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
  walletVersion: number;
  lastLedgerVersion: number;
  chainBreaks: number;
  /** Double-entry journal checks: wallet account balance per journal and unbalanced transactions. */
  journal: { walletAccountBalance: MoneyProps; unbalancedTransactions: number };
  checkedAt: string;
}

/**
 * Recomputes the balance from the ledger in a REPEATABLE READ snapshot (no locks on the hot path) and compares.
 * Divergences are never corrected silently: they are logged at error level, counted in a metric and reported.
 */
export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly metrics: AppMetrics,
    private readonly logger: AppLogger,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const report = await this.uow.snapshot(
      async (scope) => {
        const wallet = await scope.wallets.findById(walletId);
        if (!wallet) throw new NotFoundError("wallet", walletId);
        const agg = await scope.ledger.aggregate(walletId, wallet.currency);
        const calculated = agg.credits.subtract(agg.debits);
        const difference = wallet.balance.subtract(calculated);
        // An untouched zero-opened wallet has version 1 and no entries.
        const expectedLastVersion = agg.entries === 0 ? 0 : wallet.version;
        const consistent =
          difference.isZero() &&
          agg.chainBreaks === 0 &&
          agg.maxVersion === expectedLastVersion &&
          !(agg.entries === 0 && wallet.version !== 1) &&
          agg.unbalancedJournals === 0 &&
          agg.journalBalance.equals(wallet.balance);
        return {
          walletId,
          storedBalance: wallet.balance.toJSON(),
          calculatedBalance: calculated.toJSON(),
          difference: difference.toJSON(),
          consistent,
          checkedEntries: agg.entries,
          walletVersion: wallet.version,
          lastLedgerVersion: agg.maxVersion,
          chainBreaks: agg.chainBreaks,
          journal: {
            walletAccountBalance: agg.journalBalance.toJSON(),
            unbalancedTransactions: agg.unbalancedJournals,
          },
          checkedAt: this.clock.now().toISOString(),
        };
      },
      { label: "reconcile-wallet" },
    );

    this.metrics.reconciliation(report.consistent);
    if (!report.consistent) {
      this.logger.error(
        {
          walletId,
          walletVersion: report.walletVersion,
          lastLedgerVersion: report.lastLedgerVersion,
          chainBreaks: report.chainBreaks,
          unbalancedJournals: report.journal.unbalancedTransactions,
          checkedEntries: report.checkedEntries,
        },
        "RECONCILIATION MISMATCH: wallet balance diverges from ledger",
      );
    }
    return report;
  }
}
