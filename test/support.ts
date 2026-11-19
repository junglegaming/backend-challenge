import {
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { config } from '../src/config';
import { createSqsClient, ensureQueues, queueDepth, QueueUrls } from '../src/infra/sqs/queues';
import { OpenWallet, WalletView } from '../src/application/open-wallet';
import { SubmitResult, SubmitWagerTransaction } from '../src/application/submit-wager-transaction';
import { ormConfig } from '../src/infra/persistence/orm';
import { MikroUnitOfWork } from '../src/infra/persistence/unit-of-work';

const ADMIN_URL = process.env.ADMIN_DATABASE_URL!;
export const TEST_DATABASE_URL = process.env.DATABASE_URL!;

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

/** Resultado com status/failureCode como string, para comparar com literais nos testes. */
export type Result = Omit<SubmitResult, 'status' | 'failureCode'> & { status: string; failureCode?: string };

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
    async send(payload: Record<string, any>, idempotencyKey = `${payload.providerId}:${payload.externalTransactionId}`): Promise<Result> {
      return (await submit.execute({ idempotencyKey, payload, correlationId: 'test' })) as Result;
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

// ---------------------------------------------------------------- SQS (LocalStack real)

let queueRun = 0;

/** Filas novas e vazias para o arquivo de teste (nome único), também herdadas por processos filhos. */
export async function freshQueues(): Promise<{ sqs: SQSClient; queues: QueueUrls }> {
  queueRun += 1;
  const prefix = `${process.env.QUEUE_PREFIX}${queueRun}-`;
  config.sqs.inputQueue = `${prefix}wager-transactions.fifo`;
  config.sqs.dlq = `${prefix}wager-transactions-dlq.fifo`;
  config.sqs.eventsQueue = `${prefix}wager-events.fifo`;
  const sqs = createSqsClient();
  return { sqs, queues: await ensureQueues(sqs) };
}

/** Ambiente para um processo filho usar as mesmas filas e o mesmo banco deste teste. */
export const childEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  QUEUE_PREFIX: config.sqs.inputQueue.replace('wager-transactions.fifo', ''),
  ...extra,
});

export function wagerMessage(messageId: string, data: Record<string, any>, idempotencyKey = `${data.providerId}:${data.externalTransactionId}`) {
  return { messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: { ...data, idempotencyKey } };
}

/** Envia para a fila de entrada. Cada envio tem dedup id próprio: o SQS NÃO deduplica por nós. */
export async function enqueue(sqs: SQSClient, queueUrl: string, body: unknown, groupId: string): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: uuid(),
    }),
  );
}

/** Lê e remove tudo que estiver visível na fila. */
export async function drain(sqs: SQSClient, queueUrl: string): Promise<any[]> {
  const bodies: any[] = [];
  for (let empty = 0; empty < 2; ) {
    const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ['All'] }));
    if (Messages.length === 0) {
      empty += 1;
      continue;
    }
    empty = 0;
    for (const m of Messages) {
      let body: unknown = m.Body;
      try {
        body = JSON.parse(m.Body!);
      } catch {}
      bodies.push({ body, attributes: m.MessageAttributes });
    }
    await sqs.send(new DeleteMessageBatchCommand({ QueueUrl: queueUrl, Entries: Messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle! })) }));
  }
  return bodies;
}

export { queueDepth };

/** Mensagens visíveis + em voo (recebidas e ainda não confirmadas). 0 = tudo foi confirmado. */
export async function queueTotal(sqs: SQSClient, queueUrl: string): Promise<number> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed'] }),
  );
  return Object.values(Attributes ?? {}).reduce((total, value) => total + Number(value), 0);
}

export async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

// ---------------------------------------------------------------- processos reais

export interface Instance {
  url: string;
  process: ReturnType<typeof Bun.spawn>;
  kill(signal?: 'SIGKILL' | 'SIGTERM'): Promise<void>;
}

/** Sobe uma instância real da aplicação (processo separado) e espera o readiness. */
export async function spawnInstance(port: number, extraEnv: Record<string, string> = {}): Promise<Instance> {
  const child = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: `${import.meta.dir}/..`,
    env: childEnv({ PORT: String(port), INSTANCE_ID: `test-${port}`, ...extraEnv }),
    stdout: 'ignore',
    stderr: 'inherit',
  });
  const url = `http://localhost:${port}`;
  const instance: Instance = {
    url,
    process: child,
    async kill(signal = 'SIGKILL') {
      child.kill(signal);
      await child.exited;
    },
  };
  if (!(extraEnv.ROLES && !extraEnv.ROLES.includes('api'))) {
    await waitFor(() => fetch(`${url}/health/ready`).then((r) => r.ok, () => false), 15_000, `instance ${port} ready`);
  }
  return instance;
}
