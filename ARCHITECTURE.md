# ARCHITECTURE

Registro de decisões, atualizado a cada etapa.

## Regras permanentes

- Bun + TypeScript strict + NestJS + MikroORM + PostgreSQL + SQS (LocalStack).
- Domínio puro (`src/domain`): sem decorators do Nest, sem tipos do ORM.
- Construtores privados + factories `create`/`rehydrate`.
- Invariantes (unicidade, imutabilidade, saldo >= 0) no schema do banco.
- Idempotência persistente (nunca cache em memória); sem lock global.
- Rejeição de negócio é commitada (não faz rollback).
- Os testes financeiros de integração verificam `wallet.balance == saldo reconstruído do ledger`; testes de schema e de unidade verificam invariantes específicos.

## ADR-001 — Money

- Representação interna: `bigint` em centavos. Sem `number`/float e sem dependência externa (Decimal.js) — aritmética inteira é exata e o escopo é escala fixa 2.
- Entrada/saída: string decimal com escala 2 (`"25.00"`). Aceita `"25"` e `"25.5"` (normalizados); rejeita vazio, `NaN`, `Infinity`, notação científica, sinal `+`, mais de 2 casas, separador `,`.
- `Money.from` rejeita negativos (contratos de entrada). `Money.fromSigned` existe apenas para reidratação/valores derivados (ex.: diferença de reconciliação).
- Moeda: ISO-4217 em 3 letras maiúsculas; o modelo é multi-moeda, mas o desafio usa `BRL`. Operações entre moedas distintas lançam `CurrencyMismatchError`.
- Persistência: `MoneyAmountType` (`src/infrastructure/persistence/money-amount.type.ts`) é um custom type do MikroORM mapeando `NUMERIC(20,2)` ⇄ string decimal exata. Fica na infra, mantendo o domínio puro. A moeda vai em coluna `CHAR(3)` separada (permitido pelo README); o mapper infra→domínio combina as duas colunas em `Money`. Um custom type de coluna única não enxerga a coluna irmã, então ele não instancia `Money` diretamente. Recusa `number` na escrita e na leitura.
- Arredondamento: nunca é feito. Mais de 2 casas é rejeitado (inclusive zeros à direita, ex.: `1.000`), para o provedor não depender de uma regra de arredondamento implícita.
- O banco aplica `CHECK (balance >= 0)`; os mappers SQL também rejeitam `number` e decimais inválidos ou com mais de duas casas.

## ADR-002 — Estrutura, camadas e autenticação

- Camadas em `src/`: `domain` (puro) · `application` (casos de uso e portas) · `infrastructure` (MikroORM, SQS, config, adapters) · `interfaces` (HTTP/Nest). Dependências apontam para dentro; ESLint (`no-restricted-imports`) proíbe `domain` de importar Nest/MikroORM/outras camadas e `application` de importar infra/interfaces.
- Autenticação: fora do escopo de pontuação. `ProviderIdentityPort` (application) + `NoopProviderIdentityAdapter` (infra) + `AuthGuard` global (interfaces). Para OIDC (Keycloak/Zitadel), o adapter deve validar JWT e também é necessário implementar autorização por recurso; o guard atual apenas verifica que existe uma identidade. Rotas `@Public()` (health e métricas) não passam pelo guard.
- Migrations: MikroORM Migrator com `migrationsList` explícita (sem glob, funciona em Bun/Docker), transacionais e reversíveis (`bun run migrate`, `migrate:down`). A baseline cria `forbid_mutation()`, trigger reutilizável que tornará o ledger append-only no banco.
- Filas: `wager-transactions.fifo` e a DLQ são criadas por `docker/localstack/init-queues.sh` (hook `ready.d`), com redrive após 5 recebimentos. O healthcheck do LocalStack só passa quando a fila existe.
- TypeScript fixado em `~5.9` porque `typescript-eslint` ainda não suporta TS 7.
- MikroORM foi escolhido por seu `EntityManager.fork().transactional`, migrator e custom types; cada unidade de trabalho tem contexto isolado. SQL parametrizado explícito nas operações de concorrência permite `ON CONFLICT`, locks e `SKIP LOCKED` precisos, sem depender de lazy loading. Alternativas com query builder ou outro ORM seriam viáveis, mas manteriam as mesmas transações e constraints.
- Scripts: `dev`, `test` (unit + e2e), `test:integration` (PostgreSQL real), `migrate`, `lint`, `typecheck`.

