# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de múltiplos provedores, por **HTTP** e por **SQS**, mantendo saldo materializado e ledger imutável consistentes sob duplicação, fora de ordem, concorrência entre instâncias e falhas.

- Enunciado original: [`CHALLENGE.md`](CHALLENGE.md)
- Decisões, trade-offs e limitações: [`ARCHITECTURE.md`](ARCHITECTURE.md)

**Stack:** Bun 1.2 · TypeScript (strict) · NestJS 11 · MikroORM 6 · PostgreSQL 16 · SQS (LocalStack 3.8) · Docker Compose · Prometheus metrics · pino (JSON logs)

---

## Início rápido — só precisa de Docker

Único pré-requisito: **Docker com Compose v2** (Linux, macOS ou Windows). Não é preciso instalar Bun, Node nem PostgreSQL.

Na raiz do projeto:

```bash
docker compose up -d --build                    # sobe o sistema completo
curl localhost:8080/health/ready                # {"status":"ok","checks":{"postgres":{"status":"up"},"sqs":{"status":"up"}}}

docker compose run --rm tests                   # roda TODOS os testes (unidade + integração + concorrência)
docker compose run --rm tests bun run test:load # teste de carga contra as 3 réplicas

docker compose --profile test down -v           # derruba tudo e apaga os volumes
```

`docker compose up` sobe: `postgres`, `localstack` (SQS), `setup` (migrations + criação das filas, one-shot), **3 réplicas** de `app` e um `gateway` nginx em `http://localhost:8080` balanceando entre elas. Cada réplica roda os quatro papéis (HTTP, consumidor SQS, publisher da outbox, worker de referências pendentes); todos são seguros com N instâncias.

O serviço `tests` (profile `test`, não sobe com `up`) é uma imagem com as dependências de desenvolvimento e a suíte; ele roda dentro da rede do Compose, falando com o mesmo PostgreSQL e LocalStack. Qualquer script do `package.json` funciona nele:

```bash
docker compose run --rm tests bun run test:unit
docker compose run --rm tests bun run test:integration
docker compose run --rm tests bun run test:concurrency
docker compose run --rm tests bun run typecheck
docker compose run --rm -e DURATION_S=30 -e CONCURRENCY=64 -e HOT_RATIO=0.9 tests bun run test:load
```

Portas expostas no host (apenas `127.0.0.1`): `8080` (gateway), `55432` (PostgreSQL), `4566` (LocalStack).

## Desenvolvimento local (opcional, com Bun no host)

Pré-requisitos: Bun ≥ 1.2 e Docker.

```bash
bun install
cp .env.example .env            # aponta para postgres:55432 e localstack:4566
bun run infra:up                # só postgres + localstack
bun run migrate:up              # migrations versionadas (bun run migrate:down reverte)
bun run sqs:setup               # cria wager-transactions.fifo, a DLQ e wagering-events.fifo
bun run dev                     # http://localhost:3000
bun test                        # mesma suíte, rodando no host
```

### Comandos

| Comando | O que faz |
|---|---|
| `bun run dev` / `bun start` | sobe a aplicação (watch / normal) |
| `bun run typecheck` | `tsc --noEmit` em modo estrito |
| `bun run migrate:up` / `migrate:down` | aplica / reverte migrations |
| `bun run sqs:setup` | cria as filas FIFO (idempotente) |
| `bun test` | **todos** os testes (unidade + integração + concorrência) |
| `bun run test:unit` | só unidade (sem infraestrutura) |
| `bun run test:integration` | integração com PostgreSQL e LocalStack reais |
| `bun run test:concurrency` | corridas, 3 processos, crash/restart |
| `bun run test:load` | teste de carga (padrão: contra o gateway `:8080`) |

## Testes

Os testes de integração e concorrência precisam do PostgreSQL e do LocalStack (`docker compose run --rm tests` já cuida disso; no host, `bun run infra:up`). **Nada é mockado**: cada arquivo de teste cria um banco PostgreSQL próprio (com as migrations reais) e filas SQS próprias no LocalStack, e os destrói ao final. Os testes multi-instância sobem processos `bun src/main.ts` reais.

```
test/
  unit/           Money, Wallet, WalletLedgerEntry, regras de BET/WIN/LOSS/REFUND/ROLLBACK,
                  máquina de estados, conflito de moeda, hash canônico / payload divergente, outbox,
                  bulkhead por wallet
  integration/    schema e constraints (direto no SQL), migrations reversíveis, API HTTP,
                  atomicidade wallet+ledger+inbox+outbox, inbox/redelivery, retry/DLQ,
                  publishers concorrentes, takeover após crash, referências pendentes,
                  agendamento pelo relógio do banco
  concurrency/    mesma aposta 50x em paralelo, cenário da seção 8, hot wallet, wallets distintas,
                  isolamento da hot wallet (bulkhead, com caso de controle), consumidor em pipeline,
                  3 processos simultâneos, worker morto após commit e antes do ack,
                  SIGKILL sob carga + restart, SIGTERM com drain
```

