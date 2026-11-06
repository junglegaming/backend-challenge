import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQLSTATE, expectViolation, insertEntry, insertTx, insertWallet } from './support/fixtures';
import { type TestDatabase, createTestDatabase } from './support/test-database';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

describe('wallets', () => {
  test('UNIQUE (player_id, currency): one wallet per player and currency', async () => {
    const w = await insertWallet(db, { currency: 'BRL' });
    await expectViolation(insertWallet(db, { playerId: w.playerId, currency: 'BRL' }), SQLSTATE.unique, 'wallets_player_currency_uq');
    await insertWallet(db, { playerId: w.playerId, currency: 'USD' }); // other currency is fine
  });

  test('CHECK balance >= 0 on insert and on update (a negative balance cannot be stored)', async () => {
    await expectViolation(insertWallet(db, { balance: '-0.01' }), SQLSTATE.check, 'wallets_balance_non_negative_ck');
    const w = await insertWallet(db, { balance: '10.00' });
    await expectViolation(
      db.run('update wallets set balance = ?, version = 2 where id = ?', ['-0.01', w.id]),
      SQLSTATE.check,
      'wallets_balance_non_negative_ck',
    );
    const [row] = await db.run<{ balance: string }>('select balance from wallets where id = ?', [w.id]);
    expect(row!.balance).toBe('10.00');
  });

  test('atomic conditional debit cannot overdraw: balance - x < 0 is rejected by the database', async () => {
    const w = await insertWallet(db, { balance: '100.00' });
    await db.run('update wallets set balance = balance - ?, version = version + 1 where id = ?', ['80.00', w.id]);
    await expectViolation(
      db.run('update wallets set balance = balance - ?, version = version + 1 where id = ?', ['80.00', w.id]),
      SQLSTATE.check,
      'wallets_balance_non_negative_ck',
    );
  });

  test('CHECK version >= 1 and currency format', async () => {
    await expectViolation(insertWallet(db, { version: 0 }), SQLSTATE.check, 'wallets_version_positive_ck');
    await expectViolation(insertWallet(db, { currency: 'brl' }), SQLSTATE.check, 'wallets_currency_format_ck');
  });

  test('numeric(20,2) stores scale 2 exactly (no float drift, extra decimals are rounded by the type, not by us)', async () => {
    const w = await insertWallet(db, { balance: '0.10' });
    await db.run('update wallets set balance = balance + ?, version = version + 1 where id = ?', ['0.20', w.id]);
    const [row] = await db.run<{ balance: string }>('select balance from wallets where id = ?', [w.id]);
    expect(row!.balance).toBe('0.30');
  });

  test('version moves by exactly +1 and only together with the balance (trigger)', async () => {
    const w = await insertWallet(db, { balance: '50.00' });
    await expectViolation(db.run('update wallets set balance = 40.00 where id = ?', [w.id]), SQLSTATE.integrity);
    await expectViolation(db.run('update wallets set balance = 40.00, version = 3 where id = ?', [w.id]), SQLSTATE.integrity);
    await expectViolation(db.run('update wallets set version = 2 where id = ?', [w.id]), SQLSTATE.integrity);
    await db.run('update wallets set balance = 40.00, version = 2 where id = ?', [w.id]);
    await db.run('update wallets set updated_at = now() where id = ?', [w.id]); // no balance change, no version change
    const [row] = await db.run<{ balance: string; version: number }>('select balance, version from wallets where id = ?', [w.id]);
    expect(row).toEqual({ balance: '40.00', version: 2 });
  });

  test('identity is immutable and wallets cannot be deleted', async () => {
    const w = await insertWallet(db);
    await expectViolation(db.run('update wallets set player_id = ? where id = ?', [randomUUID(), w.id]), SQLSTATE.integrity);
    await expectViolation(db.run("update wallets set currency = 'USD' where id = ?", [w.id]), SQLSTATE.integrity);
    await expectViolation(db.run('delete from wallets where id = ?', [w.id]), SQLSTATE.integrity);
  });
});

