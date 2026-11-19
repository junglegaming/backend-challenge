# Distributed Wagering Processor — Design

Data: 2026-11-19 · Branch: `feat/wagering-processor` · Fonte de requisitos: `README.md`

## 1. Intenção

Entregar o desafio técnico da Jungle Gaming: um serviço financeiro de apostas que permanece correto com
mensagens duplicadas, fora de ordem e processadas simultaneamente por 3+ instâncias. O que se quer
demonstrar não é volume de código, é que **as garantias se sustentam e são provadas**.

## 2. Objetivos, não-objetivos, anti-objetivos

**Objetivos (ordem de prioridade = pontos da avaliação)**
1. Correção financeira e concorrência (40 pts): invariantes aplicadas no schema do Postgres.
2. Idempotência persistente e mensageria (30 pts): inbox, outbox, retry, DLQ, crash recovery.
3. Testes de integração e concorrência contra Postgres e LocalStack reais.
4. Observabilidade mínima obrigatória e documentação (`README.md` de setup, `ARCHITECTURE.md`).

**Não-objetivos**
- Autenticação real: fica um `AuthGuard` no-op documentado (não vale ponto).
- Double-entry, OpenTelemetry, dashboard.
- Teste de carga (`bun run test:load`): só se sobrar tempo.
- Reversão parcial, multi-moeda operacional (modelo é multi-moeda; operação assume `BRL`).

**Anti-objetivos**
- Qualquer falha eliminatória da seção 14 do README.
- Abstração sem motivo (interface com uma implementação, factory para um produto).
- Código que o autor não consiga defender linha a linha na apresentação.

## 3. Abordagens consideradas

| Decisão | Escolhida | Descartada e por quê |
|---|---|---|
| Concorrência | Lock pessimista por wallet (`SELECT ... FOR UPDATE`) | Optimistic + retry: tempestade de retries em hot wallet, testes não-determinísticos. Update atômico condicionado: não cobre lógica de referência e ledger encadeado. |
| ORM | MikroORM, mapeamento fora do domínio (`EntitySchema`), SQL explícito nos caminhos críticos | TypeORM: aceito mas não preferido; fica como plano B se o spike de 1h30 (Nest + MikroORM + Bun) falhar. |
| Dinheiro | `bigint` em centavos dentro de `Money`; `numeric(20,2)` no banco; string decimal nos contratos | `decimal.js`: dependência desnecessária com escala fixa de 2. `number`: eliminatório. |
| Rejeição de negócio no HTTP | `422` com `status: REJECTED` e `failureCode` | `200` com corpo REJECTED: obriga o provedor a ler o corpo. |
| Topologia | Uma imagem; toda instância roda API + consumidor + workers; 3 réplicas no Compose | Processos separados por papel: mais configuração sem ganho para o desafio. |

## 4. Estrutura

```
src/
  domain/        Money, Wallet, WagerTransaction, WalletLedgerEntry, InboxMessage, OutboxMessage,
                 eventos de integração, erros e FailureCode. Sem Nest, sem ORM.
  application/   SubmitWagerTransaction, OpenWallet, ReconcileWallet, ResolvePendingReferences,
                 PublishOutbox. Portas só onde há duas implementações ou fronteira de infra real.
  infra/
    persistence/ EntitySchemas, repositórios (rehydrate), migrations (SQL, up/down)
    sqs/         consumidor, publisher
    http/        controllers, AuthGuard no-op, filtro de erros → status HTTP
    observability/ logger JSON (pino), métricas (prom-client, GET /metrics), health
test/
  unit/  integration/  concurrency/
```

Dependências: `@nestjs/*`, `@mikro-orm/*` (postgresql, migrations, nestjs), `@aws-sdk/client-sqs`,
`pino`, `prom-client`, `zod` (validação de entrada), `fast-check` (dev).

## 5. Domínio

### Money
`bigint` de centavos + moeda. `from({amount, currency})` aceita somente `^\d+\.\d{2}$` (rejeita vazio,
negativo, notação científica, `NaN`, `Infinity`, escala ≠ 2) e moeda `^[A-Z]{3}$`. Imutável. Operação
entre moedas diferentes lança `CurrencyMismatchError`.

