import 'reflect-metadata';
import 'dotenv/config';
import { DataSource } from 'typeorm';
import { InitialSchema1710000000000 } from './migrations/1710000000000-InitialSchema';
import { FixLedgerInvariant1710000000001 } from './migrations/1710000000001-FixLedgerInvariant';
export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  migrations: [InitialSchema1710000000000, FixLedgerInvariant1710000000001],
  migrationsRun: false,
  logging: false,
});