## ADR-003 — Wallet e WalletLedgerEntry

- `WalletLedgerEntry` é imutável de forma estrutural: só campos `readonly`, `Object.freeze` e nenhum método de transição. `create` valida moeda única, valor > 0, saldos >= 0 e `balanceBefore ± money == balanceAfter`; `rehydrate` não revalida.
- `Wallet.debit/credit` constroem e validam o lançamento **antes** de tocar no estado: qualquer falha (moeda, valor <= 0, saldo insuficiente) deixa saldo, `version` e `updatedAt` intactos. Sucesso sempre muda o saldo, então `version` incrementa exatamente +1 por movimento.
- Valor zero ou negativo em debit/credit é erro (`INVALID_AMOUNT`). `LOSS` não chama a wallet (não afeta saldo).
- `InsufficientFundsError` é único no domínio; o caso de uso escolhe o `failureCode` (aposta sem saldo vs. reversão que ficaria negativa, regra 7.9) conforme o `kind` da transação.
- Abertura: `Wallet.open` já nasce com o saldo inicial e `version = 1`; `openingEntry()` gera o `CREDIT` (de 0.00 ao saldo inicial) da transação interna `OPENING`, sem alterar a wallet. Sem lançamento se o saldo inicial for zero.
- O domínio não gera ids nem lê o relógio nos movimentos: `entryId`, `transactionId` e `at` vêm do chamador (determinismo nos testes).
- A defesa final contra saldo negativo e lost update continua no banco (`CHECK (balance >= 0)` + controle de concorrência, etapas 3–4); o agregado é a primeira barreira.

## ADR-004 — WagerTransaction, taxonomia de falhas e regras (seção 7)

**Máquina de estados** (`PROCESSED`, `REJECTED`, `FAILED` são terminais; transicionar é `InvalidTransactionStateError`, erro de programação):
- `PENDING → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE`
- `PENDING_REFERENCE → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE` (retry do worker com a referência ainda ausente)
- `reject()` só aceita códigos de negócio; `fail()` só códigos de infraestrutura.

**Taxonomia de `failureCode`** (estável, legível por máquina) + `failureAdvice()` para o provedor. Resultado terminal é reenviado como replay para a mesma idempotency key, então "reenviar" sempre significa **nova** `externalTransactionId`.

| Código | Tipo | Quando | Orientação |
|---|---|---|---|
| `INSUFFICIENT_FUNDS` | negócio | BET maior que o saldo | RESUBMIT_LATER |
| `REVERSAL_WOULD_OVERDRAW` | negócio | ROLLBACK de crédito deixaria saldo negativo (regra 7.9) | RESUBMIT_LATER |
| `REFERENCE_NOT_FOUND` | negócio | referência não chegou (retries/TTL esgotados) | ABANDON |
| `REFERENCE_MISMATCH` | negócio | referência de outro provider/player/wallet/moeda/rodada | CORRECT_AND_RESUBMIT |
| `INVALID_REFERENCE_KIND` | negócio | REFUND de não-BET; ROLLBACK de LOSS/ROLLBACK | CORRECT_AND_RESUBMIT |
| `REFERENCE_NOT_PROCESSED` | negócio | referência `REJECTED`/`FAILED` | ABANDON |
| `ALREADY_REVERSED` | negócio | referência já revertida | ABANDON |
| `AMOUNT_MISMATCH` | negócio | valor ≠ valor da referência | CORRECT_AND_RESUBMIT |
| `CURRENCY_MISMATCH` | negócio | moeda ≠ moeda da wallet | CORRECT_AND_RESUBMIT |
| `WALLET_PLAYER_MISMATCH` | negócio | `playerId` não é dono da wallet | CORRECT_AND_RESUBMIT |
| `INTERNAL_ERROR`, `RETRIES_EXHAUSTED` | infra (`FAILED`) | erro permanente de infraestrutura | RESUBMIT_LATER / ABANDON |

