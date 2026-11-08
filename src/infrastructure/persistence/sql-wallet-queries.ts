import { EntityManager } from '@mikro-orm/postgresql';
import type {
  LedgerEntryRow,
  ReconciliationSnapshot,
  WalletQueries,
  WalletView,
} from '../../application/ports/wallet-queries.port';
import type { StoredTransaction } from '../../application/ports/wagering-repositories.port';
import { Sql, SqlWagerTransactionRepository } from './mikro-orm-unit-of-work';
import { decimalText } from './decimal-text';

/** Plain (non-transactional, lock-free) reads. */
export class SqlWalletQueries implements WalletQueries {
  constructor(private readonly em: EntityManager) {}

  private sql(): Sql {
    return new Sql(this.em.fork());
  }

  async findWallet(walletId: string): Promise<WalletView | undefined> {
    const [row] = await this.sql().rows(
      'select id, player_id, currency, balance, version, created_at, updated_at from wallets where id = ?::uuid',
      [walletId],
    );
    if (!row) return undefined;
    return {
      id: String(row.id),
      playerId: String(row.player_id),
      balance: { amount: decimalText(row.balance), currency: String(row.currency) },
      version: Number(row.version),
      createdAt: new Date(String(row.created_at)),
      updatedAt: new Date(String(row.updated_at)),
    };
  }

  async listLedger(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerEntryRow[] | undefined> {
    const rows = await this.sql().rows(
      `select l.seq, l.id, l.transaction_id, l.direction, l.amount, l.currency, l.balance_before, l.balance_after, l.created_at
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id and l.seq > ?::bigint
        where w.id = ?::uuid
        order by l.seq nulls last
        limit ?`,
      [afterSeq ?? '0', walletId, limit],
    );
    if (rows.length === 0) return undefined;
    return rows
      .filter((r) => r.id !== null)
      .map((r) => {
        const currency = String(r.currency);
        return {
          seq: String(r.seq),
          id: String(r.id),
          transactionId: String(r.transaction_id),
          direction: String(r.direction),
          amount: { amount: decimalText(r.amount), currency },
          balanceBefore: { amount: decimalText(r.balance_before), currency },
          balanceAfter: { amount: decimalText(r.balance_after), currency },
          createdAt: new Date(String(r.created_at)),
        };
      });
  }

  findTransactionById(id: string): Promise<StoredTransaction | undefined> {
    return new SqlWagerTransactionRepository(this.sql()).findById(id);
  }

  findTransactionByProviderAndExternalId(providerId: string, externalId: string): Promise<StoredTransaction | undefined> {
    return new SqlWagerTransactionRepository(this.sql()).findByProviderAndExternalId(providerId, externalId);
  }

  async snapshotForReconciliation(walletId: string): Promise<ReconciliationSnapshot | undefined> {
    const [row] = await this.sql().rows(
      `select w.currency, w.balance,
              coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0) as ledger_balance,
              count(l.id) as entry_count,
              (select balance_after from wallet_ledger_entries where wallet_id = w.id order by seq desc limit 1) as last_balance
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ?::uuid
        group by w.id`,
      [walletId],
    );
    if (!row) return undefined;
    const currency = String(row.currency);
    const money = (v: unknown) => ({ amount: decimalText(v), currency });
    return {
      walletId,
      currency,
      walletBalance: money(row.balance),
      ledgerBalance: money(row.ledger_balance),
      lastEntryBalance: row.last_balance === null ? undefined : money(row.last_balance),
      entryCount: Number(row.entry_count),
    };
  }
}
