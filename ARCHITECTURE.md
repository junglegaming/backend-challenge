# Arquitetura — Distributed Wagering Processor

Este documento explica **por que** o sistema é como é: as decisões, o que foi descartado, o que cada
garantia custa e onde estão os limites. O setup e os comandos estão no [README](README.md).

## 1. Visão geral

```
 provedor ──HTTP──►┐                                   ┌──────────────────────────────┐
                   ├─► SubmitWagerTransaction ───────► │ PostgreSQL (uma transação)   │
 provedor ──SQS───►┘   (um único caso de uso)          │  inbox_messages              │
   wager-transactions.fifo                             │  wallets        (FOR UPDATE) │
        │ falha permanente / retries esgotados         │  wager_transactions          │
        ▼                                              │  wallet_ledger_entries       │
   wager-transactions-dlq.fifo                         │  outbox_messages             │
                                                       └──────────────┬───────────────┘
                                                                      │ depois do commit
   wager-events.fifo ◄── PublishOutbox (FOR UPDATE SKIP LOCKED) ◄─────┘
                         ResolvePendingReferences (backoff)
```

Toda instância é idêntica e faz tudo: API HTTP, consumidor SQS, publisher da outbox e worker de
referências pendentes. O Compose sobe três. Não há estado em memória que importe: a coordenação
entre instâncias é feita inteiramente pelo PostgreSQL.

### Camadas

