import { afterAll, beforeAll, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import fc from 'fast-check';
import { ResolvePendingReferences } from '../../src/application/resolve-pending-references';
import { freshDatabase, harness } from '../support';

/**
 * Teste de propriedade: em vez de cenários escolhidos à mão, o fast-check gera sequências
 * aleatórias de operações — com duplicatas, fora de ordem, referências válidas e inválidas —
 * disparadas em paralelo. Para QUALQUER sequência, as invariantes financeiras têm de valer.
 * Se uma falhar, o fast-check reduz para o menor contraexemplo e imprime a seed.
 */
let orm: MikroORM;
let h: ReturnType<typeof harness>;

beforeAll(async () => {
  orm = await freshDatabase();
  h = harness(orm);
});
afterAll(() => orm.close());

type Op =
  | { type: 'new'; kind: 'BET' | 'WIN' | 'LOSS'; cents: number; wallet: number }
  | { type: 'reverse'; kind: 'REFUND' | 'ROLLBACK'; target: number; wrongAmount: boolean }
  | { type: 'duplicate'; target: number };

const operation: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ type: fc.constant('new' as const), kind: fc.constantFrom('BET' as const, 'WIN' as const, 'LOSS' as const), cents: fc.integer({ min: 1, max: 6000 }), wallet: fc.nat(2) }) },
  { weight: 3, arbitrary: fc.record({ type: fc.constant('reverse' as const), kind: fc.constantFrom('REFUND' as const, 'ROLLBACK' as const), target: fc.nat(), wrongAmount: fc.nat(9).map((n) => n === 0) }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant('duplicate' as const), target: fc.nat() }) },
);

const amount = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

test('for any interleaving of operations, duplicates and out-of-order references, the invariants hold', async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(operation, { minLength: 5, maxLength: 40 }), fc.infiniteStream(fc.double({ min: 0, max: 1, noNaN: true })), async (operations, order) => {
      const wallets = await Promise.all([h.wallet('50.00'), h.wallet('50.00'), h.wallet('0.00')]);
      // Constrói os payloads; reversões e duplicatas apontam para qualquer payload anterior.
      const payloads: Record<string, any>[] = [];
      for (const op of operations) {
        if (op.type === 'new') {
          payloads.push(h.payload(wallets[op.wallet]!, op.kind, amount(op.cents)));
        } else if (payloads.length > 0) {
          const target = payloads[op.target % payloads.length]!;
          if (op.type === 'duplicate') payloads.push(target);
          else {
            const wallet = wallets.find((w) => w.id === target.walletId)!;
            const value = op.wrongAmount ? '0.01' : target.money.amount;
            payloads.push(h.payload(wallet, op.kind, value, { referenceExternalTransactionId: target.externalTransactionId }));
          }
        }
      }
      // Ordem embaralhada (a referência pode chegar depois de quem a referencia) e tudo em paralelo.
      const shuffled = payloads.map((payload) => ({ payload, key: order.next().value as number })).sort((a, b) => a.key - b.key);
      await Promise.all(shuffled.map(({ payload }) => h.send(payload)));

      // Worker de pendências até estabilizar (sem esperar o backoff real).
      const resolver = new ResolvePendingReferences(h.uow);
      const walletIds = wallets.map((w) => w.id);
      for (let round = 0; round < 12; round++) {
        await h.sql(`update wager_transactions set next_attempt_at = now() - interval '1 minute' where status = 'PENDING_REFERENCE' and wallet_id in (?)`, [walletIds]);
        await resolver.runOnce();
      }

      // 1. saldo materializado == ledger, e nunca negativo em nenhum ponto da história
      await h.assertLedgerConsistent();
      expect(await h.sql(`select 1 from wallet_ledger_entries where wallet_id in (?) and (balance_after < 0 or balance_before < 0)`, [walletIds])).toHaveLength(0);

      // 2. cada operação distinta virou no máximo uma transação e todas terminaram
      const distinct = new Set(payloads.map((p) => p.externalTransactionId)).size;
      const transactions = await h.sql(`select status from wager_transactions where wallet_id in (?) and kind <> 'OPENING'`, [walletIds]);
      expect(transactions).toHaveLength(distinct);
      expect(transactions.every((t) => ['PROCESSED', 'REJECTED'].includes(t.status))).toBe(true);

      // 3. o saldo bate com as transações PROCESSED, calculado sem olhar o ledger
      const expected = await h.sql(
        `select t.wallet_id, sum(case
                  when t.kind = 'BET' then -t.amount
                  when t.kind in ('WIN', 'REFUND', 'OPENING') then t.amount
                  when t.kind = 'ROLLBACK' and r.kind = 'BET' then t.amount
                  when t.kind = 'ROLLBACK' then -t.amount
                  else 0 end)::numeric(20,2) as balance
           from wager_transactions t left join wager_transactions r on r.id = t.reference_transaction_id
          where t.status = 'PROCESSED' and t.wallet_id in (?) group by t.wallet_id`,
        [walletIds],
      );
      for (const wallet of wallets) {
        const fromTransactions = expected.find((e) => e.wallet_id === wallet.id)?.balance ?? '0.00';
        expect(await h.balance(wallet.id)).toBe(fromTransactions);
      }

      // 4. nenhuma transação foi revertida mais de uma vez, e só PROCESSED move saldo
      expect(
        await h.sql(
          `select reference_transaction_id from wager_transactions
            where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK') and wallet_id in (?)
            group by reference_transaction_id having count(*) > 1`,
          [walletIds],
        ),
      ).toHaveLength(0);
      expect(
        await h.sql(
          `select 1 from wallet_ledger_entries l join wager_transactions t on t.id = l.transaction_id
            where l.wallet_id in (?) and (t.status <> 'PROCESSED' or t.kind = 'LOSS')`,
          [walletIds],
        ),
      ).toHaveLength(0);
    }),
    { numRuns: 40 },
  );
}, 180_000);
