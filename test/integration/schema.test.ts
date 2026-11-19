import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { freshDatabase, harness, uuid } from '../support';

/**
 * As invariantes são garantidas pelo SCHEMA. Estes testes escrevem com SQL direto, por fora da
 * aplicação, simulando um bug de código ou uma intervenção manual — e o Postgres recusa.
 */
let orm: MikroORM;
let h: ReturnType<typeof harness>;

beforeAll(async () => {
  orm = await freshDatabase();
  h = harness(orm);
});
afterAll(async () => {
  await h.assertLedgerConsistent();
  await orm.close();
});

const rejected = (statement: Promise<unknown>, message: RegExp) => expect(statement).rejects.toThrow(message);

describe('schema constraints', () => {
  test('balance can never be negative', async () => {
    const wallet = await h.wallet('10.00');
    await rejected(h.sql(`update wallets set balance = -0.01 where id = ?`, [wallet.id]), /wallets_balance_check/);
  });

  test('one wallet per player and currency', async () => {
    const wallet = await h.wallet('10.00');
    await rejected(
      h.sql(`insert into wallets values (?, ?, 'BRL', 0, 1, now(), now())`, [uuid(), wallet.playerId]),
      /wallets_player_currency_uq/,
    );
  });

  test('balance cannot change without a matching ledger entry (checked at commit)', async () => {
    const wallet = await h.wallet('10.00');
    await rejected(h.sql(`update wallets set balance = 999.00 where id = ?`, [wallet.id]), /diverges from ledger/);
    expect(await h.balance(wallet.id)).toBe('10.00');
  });

  test('a ledger entry cannot exist without the matching balance change', async () => {
    const wallet = await h.wallet('10.00');
    const bet = await h.send(h.payload(wallet, 'LOSS', '1.00')); // transação sem lançamento
    await rejected(
      h.sql(
        `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         values (?, ?, ?, 'CREDIT', 5.00, 'BRL', 10.00, 15.00, now())`,
        [uuid(), wallet.id, bet.transactionId],
      ),
      /diverges from ledger/,
    );
  });

  test('ledger is append-only: no UPDATE, no DELETE, no TRUNCATE', async () => {
    const wallet = await h.wallet('10.00');
    await rejected(h.sql(`update wallet_ledger_entries set amount = 1 where wallet_id = ?`, [wallet.id]), /append-only/);
    await rejected(h.sql(`delete from wallet_ledger_entries where wallet_id = ?`, [wallet.id]), /append-only/);
    await rejected(h.sql(`truncate wallet_ledger_entries`), /append-only/);
  });

  test('ledger arithmetic and chain are enforced', async () => {
    const wallet = await h.wallet('10.00');
    const loss = await h.send(h.payload(wallet, 'LOSS', '1.00'));
    const insert = (before: string, after: string) =>
      h.sql(
        `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         values (?, ?, ?, 'DEBIT', 5.00, 'BRL', ?, ?, now())`,
        [uuid(), wallet.id, loss.transactionId, before, after],
      );
    await rejected(insert('10.00', '6.00'), /wallet_ledger_entries_balanced_ck/); // 10 - 5 != 6
    await rejected(insert('50.00', '45.00'), /ledger chain broken/); // o anterior terminou em 10.00
  });

  test('at most one ledger entry per transaction', async () => {
    const wallet = await h.wallet('10.00');
    const bet = await h.send(h.payload(wallet, 'BET', '4.00'));
    await rejected(
      h.sql(
        `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         values (?, ?, ?, 'DEBIT', 4.00, 'BRL', 6.00, 2.00, now())`,
        [uuid(), wallet.id, bet.transactionId],
      ),
      /wallet_ledger_entries_transaction_uq/,
    );
  });

  test('terminal transactions are frozen and transactions cannot be deleted', async () => {
    const wallet = await h.wallet('10.00');
    const bet = await h.send(h.payload(wallet, 'BET', '4.00'));
    await rejected(h.sql(`update wager_transactions set status = 'REJECTED', failure_code = 'X' where id = ?`, [bet.transactionId]), /is terminal/);
    await rejected(h.sql(`update wager_transactions set amount = 1 where id = ?`, [bet.transactionId]), /is terminal/);
    await rejected(h.sql(`delete from wager_transactions where id = ?`, [bet.transactionId]), /cannot be deleted/);
  });

  test('idempotency key and provider transaction id are unique', async () => {
    const wallet = await h.wallet('10.00');
    const payload = h.payload(wallet, 'BET', '1.00');
    const bet = await h.send(payload, 'unique-key');
    const copy = (key: string, external: string) =>
      h.sql(
        `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at)
         select ?, provider_id, ?, ?, payload_hash, wallet_id, player_id, round_id, game_id, 'LOSS', amount, currency, 'PENDING', now()
           from wager_transactions where id = ?`,
        [uuid(), external, key, bet.transactionId],
      );
    await rejected(copy('unique-key', 'other-external'), /wager_transactions_idempotency_key_uq/);
    await rejected(copy('other-key', payload.externalTransactionId), /wager_transactions_provider_external_uq/);
  });

  test('a transaction can be reversed only once, even by direct SQL', async () => {
    const wallet = await h.wallet('100.00');
    const bet = h.payload(wallet, 'BET', '30.00');
    const betResult = await h.send(bet);
    await h.send(h.payload(wallet, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId }));
    await rejected(
      h.sql(
        `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, created_at, processed_at)
         select ?, provider_id, 'second-reversal', 'second-reversal', payload_hash, wallet_id, player_id, round_id, game_id, 'ROLLBACK', amount, currency, external_transaction_id, id, 'PROCESSED', now(), now()
           from wager_transactions where id = ?`,
        [uuid(), betResult.transactionId],
      ),
      /wager_transactions_single_reversal_uq/,
    );
  });

  test('structural checks: reference required, failure code tied to status, positive amount', async () => {
    const wallet = await h.wallet('10.00');
    const insert = (columns: string, values: string) =>
      h.sql(
        `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, currency, created_at, ${columns})
         values (?, 'p', ?, ?, repeat('a', 64), ?, ?, 'r', 'g', 'BRL', now(), ${values})`,
        [uuid(), uuid(), uuid(), wallet.id, wallet.playerId],
      );
    await rejected(insert('kind, amount, status', `'REFUND', 1, 'PENDING'`), /reference_required_ck/);
    await rejected(insert('kind, amount, status', `'BET', 1, 'REJECTED'`), /failure_code_ck/);
    await rejected(insert('kind, amount, status, failure_code', `'BET', 1, 'PENDING', 'X'`), /failure_code_ck/);
    await rejected(insert('kind, amount, status', `'BET', 0, 'PENDING'`), /amount_positive_ck/);
    await rejected(insert('kind, amount, status', `'BONUS', 1, 'PENDING'`), /kind_check/);
  });
});

describe('migrations', () => {
  test('are reversible: down removes everything, up restores it', async () => {
    const tables = () => h.sql(`select table_name from information_schema.tables where table_schema = 'public' and table_name <> 'mikro_orm_migrations'`);
    await orm.migrator.down();
    expect(await tables()).toHaveLength(0);
    expect(await h.sql(`select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`)).toHaveLength(0);
    await orm.migrator.up();
    expect((await tables()).map((t) => t.table_name).sort()).toEqual(
      ['inbox_messages', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets'],
    );
  });
});