| Pasta | Conteúdo | Depende de |
|---|---|---|
| `src/domain` | `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, inbox/outbox, eventos, `FailureCode` | nada (sem Nest, sem ORM) |
| `src/application` | casos de uso e as portas `UnitOfWork`, `TxStore`, `EventPublisher` | domínio |
| `src/infra` | MikroORM, migrations, SQS, HTTP | aplicação e domínio |
| `src/observability` | logger e métricas | — |

Há portas só onde existe uma fronteira real de infraestrutura (banco e broker). Os casos de uso são
classes puras instanciadas por factories no `AppModule`; o NestJS fica restrito à borda.
Simplificação assumida: logger e métricas são importados diretamente pela aplicação, sem porta.

## 2. Decisões

### 2.1 ORM: MikroORM

Escolhido por ser o preferencial do desafio e porque o que ele expõe é exatamente o que este problema
pede: `em.fork()` dá um Identity Map e um Unit of Work por transação, `em.transactional()` delimita a
transação SQL e `LockMode.PESSIMISTIC_WRITE` emite o `SELECT ... FOR UPDATE`.

- **Mapeamento fora do domínio.** As entidades de persistência são definidas com `defineEntity`
  (`src/infra/persistence/records.ts`), sem decorators. O domínio não importa nada do ORM; o
  `TxStore` converte registro ↔ domínio usando as factories `rehydrate`.
- **Como o Unit of Work é usado.** O store guarda os registros gerenciados carregados na transação.
  "Salvar" é copiar o estado do agregado para o registro; no flush (fim do `transactional`) o ORM
  calcula o diff e emite os `INSERT`/`UPDATE` — tudo antes do `COMMIT`.
- **SQL explícito onde a semântica importa**: `INSERT ... ON CONFLICT DO NOTHING` da inbox, o
  `FOR UPDATE SKIP LOCKED` da outbox e as consultas do lado de leitura.
- **Schema por migration em SQL**, não pelo gerador do ORM: constraints, índices parciais e triggers
  são parte do que está sendo avaliado e precisam ser lidos como estão.
- TypeORM foi o plano B. Antes de escrever código, um spike validou NestJS + MikroORM 7 + Bun com
  migration, transação e lock de linha.

### 2.2 Money

- **Em memória:** `bigint` em centavos. Com escala fixa de 2 casas a aritmética é exata e não existe
  arredondamento; nenhuma biblioteca decimal é necessária. Nunca passa por `number`.
- **Nos contratos (HTTP, SQS, eventos):** string decimal com exatamente 2 casas, `^\d{1,18}\.\d{2}$`.
  Isso rejeita vazio, negativo, `NaN`, `Infinity`, notação científica e escala diferente de 2.
  Um `amount` enviado como número JSON é recusado (`400`).
- **No banco:** `numeric(20,2)` + coluna `currency char(3)`. O driver devolve `numeric` como string,
  que é reidratada por `Money.from`.
- O modelo é multi-moeda (a moeda acompanha todo valor e operar moedas diferentes lança
  `CurrencyMismatchError`); a operação assume `BRL`.

### 2.3 Concorrência: lock pessimista por wallet

Toda escrita começa com `SELECT ... FOR UPDATE` na linha da wallet. Operações da mesma wallet formam
fila no banco; wallets diferentes seguem em paralelo. Não existe lock global.

| Alternativa | Por que não |
|---|---|
| Optimistic locking (`version`) + retry | Em hot wallet vira tempestade de retries: N requisições, N−1 refazem. Exige política de retry e deixa os testes sensíveis a tempo. |
| `UPDATE ... SET balance = balance - x WHERE balance >= x` | Ótimo para um débito isolado, mas a decisão aqui depende de mais leituras (idempotência, referência, reversão anterior) que precisam ser consistentes com o saldo. |
| `SERIALIZABLE` | Correto, mas troca espera por aborto e retry; mesmo problema do optimistic. |

**Custo assumido:** a latência de uma hot wallet cresce linearmente com a fila. `lock_timeout` de 5s
(`SET LOCAL`) limita a espera: estourou, vira erro transitório (`503` / redelivery) e conta na métrica
`wager_lock_conflicts_total`.

**Sem deadlock por construção:** em todo o sistema, cada transação trava **uma** wallet, e sempre
antes de qualquer outra coisa. O worker de pendências lê as candidatas sem lock e só decide depois de
travar a wallet.

`version` é mantido como contador de mudanças de saldo (começa em 1, incrementa só quando o saldo
muda), não como mecanismo de lock.

### 2.4 Garantias no schema

A aplicação aplica as regras; o banco **recusa** o que as viola, mesmo que a aplicação tenha um bug
ou que alguém escreva por fora. Cada linha abaixo tem um teste em `test/integration/schema.test.ts`
que tenta a violação com SQL direto.

| Garantia | Mecanismo |
|---|---|
| Saldo nunca negativo | `CHECK (balance >= 0)` |
| Uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| Idempotência | `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)` |
| Inbox | `PRIMARY KEY (consumer_name, message_id)` |
| No máximo um lançamento por transação | `UNIQUE (transaction_id)` |
| Aritmética do lançamento | `CHECK (balance_after = balance_before ± amount)` |
| Ledger encadeado | trigger: `balance_before` = `balance_after` do lançamento anterior da wallet |
| Ledger append-only | trigger bloqueia `UPDATE`, `DELETE` e `TRUNCATE` |
| **Saldo materializado = ledger** | *constraint trigger* `DEFERRABLE INITIALLY DEFERRED` em `wallets` e no ledger, verificado no `COMMIT` |
| Reversão única | índice único parcial em `reference_transaction_id` para `REFUND`/`ROLLBACK` `PROCESSED` |
| Estado terminal congelado | trigger bloqueia `UPDATE` de transação `PROCESSED`/`REJECTED`/`FAILED` e qualquer `DELETE` |
| Coerência estrutural | `CHECK`s: referência obrigatória por `kind`, `failure_code` se e somente se rejeitada/falha, valor positivo |

O trigger *deferred* é o que torna "toda alteração de saldo tem um lançamento, e vice-versa" uma
propriedade do banco: alterar o saldo sem lançar, ou lançar sem alterar o saldo, falha no commit.
As FKs também são *deferred*, para que a ordem dos `INSERT`s no flush do ORM seja irrelevante.

### 2.5 Idempotência

- A fonte da verdade é o header `Idempotency-Key` (na fila, o campo `idempotencyKey`).
- **`payloadHash` = SHA-256 (hex) do JSON canônico** dos campos de negócio: `providerId`,
  `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e
  `referenceExternalTransactionId`. JSON canônico: chaves ordenadas recursivamente, sem espaços,
  campos ausentes omitidos (`src/application/payload-hash.ts`). Header e metadados de transporte não
  entram.
- A busca pela key acontece **depois** do lock da wallet. Cinquenta requisições idênticas formam fila
  no lock; a primeira grava, as outras 49 já encontram a transação e devolvem replay.
- Mesma key + mesmo hash → resposta original com `idempotentReplay: true`. O saldo devolvido é o
  **daquele momento** (coluna `resulting_balance`), não o atual. Vale também para rejeitadas: uma
  aposta recusada por saldo continua recusada no replay.
