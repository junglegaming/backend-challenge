import type { Migration } from '@mikro-orm/migrations';
import type { Constructor } from '@mikro-orm/core';
import { Migration20261106000001_baseline } from './Migration20261106000001_baseline';
import { Migration20261106000002_wallets } from './Migration20261106000002_wallets';
import { Migration20261106000003_wagering_transactions } from './Migration20261106000003_wagering_transactions';
import { Migration20261106000004_wallet_ledger_entries } from './Migration20261106000004_wallet_ledger_entries';
import { Migration20261106000005_inbox_outbox } from './Migration20261106000005_inbox_outbox';
import { Migration20261107000006_reference_retry } from './Migration20261107000006_reference_retry';

const classes: Constructor<Migration>[] = [
  Migration20261106000001_baseline,
  Migration20261106000002_wallets,
  Migration20261106000003_wagering_transactions,
  Migration20261106000004_wallet_ledger_entries,
  Migration20261106000005_inbox_outbox,
  Migration20261107000006_reference_retry,
];

export const migrations = classes.map((cls) => ({ name: cls.name, class: cls }));