Payload malformado (valor inválido, campo vazio, kind desconhecido, `OPENING`, REFUND sem referência) **não** vira transação rejeitada: é `InvalidTransactionError` → 4xx na borda.

**Interpretações adotadas:**
- Uma referência só pode ser revertida **uma vez por qualquer reversão** (REFUND *ou* ROLLBACK), não "uma vez por tipo". A leitura literal da regra 4 permitiria REFUND + ROLLBACK da mesma BET e creditar duas vezes, o que viola o invariante global de não duplicar créditos.
- Referência existente mas ainda `PENDING`/`PENDING_REFERENCE` faz a reversão esperar (`PENDING_REFERENCE`), como se estivesse ausente; só `REJECTED`/`FAILED` rejeita com `REFERENCE_NOT_PROCESSED`.
- `REFUND` só referencia `BET`; `ROLLBACK` referencia `BET`, `WIN` ou `REFUND`. Direção do ROLLBACK é a inversa da referência (BET→crédito, WIN/REFUND→débito).
- `BET` não aceita referência. `WIN`/`LOSS` aceitam referência apenas informativa: não é resolvida nem bloqueia (README: "pode referenciar").
- Valor deve ser > 0, exceto `LOSS` (>= 0, não move saldo).
- Ordem das verificações de reversão: mismatch de contexto → tipo → status da referência → já revertida → valor → saldo.
- `OPENING` só nasce via `WagerTransaction.createOpening` (interno); `create` o rejeita e o domain service não o processa (usa `Wallet.openingEntry`).

**Hash do payload:** SHA-256 (hex) do JSON canônico (chaves ordenadas recursivamente, sem espaços, `undefined` omitido) apenas dos campos de negócio: `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money{amount,currency}, referenceExternalTransactionId`. O header `Idempotency-Key` e metadados de transporte ficam fora; `money` é normalizado via `Money` (`"25"` ≡ `"25.00"`). Calculado dentro de `WagerTransaction.create`, então não pode divergir dos campos.

**`WagerRulesService`** (domain service puro, sem I/O): recebe transação, wallet, referência resolvida e `referenceAlreadyReversed`; aplica as regras e devolve `PROCESSED(entry?) | REJECTED(code) | PENDING_REFERENCE`. O chamador (etapa 4) carrega wallet/referência sob o lock da wallet e persiste tudo, inclusive a rejeição, na mesma transação SQL (rejeição é commitada).

## ADR-005: Schema, constraints, triggers e índices (Etapa 4)

**Princípio:** o banco é a última linha de defesa; todo invariante crítico existe como constraint nomeada, e os testes de integração (`test/integration`, Postgres real, banco temporário por suíte) provam que cada uma bloqueia.

- **Migrations** versionadas (`migrations/Migration2026110600000N_*`), listadas explicitamente em `migrations/index.ts`, com `down` reversível (testado: up → down passo a passo até schema vazio → up).
- **wallets:** `UNIQUE(player_id, currency)`, `CHECK balance >= 0`, trigger que exige `version + 1` somente quando o saldo muda e identidade imutável; DELETE bloqueado.
- **wagering_transactions:** `UNIQUE(idempotency_key)`, `UNIQUE(provider_id, external_transaction_id)`, `balance_snapshot` (saldo pós-processamento, devolvido em replays), checks de status/failure_code/processed_at; trigger congela estados terminais e campos de negócio; DELETE bloqueado.
- **Reversão única:** índice parcial `(reference_transaction_id, kind) WHERE status='PROCESSED'` (pedido) **mais** `(reference_transaction_id) WHERE status='PROCESSED' AND kind IN ('REFUND','ROLLBACK')`, que impede REFUND + ROLLBACK da mesma referência (ver ADR-004).
- **wallet_ledger_entries:** `UNIQUE(wallet_id, transaction_id)`, `seq` identity (cursor estável), checks de valor > 0 e aritmética `before ± amount = after`; triggers bloqueiam UPDATE/DELETE/TRUNCATE (append-only).
- **inbox:** PK `(consumer_name, message_id)`. **outbox:** índice parcial de pendentes por `next_attempt_at` (`published_at IS NULL`).
- **Money:** `MoneyAmountType` mapeia `NUMERIC(20,2)` ⇄ string decimal; `number` é rejeitado.
- **Eficiência / N+1:** FKs são colunas escalares nos `EntitySchema` (sem `ManyToOne`, nada de lazy-load acidental); `loadStrategy: 'joined'` por padrão; leituras em lote com `$in`. Índices cobrem cada caminho quente (idempotência, provider+external, "quem espera esta referência", scan do worker, histórico por wallet, ledger por transação, keyset por `seq`, reconciliação index-only via `INCLUDE (direction, amount)`, claim do outbox). Testes usam `EXPLAIN` (com seqscan/bitmap desabilitados) e provam contagem de queries constante (N=5 vs 40).
- **Limitação:** superuser pode desabilitar triggers. Em produção, a aplicação deve usar um role sem `ALTER TABLE`/`DISABLE TRIGGER`.
- `outbox.next_attempt_at` é `NOT NULL DEFAULT now()`; na inserção pela aplicação, começa em `occurred_at`, usando o mesmo relógio dos eventos e do publisher. Retries recebem datas explícitas; relógios das instâncias da aplicação devem estar sincronizados.