describe('wagering_transactions', () => {
  test('UNIQUE idempotency_key', async () => {
    const w = await insertWallet(db);
    await insertTx(db, w, { idempotencyKey: 'dup-key' });
    await expectViolation(insertTx(db, w, { idempotencyKey: 'dup-key' }), SQLSTATE.unique, 'wagering_transactions_idempotency_key_uq');
  });

  test('UNIQUE (provider_id, external_transaction_id); same external id under another provider is fine', async () => {
    const w = await insertWallet(db);
    await insertTx(db, w, { providerId: 'provider-a', externalTransactionId: 'tx-1' });
    await expectViolation(
      insertTx(db, w, { providerId: 'provider-a', externalTransactionId: 'tx-1', idempotencyKey: 'other-key' }),
      SQLSTATE.unique,
      'wagering_transactions_provider_external_uq',
    );
    await insertTx(db, w, { providerId: 'provider-b', externalTransactionId: 'tx-1' });
  });

  test('FK wallet_id must exist', async () => {
    await expectViolation(insertTx(db, { id: randomUUID(), playerId: randomUUID() }), SQLSTATE.foreignKey);
  });

  test('CHECK kind / status domains, amount rules, currency format', async () => {
    const w = await insertWallet(db);
    await expectViolation(insertTx(db, w, { kind: 'TIP' }), SQLSTATE.check, 'wagering_transactions_kind_ck');
    await expectViolation(insertTx(db, w, { status: 'DONE' }), SQLSTATE.check, 'wagering_transactions_status_ck');
    await expectViolation(insertTx(db, w, { kind: 'BET', amount: '0.00' }), SQLSTATE.check, 'wagering_transactions_amount_ck');
    await expectViolation(insertTx(db, w, { kind: 'WIN', amount: '-1.00' }), SQLSTATE.check, 'wagering_transactions_amount_ck');
    await insertTx(db, w, { kind: 'LOSS', amount: '0.00' }); // LOSS may be zero
  });

  test('REFUND and ROLLBACK require reference_external_transaction_id', async () => {
    const w = await insertWallet(db);
    for (const kind of ['REFUND', 'ROLLBACK']) {
      await expectViolation(insertTx(db, w, { kind }), SQLSTATE.check, 'wagering_transactions_reversal_reference_ck');
      await insertTx(db, w, { kind, referenceExternalTransactionId: 'bet-ext' });
    }
  });

  test('status consistency: failure_code, processed_at and balance snapshot match the status', async () => {
    const w = await insertWallet(db);
    await expectViolation(insertTx(db, w, { status: 'REJECTED', failureCode: null }), SQLSTATE.check, 'wagering_transactions_failure_code_ck');
    await expectViolation(insertTx(db, w, { status: 'PENDING', failureCode: 'INSUFFICIENT_FUNDS' }), SQLSTATE.check, 'wagering_transactions_failure_code_ck');
    await expectViolation(insertTx(db, w, { status: 'PROCESSED', processedAt: null }), SQLSTATE.check, 'wagering_transactions_processed_at_ck');
    await expectViolation(insertTx(db, w, { status: 'PENDING', processedAt: 'now' }), SQLSTATE.check, 'wagering_transactions_processed_at_ck');
    await expectViolation(insertTx(db, w, { status: 'PROCESSED', balanceSnapshot: null }), SQLSTATE.check);
    await expectViolation(insertTx(db, w, { status: 'PROCESSED', balanceSnapshot: '-1.00' }), SQLSTATE.check);
    const id = await insertTx(db, w, { status: 'PROCESSED', balanceSnapshot: '90.00' });
    const [row] = await db.run<{ balance_snapshot: string }>('select balance_snapshot from wagering_transactions where id = ?', [id]);
    expect(row!.balance_snapshot).toBe('90.00'); // the balance observed at processing time, for exact replays
  });

  test('reference_transaction_id only on PROCESSED rows and never to itself', async () => {
    const w = await insertWallet(db);
    const bet = await insertTx(db, w, { status: 'PROCESSED' });
    await expectViolation(
      insertTx(db, w, { kind: 'REFUND', referenceExternalTransactionId: 'x', referenceTransactionId: bet, status: 'PENDING' }),
      SQLSTATE.check,
      'wagering_transactions_reference_processed_ck',
    );
    const self = randomUUID();
    await expectViolation(
      insertTx(db, w, { id: self, kind: 'REFUND', referenceExternalTransactionId: 'x', referenceTransactionId: self, status: 'PROCESSED' }),
      SQLSTATE.check,
    );
    await expectViolation(
      insertTx(db, w, { kind: 'REFUND', referenceExternalTransactionId: 'x', referenceTransactionId: randomUUID(), status: 'PROCESSED' }),
      SQLSTATE.foreignKey,
      'wagering_transactions_reference_fk',
    );
  });

  test('partial unique index: a reference is reversed at most once per kind (only PROCESSED counts)', async () => {
    const w = await insertWallet(db);
    const bet = await insertTx(db, w, { kind: 'BET', status: 'PROCESSED' });
    const ref = { referenceExternalTransactionId: 'bet-ext', referenceTransactionId: bet };

    // REJECTED / PENDING_REFERENCE attempts do not occupy the slot
    await insertTx(db, w, { kind: 'REFUND', status: 'REJECTED', failureCode: 'AMOUNT_MISMATCH', referenceExternalTransactionId: 'bet-ext' });
    await insertTx(db, w, { kind: 'REFUND', status: 'PENDING_REFERENCE', referenceExternalTransactionId: 'bet-ext' });

    await insertTx(db, w, { kind: 'REFUND', status: 'PROCESSED', ...ref });
    await expectViolation(
      insertTx(db, w, { kind: 'REFUND', status: 'PROCESSED', ...ref }),
      SQLSTATE.unique,
      'wagering_transactions_reversal_per_kind_uq',
    );
  });

  test('stricter partial unique index: REFUND and ROLLBACK cannot both reverse the same transaction (double credit)', async () => {
    const w = await insertWallet(db);
    const bet = await insertTx(db, w, { kind: 'BET', status: 'PROCESSED' });
    const ref = { referenceExternalTransactionId: 'bet-ext', referenceTransactionId: bet };
    await insertTx(db, w, { kind: 'REFUND', status: 'PROCESSED', ...ref });
    await expectViolation(
      insertTx(db, w, { kind: 'ROLLBACK', status: 'PROCESSED', ...ref }),
      SQLSTATE.unique,
      'wagering_transactions_single_reversal_uq',
    );
  });

  test('terminal rows are frozen: PROCESSED, REJECTED and FAILED never change again', async () => {
    const w = await insertWallet(db);
    for (const status of ['PROCESSED', 'REJECTED', 'FAILED']) {
      const id = await insertTx(db, w, { status });
      await expectViolation(db.run("update wagering_transactions set status = 'PENDING' where id = ?", [id]), SQLSTATE.integrity);
      await expectViolation(db.run('update wagering_transactions set failure_code = null where id = ?', [id]), SQLSTATE.integrity);
      await expectViolation(db.run('delete from wagering_transactions where id = ?', [id]), SQLSTATE.integrity);
    }
  });

  test('non-terminal rows may advance, but never regress or change business fields', async () => {
    const w = await insertWallet(db);
    const waiting = await insertTx(db, w, { kind: 'REFUND', status: 'PENDING_REFERENCE', referenceExternalTransactionId: 'r' });
    await expectViolation(db.run("update wagering_transactions set status = 'PENDING' where id = ?", [waiting]), SQLSTATE.integrity);
    await expectViolation(db.run("update wagering_transactions set amount = 1.00 where id = ?", [waiting]), SQLSTATE.integrity);
    await expectViolation(db.run("update wagering_transactions set payload_hash = 'x' where id = ?", [waiting]), SQLSTATE.integrity);
    await expectViolation(db.run("update wagering_transactions set idempotency_key = 'x' where id = ?", [waiting]), SQLSTATE.integrity);
    await db.run("update wagering_transactions set status = 'PENDING_REFERENCE' where id = ?", [waiting]); // retry stays waiting
    await db.run("update wagering_transactions set status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND' where id = ?", [waiting]);
    await expectViolation(db.run("update wagering_transactions set failure_code = 'X' where id = ?", [waiting]), SQLSTATE.integrity);
  });
});