### Máquina de estados de WagerTransaction
```
create ─► PENDING ─┬─► PROCESSED         (terminal)
                   ├─► REJECTED          (terminal)
                   ├─► FAILED            (terminal)
                   └─► PENDING_REFERENCE ─┬─► PROCESSED
                                          ├─► REJECTED
                                          └─► FAILED
```
`PENDING` só existe dentro da transação SQL. Transição a partir de terminal lança
`InvalidTransactionStateError`.

### FailureCode
| Código | Quando |
|---|---|
| `INSUFFICIENT_FUNDS` | BET sem saldo |
| `REVERSAL_WOULD_OVERDRAW` | ROLLBACK de WIN/REFUND deixaria saldo negativo |
| `REFERENCE_NOT_FOUND` | referência não chegou após esgotar tentativas |
| `REFERENCE_MISMATCH` | referência de outro player, wallet, rodada ou moeda |
| `INVALID_REFERENCE_KIND` | REFUND → não-BET; ROLLBACK → LOSS, ROLLBACK ou OPENING |
| `REFERENCE_NOT_PROCESSED` | referência está `REJECTED` ou `FAILED` |
| `ALREADY_REVERSED` | referência já revertida por esse tipo |
| `AMOUNT_MISMATCH` | valor ≠ valor da referência |
| `CURRENCY_MISMATCH` | moeda da operação ≠ moeda da wallet |

Referência existente mas ainda `PENDING_REFERENCE` → a dependente também fica `PENDING_REFERENCE`.

Direção do ledger: BET = DEBIT; WIN, REFUND, OPENING = CREDIT; ROLLBACK = inverso da referência;
LOSS = nenhum lançamento.

## 6. Schema (garantias no banco)

- **`wallets`**: `balance numeric(20,2) CHECK (balance >= 0)`, `version int CHECK (version >= 1)`,
  `UNIQUE (player_id, currency)`.
- **`wager_transactions`**: `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)`,
  FK para `wallets`, `amount CHECK (amount > 0)`, `CHECK` de referência obrigatória para
  REFUND/ROLLBACK, `CHECK` de `failure_code` presente se e somente se status ∈ {REJECTED, FAILED},
  índice único parcial `(reference_transaction_id, kind) WHERE status = 'PROCESSED'`,
  trigger que bloqueia UPDATE de linha em estado terminal, colunas `resulting_balance`
  (snapshot para replay), `attempts`, `next_attempt_at`.
- **`wallet_ledger_entries`**: `UNIQUE (transaction_id)`, `UNIQUE (wallet_id, sequence)`,
  `CHECK` aritmético (`balance_after = balance_before ± amount`), `balance_after >= 0`,
  trigger que bloqueia UPDATE e DELETE, constraint trigger `DEFERRABLE INITIALLY DEFERRED` que exige
  `wallets.balance = balance_after` do último lançamento da wallet.
- **`inbox_messages`**: PK `(consumer_name, message_id)`.
- **`outbox_messages`**: `payload jsonb`, `attempts`, `next_attempt_at`, `published_at`,
  índice parcial em pendentes.

Migrations versionadas com `up` e `down`.

## 7. Fluxos

### Submissão (um use case, duas entradas)
1. Valida o payload (zod); `kind = OPENING` é inválido. Calcula
   `payloadHash = sha256(JSON canônico)` dos campos de negócio: `providerId`,
   `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money`,
   `referenceExternalTransactionId`. Chaves ordenadas, sem header nem metadados.
2. Abre transação SQL.
3. Entrada SQS: `INSERT` na inbox `ON CONFLICT DO NOTHING`; se já existia, commit e ack.
4. `SELECT ... FOR UPDATE` na wallet. Inexistente ou de outro `playerId` → `WALLET_NOT_FOUND`
   sem persistir (não há FK possível). Limitação documentada.
5. Busca por `idempotency_key`: mesmo hash → replay (resposta original, `idempotentReplay: true`);
   hash diferente → conflito.
6. Resolve referência (se exigida), aplica regras, atualiza saldo e `version`, grava ledger,
   grava eventos na outbox, marca inbox processada. Commit.