## ADR-006: ProcessWagerTransaction, OpenWallet e mapeamento HTTP (Etapa 5)

**Fluxo (uma transação SQL, `MikroOrmUnitOfWork`):**
1. `INSERT ... ON CONFLICT DO NOTHING` da transação `PENDING` (unique de `idempotency_key` e de `provider_id + external_transaction_id`); o insert é um `INSERT ... SELECT FROM wallets`, então wallet inexistente vira no-op (sem erro de FK abortando a transação).
2. Insert sem efeito → carrega a existente: mesma key + mesmo `payloadHash` = **replay** (resultado original, `idempotentReplay: true`, saldo = snapshot gravado, não o saldo atual); payload diferente, ou mesmo `provider/external id` sob outra key = **409**; nada encontrado = wallet inexistente (**404**).
3. `SELECT ... FOR NO KEY UPDATE` da wallet (só ela é serializada; nenhum lock global).
4. Referência resolvida por `(provider, referenceExternalTransactionId)`, `isReversed` e `WagerRulesService` (domínio puro).
5. Resultado persistido: status/failureCode/snapshot da transação, ledger, `wallets.balance + version` (guarda `version = esperada`) e eventos na outbox; `COMMIT`. **Rejeição de negócio é um resultado, não exceção: é commitada** (linha `REJECTED` + evento). Exceção = rollback total.

**Por que `FOR NO KEY UPDATE` e não `FOR UPDATE`:** como o insert (passo 1) precede o lock (passo 3), cada transação concorrente já segura `FOR KEY SHARE` na wallet (FK). Duas delas pedindo `FOR UPDATE` se bloqueiam mutuamente → **deadlock** (observado nos testes com 50 requisições paralelas). `FOR NO KEY UPDATE` não conflita com `KEY SHARE` e é suficiente, pois a chave da wallet nunca muda.

**Outros pontos:** `lock_timeout` local (5s, `LOCK_TIMEOUT_MS`) transforma contenção excessiva em 503 retryável; ids UUIDv7 (`IdGenerator`), `Clock` injetável; eventos da outbox: `WagerTransactionProcessed` (inclusive LOSS), `WalletBalanceChanged` (só quando o saldo muda), `WagerTransactionRejected`, `WagerTransactionPendingReference`. `POST /wallets` cria wallet + `OPENING` (provider `SYSTEM`, key `opening:<walletId>`) + ledger `CREDIT` + eventos na mesma transação (saldo zero: só a wallet).

**Mapeamento HTTP (igual em todos os endpoints; erros sempre `{ "error": { "code", "message" } }`):**