Todo arquivo de integração/concorrência termina verificando o invariante global
`wallet.balance == saldo reconstruído pelo ledger` (mais encadeamento do ledger e ausência de saldo negativo).

Resultado da última execução: **153 testes, 0 falhas, ~45 s**.

## API

| Método | Rota | Notas |
|---|---|---|
| `POST` | `/wallets` | `201`; `409 WALLET_ALREADY_EXISTS` para (player, moeda) duplicado |
| `GET` | `/wallets/:walletId` | |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` | cursor opaco e estável, `limit` 1–200 |
| `POST` | `/wallets/:walletId/reconciliation` | nunca corrige; divergência é logada, contada e sinalizada |
| `POST` | `/wagering/transactions` | header `Idempotency-Key` obrigatório |
| `GET` | `/wagering/transactions/:transactionId` | |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | |
| `GET` | `/health/live`, `/health/ready` | abertos, sem autenticação |
| `GET` | `/metrics` | Prometheus |

### Códigos HTTP (consistentes entre endpoints e iguais em replays)

| Situação | HTTP | Corpo | Pode reenviar? |
|---|---|---|---|
| Processada | `200` | `status: PROCESSED` | — (replay devolve o mesmo) |
| Aceita, aguardando referência | `202` | `status: PENDING_REFERENCE` | não precisa |
| Rejeitada por regra de negócio | `422` | `status: REJECTED`, `failureCode` | não (decisão final) |
| Payload inválido | `400` | `error.code: INVALID_PAYLOAD` | só corrigindo o payload |
| Wallet/transação inexistente | `404` | `*_NOT_FOUND` | não |
| Conflito de idempotência | `409` | `IDEMPOTENCY_KEY_CONFLICT` / `EXTERNAL_TRANSACTION_CONFLICT` | não |
| Falha transitória (lock, banco, broker) | `503` + `Retry-After` | `TEMPORARILY_UNAVAILABLE`, `retryable: true` | **sim, com a mesma key** |

Erros usam o envelope `{"error": {"code", "message", "retryable", "details?"}}`.

### Exemplo

```bash
W=$(curl -s -XPOST localhost:8080/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}')
WID=$(echo "$W" | jq -r .id)

curl -s -XPOST localhost:8080/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"transaction-123\",
       \"playerId\":\"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1\",\"walletId\":\"$WID\",
       \"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",
       \"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
# {"transactionId":"...","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
```

### Mensagem SQS (`wager-transactions.fifo`)

Formato do enunciado (`messageId`, `type: WagerTransactionRequested`, `occurredAt`, `data` com `idempotencyKey`), mais `correlationId` opcional. Recomenda-se `MessageGroupId = walletId`.

### Eventos publicados (`wagering-events.fifo`)

`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference` — envelope `{eventId, eventType, aggregateId, correlationId, causationId?, occurredAt, version, data}`. `MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId`; consumidores devem deduplicar por `eventId`.

## Teste de carga

```bash
docker compose run --rm tests bun run test:load     # contra o gateway (3 réplicas)
docker compose run --rm -e HOT_RATIO=0.9 -e CONCURRENCY=64 tests bun run test:load
BASE_URL=http://localhost:3000 bun run test:load    # no host, contra uma instância local
```

Metodologia, ambiente e resultados em [`ARCHITECTURE.md` § Teste de carga](ARCHITECTURE.md#13-teste-de-carga).

## Configuração

Todas as variáveis estão em [`src/infrastructure/config/app-config.ts`](src/infrastructure/config/app-config.ts) (validadas com zod no boot). As principais:

| Variável | Padrão | |
|---|---|---|
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5432/wagering` | |
| `AWS_ENDPOINT_URL` | — | `http://localhost:4566` para LocalStack |
| `DB_LOCK_TIMEOUT_MS` | `5000` | espera máxima pelo lock da wallet → `503` / retry |
| `WALLET_MAX_IN_FLIGHT` / `WALLET_MAX_QUEUE` / `WALLET_MAX_WAIT_MS` | `1` / `200` / `5000` | bulkhead por wallet: quantas usam conexão, quantas esperam em memória e por quanto tempo |
| `CONSUMER_CONCURRENCY` | `10` | mensagens SQS em voo por instância |
| `CONSUMER_MAX_ATTEMPTS` | `5` | recebimentos antes da DLQ |
| `PENDING_REFERENCE_MAX_ATTEMPTS` | `10` | tentativas antes de `REFERENCE_NOT_FOUND` |
| `CONSUMER_ENABLED` / `OUTBOX_ENABLED` / `PENDING_REFERENCE_ENABLED` | `true` | liga/desliga cada papel por instância |