- Mesma key + hash diferente, ou mesmo `(providerId, externalTransactionId)` com outra key →
  `409 IDEMPOTENCY_CONFLICT`.
- Corrida residual: a mesma key chegando para **wallets diferentes** não é serializada pelo lock. O
  `UNIQUE` barra a segunda; o caso de uso tenta uma vez de novo e, agora enxergando a primeira,
  responde conflito.
- Nada disso usa memória: reiniciar todas as instâncias não muda nenhuma resposta.

### 2.6 Máquina de estados

```
create ─► PENDING ─┬─► PROCESSED         (terminal)
                   ├─► REJECTED          (terminal)
                   ├─► FAILED            (terminal)
                   └─► PENDING_REFERENCE ─┬─► PROCESSED
                                          ├─► REJECTED
                                          ├─► FAILED
                                          └─► PENDING_REFERENCE (nova tentativa)
```

`PENDING` só existe dentro da transação SQL: com a wallet travada, a transação é resolvida ali mesmo.
Transicionar a partir de um estado terminal lança `InvalidTransactionStateError` no domínio e é
bloqueado por trigger no banco. `FAILED` é reservado a erro permanente de infraestrutura (hoje: uma
violação de integridade ao resolver uma pendência).

### 2.7 Códigos de falha

| `failureCode` | Situação | O que o provedor faz |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` maior que o saldo | desiste |
| `REVERSAL_WOULD_OVERDRAW` | `ROLLBACK` de `WIN`/`REFUND` deixaria o saldo negativo | escala (o dinheiro já foi gasto) |
| `REFERENCE_NOT_FOUND` | a transação referenciada não chegou dentro do limite | reenvia a referência e uma nova reversão |
| `REFERENCE_MISMATCH` | referência de outro player, wallet, rodada ou moeda | corrige o payload |
| `INVALID_REFERENCE_KIND` | `REFUND`/`WIN` apontando para não-`BET`; `ROLLBACK` para `LOSS`/`ROLLBACK` | corrige o payload |
| `REFERENCE_NOT_PROCESSED` | a referência foi rejeitada ou falhou | desiste |
| `ALREADY_REVERSED` | a referência já foi revertida | desiste |
| `AMOUNT_MISMATCH` | valor diferente do valor da referência | corrige o payload |
| `CURRENCY_MISMATCH` | moeda diferente da moeda da wallet | corrige o payload |
| `INTERNAL_ERROR` | só em `FAILED` | contata o suporte |

### 2.8 Status HTTP

| Status | Significado | Reenviar igual? |
|---|---|---|
| `200` | `PROCESSED` (nova ou replay; `idempotentReplay` diferencia) | — |
| `201` | wallet criada | — |
| `202` | `PENDING_REFERENCE`: aceita, será resolvida depois | não precisa; consulte ou reenvie para ver o estado |
| `400` | payload inválido, `Idempotency-Key` ausente | não, corrija |
| `404` | recurso consultado não existe | — |
| `409` | conflito de idempotência; wallet duplicada | não |
| `422` | recusada por regra de negócio (`failureCode` no corpo); `WALLET_NOT_FOUND` | não |
| `503` + `Retry-After` | falha transitória; nada foi confirmado | **sim, com a mesma key** |

O mapeamento é um único filtro (`src/infra/http/http.ts`) aplicado a todos os endpoints. Erro
desconhecido é tratado como transitório de propósito: se não sabemos o que houve, o seguro é o
provedor reenviar — a idempotência absorve. A exceção são os erros de dado do Postgres (SQLSTATE
classe 22, por exemplo um valor que estoura `numeric(20,2)`): viram `400`, porque reenviar não
resolve.

### 2.9 Consumidor SQS e inbox

O consumidor chama **o mesmo caso de uso** do HTTP, passando o `messageId`. O registro na inbox
(`INSERT ... ON CONFLICT DO NOTHING`) acontece na mesma transação dos efeitos: ou a mensagem foi
registrada **e** aplicada, ou nenhuma das duas coisas.

| Resultado | Ação |
|---|---|
| Sucesso, replay ou rejeição de negócio (`REJECTED` persistida) | ack |
| Mensagem já registrada na inbox com o mesmo conteúdo | ack |
| Mesmo `messageId` com conteúdo diferente (`payload_hash` da inbox não bate) | DLQ com `reason = message_id_conflict` |
| Erro permanente: JSON malformado, payload inválido, conflito de idempotência, wallet inexistente | envia para a DLQ com o atributo `reason` e faz ack |
| Erro transitório: banco indisponível, lock timeout, qualquer erro desconhecido | **sem ack**; visibilidade de `2^n` s (teto 60s); após 5 recebimentos a *redrive policy* move para a DLQ |

- O ack (`DeleteMessage`) só é enviado depois que o caso de uso retorna, isto é, depois do commit.
- FIFO com `MessageGroupId = walletId` é otimização (reduz contenção de lock), não garantia.
- Falha transitória interrompe o lote daquele grupo: as mensagens seguintes da mesma wallet são
  devolvidas, para não passarem na frente da que será reentregue.
- **SIGTERM:** o consumidor para de receber, conclui a mensagem em andamento e devolve as demais com
  visibilidade 0. O long poll em curso não é abortado — abortar no cliente não cancela no servidor,
  que ainda entregaria uma mensagem a uma requisição abandonada (um teste pegou isso).

### 2.10 Transactional outbox

Os eventos são gravados em `outbox_messages` na mesma transação do efeito financeiro; nada é
publicado antes do commit. O worker faz, em uma transação:
`SELECT ... FOR UPDATE SKIP LOCKED` → publica → marca `published_at` → commit.

- **Vários publishers:** `SKIP LOCKED` faz cada um pegar um lote diferente.
- **Processo morre antes de publicar:** os eventos continuam pendentes e outra instância publica.
- **Processo morre depois de publicar e antes do commit:** o evento sai de novo. É at-least-once;
  o consumidor deduplica por `eventId`, que também vai como `MessageDeduplicationId`.
- **Falha de publicação:** `attempts + 1` e `next_attempt_at` com backoff exponencial (teto 60s). Os
  eventos seguintes da mesma wallet esperam: não são tentados naquele lote, e a consulta do publisher
  não seleciona um evento enquanto houver um anterior da mesma wallet em backoff.
- **Custo assumido:** os locks de linha ficam presos durante a chamada ao SQS. O lote é limitado (50)
  e as linhas travadas só interessam a outros publishers, que as pulam.

Eventos: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` (só quando o
saldo muda) e `WagerTransactionPendingReference`. Cada um é uma subclasse de `IntegrationEvent<T>` com
`eventType` e `version` no tipo; `data` carrega `MoneyProps`, nunca `Money`.