| Situação | HTTP | Observação |
|---|---|---|
| Payload inválido (JSON, money, UUID, kind, OPENING, header `Idempotency-Key` ausente/vazio/>255) | **400** | nada persistido; não reenviar sem corrigir |
| Wallet inexistente | **404** | nada persistido |
| Mesma key com payload diferente; mesmo provider/external id com outra key | **409** `IDEMPOTENCY_CONFLICT` | não é replay |
| Wallet duplicada (`playerId + currency`) | **409** `WALLET_ALREADY_EXISTS` | |
| Rejeição de negócio (`REJECTED`) | **422** | corpo traz `failureCode` + `advice`; persistida, replay devolve o mesmo 422 |
| Referência ausente/pendente (`PENDING_REFERENCE`) | **202** | aceito, processamento pendente |
| Aplicada (`PROCESSED`) | **200** (`POST /wallets`: **201**) | `balance` = saldo após a transação |
| Falha transitória (conexão, deadlock, serialização, lock timeout) | **503** + `Retry-After: 1` | nada foi commitado; reenviar a MESMA key é seguro |
| `FAILED` terminal reproduzido / erro inesperado | **500** | |

Replay mantém o status do resultado original (200/202/422) com `idempotentReplay: true`.

**Referências fora de ordem:** a decisão inicial olha apenas referências já commitadas; o worker descrito na ADR-007 trata a chegada posterior.

## ADR-007: Reprocessamento de referências pendentes

- O processamento inicial e os retries compartilham `WagerRulesService` e a mesma aplicação de saldo, ledger, versão e outbox. A referência é procurada por `(providerId, referenceExternalTransactionId)`; referência de outro provedor não é usada.
- A migration adiciona contagem e próximo horário persistidos e um índice parcial para buscar pendências vencidas. Linhas pendentes anteriores à migration ficam elegíveis imediatamente. Cada tentativa é uma transação SQL separada: `FOR NO KEY UPDATE SKIP LOCKED` na pendência, lock da wallet, regras e persistência atômica. O lock mais fraco é compatível com os `KEY SHARE` das FKs; workers concorrentes não processam a mesma linha simultaneamente.
- O scheduler roda a cada segundo, com até 20 transações por ciclo, sem sobreposição no mesmo processo, e aguarda trabalho em andamento no encerramento. Falhas de infraestrutura causam rollback, são registradas e a linha continua elegível para nova tentativa.
- Primeira tentativa após 1 segundo; depois intervalos de 2, 4, 8, 16, 32, 64 e 128 segundos. No máximo **8 tentativas** ou **5 minutos** desde a criação: em condições normais o limite é atingido após 255 segundos; o TTL limita pendências quando há atrasos do worker. São valores operacionais conservadores para absorver reordenação breve sem manter pendências indefinidamente, não uma garantia de entrega do provedor.
- Em cada tentativa as regras são executadas antes de verificar o limite: se a referência já estiver disponível, ela é processada mesmo após atraso do worker; se continuar ausente ou pendente ao esgotar o prazo/tentativas, a transação vira `REJECTED` com `REFERENCE_NOT_FOUND` e evento `WagerTransactionRejected`, no mesmo commit. Retries que continuam pendentes não repetem o evento inicial.
- A unicidade existente impede duas reversões de uma mesma referência por qualquer combinação de REFUND e ROLLBACK. Um replay consulta o estado atualmente persistido, que pode ter evoluído de `PENDING_REFERENCE` para terminal.

## ADR-008: Publicação da outbox no SQS

- Os quatro eventos versionados já são serializados com `MoneyProps` e gravados na transação financeira. A fila de saída `wager-events.fifo` é separada da fila de entrada `wager-transactions.fifo`; configurar `SQS_EVENTS_QUEUE_URL` também fora do Docker Compose.
- Cada publicação reserva uma mensagem vencida com `FOR UPDATE SKIP LOCKED`, envia ao SQS mantendo a transação aberta e só depois marca `published_at` e commita. Múltiplas instâncias trabalham em paralelo; uma falha no banco ou morte do processo libera o lock e deixa o registro elegível novamente. O scheduler tenta até 20 registros por ciclo de um segundo, sem ciclos simultâneos na mesma instância, e aguarda o trabalho em andamento no encerramento.
- Falhas de envio são registradas e persistem `attempts` e `next_attempt_at` com backoff exponencial (1 s inicial, teto 5 min, sem limite de tentativas). Falhas ao gravar esse estado ou ao confirmar publicação propagam e revertem a transação. O envio usa timeout de 20 s e uma tentativa por chamada do SDK.
- O `eventId` persistido é `MessageDeduplicationId` e `aggregateId` é `MessageGroupId`. SQS FIFO deduplica dentro da janela de cinco minutos, mas **não garante exactly-once de ponta a ponta**: queda após envio e antes do commit, timeout ambíguo ou reentrega após a janela podem produzir duplicatas. Consumidores de eventos de saída precisam de inbox persistente e idempotência por `eventId`; esses consumidores permanecem fora deste escopo.
- A fila FIFO preserva a ordem de chegada ao SQS por grupo, mas publishers concorrentes usando `SKIP LOCKED` não garantem que a ordem de envio seja a mesma dos commits para uma wallet. Consumidores não devem presumir ordenação por versão da wallet.

