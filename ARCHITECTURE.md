# Arquitetura e decisões

Este documento explica **como** as garantias do desafio são obtidas, **por que** cada decisão foi tomada e **o que fica de fora**. A regra geral: o **PostgreSQL é a fonte da verdade** para todas as invariantes financeiras; aplicação, SQS FIFO e caches são otimizações, nunca a garantia.

## Sumário

1. [Camadas e organização](#1-camadas-e-organização)
2. [ORM, mapeamento do Money e estratégia transacional](#2-orm-mapeamento-do-money-e-estratégia-transacional)
3. [Concorrência](#3-concorrência)
4. [Idempotência](#4-idempotência)
5. [Garantias no schema](#5-garantias-no-schema)
6. [Regras de negócio e interpretações adotadas](#6-regras-de-negócio-e-interpretações-adotadas)
7. [Máquina de estados e taxonomia de falhas](#7-máquina-de-estados-e-taxonomia-de-falhas)
8. [Referências fora de ordem](#8-referências-fora-de-ordem)
9. [Consumidor SQS](#9-consumidor-sqs)
10. [Transactional Outbox](#10-transactional-outbox)
11. [Observabilidade](#11-observabilidade)
12. [Autenticação](#12-autenticação)
13. [Teste de carga](#13-teste-de-carga)
14. [Limitações e próximos passos](#14-limitações-e-próximos-passos)

---

## 1. Camadas e organização

Arquitetura hexagonal (ports & adapters) com DDD tático, em um único bounded context:

```
src/
  domain/            puro TypeScript — sem NestJS, sem ORM
    money.ts                     value object (bigint em centavos)
    wallet.ts                    aggregate root: debit/credit geram o lançamento
    wallet-ledger-entry.ts       imutável (Object.freeze + sem métodos de transição)
    wager-transaction.ts         máquina de estados explícita
    wager-settlement.ts          domain service com as regras da seção 7 (puro, testável)
    inbox-message.ts, outbox-message.ts
    events/                      IntegrationEvent abstrata + 4 subclasses
    ports/                       repositórios, UnitOfWork, Clock, IdGenerator
  application/       casos de uso (orquestram transação + domínio + portas)
    submit-wager-transaction.ts  ÚNICO ponto de entrada para HTTP e SQS
    wallet-admission.ts          bulkhead por wallet (fila em memória sem segurar conexão)
    wager-processor.ts           aplica a decisão e grava tudo no mesmo escopo transacional
    open-wallet.ts, queries.ts, reconcile-wallet.ts, resolve-pending-references.ts
  infrastructure/    adapters de saída
    persistence/                 MikroORM (EntitySchema), mappers, repositórios, UoW, migrations
    messaging/                   SQS gateway, outbox publisher, workers
    observability/               pino + Prometheus
  interface/         adapters de entrada
    http/                        controllers, filtro de erros, auth (ponto de extensão)
    sqs/                         consumidor
```

**Padrões usados e por quê**

| Padrão | Onde | Motivo |
|---|---|---|
| Value Object | `Money` | aritmética exata e imutável num só lugar |
| Aggregate Root | `Wallet` | o saldo só muda via `debit`/`credit`, que **produzem** o lançamento — "toda alteração de saldo tem lançamento" é estrutural |
| Factory estática + construtor privado | todas as entidades | `create/open` validam; `rehydrate` reconstrói sem revalidar transições (6.0) |
| Domain Service | `WagerSettlement` | regras de BET/WIN/LOSS/REFUND/ROLLBACK sem I/O → testes unitários exaustivos |
| Unit of Work + Repository (ports) | `UnitOfWork.run(scope => …)` | o caso de uso recebe repositórios já ligados à mesma transação SQL; nada de transação implícita |
| Data Mapper | `infrastructure/persistence/mappers.ts` | domínio não conhece ORM; o mapper é o único lugar que conhece os dois lados |
| Bulkhead (semáforo por chave) | `WalletAdmission` | uma wallet quente não esgota o pool de conexões nem atrasa as demais |
| Template Method | `PollingWorker` | outbox publisher, worker de pendências e sampler de métricas compartilham loop, drain e shutdown |
| Strategy / porta | `Authenticator`, `WageringMetrics`, `StructuredLogger` | trocar implementação sem tocar casos de uso |
| Transactional Outbox / Inbox | `outbox_messages`, `inbox_messages` | atomicidade entre mudança financeira e mensageria |

O mesmo caso de uso (`SubmitWagerTransaction`) atende HTTP e SQS; a única diferença é que a entrada SQS passa `inbox: {consumerName, messageId}`.

## 2. ORM, mapeamento do Money e estratégia transacional

**MikroORM 6** (preferencial no enunciado), com `EntitySchema` (sem decorators) sobre **records de persistência separados do domínio**.

- **Leituras** usam a API do MikroORM (`em.findOne`, `em.count`, `LockMode.PESSIMISTIC_WRITE`), sempre com `refresh: true` para que o identity map nunca sirva estado velho.
- **Escritas são explícitas** (`em.insert`, `em.nativeUpdate`, SQL parametrizado para `ON CONFLICT`/`SKIP LOCKED`/`RETURNING`) em vez do change tracking do Unit of Work. Motivo: no caminho quente quero (a) controlar a ordem dos statements, (b) expressar updates condicionais (`WHERE version = ?`, `WHERE status = ?`) cujo número de linhas afetadas **prova** que ninguém escreveu no meio, e (c) receber erros de constraint no ponto exato. O `flush` do MikroORM vira no-op.
- **`UnitOfWork.run`** = `orm.em.fork().transactional(...)` em `READ COMMITTED`, com `SET LOCAL lock_timeout` e `statement_timeout`. Consultas usam `snapshot()` em `REPEATABLE READ, READ ONLY` (o ledger paginado e a reconciliação enxergam uma foto consistente).
- Erros do driver são traduzidos para a taxonomia da aplicação (`database-errors.ts`) por SQLSTATE: `55P03/40P01/40001/57014/08xxx` → transitório; `23505` → `UniqueViolationError` (corrida, re-executável); demais `23xxx`/triggers → `IntegrityViolationError` (bug).

**Money**

- Domínio: `bigint` de centavos (escala fixa 2). Nenhum `number` toca dinheiro. Entrada estrita por regex: sem sinal, sem expoente, sem zeros à esquerda, ≤ 18 dígitos inteiros, ≤ 2 decimais. **Não há arredondamento**: `"10.005"` é rejeitado, não arredondado (arredondar dinheiro de entrada silenciosamente é pior que rejeitar). `"25"`/`"25.5"` são normalizados para `"25.00"`/`"25.50"`.
- Persistência: duas colunas, `numeric(20,2)` + `char(3)`. O MikroORM mapeia `decimal` para **string**, e o mapper reidrata com `Money.fromPersisted` — exato nos dois sentidos.
- Contratos: sempre `{"amount": "25.00", "currency": "BRL"}`; eventos carregam `MoneyProps`, nunca a instância.
- Multi-moeda: o modelo inteiro carrega a moeda; operações entre moedas lançam `CurrencyMismatchError` (testado); uma wallet por `(player, moeda)`.

## 3. Concorrência

**Unidade de concorrência: a linha da wallet.** Estratégia: **lock pessimista por linha** (`SELECT … FOR UPDATE`) + **update condicional por versão** como defesa em profundidade.

Fluxo de uma submissão (uma transação SQL):

```
BEGIN
  [SQS] INSERT inbox ON CONFLICT DO NOTHING            -- dedup persistente
  SELECT tx WHERE idempotency_key = ?                  -- fast path de replay, sem lock
  SELECT wallet WHERE id = ? FOR UPDATE                -- serializa só ESTA wallet
  SELECT tx WHERE idempotency_key = ?                  -- re-check sob o lock
  SELECT tx WHERE (provider, external_id) = ?          -- conflito de external id
  SELECT referência (+ "já revertida?")
  -- domínio decide (puro)
  INSERT wager_transactions
  UPDATE wallets SET balance, version WHERE id = ? AND version = ?   -- 1 linha, senão conflito
  INSERT wallet_ledger_entries
  UPDATE dependentes PENDING_REFERENCE -> devidos agora
  INSERT outbox_messages
COMMIT                                                 -- triggers DEFERRED validam wallet == ledger
```

**Por que pessimista e não otimista?** O cenário central é a *hot wallet* (muitas operações na mesma wallet). Com locking otimista, sob contenção, a maioria das tentativas falha e re-executa (tempestade de retries, latência imprevisível e mais trabalho no banco); com `FOR UPDATE` os escritores fazem fila no próprio PostgreSQL, cada um executa uma vez. O lock é **por linha** (nunca global): wallets diferentes nunca se bloqueiam — o teste "wallets distintas em paralelo" verifica isso.

- `lock_timeout` (padrão 5 s) limita a espera: estourou → erro **transitório** (`503`/retry SQS) e métrica `wagering_lock_conflicts_total{reason="lock-timeout"}`; nunca uma fila infinita de conexões.
- **Deadlocks são evitados por ordem de lock**: todo caminho que escreve trava primeiro a wallet e só então linhas de transação; o claim do worker de pendências não trava wallet. Ainda assim `40P01` é tratado como transitório.
- O `UPDATE … WHERE version = ?` nunca deveria falhar enquanto o lock está seguro; se falhar (bug, escrita fora da aplicação), vira `ConcurrencyConflictError` e é contado — não há *lost update* possível.
- Triggers no banco tornam a não-negatividade e a coerência saldo/ledger independentes do código (seção 5).
- **Bulkhead por wallet (por instância)** — `application/wallet-admission.ts`. Sem ele, N requisições para a mesma wallet "quente" pegariam cada uma uma conexão do pool e ficariam paradas no lock da linha: uma única wallet esgotaria o pool e atrasaria **todas as outras wallets** da instância. Agora, no máximo `WALLET_MAX_IN_FLIGHT` (1) unidade de trabalho por wallet usa conexão; as demais esperam **em memória, sem conexão**, em fila FIFO limitada (`WALLET_MAX_QUEUE`, 200) e com espera máxima (`WALLET_MAX_WAIT_MS`, 5 s); o excesso é recusado na hora como erro transitório (`503` / retry SQS). É só agendamento — a correção continua vindo do lock da linha e das constraints; nada de idempotência ou saldo fica em memória. O teste `hot-wallet-isolation` prova o efeito com um pool de 4 conexões e a linha quente travada: com o bulkhead, outra wallet responde em < 1 s; no caso de controle (bulkhead desligado) ela fica bloqueada até o lock ser liberado. Métrica: `wagering_wallet_admission_total{outcome}`.
- Corridas entre wallets diferentes com a mesma idempotency key são resolvidas pela constraint `UNIQUE`: o perdedor recebe `23505`, o caso de uso re-executa (até 3x) e na segunda passada enxerga o vencedor → replay ou conflito.

**Cenário obrigatório (100.00, duas apostas de 80.00 simultâneas)**: coberto em uma instância e em 3 processos — exatamente uma `PROCESSED`, outra `REJECTED/INSUFFICIENT_FUNDS`, saldo `20.00`, um único `DEBIT`, retries em paralelo não duplicam.

**Ordenação**: SQS FIFO com `MessageGroupId = walletId` entrega em ordem por wallet e o consumidor processa um grupo sequencialmente. Isso é **otimização** — a correção não depende dela: fora de ordem vira `PENDING_REFERENCE` (seção 8) e duplicata vira replay.

## 4. Idempotência

- **`Idempotency-Key` é obrigatório e é a fonte da verdade** (padrão recomendado `{providerId}:{externalTransactionId}`; não é imposto). Na fila, vem em `data.idempotencyKey`.
- **Persistente**: `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` em `wager_transactions`. Não existe cache em memória.
- **`payloadHash`** = SHA-256 (hex minúsculo) do **JSON canônico** do subconjunto de negócio: `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money{amount,currency}, referenceExternalTransactionId`. JSON canônico = chaves ordenadas lexicograficamente em todos os níveis, sem espaços, membros `undefined` omitidos, `amount` já normalizado (`"25"` ≡ `"25.00"`). Header, `messageId`, `occurredAt` e demais metadados de transporte **não** entram (`application/payload-hash.ts`).
- **Mesma key + mesmo hash** → replay: devolve **a resposta original**, incluindo o saldo observado naquele momento (persistido em `result_balance`) e o mesmo código HTTP, com `idempotentReplay: true`.
- **Mesma key + hash diferente** → `409 IDEMPOTENCY_KEY_CONFLICT` (nunca replay). Mesmo `(provider, externalTransactionId)` com outra key → `409 EXTERNAL_TRANSACTION_CONFLICT`.
- Uma transação `PENDING_REFERENCE` replayada devolve o **estado atual** (que pode já ser final).
- **Inbox** (SQS): `(consumer_name, message_id)` é PK; o insert `ON CONFLICT DO NOTHING` acontece **dentro** da transação financeira. Duas entregas simultâneas da mesma mensagem: a segunda espera no índice único até o commit da primeira e então vê o conflito → duplicata (ack). Se a primeira der rollback, a segunda processa. Mesmo `messageId` com payload diferente → DLQ.

## 5. Garantias no schema

Migration: `src/infrastructure/persistence/migrations/Migration20261114000001_initial_schema.ts` (com `down`, testada em `schema.test.ts`).

| Garantia | Mecanismo no PostgreSQL |
|---|---|
| uma wallet por `(player, moeda)` | `UNIQUE (player_id, currency)` |
| saldo nunca negativo | `CHECK (balance >= 0)` em `wallets`; `CHECK (balance_before/after >= 0)` no ledger |
| dinheiro exato | `numeric(20,2)`; `CHECK (amount > 0)` |
| idempotência | `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)` |
| ≤ 1 lançamento por transação/wallet | `UNIQUE (transaction_id, wallet_id)` |
| lançamento aritmeticamente fechado | `CHECK (CREDIT: after = before + amount / DEBIT: after = before − amount)` |
| ledger encadeado | `UNIQUE (wallet_id, wallet_version)` + trigger `BEFORE INSERT`: `balance_before` = `balance_after` do lançamento anterior; moeda = moeda da wallet |
| **saldo == ledger** | `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` em `wallets`: no COMMIT, saldo e versão da wallet = cabeça da cadeia do ledger (ou 0/v1 sem lançamentos) |
| `version` só muda com o saldo, sempre +1 | trigger `BEFORE UPDATE` em `wallets` (identidade também imutável) |
| ledger imutável | triggers rejeitam `UPDATE`, `DELETE` e `TRUNCATE` |
| reversão única | `UNIQUE INDEX (reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK') AND status='PROCESSED'` |
| estados terminais finais | trigger: transação `PROCESSED/REJECTED/FAILED` não pode ser alterada; colunas de negócio são write-once; `DELETE` proibido |
| coerência de estado | `CHECKs`: `failure_code` ⇔ `REJECTED/FAILED`; `processed_at` ⇔ `PROCESSED`; `next_reference_check_at` ⇔ `PENDING_REFERENCE`; `REFUND/ROLLBACK` exigem referência; `OPENING` ⇔ provider `internal` |
| dedup de inbox | `PRIMARY KEY (consumer_name, message_id)` |
| evento imutável | trigger: `payload/event_type/aggregate_id/occurred_at` da outbox não mudam; `published_at` é write-once |

Índices parciais atendem os workers: `outbox_messages(next_attempt_at, sequence) WHERE published_at IS NULL`, `wager_transactions(next_reference_check_at) WHERE status='PENDING_REFERENCE'`, `(provider_id, reference_external_transaction_id) WHERE status='PENDING_REFERENCE'`.

`wallet_version` no lançamento é uma adaptação do modelo da seção 6.4: liga cada lançamento à versão da wallet que ele produziu, o que permite as checagens de cadeia e coerência acima. O cursor do ledger usa `sequence` (identity monotônica), então páginas já servidas não "andam".

## 6. Regras de negócio e interpretações adotadas

| Operação | Saldo | Ledger | Referência |
|---|---|---|---|
| `BET` | débito | 1 `DEBIT` | não aceita |
| `WIN` | crédito | 1 `CREDIT` | opcional, deve ser `BET` |
| `LOSS` | — | nenhum | opcional, deve ser `BET` |
| `REFUND` | crédito | 1 `CREDIT` | obrigatória, só `BET` |
| `ROLLBACK` | inverso da referência | 1 invertido | obrigatória: `BET`, `WIN` ou `REFUND` |

Interpretações (o enunciado pede que sejam documentadas):

1. **Uma transação só pode ser revertida uma vez, por qualquer tipo.** A regra 4 fala em "mesmo tipo", mas `REFUND` + `ROLLBACK` da mesma `BET` creditaria duas vezes; adotei a regra mais forte, que implica a pedida. Enforced pelo índice único parcial.
2. `ROLLBACK` de um `REFUND` é permitido (desfaz o estorno → débito). `ROLLBACK` de `ROLLBACK`/`LOSS`/`OPENING` não.
3. A referência de `WIN`/`LOSS` é opcional; quando presente, segue as mesmas validações (mesmo provider/player/wallet/moeda/rodada) e o mesmo fluxo de `PENDING_REFERENCE`.
4. Referência existente porém ainda `PENDING_REFERENCE` → a dependente também espera. Referência `REJECTED`/`FAILED` → `REFERENCE_NOT_PROCESSED`.
5. **Wallet inexistente** não é persistida (não há wallet para a FK): HTTP `404 WALLET_NOT_FOUND`; na fila é erro de negócio terminal (ack, logado). **Player diferente do dono da wallet** é persistido como `REJECTED/WALLET_PLAYER_MISMATCH` (auditável).
6. `OPENING` só é criado internamente (`POST /wallets`), com provider reservado `internal`, que a API e a fila rejeitam.
7. Wallet aberta com saldo positivo: a transação `OPENING` + `CREDIT` são a própria versão 1 (versão "inicia em 1 após a criação"). Aberta com zero: versão 1 sem lançamento; o primeiro movimento gera a versão 2.
8. `REJECTED` nunca gera lançamento nem altera saldo/versão; o saldo observado é guardado para o replay.
9. Valor da reversão deve ser igual ao da referência (`REFERENCE_AMOUNT_MISMATCH`); parcial fora de escopo.

## 7. Máquina de estados e taxonomia de falhas

```
            ┌───────────────► PROCESSED  (terminal)
PENDING ────┼───────────────► REJECTED   (terminal)
 (memória)  ├───────────────► FAILED     (terminal)
            └─► PENDING_REFERENCE ──┬──► PROCESSED | REJECTED | FAILED
                     ▲              │
                     └── retry ─────┘
```

`PENDING` existe apenas em memória: a transação é decidida na mesma transação SQL em que nasce, então nunca é persistida nesse estado. Transicionar um estado terminal lança `InvalidTransactionStateError` (erro de programação), e o banco também recusa.

**`failureCode`** (estáveis, só se adicionam valores):

| Código | Significado | Ação do provedor |
|---|---|---|
| `INSUFFICIENT_FUNDS` | aposta sem saldo | decisão final |
| `REVERSAL_INSUFFICIENT_FUNDS` | reversão que deixaria saldo negativo (≠ aposta sem saldo, seção 7.9) | decisão final; operação manual |
| `CURRENCY_MISMATCH` | moeda ≠ moeda da wallet | corrigir payload, nova transação |
| `WALLET_PLAYER_MISMATCH` | player não é dono da wallet | corrigir payload |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro do orçamento de tentativas | reenviar a referência e depois uma nova reversão |
| `REFERENCE_MISMATCH` | referência de outro player/wallet/moeda/rodada | corrigir payload |
| `REFERENCE_KIND_NOT_ALLOWED` | ex.: `REFUND` de `WIN` | corrigir payload |
| `REFERENCE_NOT_PROCESSED` | referência terminou `REJECTED`/`FAILED` | nada a reverter |
| `REFERENCE_ALREADY_REVERSED` | já revertida | decisão final |
| `REFERENCE_AMOUNT_MISMATCH` | valor ≠ valor da referência | corrigir payload |
| `PROCESSING_ERROR` (`FAILED`) | erro permanente inesperado no worker de pendências | auditoria/suporte |

Erros que **não** viram transação persistida usam `error.code`: `INVALID_PAYLOAD` (400), `WALLET_NOT_FOUND`/`TRANSACTION_NOT_FOUND` (404), `IDEMPOTENCY_KEY_CONFLICT`/`EXTERNAL_TRANSACTION_CONFLICT`/`WALLET_ALREADY_EXISTS` (409), `TEMPORARILY_UNAVAILABLE` (503, `retryable: true`).

## 8. Referências fora de ordem

- Referência ausente → transação persistida como `PENDING_REFERENCE` com `next_reference_check_at`, evento `WagerTransactionPendingReference`, HTTP `202`.
- **Worker agendado** (`PendingReferenceWorker`, em toda instância): `UPDATE … WHERE id IN (SELECT … WHERE status='PENDING_REFERENCE' AND next_reference_check_at <= now() ORDER BY … LIMIT n FOR UPDATE SKIP LOCKED) RETURNING id` — o claim empurra `next_reference_check_at` +30 s como *lease*, então instâncias não disputam o mesmo item. Cada item é processado na sua própria transação, sob o lock da wallet, pelo **mesmo** `WagerProcessor` do caminho online.
- **Relógio único: o do banco.** O claim ("está vencido?"), o lease e o wake-up usam `now()` do PostgreSQL — como a outbox —, então instâncias com relógios divergentes concordam sobre o que está vencido (teste `scheduling-clock`). O horário do próximo retry é calculado a partir do relógio da aplicação; um desvio entre relógios só desloca esse backoff pelo tamanho do desvio, nunca causa processamento duplicado.
- **Backoff exponencial com jitter** ("equal jitter": 50–100% do valor exponencial), base 2 s, teto 5 min.
- **Limite: 10 reprocessamentos** (`PENDING_REFERENCE_MAX_ATTEMPTS`). Janela nominal ≈ 2+4+8+…+256+300+300 s ≈ 18,5 min (9–18,5 min com jitter). Justificativa: provedores reenviam a operação original em segundos/minutos; passar de ~15 min esperando uma `BET` significa que ela não existe do lado de cá e segurar a reversão só atrasa a decisão. Esgotado → `REJECTED/REFERENCE_NOT_FOUND` + `WagerTransactionRejected`.
- **Wake-up**: quando qualquer transação termina, as pendentes que a referenciam têm `next_reference_check_at` antecipado para `now()`, na mesma transação — a reversão é aplicada no próximo ciclo do worker (~1 s) em vez de esperar o backoff.

## 9. Consumidor SQS

Fila `wager-transactions.fifo`, DLQ `wager-transactions-dlq.fifo`, eventos em `wagering-events.fifo`.

- Long polling **em pipeline**: os pollers continuam recebendo enquanto mensagens anteriores ainda estão em processamento, até `CONSUMER_CONCURRENCY` mensagens em voo (slots reservados antes de cada `ReceiveMessage`). Uma mensagem lenta — por exemplo, presa no lock de uma wallet quente — não segura o próximo recebimento (teste `consumer-pipelining`, que falha contra a versão anterior por lote).
- Mensagens do mesmo `MessageGroupId` (= wallet) em sequência: dentro do lote pelo consumidor, entre lotes pelo próprio SQS FIFO (que não entrega a próxima mensagem de um grupo enquanto outra dele está em voo). Grupos diferentes em paralelo.
- **Ack (DeleteMessage) só após o commit.** O inbox está dentro da transação financeira: morrer antes do commit → rollback de tudo, a mensagem volta; morrer depois do commit e antes do ack → a mensagem volta, o inbox detecta e só faz ack (teste `crash-recovery`: processo com `FAULT_INJECTION=crash-after-commit` sai com 137 entre commit e ack).

| Resultado | Classe | Ação |
|---|---|---|
| `PROCESSED` / `REJECTED` / `PENDING_REFERENCE` / replay / duplicata de inbox | negócio (terminal) | ack |
| `WALLET_NOT_FOUND` | negócio (terminal) | ack |
| JSON inválido, schema inválido, `OPENING`, conflito de idempotência/inbox, violação de integridade | permanente | envia para a DLQ (com atributos `reason`/`errorCode`) e apaga |
| lock timeout, deadlock, banco/broker indisponível, erro inesperado | transitório | `ChangeMessageVisibility` com backoff `2s·2^(n−1)` (teto 15 min) |
| transitório com `ApproximateReceiveCount ≥ CONSUMER_MAX_ATTEMPTS` (5) | esgotado | DLQ (`reason=max-attempts`) |

A `RedrivePolicy` da fila (`maxReceiveCount = max+1`) é rede de segurança caso o próprio consumidor falhe em mover. Envio à DLQ é "send, depois delete": um crash no meio só duplica a entrada na DLQ.

- **SIGTERM**: para de buscar (aborta o long poll), conclui as mensagens em andamento, devolve as ainda não iniciadas com visibilidade 0, depois para os workers e fecha banco/SQS; sai com 0 (teste de drain). Um guard derruba o processo se exceder o grace period.

## 10. Transactional Outbox

Eventos são gravados em `outbox_messages` **na mesma transação** da mudança financeira (a atomicidade é testada sabotando o insert da outbox com um trigger: nada da unidade sobrevive). Nada é publicado antes do commit, porque a publicação só lê linhas commitadas.

Publisher (em toda instância):

1. **claim** (transação curta): `UPDATE … SET locked_by, locked_until = now()+lease WHERE id IN (SELECT … WHERE published_at IS NULL AND next_attempt_at <= now() AND (locked_until IS NULL OR locked_until < now()) ORDER BY … LIMIT n FOR UPDATE SKIP LOCKED) RETURNING …` — publishers concorrentes pegam conjuntos disjuntos; o lease usa o relógio do banco (sem skew entre instâncias);
2. **send** sem transação aberta (`SendMessageBatch`, `MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId`);
3. **mark** (transação curta): `published_at = now()`; falhas → `attempts++`, `next_attempt_at` com backoff exponencial (1 s … 5 min), `last_error`. **Nunca descarta** um evento.

Cenário do enunciado: commit → processo morre antes de publicar → o lease expira → outra instância reclama e publica (teste `outbox.test.ts`). Morrer **depois** do send e antes do mark → republicação: o FIFO deduplica pela janela de 5 min e, além dela, o consumidor deduplica por `eventId` (at-least-once).

Trade-off: a ordem global de publicação por agregado não é garantida entre publishers concorrentes; consumidores devem usar `walletVersion` (em `WalletBalanceChanged`) para ordenar e descartar eventos antigos.

## 11. Observabilidade

- **Logs JSON (pino)** com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` injetados automaticamente via `AsyncLocalStorage` (mixin), mais `instanceId`. `correlationId` vem de `X-Correlation-Id` (ou é gerado e devolvido no header) / do envelope SQS. **Redação** de `money`, `amount`, `balance*`, `payload` e `authorization` — nada de valores financeiros ou payloads completos nos logs; só identificadores, status e `failureCode`.
- **Métricas Prometheus** (`GET /metrics`, registry por instância):

| Métrica | Cobre |
|---|---|
| `wagering_transactions_total{status,kind,source,failure_code}` | transações por status |
| `wagering_duplicates_detected_total{kind}` | replays de idempotência, duplicatas de inbox, republicações de outbox |
| `wagering_retries_total{component,reason}` | retries (sqs, outbox, pending-reference, unit-of-work) |
| `wagering_dlq_messages_total{reason}`, `wagering_dlq_depth` | mensagens em DLQ |
| `wagering_lock_conflicts_total{reason}` | lock timeout, deadlock, serialização, version guard, corrida de unique |
| `wagering_wallet_admission_total{outcome}` | bulkhead por wallet: `immediate`, `queued` (esperou a vez da wallet), `rejected` (wallet ocupada → 503) |
| `wagering_outbox_lag_seconds`, `wagering_outbox_pending`, `wagering_outbox_publish_delay_seconds` | outbox lag |
| `wagering_processing_duration_seconds{source}` | latência de processamento |
| `wagering_reconciliation_mismatches_total` | divergências saldo × ledger |
| `wagering_sqs_messages_total{result}`, `wagering_outbox_published_total{event_type}` | throughput |

- **Health**: `/health/live` (processo responde, sem dependências) e `/health/ready` (`SELECT 1` + `GetQueueAttributes`, timeout 2 s, `503` se algum falhar). Ambos públicos.

## 12. Autenticação

**Não implementada nesta entrega** — conforme a seção 2, não vale pontos e o timebox foi para correção financeira, concorrência e mensageria. O ponto de extensão está explícito em `src/interface/http/auth.ts`:

- `AuthGuard` global com a porta `Authenticator` (binding atual: `NoopAuthenticator`, identidade anônima irrestrita); rotas `@Public()` (health, metrics) passam direto.
- `assertActsFor(identity, providerId)` já é aplicado no `POST /wagering/transactions`: quando a identidade tiver `providerId`, um provedor não pode submeter em nome de outro (`403`).

**Desenho que eu adotaria**: Keycloak (ou Zitadel) no Compose; cada provedor de jogo é um *confidential client* OIDC usando **client credentials**; a API valida o JWT (assinatura via JWKS em cache, `iss`, `aud`, `exp`) e mapeia uma claim `provider_id` para `ProviderIdentity`. Trocar `NoopAuthenticator` por um `JwtAuthenticator` é a única mudança. Mensagens da fila seguem como canal interno confiável, mas `providerId` continua sujeito às validações de domínio (wallet/player/referência do mesmo provider).

## 13. Teste de carga

`bun run test:load` (`scripts/load-test.ts`): loop fechado com `CONCURRENCY` clientes por `DURATION_S`; `WALLETS` wallets, `HOT_RATIO` das requisições na mesma wallet; mix 70% BET, 20% WIN, 5% LOSS, 5% replays. Ao final mede o tempo de drenagem da outbox e **reconcilia todas as wallets**.

**Ambiente**: uma única máquina (12 vCPU, 24 GB), tudo em Docker: 3 réplicas da app atrás de nginx, PostgreSQL 16, LocalStack 3.8; o gerador de carga roda na mesma máquina (compete por CPU — os números são conservadores e **não** representam um ambiente de produção).

Resultados com o bulkhead por wallet e o consumidor em pipeline (versão atual):

| Cenário | Throughput | p50 | p95 | p99 | Erros | Lock conflicts | Drain da outbox | Reconciliação |
|---|---|---|---|---|---|---|---|---|
| 200 wallets, 10% hot, 32 clientes, 20 s | **679 req/s** | 22.8 ms | 263 ms | 418 ms | 0% | 0 | 1.0 s | 200/200 ok |
| 50 wallets, **90% hot**, 64 clientes, 15 s | **183 req/s** | 391 ms | 575 ms | 920 ms | 0% | 0 | 3.0 s | 50/50 ok |

Antes do bulkhead, os mesmos cenários deram 606 req/s (p99 633 ms) e 205 req/s (p99 805 ms). No cenário misto o ganho é real: as requisições das wallets comuns deixaram de esperar atrás da wallet quente (p99 −34%). No cenário 90% quente o throughput fica no mesmo teto — limitado pelo lock da linha, como esperado; a diferença está dentro da variação entre execuções numa máquina compartilhada.

**Análise honesta**

- A hot wallet é o limite: com lock por linha, as escritas em uma wallet são **serializadas**; o teto é ≈ 1 / (tempo de lock segurado) ≈ 200 tx/s nesta máquina (~5 ms por transação: 6–8 round-trips + commit com triggers). As requisições excedentes esperam a vez da wallet — em memória, graças ao bulkhead, sem prender conexões — por isso o p50 sobe para centenas de ms sem erros e sem afetar as outras wallets. Isso é uma propriedade escolhida (correção > throughput por wallet), não um bug. Se for preciso mais: reduzir round-trips (stored procedure ou CTE única), `synchronous_commit` por sessão para caminhos não financeiros, ou *sub-wallets*/saldo particionado.
- 0 lock conflicts: com `lock_timeout` de 5 s nenhuma espera estourou; abaixando o timeout eles apareceriam como `503` retentáveis (testado em `sqs-consumer.test.ts`).
- O p99 no cenário distribuído é dominado por espera atrás das requisições "hot" (10%) e pelo gerador co-localizado.
- O contador de conflitos/replays é lido de uma instância via gateway (as métricas são por instância); em produção agrega-se no Prometheus.

## 14. Limitações e próximos passos

- **Autenticação** não implementada (seção 12).
- Ledger de **partidas dobradas** não implementado (opcional): o ledger é de entrada simples por wallet; a contrapartida da casa poderia ser uma wallet "house" por provedor/moeda, com os dois lançamentos na mesma transação.
- **Retenção** de `inbox_messages`/`outbox_messages` publicados (job de limpeza por idade) não incluída — a janela da inbox deve ser maior que o máximo de redelivery possível.
- Visibilidade de mensagens SQS não é estendida durante o processamento (o processamento leva ms; com visibilidade de 30 s não é necessário). Para cargas lentas, um *heartbeat* de `ChangeMessageVisibility`.
- O evento de transação `FAILED` não é publicado (fica auditável na tabela e nas métricas).
- Ordem de publicação por agregado não é estrita entre publishers (seção 10).
- `FAULT_INJECTION` existe apenas para os testes de crash (desligado por padrão) — em produção eu restringiria a builds de teste.
- OpenTelemetry/dashboard não incluídos (opcionais); os logs já carregam os IDs de correlação para o tracing ser adicionado depois.