### 2.11 Referências fora de ordem

`REFUND`/`ROLLBACK` (ou `WIN` com referência) cuja referência ainda não existe é persistida como
`PENDING_REFERENCE`, responde `202` e publica `WagerTransactionPendingReference`. Um worker reprocessa
com backoff de 1s, 2s, 4s… até **8 tentativas (cerca de 4 minutos)**; esgotado, vira
`REJECTED / REFERENCE_NOT_FOUND` com o evento correspondente.

**Por que 4 minutos:** fora de ordem em entrega at-least-once é questão de milissegundos a segundos.
Uma referência que não apareceu em minutos provavelmente não vem, e manter a reversão pendurada
indefinidamente esconde o problema do provedor. É configurável (`PENDING_REFERENCE_MAX_ATTEMPTS`).

A pendência não é resolvida no instante em que a referência chega, só no próximo ciclo do worker: um
caminho a menos para testar, ao custo de até ~1s.

## 3. Interpretações adotadas

1. **Uma transação só pode ser revertida uma vez, por `REFUND` ou por `ROLLBACK`.** O enunciado
   proíbe duas reversões "pelo mesmo tipo"; permitir um `REFUND` e depois um `ROLLBACK` da mesma
   `BET` creditaria o valor duas vezes, então a regra aqui é mais restrita.
2. `WIN` pode referenciar uma `BET`. Se referenciar, a `BET` precisa ser da mesma rodada e estar
   `PROCESSED`; o valor é livre. Sem referência, o `WIN` é aplicado direto.
3. `LOSS` aceita `0.00`; as demais operações exigem valor positivo.
4. Uma referência que existe mas ainda está `PENDING_REFERENCE` faz a dependente esperar também.
5. Wallet inexistente, ou de outro `playerId`, responde `422 WALLET_NOT_FOUND` e **não é
   persistida** (a transação tem FK para a wallet). Esse caso fica fora da idempotência persistente.