## ADR-009: Consumo SQS com inbox

- `WagerTransactionRequested` usa `messageId` da mensagem de aplicação, não o ID de transporte do SQS. A PK `(wager-transactions, messageId)` é inserida antes de executar o mesmo `ProcessWagerTransaction` da HTTP, dentro da mesma transação SQL; inbox, transação financeira, saldo, ledger e outbox são commitados juntos. A inbox guarda SHA-256 do JSON canônico do envelope completo; mesma ID e payload divergente é conflito permanente, nunca replay silencioso.
- Rejeições de negócio e `PENDING_REFERENCE` são resultados persistidos e recebem ack. Payload inválido, conflito de idempotência, wallet inexistente ou transação `FAILED` são erros permanentes; erros transitórios e inesperados são registrados separadamente. Em todos os erros não há ack e a visibilidade é reagendada com backoff exponencial (1 s, 2 s, 4 s, ... até 300 s).
- O redrive do SQS da fila de entrada encaminha mensagens não reconhecidas à DLQ após cinco recebimentos, inclusive falhas transitórias prolongadas. A configuração de produção precisa manter uma política equivalente e operadores devem inspecionar/reprocessar a DLQ. Não há envio manual à DLQ seguido de delete, evitando perda entre duas chamadas não atômicas.
- Ack (`DeleteMessage`) acontece somente após o commit. Falha de ack ou morte após commit causa redelivery, resolvida pela inbox; falha antes do commit reverte também a inbox. Se o resultado do commit for ambíguo, a reentrega com os mesmos IDs é segura.
- Na entrada, produtores devem usar `walletId` como `MessageGroupId`, mas isso é apenas otimização: a correção depende de constraints e lock SQL por wallet, não de FIFO ou do grupo. O consumidor renova visibilidade durante o processamento; `SIGTERM` interrompe o long polling e aguarda a mensagem em andamento antes de fechar o cliente. Uma terminação forçada permite redelivery quando a visibilidade expirar.

## Testes de concorrência e recuperação

Os testes de integração iniciam três processos independentes da aplicação Nest, com banco e filas reais isolados. Uma wallet bloqueada força as três requisições a disputar o mesmo registro no PostgreSQL; após liberar o lock, são verificados os resultados e a reconciliação. Outro cenário mata o serviço, envia uma mensagem durante a indisponibilidade, reinicia e verifica inbox, ledger, outbox e entrega no SQS. O teste de atomicidade injeta uma falha no segundo evento da outbox e compara wallet, ledger, transação, inbox e outbox antes e depois do rollback.

## ADR-010: Correlação, logs e métricas

