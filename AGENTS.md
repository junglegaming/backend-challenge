# Repository guide

This directory is the Git root of the Distributed Wagering Processor.
Run Git, Bun and Docker Compose commands here.

## Commands

- Install: `bun install --frozen-lockfile`.
- Static checks and unit tests: `bun run check`.
- Suites: `bun run test:unit`, `test:integration`, `test:concurrency`,
  `test:failure`, `test:load`; `bun run test` runs the mandatory suites.
- Local stack: `bun run stack:up`, `bun run stack:down`.
- Migrations: `bun run migration:up`, `bun run migration:down`.
- Queue recovery: `bun run dlq:redrive`.
- Configuration lives in Compose defaults and process environment; no `.env*` files.

## Module map

- `src/shared/domain`: money, errors and integration event base.
- `src/shared/application`: shared transaction and synchronization contracts.
- `src/shared/infrastructure`: database adapters.
- `src/wagering`: domain, application use cases, persistence and HTTP.
- `src/messaging`: inbox/outbox domain, persistence and runtime modules.
- `src/identity`: provider identity adapter and HTTP authorization.
- `src/observability`: structured logs, metrics and health.
- `src/config`: typed startup configuration.
- `src/cli`: one-shot infrastructure bootstrap and queue recovery.
- `database/migrations`: reversible migrations.

## Verification layout

`test/unit`, `test/integration`, `test/concurrency` and `test/failure` separate
verification scopes. `test/support` and `scripts/with-stack.ts` own the isolated
`wagering-test` Compose project, with ports offset by 10000. Integration and higher
suites use real PostgreSQL and MiniStack with 3 API, 3 consumer and 2 worker replicas.
`load` contains the containerized k6 scenarios. Documentation is in `docs`.