describe('wallet_ledger_entries', () => {
  async function scene() {
    const w = await insertWallet(db, { balance: '100.00' });
    const t = await insertTx(db, w, { status: 'PROCESSED' });
    return { w, t };
  }

  test('UNIQUE (wallet_id, transaction_id): at most one entry per transaction and wallet', async () => {
    const { w, t } = await scene();
    await insertEntry(db, { walletId: w.id, transactionId: t });
    await expectViolation(
      insertEntry(db, { walletId: w.id, transactionId: t }),
      SQLSTATE.unique,
      'wallet_ledger_entries_wallet_transaction_uq',
    );
  });

  test('FKs: wallet and transaction must exist', async () => {
    const { w, t } = await scene();
    await expectViolation(insertEntry(db, { walletId: randomUUID(), transactionId: t }), SQLSTATE.foreignKey);
    await expectViolation(insertEntry(db, { walletId: w.id, transactionId: randomUUID() }), SQLSTATE.foreignKey);
  });

  test('CHECK arithmetic: balance_before ± amount = balance_after', async () => {
    const { w, t } = await scene();
    const ck = 'wallet_ledger_entries_arithmetic_ck';
    await expectViolation(insertEntry(db, { walletId: w.id, transactionId: t, direction: 'DEBIT', before: '100.00', amount: '10.00', after: '95.00' }), SQLSTATE.check, ck);
    await expectViolation(insertEntry(db, { walletId: w.id, transactionId: t, direction: 'DEBIT', before: '100.00', amount: '10.00', after: '110.00' }), SQLSTATE.check, ck);
    await expectViolation(insertEntry(db, { walletId: w.id, transactionId: t, direction: 'CREDIT', before: '100.00', amount: '10.00', after: '90.00' }), SQLSTATE.check, ck);
    await insertEntry(db, { walletId: w.id, transactionId: t, direction: 'CREDIT', before: '100.00', amount: '10.00', after: '110.00' });
  });

  test('CHECK amount > 0, balances >= 0, direction domain', async () => {
    const { w, t } = await scene();
    await expectViolation(insertEntry(db, { walletId: w.id, transactionId: t, amount: '0.00', after: '100.00' }), SQLSTATE.check, 'wallet_ledger_entries_amount_positive_ck');
    await expectViolation(insertEntry(db, { walletId: w.id, transactionId: t, before: '5.00', amount: '10.00', after: '-5.00' }), SQLSTATE.check, 'wallet_ledger_entries_balances_non_negative_ck');
    // an unknown direction also violates the arithmetic check, so only the SQLSTATE is asserted
    await expectViolation(insertEntry(db, { walletId: w.id, transactionId: t, direction: 'SIDEWAYS' }), SQLSTATE.check);
  });

  test('trigger blocks UPDATE, DELETE and TRUNCATE: the ledger is append-only', async () => {
    const { w, t } = await scene();
    const entry = await insertEntry(db, { walletId: w.id, transactionId: t });

    await expectViolation(db.run("update wallet_ledger_entries set amount = 1.00, balance_after = 99.00 where id = ?", [entry]), SQLSTATE.integrity);
    await expectViolation(db.run("update wallet_ledger_entries set created_at = now() where id = ?", [entry]), SQLSTATE.integrity);
    await expectViolation(db.run('delete from wallet_ledger_entries where id = ?', [entry]), SQLSTATE.integrity);
    await expectViolation(db.run('delete from wallet_ledger_entries'), SQLSTATE.integrity);
    await expectViolation(db.run('truncate wallet_ledger_entries'), SQLSTATE.integrity);

    const [row] = await db.run<{ amount: string }>('select amount from wallet_ledger_entries where id = ?', [entry]);
    expect(row!.amount).toBe('10.00'); // untouched
  });

  test('an UPDATE that changes nothing is also blocked (no silent rewrites)', async () => {
    const { w, t } = await scene();
    const entry = await insertEntry(db, { walletId: w.id, transactionId: t });
    await expectViolation(db.run('update wallet_ledger_entries set amount = amount where id = ?', [entry]), SQLSTATE.integrity);
  });

  test('seq is generated, monotonic per insert and cannot be supplied', async () => {
    const { w, t } = await scene();
    const t2 = await insertTx(db, w, { status: 'PROCESSED' });
    const a = await insertEntry(db, { walletId: w.id, transactionId: t });
    const b = await insertEntry(db, { walletId: w.id, transactionId: t2, direction: 'CREDIT', before: '100.00', amount: '10.00', after: '110.00' });
    const rows = await db.run<{ id: string; seq: string }>('select id, seq from wallet_ledger_entries where id in (?, ?) order by seq', [a, b]);
    expect(rows.map((r) => r.id)).toEqual([a, b]);
    await expectViolation(
      db.run(
        `insert into wallet_ledger_entries (id, seq, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         values (?, 1, ?, ?, 'DEBIT', 1.00, 'BRL', 10.00, 9.00, now())`,
        [randomUUID(), w.id, t],
      ),
      '428C9', // cannot insert into a GENERATED ALWAYS identity column
    );
  });
});