- `X-Correlation-Id` válido é devolvido na resposta; sem header, um UUID é gerado. Para SQS, `correlationId` do envelope é preservado; se ausente, usa-se `messageId` (SHA-256 para IDs fora do formato aceito). O contexto assíncrono é isolado por requisição/mensagem. Os eventos têm o mesmo `correlationId`; nas mensagens, `causationId` é o `messageId`. As colunas `correlation_id` e `causation_id` preservam o contexto para retries agendados. Pendências anteriores à migration usam o ID da transação como fallback.
- `JsonLogger` escreve linhas JSON, com os identificadores disponíveis e sem serializar erros arbitrários, payloads, saldos ou valores. Logs de erro não contêm stacks ou detalhes do driver, pois estes podem incluir SQL e parâmetros; isso reduz a capacidade de diagnóstico e exige observabilidade adicional segura em produção.
- O registro `prom-client` é por processo. Status conta **transições commitadas**, inclusive abertura e retry; uma transação pode ser contada em `PENDING_REFERENCE` e depois no estado terminal. Duplicatas não aumentam o contador de status. Retries são tentativas, não necessariamente commits. `wager_dlq_messages` consulta o tamanho aproximado atual da DLQ, não o total histórico de redrives. `wager_outbox_oldest_unpublished_seconds` mede a idade do mais antigo pendente, inclusive itens ainda em backoff. Histograma mede duração de HTTP, consumo SQS e processamento HTTP de transação; não são percentis globais até agregação por Prometheus.
- `/metrics` consulta PostgreSQL e SQS no scrape; falhas são propagadas, não mascaradas como zero. Leituras não alteram o ledger. Acesso à rota pública deve ser restringido por rede em produção.
- Com `FOR NO KEY UPDATE`, uma hot wallet limita vazão por carteira e segura conexão durante a transação. Optimistic locking isolado exigiria retry da transação completa e pode aumentar colisões; lock global reduziria paralelismo entre carteiras; FIFO isolado não cobre concorrência HTTP, grupos diferentes nem redelivery. A versão otimista complementa o lock, não o substitui.

## Auditoria dos requisitos do README

Os caminhos abaixo são evidências específicas, não uma prova matemática contra todas as falhas possíveis. Os testes de integração usam PostgreSQL e LocalStack reais.

### Nove restrições invioláveis

| # | Requisito | Evidência |
|---|---|---|
| 1 | Sem `number`/float em dinheiro | `src/domain/shared/money.ts`, `src/infrastructure/persistence/money-amount.type.ts`, `src/infrastructure/persistence/decimal-text.ts`; `test/unit/money.test.ts`, `test/unit/infrastructure/decimal-text.test.ts`, `test/integration/money-mapping.integration.test.ts`. O teste de concorrência que usava `number` para calcular saldo foi corrigido para `bigint`. |
| 2 | Idempotência não depende de memória | `src/infrastructure/persistence/migrations/Migration20261106000003_wagering_transactions.ts`, `Migration20261106000005_inbox_outbox.ts`, `mikro-orm-unit-of-work.ts`; `test/integration/concurrency.integration.test.ts`, `sqs-consumer.integration.test.ts`. |
| 3 | Não confiar somente em FIFO | Unique constraints, inbox e lock em `src/infrastructure/persistence/mikro-orm-unit-of-work.ts`; teste “different group ID” em `test/integration/sqs-consumer.integration.test.ts` e concorrência HTTP em `concurrency.integration.test.ts`. |
| 4 | Sem publicação antes do commit financeiro | `src/application/wagering/process-wager-transaction.ts` e `open-wallet.ts` apenas enfileiram no mesmo UoW; `src/application/outbox/publish-outbox.ts` publica linhas posteriormente visíveis. `test/integration/outbox-commit.integration.test.ts` mantém a transação aberta e comprova que não há publicação antes do commit; `sqs-consumer.integration.test.ts` testa rollback por falha da outbox. |
| 5 | Ledger não é sobrescrito/excluído | `src/infrastructure/persistence/migrations/Migration20261106000004_wallet_ledger_entries.ts` bloqueia UPDATE, DELETE e TRUNCATE; `test/integration/schema-constraints.integration.test.ts` testa inclusive UPDATE sem alteração. |
| 6 | Sem lock global | `SqlWalletRepository.lockById` em `src/infrastructure/persistence/mikro-orm-unit-of-work.ts`; `test/integration/concurrency.integration.test.ts` cobre wallets distintas e hot wallet. |
| 7 | Sem read-calculate-update desprotegido | Lock `FOR NO KEY UPDATE` e guarda de versão em `mikro-orm-unit-of-work.ts`; `concurrency.integration.test.ts` testa disputa 100/80/80 e continuidade do ledger. |
| 8 | Múltiplas instâncias | Constraints e locks SQL, claims `SKIP LOCKED` em `mikro-orm-unit-of-work.ts` e `outbox-publisher-store.ts`; `test/integration/multiprocess-recovery.integration.test.ts` executa três processos e reinício. |
| 9 | Unicidade, imutabilidade e não-negatividade no schema | Migrations `20261106000002_wallets`, `20261106000003_wagering_transactions`, `20261106000004_wallet_ledger_entries`, `20261106000005_inbox_outbox`; `test/integration/schema-constraints.integration.test.ts` e `migrations.integration.test.ts`. |

