import { Migration20261008000001CoreSchema } from "./Migration20261008000001CoreSchema";
import { Migration20261009000001DoubleEntryJournal } from "./Migration20261009000001DoubleEntryJournal";
import { Migration20261010000001SubmissionFailureAudit } from "./Migration20261010000001SubmissionFailureAudit";
import { Migration20261011000001BatchWalletVersion } from "./Migration20261011000001BatchWalletVersion";
import { Migration20261012000001ProviderScopedIdempotency } from "./Migration20261012000001ProviderScopedIdempotency";

/** Explicit, ordered list: no filesystem globbing, identical behaviour in dev, tests and containers. */
export const MIGRATIONS = [
  { name: "Migration20261008000001CoreSchema", class: Migration20261008000001CoreSchema },
  { name: "Migration20261009000001DoubleEntryJournal", class: Migration20261009000001DoubleEntryJournal },
  {
    name: "Migration20261010000001SubmissionFailureAudit",
    class: Migration20261010000001SubmissionFailureAudit,
  },
  { name: "Migration20261011000001BatchWalletVersion", class: Migration20261011000001BatchWalletVersion },
  {
    name: "Migration20261012000001ProviderScopedIdempotency",
    class: Migration20261012000001ProviderScopedIdempotency,
  },
];
