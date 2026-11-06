import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { Money, MoneyProps, DomainError } from './domain/money';
import { Kind, Status } from './domain/wager';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  WagerTransactionPendingReference,
} from './domain/integration-event';
import { metrics } from './metrics';

type Submit = {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<Kind, Kind.Opening>;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
};
const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
          .join(',')}}`
      : JSON.stringify(v);
@Injectable()
export class AppService {
  private readonly log = new Logger(AppService.name);
  private readonly sqs = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
  constructor(private readonly db: DataSource) {}
  async createWallet(input: { playerId: string; initialBalance: MoneyProps }) {
    if (
      !input ||
      typeof input.playerId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.playerId,
      ) ||
      !input.initialBalance
    )
      throw new DomainError(
        'INVALID_WALLET',
        'playerId must be a UUID and initialBalance is required',
      );
    const money = Money.from(input.initialBalance),
      id = randomUUID(),
      now = new Date();
    try {
      return await this.db.transaction(async (m) => {
        await m.query(
          'INSERT INTO wallets(id,player_id,currency,balance,version,created_at,updated_at) VALUES($1,$2,$3,$4,1,$5,$5)',
          [id, input.playerId, money.currency, money.toString(), now],
        );
        if (money.isPositive()) {
          const tx = randomUUID();
          await m.query(
            `INSERT INTO wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,created_at,processed_at) VALUES($1,'internal',$2,$2,$3,$4,$5,'opening','internal','OPENING',$6,$7,'PROCESSED',$8,$8)`,
            [
              tx,
              `opening:${id}`,
              createHash('sha256').update(id).digest('hex'),
              id,
              input.playerId,
              money.toString(),
              money.currency,
              now,
            ],
          );
          await m.query(
            `INSERT INTO wallet_ledger_entries VALUES($1,$2,$3,'CREDIT',$4,$5,0,$4,$6)`,
            [randomUUID(), id, tx, money.toString(), money.currency, now],
          );
        }
        return { id, playerId: input.playerId, balance: money.toJSON(), version: 1 };
      });
    } catch (error) {
      const e = error as { code?: string; driverError?: { code?: string } };
      if ((e.driverError?.code ?? e.code) === '23505')
        throw new DomainError(
          'WALLET_CONFLICT',
          'A wallet already exists for this player and currency',
        );
      throw error;
    }
  }
  async submit(
    input: Submit,
    key: string,
    correlationId = randomUUID(),
    inbox?: { messageId: string; payloadHash: string },
  ) {
    const started = Date.now();
    if (!key)
      throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
    const raw = input as unknown as Record<string, unknown>;
    for (const field of [
      'providerId',
      'externalTransactionId',
      'playerId',
      'walletId',
      'roundId',
      'gameId',
    ])
      if (typeof raw?.[field] !== 'string' || !(raw[field] as string).trim())
        throw new DomainError('INVALID_PAYLOAD', `${field} is required`);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        String(raw.playerId),
      ) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        String(raw.walletId),
      )
    )
      throw new DomainError('INVALID_PAYLOAD', 'playerId and walletId must be UUIDs');
    if (!Object.values(Kind).includes(raw.kind as Kind) || String(raw.kind) === Kind.Opening)
      throw new DomainError('INVALID_KIND', 'Transaction kind is invalid or internal');
    if (typeof raw.money !== 'object' || raw.money === null)
      throw new DomainError('INVALID_MONEY', 'money is required');
    if (
      (raw.kind === Kind.Refund || raw.kind === Kind.Rollback) &&
      (typeof raw.referenceExternalTransactionId !== 'string' ||
        !raw.referenceExternalTransactionId.trim())
    )
      throw new DomainError('INVALID_REFERENCE', 'Reference transaction ID is required');
    const money = Money.from(input.money);
    if (money.isZero()) throw new DomainError('INVALID_AMOUNT', 'Wager amount must be positive');
    const hash = createHash('sha256')
      .update(canonical({ ...input, money: money.toJSON() }))
      .digest('hex');
    try {
      return await this.db.transaction(async (m) => {
        if (inbox) {
          const inserted = await m.query(
            'INSERT INTO inbox_messages(message_id,consumer_name,payload_hash,received_at) VALUES($1,$2,$3,now()) ON CONFLICT DO NOTHING RETURNING message_id',
            [inbox.messageId, 'wager-processor', inbox.payloadHash],
          );
          if (!inserted.length) {
            const prior = (
              await m.query(
                'SELECT payload_hash FROM inbox_messages WHERE consumer_name=$1 AND message_id=$2 FOR UPDATE',
                ['wager-processor', inbox.messageId],
              )
            )[0];
            if (prior?.payload_hash !== inbox.payloadHash)
              throw new DomainError(
                'INBOX_MESSAGE_CONFLICT',
                'SQS message ID was reused with different content',
              );
            metrics.increment('wagering_inbox_duplicates_total');
            return { duplicateInbox: true };
          }
        }
        const existing = await m.query(
          'SELECT * FROM wager_transactions WHERE idempotency_key=$1 FOR UPDATE',
          [key],
        );
        if (existing.length && existing[0].payload_hash !== hash)
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            'Idempotency key was used with a different payload',
          );
        if (existing.length && existing[0].status !== 'PENDING_REFERENCE') {
          metrics.increment('wagering_idempotent_replays_total');
          if (inbox)
            await m.query(
              'UPDATE inbox_messages SET processed_at=now() WHERE consumer_name=$1 AND message_id=$2',
              ['wager-processor', inbox.messageId],
            );
          return this.result(m, existing[0], true);
        }
        const wid = await m.query('SELECT * FROM wallets WHERE id=$1 FOR UPDATE', [input.walletId]);
        if (!wid.length || wid[0].player_id !== input.playerId)
          throw new DomainError('WALLET_MISMATCH', 'Wallet does not belong to player');
        const txId = existing.length ? existing[0].id : randomUUID(),
          now = new Date();
        if (!existing.length)
          await m.query(
            `INSERT INTO wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,reference_external_id,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'PENDING',$14)`,
            [
              txId,
              input.providerId,
              input.externalTransactionId,
              key,
              hash,
              input.walletId,
              input.playerId,
              input.roundId,
              input.gameId,
              input.kind,
              money.toString(),
              money.currency,
              input.referenceExternalTransactionId ?? null,
              now,
            ],
          );
        let state: Status = Status.Processed,
          failure: string | undefined,
          ref: any;
        if (String(wid[0].currency).trim() !== money.currency) failure = 'CURRENCY_MISMATCH';
        if (!failure && (input.kind === Kind.Refund || input.kind === Kind.Rollback)) {
          ref = (
            await m.query(
              'SELECT * FROM wager_transactions WHERE provider_id=$1 AND external_transaction_id=$2 FOR UPDATE',
              [input.providerId, input.referenceExternalTransactionId],
            )
          )[0];
          if (!ref) {
            state = Status.PendingReference;
            await m.query(
              "UPDATE wager_transactions SET status='PENDING_REFERENCE',attempts=attempts+1,next_attempt_at=now()+make_interval(secs=>LEAST(300,power(2,attempts)::int)) WHERE id=$1",
              [txId],
            );
            if (!existing.length)
              await this.event(m, txId, 'WagerTransactionPendingReference', {
                transactionId: txId,
              });
            if (inbox)
              await m.query(
                'UPDATE inbox_messages SET processed_at=now() WHERE consumer_name=$1 AND message_id=$2',
                ['wager-processor', inbox.messageId],
              );
            metrics.increment(`wagering_transactions_total{status="${state}"}`);
            metrics.gauge('wagering_processing_duration_ms', Date.now() - started);
            this.log.log(
              JSON.stringify({
                correlationId,
                messageId: inbox?.messageId,
                transactionId: txId,
                walletId: input.walletId,
                providerId: input.providerId,
                status: state,
              }),
            );
            return {
              transactionId: txId,
              status: state,
              balance: { amount: String(wid[0].balance), currency: wid[0].currency },
              idempotentReplay: existing.length > 0,
            };
          }
          if (
            ref.wallet_id !== input.walletId ||
            ref.player_id !== input.playerId ||
            ref.round_id !== input.roundId ||
            String(ref.currency).trim() !== money.currency ||
            (input.kind === Kind.Refund && ref.kind !== 'BET') ||
            !['BET', 'WIN', 'REFUND'].includes(ref.kind) ||
            ref.status !== 'PROCESSED' ||
            !new Decimal(ref.amount).equals(money.toString())
          )
            failure = 'REFERENCE_INVALID';
          else if (
            (
              await m.query(
                "SELECT 1 FROM wager_transactions WHERE reference_transaction_id=$1 AND kind=$2 AND status IN ('PROCESSED','PENDING','PENDING_REFERENCE')",
                [ref.id, input.kind],
              )
            ).length
          )
            failure = 'REFERENCE_ALREADY_REVERSED';
        }
        const before = String(wid[0].balance),
          amt = money.toString();
        let after = before,
          direction: 'DEBIT' | 'CREDIT' | undefined;
        if (input.kind === 'BET') {
          if (new Decimal(before).lessThan(amt)) failure = 'INSUFFICIENT_FUNDS';
          else {
            after = new Decimal(before).minus(amt).toFixed(2);
            direction = 'DEBIT';
          }
        }
        if (input.kind === 'WIN' || input.kind === 'REFUND') {
          after = new Decimal(before).plus(amt).toFixed(2);
          direction = 'CREDIT';
        }
        if (input.kind === 'ROLLBACK' && ref) {
          direction = ref.kind === 'BET' ? 'CREDIT' : 'DEBIT';
          if (direction === 'CREDIT') after = new Decimal(before).plus(amt).toFixed(2);
          else if (new Decimal(before).lessThan(amt)) failure = 'REVERSAL_INSUFFICIENT_FUNDS';
          else after = new Decimal(before).minus(amt).toFixed(2);
        }
        if (failure) {
          state = Status.Rejected;
          await m.query(
            "UPDATE wager_transactions SET status='REJECTED',failure_code=$2,processed_at=$3,reference_transaction_id=$4,resulting_balance=$5,next_attempt_at=NULL WHERE id=$1",
            [txId, failure, now, ref?.id ?? null, before],
          );
          await this.event(m, txId, 'WagerTransactionRejected', {
            transactionId: txId,
            failureCode: failure,
          });
        } else {
          if (direction) {
            await m.query(
              'UPDATE wallets SET balance=$2,version=version+1,updated_at=$3 WHERE id=$1',
              [input.walletId, after, now],
            );
            await m.query(
              'INSERT INTO wallet_ledger_entries(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
              [
                randomUUID(),
                input.walletId,
                txId,
                direction,
                amt,
                money.currency,
                before,
                after,
                now,
              ],
            );
          }
          await m.query(
            "UPDATE wager_transactions SET status='PROCESSED',processed_at=$2,reference_transaction_id=$3,resulting_balance=$4,next_attempt_at=NULL WHERE id=$1",
            [txId, now, ref?.id ?? null, after],
          );
          await this.event(m, txId, 'WagerTransactionProcessed', {
            transactionId: txId,
            kind: input.kind,
          });
          if (direction)
            await this.event(m, input.walletId, 'WalletBalanceChanged', {
              walletId: input.walletId,
              transactionId: txId,
              direction,
              money: money.toJSON(),
              balanceBefore: { amount: before, currency: money.currency },
              balanceAfter: { amount: after, currency: money.currency },
            });
        }
        const response = {
          transactionId: txId,
          status: state,
          ...(failure ? { failureCode: failure } : {}),
          balance: { amount: after, currency: money.currency },
          idempotentReplay: existing.length > 0,
        };
        if (inbox)
          await m.query(
            'UPDATE inbox_messages SET processed_at=now() WHERE consumer_name=$1 AND message_id=$2',
            ['wager-processor', inbox.messageId],
          );
        metrics.increment(`wagering_transactions_total{status="${state}"}`);
        metrics.gauge('wagering_processing_duration_ms', Date.now() - started);
        this.log.log(
          JSON.stringify({
            correlationId,
            messageId: inbox?.messageId,
            transactionId: txId,
            walletId: input.walletId,
            providerId: input.providerId,
            status: state,
          }),
        );
        return response;
      });
    } catch (error) {
      const e = error as { code?: string; driverError?: { code?: string } };
      const sqlState = e.driverError?.code ?? e.code;
      if (['40P01', '55P03', '40001'].includes(sqlState ?? ''))
        metrics.increment('wallet_lock_conflicts_total');
      if (sqlState === '23505') {
        const concurrent = (
          await this.db.query('SELECT * FROM wager_transactions WHERE idempotency_key=$1', [key])
        )[0];
        if (concurrent) {
          if (concurrent.payload_hash !== hash)
            throw new DomainError(
              'IDEMPOTENCY_CONFLICT',
              'Idempotency key was used with a different payload',
            );
          metrics.increment('wagering_idempotent_replays_total');
          return this.result(this.db, concurrent, true);
        }
        throw new DomainError(
          'TRANSACTION_CONFLICT',
          'Provider transaction identifier already exists',
        );
      }
      throw error;
    }
  }
  private async event(
    m: any,
    aggregateId: string,
    eventType: string,
    data: Record<string, unknown>,
  ) {
    const occurredAt = new Date(),
      eventId = randomUUID(),
      props = { eventId, aggregateId, correlationId: eventId, occurredAt, data };
    const event =
      eventType === 'WagerTransactionProcessed'
        ? new WagerTransactionProcessed(props)
        : eventType === 'WagerTransactionRejected'
          ? new WagerTransactionRejected(props)
          : eventType === 'WalletBalanceChanged'
            ? new WalletBalanceChanged(props)
            : new WagerTransactionPendingReference(props);
    const payload = event.toJSON();
    await m.query(
      'INSERT INTO outbox_messages(id,aggregate_id,event_type,payload,occurred_at) VALUES($1,$2,$3,$4,$5)',
      [eventId, aggregateId, event.eventType, JSON.stringify(payload), occurredAt],
    );
  }
  private async result(m: any, tx: any, replay: boolean) {
    const w = (
      await m.query('SELECT balance,currency FROM wallets WHERE id=$1', [tx.wallet_id])
    )[0];
    return {
      transactionId: tx.id,
      status: tx.status,
      ...(tx.failure_code ? { failureCode: tx.failure_code } : {}),
      balance: {
        amount: String(tx.resulting_balance ?? w.balance),
        currency: String(w.currency).trim(),
      },
      idempotentReplay: replay,
    };
  }
  async wallet(id: string) {
    const rows = await this.db.query(
      'SELECT id,player_id,balance,currency,version FROM wallets WHERE id=$1',
      [id],
    );
    if (!rows.length) return null;
    const w = rows[0];
    return {
      id: w.id,
      playerId: w.player_id,
      balance: { amount: String(w.balance), currency: w.currency },
      version: Number(w.version),
    };
  }
  async transaction(id: string) {
    return (await this.db.query('SELECT * FROM wager_transactions WHERE id=$1', [id]))[0] ?? null;
  }
  async byExternal(provider: string, external: string) {
    return (
      (
        await this.db.query(
          'SELECT * FROM wager_transactions WHERE provider_id=$1 AND external_transaction_id=$2',
          [provider, external],
        )
      )[0] ?? null
    );
  }
  async ledger(walletId: string, cursor?: string, limit = 50) {
    let point: { createdAt: string; id: string } | undefined;
    if (cursor) {
      try {
        point = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
          createdAt: string;
          id: string;
        };
        if (!point.createdAt || !point.id) throw new Error('invalid');
      } catch {
        throw new DomainError('INVALID_CURSOR', 'Ledger cursor is invalid');
      }
    }
    const rows = await this.db.query(
      'SELECT * FROM wallet_ledger_entries WHERE wallet_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4',
      [walletId, point?.createdAt ?? null, point?.id ?? null, Math.min(Math.max(limit, 1), 100)],
    );
    const last = rows[rows.length - 1];
    return {
      items: rows,
      nextCursor: rows.length
        ? Buffer.from(
            JSON.stringify({ createdAt: new Date(last.created_at).toISOString(), id: last.id }),
          ).toString('base64url')
        : null,
    };
  }
  async reconcile(walletId: string) {
    const w = (
      await this.db.query('SELECT balance,currency FROM wallets WHERE id=$1', [walletId])
    )[0];
    if (!w) return null;
    const sums = (
      await this.db.query(
        "SELECT COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END),0) AS total,COUNT(*) AS n FROM wallet_ledger_entries WHERE wallet_id=$1",
        [walletId],
      )
    )[0];
    const stored = String(w.balance),
      calc = new Decimal(sums.total).toFixed(2),
      consistent = new Decimal(stored).equals(calc);
    if (!consistent) {
      metrics.increment('wallet_reconciliation_mismatches_total');
      this.log.error(
        JSON.stringify({
          event: 'wallet_reconciliation_mismatch',
          correlationId: randomUUID(),
          walletId,
          checkedEntries: Number(sums.n),
        }),
      );
    }
    return {
      walletId,
      storedBalance: { amount: stored, currency: String(w.currency).trim() },
      calculatedBalance: { amount: calc, currency: String(w.currency).trim() },
      difference: {
        amount: new Decimal(stored).minus(calc).toFixed(2),
        currency: String(w.currency).trim(),
      },
      consistent,
      checkedEntries: Number(sums.n),
    };
  }
  async readiness() {
    await this.db.query('SELECT 1');
    const queue = process.env.WAGER_QUEUE_URL;
    if (queue)
      await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: queue,
          AttributeNames: ['ApproximateNumberOfMessages'],
        }),
      );
  }
  async retryPendingReferences() {
    const rows = await this.db.query(
      "SELECT * FROM wager_transactions WHERE status='PENDING_REFERENCE' AND COALESCE(next_attempt_at,now())<=now() ORDER BY created_at LIMIT 100",
    );
    const max = Number.parseInt(process.env.PENDING_REFERENCE_MAX_ATTEMPTS ?? '10', 10);
    for (const row of rows) {
      if (Number(row.attempts) >= max) {
        await this.db.transaction(async (m) => {
          const current = (
            await m.query('SELECT * FROM wager_transactions WHERE id=$1 FOR UPDATE', [row.id])
          )[0];
          if (!current || current.status !== 'PENDING_REFERENCE') return;
          const wallet = (
            await m.query('SELECT balance FROM wallets WHERE id=$1 FOR UPDATE', [row.wallet_id])
          )[0];
          await m.query(
            "UPDATE wager_transactions SET status='REJECTED',failure_code='REFERENCE_NOT_FOUND',processed_at=now(),resulting_balance=$2,next_attempt_at=NULL WHERE id=$1",
            [row.id, wallet.balance],
          );
          await this.event(m, row.id, 'WagerTransactionRejected', {
            transactionId: row.id,
            failureCode: 'REFERENCE_NOT_FOUND',
          });
        });
        continue;
      }
      metrics.increment('wagering_reference_retries_total');
      await this.submit(
        {
          providerId: row.provider_id,
          externalTransactionId: row.external_transaction_id,
          playerId: row.player_id,
          walletId: row.wallet_id,
          roundId: row.round_id,
          gameId: row.game_id,
          kind: row.kind,
          money: { amount: String(row.amount), currency: String(row.currency).trim() },
          ...(row.reference_external_id
            ? { referenceExternalTransactionId: row.reference_external_id }
            : {}),
        },
        row.idempotency_key,
      );
    }
  }
}