### Falhas eliminatórias

| Falha | Evidência de prevenção |
|---|---|
| `number` para dinheiro | `Money`, `MoneyAmountType`, `decimalText` e testes citados no item 1; `Number` remanescente em `src` trata versão, contagens, configuração e métricas, não dinheiro. |
| Saldo negativo por race | Lock por wallet e `CHECK balance >= 0`; `test/integration/concurrency.integration.test.ts` e `schema-constraints.integration.test.ts`. |
| Débito/crédito duplicado | Unicidade de idempotência e ledger e índice parcial de reversão; testes de 50 envios e reversões concorrentes em `test/integration/concurrency.integration.test.ts`. |
| Idempotência só em memória | Constraints e inbox persistentes; testes de redelivery e concorrência citados no item 2. |
| Correção somente com uma instância | `test/integration/multiprocess-recovery.integration.test.ts` e publishers concorrentes em `outbox-publisher.integration.test.ts`. |
| Evento antes do commit | Outbox transacional e publisher separados; testes citados no item 4. |
| Ausência de ledger auditável | Migration do ledger append-only, `src/domain/wallet/wallet-ledger-entry.ts`, `test/integration/schema-constraints.integration.test.ts` e `wallet-queries.integration.test.ts`. |
| PostgreSQL e SQS completamente substituídos por mocks | `test/integration/support/test-database.ts` cria banco real; `test/integration/sqs-consumer.integration.test.ts` e `outbox-publisher.integration.test.ts` usam LocalStack. |

Busca por `UPDATE`/`DELETE`/`TRUNCATE` no ledger encontrou apenas tentativas deliberadas nos testes de constraints; o caminho de produção apenas insere. A única chamada de publicação está no worker da outbox, não na transação financeira. Falhas encontradas e corrigidas nesta auditoria: leitura SQL convertia valores arbitrários com `String` sem recusar `number`, teste financeiro usava `number`, e o e2e importava a configuração antes de definir seus defaults.

### Limitações conhecidas

- A atomicidade saldo/ledger é garantida pelo caminho transacional da aplicação, não por uma constraint cruzada que impeça um usuário SQL privilegiado de atualizar a wallet diretamente sem lançamento. Reconciliação detecta diferença, mas não impede nem corrige; em produção restrinja os privilégios, monitore divergências e considere uma API de escrita no banco ou constraint trigger diferido.
- O banco impede alterações em linhas de ledger, mas um administrador pode desabilitar triggers; o papel da aplicação não deve ter esse privilégio. Escritas SQL externas também podem contornar validações de domínio, incluindo compatibilidade de moeda.
- A reconciliação é pontual, compara soma e último saldo; não prova por si só a continuidade de toda a cadeia. Não há reparo automático nem sinalização persistida.
- O publisher oferece entrega pelo menos uma vez, não exactly-once nem ordenação de commit por wallet entre publishers; consumidores precisam de inbox própria. Publicação mantém uma transação aberta durante I/O de rede.
- O estado `FAILED` e seus códigos existem no modelo, mas erros de infraestrutura atuais fazem rollback ou seguem à DLQ, em vez de criar automaticamente uma transação `FAILED` terminal.
- A autenticação **não está implementada**: `NoopProviderIdentityAdapter` aceita qualquer requisição, sem autorização por wallet/provider. Para produção, implementar validação OIDC/JWT, identidade e autorização de recurso, além de proteger métricas; apenas trocar o adapter sem autorização adicional não é suficiente.
- Readiness verifica Postgres e filas de entrada/saída, não a DLQ; métricas dependem da DLQ e falham no scrape se ela não estiver acessível. Métricas são reiniciadas por processo e a contagem da DLQ é aproximada.
