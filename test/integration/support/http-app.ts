import 'reflect-metadata';
import { expect } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { buildOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';
import { WageringModule } from '../../../src/wagering.module';
import type { TestDatabase } from './test-database';

export interface TestApp {
  app: INestApplication;
  url: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper: bodies are asserted field by field
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any; headers: Headers }>;
  close(): Promise<void>;
}

export async function createTestApp(db: TestDatabase, options: { lockTimeoutMs?: number } = {}): Promise<TestApp> {
  process.env.LOCK_TIMEOUT_MS = String(options.lockTimeoutMs ?? 5000);
  const moduleRef = await Test.createTestingModule({
    imports: [MikroOrmModule.forRoot({ ...buildOrmConfig(db.url) }), WageringModule],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.listen(0);
  const url = await app.getUrl();

  return {
    app,
    url,
    async post(path, body, headers = {}) {
      const res = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => undefined), headers: res.headers };
    },
    close: () => app.close(),
  };
}

/** The closing assertion of every test: wallet.balance == balance rebuilt from its ledger. */
export async function expectWalletMatchesLedger(db: TestDatabase, walletId: string): Promise<void> {
  const [wallet] = await db.run<{ balance: string }>('select balance from wallets where id = ?', [walletId]);
  const [ledger] = await db.run<{ balance: string; entries: string }>(
    `select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::numeric(20,2) as balance,
            count(*) as entries
       from wallet_ledger_entries where wallet_id = ?`,
    [walletId],
  );
  expect(wallet, `wallet ${walletId} exists`).toBeDefined();
  expect(wallet!.balance).toBe(ledger!.balance);
}
