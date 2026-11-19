# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`)
vindas de provedores de jogos por HTTP e por SQS. Continua correto com mensagens duplicadas, fora de
ordem e processadas ao mesmo tempo por várias instâncias.

- Enunciado do desafio: [CHALLENGE.md](CHALLENGE.md)
- Decisões, trade-offs, matriz de falhas e limitações: [ARCHITECTURE.md](ARCHITECTURE.md)
- Teste de carga, com metodologia e análise: [LOAD_TEST.md](LOAD_TEST.md)

**Stack:** Bun · TypeScript estrito · NestJS · MikroORM · PostgreSQL · SQS (LocalStack) · Docker Compose

## Rodar

Pré-requisitos: Docker com Compose. Para os testes, também [Bun](https://bun.sh) 1.x.

```bash
docker compose up --build
```

Sobe PostgreSQL, LocalStack, aplica as migrations e inicia **três instâncias** da aplicação em
`localhost:3000`, `3001` e `3002`. Cada instância é API, consumidor SQS e worker ao mesmo tempo.

```bash
curl localhost:3000/health/ready
# {"status":"ok","checks":{"postgres":"up","sqs":"up"}}
```

### Um fluxo completo

```bash
# 1. cria a wallet
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
# → {"id":"<WALLET_ID>","playerId":"...","balance":{"amount":"1000.00","currency":"BRL"},"version":1}

# 2. aposta (repita o mesmo comando em outra instância, ex.: porta 3001 → idempotentReplay: true)
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<WALLET_ID>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
# → {"transactionId":"...","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}

# 3. extrato e reconciliação
curl -s "localhost:3000/wallets/<WALLET_ID>/ledger?limit=50"
curl -s -X POST localhost:3000/wallets/<WALLET_ID>/reconciliation
```

Pela fila, com a AWS CLI apontada para o LocalStack:

```bash
aws --endpoint-url http://localhost:4566 --region us-east-1 sqs send-message \
  --queue-url http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/wager-transactions.fifo \
  --message-group-id <WALLET_ID> --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{"providerId":"provider-a","externalTransactionId":"transaction-124","idempotencyKey":"provider-a:transaction-124","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<WALLET_ID>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}}'
```

## Endpoints

| Método | Rota | |
|---|---|---|
| `POST` | `/wallets` | cria wallet (`201`; `409` se já existe para o player e a moeda) |
| `GET` | `/wallets/:walletId` | saldo e versão |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` | extrato paginado por cursor opaco |
| `POST` | `/wallets/:walletId/reconciliation` | compara saldo e ledger |
| `POST` | `/wagering/transactions` | submete transação (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | consulta por id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | consulta por id do provedor |
| `GET` | `/health/live`, `/health/ready` | liveness e readiness (sem autenticação) |
| `GET` | `/metrics` | métricas Prometheus |

Respostas de `POST /wagering/transactions`: `200` processada · `202` aguardando referência · `400`
payload inválido · `409` conflito de idempotência · `422` recusada por regra de negócio (com
`failureCode`) · `503` falha transitória, reenvie com a mesma key. Detalhes em
[ARCHITECTURE.md](ARCHITECTURE.md#28-status-http).

Filas: `wager-transactions.fifo` (entrada), `wager-transactions-dlq.fifo` (DLQ) e `wager-events.fifo`
(eventos publicados pela outbox).

## Testes

Os testes de integração e concorrência usam o **PostgreSQL e o LocalStack reais** do Compose, em um
banco (`wagering_test`) e filas separados — podem rodar com a aplicação no ar.

```bash
docker compose up -d postgres localstack   # só a infraestrutura
bun install

bun test                  # tudo (cerca de 1 minuto)
bun run test:unit         # domínio: Money, Wallet, regras, transições
bun run test:integration  # schema/constraints, casos de uso, inbox, outbox, retry, DLQ
bun run test:concurrency  # corridas, 3 processos reais, crash, restart, teste de propriedade
bun run typecheck

bun run test:load         # teste de carga; precisa do stack completo no ar (docker compose up --build)
```

| Arquivo | O que prova |
|---|---|
| `test/unit/*` | `Money` (escala, entradas inválidas, moedas), invariantes da `Wallet`, regras e transições |
| `test/integration/schema.test.ts` | o banco recusa cada violação feita por SQL direto; migrations reversíveis |
| `test/integration/submission.test.ts` | regras de negócio, idempotência, replay, conflito, validação |
| `test/integration/messaging.test.ts` | inbox, redelivery, atomicidade, retry, DLQ, shutdown, publishers concorrentes |
| `test/concurrency/wallet.test.ts` | 50 apostas idênticas, cenário 100/80/80, hot wallet, referência fora de ordem |
| `test/concurrency/multi-instance.test.ts` | 3 processos, morte entre commit e ack, matar tudo e reiniciar |
| `test/concurrency/property.test.ts` | invariantes para sequências aleatórias de operações (`fast-check`) |

## Desenvolvimento local

```bash
docker compose up -d postgres localstack
bun install
bun run migrate        # aplica as migrations (bun run migrate:down reverte)
bun run dev            # uma instância com reload em localhost:3000
```

Configuração por variáveis de ambiente, todas com default em [`src/config.ts`](src/config.ts):
`PORT`, `DATABASE_URL`, `SQS_ENDPOINT`, `ROLES` (`api,consumer,workers`), `LOCK_TIMEOUT_MS`,
`SQS_MAX_RECEIVE_COUNT`, `PENDING_REFERENCE_MAX_ATTEMPTS`, `LOG_LEVEL`, entre outras.

## Estrutura

```
src/
  domain/         regras e invariantes, sem framework nem ORM
  application/    casos de uso e portas (UnitOfWork, EventPublisher)
  infra/          MikroORM + migrations, SQS, HTTP
  observability/  logs e métricas
test/
  unit/  integration/  concurrency/
```

## Não implementado

Autenticação (há um guard no-op e o desenho em
[ARCHITECTURE.md](ARCHITECTURE.md#6-autenticação)), double-entry e OpenTelemetry.
A lista completa de limitações está em [ARCHITECTURE.md](ARCHITECTURE.md#8-limitações-conhecidas).
