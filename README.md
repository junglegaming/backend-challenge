# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) vindas de provedores de jogos, por HTTP ou SQS, mantendo saldo, ledger e eventos consistentes com múltiplas instâncias, mensagens duplicadas e entregas fora de ordem.

O enunciado está em [docs/CHALLENGE.md](docs/CHALLENGE.md) e as decisões técnicas em [ARCHITECTURE.md](ARCHITECTURE.md).

**Stack:** Bun 1.x · TypeScript estrito · NestJS 11 · MikroORM 6 · PostgreSQL 17 · SQS (LocalStack ou MiniStack) · Docker Compose.

## Como rodar

Pré-requisitos: Docker com Compose e Bun 1.x.

```bash
bun install
cp .env.example .env     # o Bun carrega o .env automaticamente

# Tudo: Postgres + SQS + migrations + 3 instâncias da aplicação (portas 3001, 3002 e 3003)
docker compose up -d --build

# Ou só a infraestrutura, com a aplicação rodando no host
docker compose up -d postgres sqs
bun run migration:up
bun run start            # http://localhost:3000
```

Para usar o MiniStack em vez do LocalStack: `SQS_IMAGE=ministackorg/ministack docker compose up -d`.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` | sobe a aplicação (HTTP e workers) |
| `bun run migration:up` / `migration:down` | aplica / desfaz a última migration |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run test:unit` | testes de unidade (não precisam de Docker) |
| `bun run test:integration` | Postgres e SQS reais (precisa de `docker compose up -d postgres sqs`) |
| `bun run test:concurrency` | sobe 3 processos reais da aplicação e testa corridas e crashes |
| `bun run test` | tudo |

Os testes de integração criam o banco `wagering_test` sozinhos, e cada arquivo usa filas com prefixo próprio.

## Configuração (variáveis de ambiente)

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | porta HTTP |
| `WORKERS` | `consumer,outbox,pending-references` | workers desta instância (`none` = só HTTP) |
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5432/wagering` | |
| `DB_LOCK_TIMEOUT_MS` | `5000` | espera máxima pelo lock de uma wallet |
| `SQS_ENDPOINT` | `http://localhost:4566` | LocalStack/MiniStack |
| `SQS_MAX_ATTEMPTS` | `5` | tentativas antes da DLQ |
| `PENDING_REFERENCE_TTL_MS` | `600000` | tempo máximo esperando uma referência (10 min) |
| `RUN_MIGRATIONS` | — | `true` roda as migrations ao subir |
| `FAULT_INJECTION` | — | **só para testes**: `crash-after-commit-before-ack`, `crash-before-outbox-publish` |

## API

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | cria wallet (saldo inicial vira transação `OPENING`) |
| `GET` | `/wallets/:walletId` | wallet e saldo |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` | ledger paginado (cursor opaco) |
| `POST` | `/wallets/:walletId/reconciliation` | compara saldo × ledger |
| `POST` | `/wagering/transactions` | submete operação (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | consulta por id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | consulta por id do provedor |
| `GET` | `/health/live`, `/health/ready` | liveness e readiness (Postgres e SQS) |
| `GET` | `/metrics` | métricas Prometheus |

### Exemplo

```bash
curl -s -X POST localhost:3001/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl -s -X POST localhost:3001/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123",
       "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id da wallet>",
       "roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'
```

### Status HTTP

| Situação | Status | Pode reenviar? |
|---|---|---|
| Processada (ou replay idêntico) | `200` | — (replay devolve `idempotentReplay: true`) |
| Aceita, aguardando referência | `202` | sim, para consultar o resultado |
| Payload inválido | `400` | não, sem corrigir |
| Não encontrado | `404` | não |
| Conflito: wallet duplicada ou mesma key com outro payload | `409` | não |
| Rejeitada por regra de negócio (`failureCode`) | `422` | não |
| Falha transitória (banco ou lock indisponível) | `503` + `Retry-After` | sim |

Os erros seguem o formato `{ "error": { "code", "message", "details?" } }`.

## Estrutura

```
src/
  main.ts          bootstrap (HTTP, logs, shutdown)
  app.module.ts    módulo único: registra controllers, services e workers
  config.ts        variáveis de ambiente
  controllers/     HTTP: wallets, wagering, health (+ /metrics)
  services/        regras de aplicação: WalletsService, WageringService
  repositories/    acesso ao banco (um por tabela) + UnitOfWork (transação)
  domain/          Money, Wallet, WagerTransaction, regras, inbox/outbox, eventos (TypeScript puro)
  dto/             validação de entrada (zod)
  workers/         consumer SQS, relay da outbox, referências pendentes
  database/        MikroORM: entidades.ts (tabelas), config e migrations
  utils/           erros, logger, métricas, filtro de erros, AuthGuard, cliente SQS, utilitários
test/
  unit/            regras de domínio
  integration/     Postgres e SQS reais
  concurrency/     3 processos reais, corridas e crashes
```