6. A abertura com saldo inicial não incrementa `version`: a wallet nasce em `version = 1` já com o
   saldo, como no exemplo do enunciado.
7. A transação `OPENING` usa `providerId = "internal"` e não pode ser submetida por HTTP nem fila.

## 4. Matriz de falhas

| Onde falha | O que acontece | Teste que prova |
|---|---|---|
| Processo morre antes do commit | Rollback: sem inbox, transação, ledger, outbox ou mudança de saldo. A mensagem volta. | `messaging` › *atomicity: a crash before commit…* |
| Processo morre depois do commit e antes do ack | Redelivery; a inbox reconhece; um único débito. | `multi-instance` › *worker killed after commit and before ack* |
| Processo morre depois do commit e antes de publicar | Evento fica na outbox; outra instância publica. | `messaging` › *two concurrent publishers…* |
| Mesmo evento publicado duas vezes | Mesmo `eventId`; deduplicado. | `messaging` › *a duplicate publication is safe* |
| SQS indisponível ao publicar | Evento continua pendente com backoff; publicado depois, em ordem. | `messaging` › *publish failure keeps the event pending…* |
| PostgreSQL indisponível (entrada SQS) | Sem ack; redelivery com backoff; processado uma vez. | `messaging` › *transient failure…* |
| PostgreSQL indisponível por muito tempo | Após o limite de recebimentos, DLQ; nada aplicado. | `messaging` › *retries exhausted…* |
| PostgreSQL indisponível (entrada HTTP) | `503` + `Retry-After`; reenvio seguro. | filtro de erros (sem teste automatizado — ver limitações) |
| Mensagem inválida ou conflitante | DLQ imediata com motivo. | `messaging` › *permanent errors go straight to the DLQ…* |
| Mesma mensagem entregue N vezes | Um efeito, uma linha na inbox. | `messaging` › *redelivery of the same message…* |
| Mesma requisição 50× em paralelo | Um débito, 49 replays. | `wallet` e `multi-instance` › *the same bet sent 50 times…* |
| Duas apostas disputam o saldo | Uma `PROCESSED`, uma `REJECTED`, saldo 20.00. | `wallet` e `multi-instance` › *mandatory scenario* |
| Referência chega depois | `PENDING_REFERENCE`, depois aplicada uma vez. | `wallet` › *REFUND and ROLLBACK arriving before their reference…* |
| Referência nunca chega | `REJECTED / REFERENCE_NOT_FOUND` + evento. | `wallet` › *when attempts run out…* |
| Todas as instâncias morrem no meio do trabalho | Estado confirmado é consistente; ao reiniciar, tudo termina. | `multi-instance` › *all instances are killed mid-flight and restarted* |
| SIGTERM | Conclui a mensagem em andamento, devolve as outras. | `messaging` › *graceful shutdown…* |
| Bug na aplicação tenta gravar estado inválido | O banco recusa. | `schema` (todos) |

## 5. Como os testes sustentam as garantias

- **Infra real.** Integração e concorrência rodam contra o PostgreSQL e o LocalStack do Compose, em
  banco (`wagering_test`) e filas próprios. As únicas coisas simuladas são falhas de infraestrutura
  (um `UnitOfWork` que recusa conexões, um publisher que falha).
- **Paralelismo real.** Em processo, cada chamada usa uma conexão própria e quem arbitra é o
  Postgres. Os testes `multi-instance` sobem três processos `bun src/main.ts` separados e usam
  `SIGKILL`.
- **Teste de propriedade** (`test/concurrency/property.test.ts`, `fast-check`): gera sequências
  aleatórias de operações com duplicatas, ordem embaralhada e referências válidas e inválidas, dispara
  em paralelo e verifica as invariantes para qualquer sequência.
- **Revisão independente.** Depois de pronto, o código passou por uma revisão separada focada em
  correção financeira e mensageria. Não encontrou defeito de saldo; os pontos de mensageria e de
  classificação de erro que encontrou foram corrigidos e ganharam teste.
- **Os testes falham quando a garantia some.** Removendo o `FOR UPDATE` de `lockWallet`, 9 testes de
  concorrência falham. (Verificado manualmente; os triggers do banco continuam impedindo corrupção.)
- Invariante final de todo arquivo de teste: `wallet.balance == saldo reconstruído pelo ledger`.

## 6. Autenticação

