import { MikroORM } from '@mikro-orm/postgresql';
import { NotFoundError } from '../../application/errors';
import { WalletView } from '../../application/open-wallet';
import { ValidationError } from '../../domain/errors';
import { Money } from '../../domain/money';
import { logger } from '../../observability/logger';
import { metrics } from '../../observability/metrics';

const money = (amount: string, currency: string) => ({ amount, currency });

/** Reconstrói um Money a partir de um numeric que pode ser negativo (ledger corrompido). */
const signedMoney = (amount: string, currency: string): Money =>
  amount.startsWith('-') ? Money.from({ amount: amount.slice(1), currency }).negate() : Money.from({ amount, currency });

/** Lado de leitura: consultas diretas, sem passar pelo domínio (nada aqui muda estado). */
export class ReadModel {
  constructor(private readonly orm: MikroORM) {}

  private query<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.orm.em.fork().execute(sql, params as any[]);
  }

  async ping(): Promise<void> {
    await this.query('select 1');
  }

  async outboxLagSeconds(): Promise<number> {
    const [row] = await this.query(
      `select coalesce(extract(epoch from now() - min(occurred_at)), 0) as lag from outbox_messages where published_at is null`,
    );
    return Number(row!.lag);
  }

  async wallet(walletId: string): Promise<WalletView> {
    const [row] = await this.query(`select id, player_id, currency, balance, version from wallets where id = ?`, [walletId]);
    if (!row) throw new NotFoundError(`wallet ${walletId} not found`);
    return { id: row.id, playerId: row.player_id, balance: money(row.balance, row.currency), version: row.version };
  }

  /** Cursor opaco e estável: a posição é a `sequence` do último item, que nunca muda (ledger é append-only). */
  async ledger(walletId: string, cursor: string | undefined, limit: number) {
    await this.wallet(walletId);
    const after = cursor === undefined ? '0' : Buffer.from(cursor, 'base64url').toString();
    if (!/^\d+$/.test(after)) throw new ValidationError('invalid cursor');
    const rows = await this.query(
      `select id, sequence, transaction_id, direction, amount, currency, balance_before, balance_after, created_at
         from wallet_ledger_entries where wallet_id = ? and sequence > ? order by sequence limit ?`,
      [walletId, after, limit + 1],
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        transactionId: r.transaction_id,
        direction: r.direction,
        money: money(r.amount, r.currency),
        balanceBefore: money(r.balance_before, r.currency),
        balanceAfter: money(r.balance_after, r.currency),
        createdAt: new Date(r.created_at).toISOString(),
      })),
      nextCursor: rows.length > limit ? Buffer.from(String(page.at(-1)!.sequence)).toString('base64url') : null,
    };
  }

  transaction(transactionId: string) {
    return this.findTransaction(`id = ?`, [transactionId]);
  }

  transactionByProviderRef(providerId: string, externalTransactionId: string) {
    return this.findTransaction(`provider_id = ? and external_transaction_id = ?`, [providerId, externalTransactionId]);
  }

  private async findTransaction(where: string, params: unknown[]) {
    const [r] = await this.query(`select * from wager_transactions where ${where}`, params);
    if (!r) throw new NotFoundError('transaction not found');
    return {
      transactionId: r.id,
      providerId: r.provider_id,
      externalTransactionId: r.external_transaction_id,
      walletId: r.wallet_id,
      playerId: r.player_id,
      roundId: r.round_id,
      gameId: r.game_id,
      kind: r.kind,
      money: money(r.amount, r.currency),
      status: r.status,
      failureCode: r.failure_code ?? undefined,
      referenceExternalTransactionId: r.reference_external_transaction_id ?? undefined,
      referenceTransactionId: r.reference_transaction_id ?? undefined,
      balance: r.resulting_balance ? money(r.resulting_balance, r.currency) : undefined,
      createdAt: new Date(r.created_at).toISOString(),
      processedAt: r.processed_at ? new Date(r.processed_at).toISOString() : undefined,
    };
  }

  /** Compara o saldo materializado com o reconstruído pelo ledger. Nunca corrige: só sinaliza. */
  async reconcile(walletId: string) {
    // Uma única instrução SQL = um snapshot consistente, sem precisar travar a wallet.
    const [row] = await this.query(
      `select w.balance, w.currency, count(l.id)::int as entries,
              coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2) as calculated
         from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ? group by w.id`,
      [walletId],
    );
    if (!row) throw new NotFoundError(`wallet ${walletId} not found`);
    const stored = signedMoney(row.balance, row.currency);
    const calculated = signedMoney(row.calculated, row.currency);
    const difference = stored.subtract(calculated);
    const consistent = difference.isZero();
    if (!consistent) {
      metrics.reconciliationDivergences.inc();
      logger.error({ walletId, checkedEntries: row.entries }, 'wallet balance diverges from ledger');
    }
    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: row.entries as number,
    };
  }
}
