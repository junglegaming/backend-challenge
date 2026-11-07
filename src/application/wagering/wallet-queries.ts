import type { MoneyProps } from '../../domain/shared/money';
import { failureAdvice } from '../../domain/wagering/failure-code';
import { InvalidRequestError, TransactionNotFoundError, WalletNotFoundError } from '../errors';
import type { Clock } from '../ports/clock-and-ids.port';
import type { StoredTransaction } from '../ports/wagering-repositories.port';
import type { Metrics, WalletQueries, WalletView } from '../ports/wallet-queries.port';
import { assertUuid } from './validation';

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 100;
export const RECONCILIATION_DIVERGENCE_METRIC = 'wallet_reconciliation_divergence_total';

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  amount: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: Date;
}

export interface LedgerPage {
  items: LedgerEntryView[];
  /** Opaque; pass it back as `cursor`. Null on the last page. */
  nextCursor: string | null;
}

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  status: string;
  balance?: MoneyProps;
  failureCode?: string;
  advice?: unknown;
  createdAt: Date;
  processedAt?: Date;
}

export interface ReconciliationReport {
  walletId: string;
  status: 'OK' | 'DIVERGENT';
  divergent: boolean;
  walletBalance: MoneyProps;
  ledgerBalance: MoneyProps;
  /** walletBalance - ledgerBalance, reported as-is: reconciliation never corrects anything. */
  difference: MoneyProps;
  entryCount: number;
  reasons: string[];
  checkedAt: Date;
}

export interface Logger {
  error(message: string): void;
}

/** Cursor = base64url(JSON{v,w,s}); bound to the wallet so it cannot be replayed on another one. */
export function encodeCursor(walletId: string, seq: string): string {
  return Buffer.from(JSON.stringify({ v: 1, w: walletId, s: seq })).toString('base64url');
}

export function decodeCursor(walletId: string, cursor: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown; w?: unknown; s?: unknown };
    if (parsed.v === 1 && parsed.w === walletId && typeof parsed.s === 'string' && /^\d{1,18}$/.test(parsed.s)) return parsed.s;
  } catch {
    // falls through to the error below
  }
  throw new InvalidRequestError('cursor is invalid');
}

export function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === '') return DEFAULT_LEDGER_LIMIT;
  const text = String(raw);
  if (!/^\d+$/.test(text)) throw new InvalidRequestError(`limit must be an integer between 1 and ${MAX_LEDGER_LIMIT}`);
  const limit = Number(text);
  if (limit < 1 || limit > MAX_LEDGER_LIMIT) {
    throw new InvalidRequestError(`limit must be an integer between 1 and ${MAX_LEDGER_LIMIT}`);
  }
  return limit;
}

export class GetWallet {
  constructor(private readonly queries: WalletQueries) {}

  async execute(walletId: string): Promise<WalletView> {
    assertUuid('id', walletId);
    const wallet = await this.queries.findWallet(walletId);
    if (!wallet) throw new WalletNotFoundError(walletId);
    return wallet;
  }
}

export class ListLedger {
  constructor(private readonly queries: WalletQueries) {}

  async execute(walletId: string, options: { cursor?: string | undefined; limit?: unknown }): Promise<LedgerPage> {
    assertUuid('id', walletId);
    const limit = parseLimit(options.limit);
    const afterSeq = options.cursor ? decodeCursor(walletId, options.cursor) : undefined;

    const rows = await this.queries.listLedger(walletId, afterSeq, limit + 1);
    if (!rows) throw new WalletNotFoundError(walletId);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const items = page.map(({ seq: _seq, ...entry }) => entry);
    return { items, nextCursor: rows.length > limit && last ? encodeCursor(walletId, last.seq) : null };
  }
}

export class GetTransaction {
  constructor(private readonly queries: WalletQueries) {}

  async byId(id: string): Promise<TransactionView> {
    assertUuid('id', id);
    const stored = await this.queries.findTransactionById(id);
    if (!stored) throw new TransactionNotFoundError(id);
    return toView(stored);
  }

  async byProvider(providerId: string, externalId: string): Promise<TransactionView> {
    if (!providerId || !externalId) throw new InvalidRequestError('providerId and externalId are required');
    const stored = await this.queries.findTransactionByProviderAndExternalId(providerId, externalId);
    if (!stored) throw new TransactionNotFoundError(`${providerId}/${externalId}`);
    return toView(stored);
  }
}

function toView({ transaction: t, balanceSnapshot }: StoredTransaction): TransactionView {
  return {
    transactionId: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    money: t.money.toJSON(),
    ...(t.referenceExternalTransactionId ? { referenceExternalTransactionId: t.referenceExternalTransactionId } : {}),
    ...(t.referenceTransactionId ? { referenceTransactionId: t.referenceTransactionId } : {}),
    status: t.status,
    ...(balanceSnapshot ? { balance: balanceSnapshot.toJSON() } : {}),
    ...(t.failureCode ? { failureCode: t.failureCode, advice: failureAdvice(t.failureCode) } : {}),
    createdAt: t.createdAt,
    ...(t.processedAt ? { processedAt: t.processedAt } : {}),
  };
}

/** Compares the wallet balance with the ledger. A divergence is logged, counted and flagged; never fixed. */
export class ReconcileWallet {
  constructor(
    private readonly queries: WalletQueries,
    private readonly metrics: Metrics,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    assertUuid('id', walletId);
    const snapshot = await this.queries.snapshotForReconciliation(walletId);
    if (!snapshot) throw new WalletNotFoundError(walletId);

    const cents = (m: MoneyProps): bigint => BigInt(m.amount.replace('.', ''));
    const wallet = cents(snapshot.walletBalance);
    const ledger = cents(snapshot.ledgerBalance);

    const reasons: string[] = [];
    if (wallet !== ledger) reasons.push('WALLET_BALANCE_DIFFERS_FROM_LEDGER_SUM');
    if (snapshot.lastEntryBalance ? cents(snapshot.lastEntryBalance) !== wallet : wallet !== 0n) {
      reasons.push('WALLET_BALANCE_DIFFERS_FROM_LAST_LEDGER_ENTRY');
    }

    const diff = wallet - ledger;
    const sign = diff < 0n ? '-' : '';
    const abs = (diff < 0n ? -diff : diff).toString().padStart(3, '0');
    const difference = { amount: `${sign}${abs.slice(0, -2)}.${abs.slice(-2)}`, currency: snapshot.currency };

    const divergent = reasons.length > 0;
    if (divergent) {
      this.metrics.increment(RECONCILIATION_DIVERGENCE_METRIC, { currency: snapshot.currency });
      this.logger.error(
        `Wallet reconciliation divergent: ${reasons.join(',')}`,
      );
    }

    return {
      walletId,
      status: divergent ? 'DIVERGENT' : 'OK',
      divergent,
      walletBalance: snapshot.walletBalance,
      ledgerBalance: snapshot.ledgerBalance,
      difference,
      entryCount: snapshot.entryCount,
      reasons,
      checkedAt: this.clock.now(),
    };
  }
}