**Não implementada, por decisão.** Não pontua, e o tempo foi para correção financeira e concorrência.
O ponto de extensão é o `ProviderAuthGuard` (`src/infra/http/http.ts`), um no-op aplicado aos
controllers de negócio; health e métricas ficam abertos.

Desenho que eu adotaria: Keycloak no Compose, um *client* por provedor com *client credentials*. O
guard valida o JWT (assinatura via JWKS, `iss`, `aud`, `exp`) e exige que o claim do provedor seja
igual ao `providerId` do payload e ao `:providerId` da rota — um provedor não submete nem consulta em
nome de outro. Criação de wallet e reconciliação exigiriam um papel de operador. Mensagens da fila
continuam sendo canal interno confiável, com as mesmas validações de domínio.

## 7. Observabilidade

- **Logs** JSON (pino) com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`,
  `kind`, `status`, `failureCode`. Valores monetários e payloads não são logados. O `correlationId`
  vem do header `X-Correlation-Id` (ou é gerado) e segue até o envelope dos eventos.
- **Métricas** Prometheus em `GET /metrics`:

| Métrica | Cobre |
|---|---|
| `wager_transactions_total{kind,status,failure_code}` | transações por status |
| `wager_duplicates_total{type}` | replay idempotente, conflito de payload, redelivery na inbox |
| `wager_retries_total{source}` | retries de SQS, outbox, referência pendente e corrida de idempotência |
| `wager_dlq_messages_total{reason}`, `wager_dlq_depth` | mensagens em DLQ |
| `wager_lock_conflicts_total` | lock timeout, deadlock, falha de serialização |
| `wager_outbox_lag_seconds`, `wager_outbox_published_total{event_type}` | outbox lag |
| `wager_processing_duration_seconds{source}` | latência de processamento |
| `wallet_reconciliation_divergences_total` | divergências de reconciliação |

- **Health:** `/health/live` não toca dependências; `/health/ready` verifica PostgreSQL e SQS.
- **Reconciliação:** uma única instrução SQL (um snapshot) compara saldo e ledger. Divergência é
  logada, contada e sinalizada com `consistent: false`; nunca corrigida.

## 8. Limitações conhecidas

- **Ordem dos eventos entre publishers.** Dois publishers podem publicar eventos da mesma wallet fora
  de ordem (cada um com um lote). `WalletBalanceChanged` carrega `walletVersion` justamente para o
  consumidor ordenar e detectar lacunas. Garantir ordem estrita exigiria particionar a outbox por
  wallet.
- **Hot wallet** tem throughput limitado pela serialização do lock. É o preço da escolha em 2.3.
- **`WALLET_NOT_FOUND` não é persistido** (interpretação 5).
- **A idempotency key é única globalmente**, não por provedor. Sem autenticação, um provedor que
  adivinhe a key de outro pode ocupá-la. Com o guard real, a unicidade passaria a ser
  `(provider_id, idempotency_key)`.
- **`FAILED` não publica evento.** A lista mínima de eventos não tem um para falha permanente; a
  transação fica auditável no banco, nos logs e na métrica.
- **Devolver uma mensagem no shutdown consome um recebimento** dos 5 antes da DLQ.
- **Métricas e logs de transação são emitidos depois do commit**; um processo morto entre o commit e
  a emissão deixa de contar aquela transação (o banco continua sendo a fonte da verdade).
- **Eventos do worker de pendências** usam o id da transação como `correlationId`; o original não é
  armazenado.
- **Métricas são por instância**; a agregação fica para o Prometheus.
- **Sem teste de carga** e sem OpenTelemetry. Não há número de throughput medido para apresentar.
- **Sem teste automatizado do `503` no HTTP** nem de indisponibilidade real do Postgres (derrubar o
  container); a indisponibilidade é simulada na fronteira do `UnitOfWork`.
- **As filas são criadas pela aplicação** na inicialização; em produção seria infraestrutura como
  código.
- **Uma mensagem em retry bloqueia o grupo FIFO** (a wallet) até ser processada ou ir para a DLQ.
- **Double-entry** não foi implementado; o ledger é de entrada única por wallet.

## 9. Com mais tempo

Teste de carga com análise de p50/p95/p99 e de contenção em hot wallet; chaos com `docker kill` do
Postgres e do LocalStack; autenticação com Keycloak; resolução imediata de pendências quando a
referência chega; particionamento da outbox para ordem estrita por wallet.