7. Só então responde HTTP ou faz ack no SQS.

### Status HTTP
`200` PROCESSED (novo ou replay) · `201` wallet criada · `202` PENDING_REFERENCE · `400` payload
inválido ou sem `Idempotency-Key` · `404` recurso de consulta inexistente · `409` conflito de
idempotência ou wallet duplicada · `422` rejeição de negócio · `503` + `Retry-After` falha transitória.

### Consumidor SQS (`wager-transactions.fifo`, `MessageGroupId = walletId`)
- Negócio (REJECTED persistido) → ack.
- Transitório (banco indisponível, lock timeout) → sem ack, `ChangeMessageVisibility` com backoff;
  redrive para DLQ após `maxReceiveCount = 5`.
- Permanente (JSON malformado, schema inválido, conflito de idempotência, wallet inexistente) →
  envia para `wager-transactions-dlq.fifo` e remove da fila.
- `SIGTERM`: para de receber, conclui o que está em andamento, devolve a visibilidade do restante.

### Outbox
Worker: `SELECT ... FOR UPDATE SKIP LOCKED LIMIT N` nos pendentes vencidos, publica em
`wager-events.fifo` (`MessageGroupId = walletId`, `MessageDeduplicationId = eventId`), marca
`published_at`, commit. Falha de publish → `scheduleRetry` (backoff exponencial). Processo morto →
lock liberado, outra instância assume. Duplicata possível; consumidor deduplica por `eventId`.

Eventos: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`,
`WagerTransactionPendingReference`. Classe abstrata `IntegrationEvent<T>` com subclasse por evento.

### Worker de PENDING_REFERENCE
`SKIP LOCKED` nas vencidas; reexecuta a resolução sob lock da wallet. Backoff `2^n` s, máximo 8
tentativas (~4 min), configurável por env. Esgotado → `REJECTED / REFERENCE_NOT_FOUND` + evento.

### Reconciliação
Soma o ledger da wallet, compara com `balance`. Divergência: log de erro, métrica, `consistent: false`.
Nunca corrige.

## 8. Observabilidade

- Logs JSON (pino) com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`.
  Sem payload financeiro completo.
- Métricas Prometheus em `GET /metrics`: transações por status, duplicatas, retries, mensagens em DLQ,
  conflitos/timeouts de lock, outbox lag, latência de processamento, divergências de reconciliação.
- `GET /health/live`, `GET /health/ready` (Postgres + SQS). Sem autenticação.

## 9. Testes

- **Unidade**: lista da seção 13 do README.
- **Integração** (Postgres + LocalStack via Compose): constraints e triggers rejeitando escrita
  inválida feita por SQL direto; atomicidade; inbox e redelivery; publishers concorrentes; retry e DLQ.
- **Concorrência**: os 8 cenários do README. Multi-instância com 3 processos reais (`Bun.spawn`),
  incluindo `SIGKILL` depois do commit e antes do ack.
- **Diferencial**: teste de propriedade (`fast-check`) gerando sequências aleatórias com duplicatas e
  ordem embaralhada, em paralelo, verificando as invariantes.
- Invariante final de todo teste: `wallet.balance == saldo reconstruído pelo ledger`.

## 10. Entregáveis de documentação

`README.md` (setup e comandos) e `ARCHITECTURE.md` com decisões, trade-offs, limitações e a
**matriz de falhas** (ponto de falha → comportamento → teste que prova).

## 11. Ordem de construção

1. Spike: Nest + MikroORM + Postgres no Bun (máx. 1h30; falhou → TypeORM).
2. Compose, migrations, constraints + testes de schema.
3. Domínio + testes de unidade.
4. Submissão + API HTTP + cenário obrigatório da seção 8.
5. Consumidor SQS + inbox + DLQ.
6. Outbox + worker de pendências + reconciliação.
7. Testes de concorrência e multi-instância.
8. Observabilidade.
9. `ARCHITECTURE.md`, README.
10. Diferenciais (teste de propriedade; carga se sobrar).

## 12. Deixado para quem implementa

Nomes de arquivos e classes internas, formato do cursor opaco do ledger (base64 de `sequence`),
intervalos de polling dos workers, nomes exatos das métricas.