describe('inbox_messages', () => {
  const insert = (consumer: string, message: string) =>
    db.run(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values (?, ?, 'h', now())`,
      [consumer, message],
    );

  test('PRIMARY KEY (consumer_name, message_id) deduplicates per consumer', async () => {
    await insert('wager-consumer', 'msg-1');
    await expectViolation(insert('wager-consumer', 'msg-1'), SQLSTATE.unique, 'inbox_messages_pk');
    await insert('other-consumer', 'msg-1'); // same message, different consumer
    await insert('wager-consumer', 'msg-2');
  });

  test('ON CONFLICT DO NOTHING detects redelivery atomically (no read-then-insert race)', async () => {
    await insert('c', 'redelivered');
    const rows = await db.run(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
       values ('c', 'redelivered', 'h', now()) on conflict do nothing returning message_id`,
    );
    expect(rows).toHaveLength(0);
  });

  test('NOT NULL columns', async () => {
    await expectViolation(
      db.run(`insert into inbox_messages (consumer_name, message_id, received_at) values ('c', 'x', now())`),
      SQLSTATE.notNull,
    );
  });
});

describe('outbox_messages', () => {
  const insert = (id: string, attempts = 0) =>
    db.run(
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
       values (?, ?, 'WalletBalanceChanged', ?::jsonb, now(), ?)`,
      [id, randomUUID(), JSON.stringify({ eventId: id }), attempts],
    );

  test('primary key and attempts >= 0', async () => {
    const id = randomUUID();
    await insert(id);
    await expectViolation(insert(id), SQLSTATE.unique);
    await expectViolation(insert(randomUUID(), -1), SQLSTATE.check, 'outbox_messages_attempts_ck');
  });

  test('defaults: next_attempt_at is due immediately and the row is pending', async () => {
    const id = randomUUID();
    await insert(id);
    const [row] = await db.run<{ pending: boolean; due: boolean }>(
      'select published_at is null as pending, next_attempt_at <= now() as due from outbox_messages where id = ?',
      [id],
    );
    expect(row).toEqual({ pending: true, due: true });
  });

  test('the partial pending index only contains unpublished rows', async () => {
    const pending = randomUUID();
    const published = randomUUID();
    await insert(pending);
    await insert(published);
    await db.run('update outbox_messages set published_at = now() where id = ?', [published]);
    const rows = await db.run<{ id: string }>(
      'select id from outbox_messages where published_at is null and next_attempt_at <= now() and id in (?, ?)',
      [pending, published],
    );
    expect(rows.map((r) => r.id)).toEqual([pending]);
  });
});
