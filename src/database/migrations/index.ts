import { Migration20261105000001_schema_inicial } from './Migration20261105000001_schema_inicial';
import { Migration20261105000002_ledger_imutavel } from './Migration20261105000002_ledger_imutavel';

/** Lista explícita e ordenada (sem descoberta por arquivo): funciona igual com Bun, no container e nos testes. */
export const MIGRATIONS = [
  { name: 'Migration20261105000001_schema_inicial', class: Migration20261105000001_schema_inicial },
  { name: 'Migration20261105000002_ledger_imutavel', class: Migration20261105000002_ledger_imutavel },
];
