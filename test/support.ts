import { MikroORM } from '@mikro-orm/postgresql';
import { OpenWallet, WalletView } from '../src/application/open-wallet';
import { SubmitResult, SubmitWagerTransaction } from '../src/application/submit-wager-transaction';
import { ormConfig } from '../src/infra/persistence/orm';
import { MikroUnitOfWork } from '../src/infra/persistence/unit-of-work';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering';
export const TEST_DATABASE_URL = ADMIN_URL.replace(/\/[^/]+$/, '/wagering_test');

/** Banco de teste dedicado, recriado do zero e migrado. Postgres real, sem mocks. */
export async function freshDatabase(): Promise<MikroORM> {
  const admin = await MikroORM.init({ ...ormConfig(ADMIN_URL), entities: [], discovery: { warnWhenNoEntities: false } });
  const exists = await admin.em.execute(`select 1 from pg_database where datname = 'wagering_test'`);
  if (exists.length === 0) await admin.em.execute(`create database wagering_test`);
  await admin.close();

  const orm = await MikroORM.init(ormConfig(TEST_DATABASE_URL));
  await orm.em.execute(`drop schema public cascade; create schema public;`);
  await orm.migrator.up();
  return orm;
}

export type Sql = <T = Record<string, any>>(query: string, params?: unknown[]) => Promise<T[]>;
export const sqlFor = (orm: MikroORM): Sql => (query, params = []) => orm.em.fork().execute(query, params as any[]);

export const uuid = (): string => crypto.randomUUID();

export function harness(orm: MikroORM) {
  const uow = new MikroUnitOfWork(orm);
  const sql = sqlFor(orm);
  const openWallet = new OpenWallet(uow);
  const submit = new SubmitWagerTransaction(uow);
  let counter = 0;

  return {
    uow,
    sql,
    submit,
    async wallet(amount = '100.00', currency = 'BRL'): Promise<WalletView> {
      return openWallet.execute({ playerId: uuid(), initialBalance: { amount, currency } }, 'test');
    },
    /** Monta um payload válido para a wallet; `over` sobrescreve campos. */
    payload(wallet: WalletView, kind: string, amount: string, over: Record<string, unknown> = {}) {
      counter += 1;
      return {
        providerId: 'provider-a',
        externalTransactionId: `ext-${counter}-${uuid()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind,
        money: { amount, currency: 'BRL' },
        ...over,
      };
    },
    async send(payload: Record<string, any>, idempotencyKey = `${payload.providerId}:${payload.externalTransactionId}`): Promise<SubmitResult> {
      return (await submit.execute({ idempotencyKey, payload, correlationId: 'test' })) as SubmitResult;
    },
    async balance(walletId: string): Promise<string> {
      const [row] = await sql(`select balance from wallets where id = ?`, [walletId]);
      return row!.balance;
    },
    /** Invariante final de todo teste: saldo materializado == saldo reconstruído pelo ledger. */
    async assertLedgerConsistent(walletId?: string): Promise<void> {
      const rows = await sql(
        `select w.id, w.balance, coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0) as rebuilt
           from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
          where (?::uuid is null or w.id = ?::uuid)
          group by w.id having w.balance <> coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)`,
        [walletId ?? null, walletId ?? null],
      );
      if (rows.length > 0) throw new Error(`balance diverges from ledger: ${JSON.stringify(rows)}`);
    },
  };
}
