# ARCHITECTURE

Registro de decisões, atualizado a cada etapa.

## Regras permanentes

- Bun + TypeScript strict + NestJS + MikroORM + PostgreSQL + SQS (LocalStack).
- Domínio puro (`src/domain`): sem decorators do Nest, sem tipos do ORM.
- Construtores privados + factories `create`/`rehydrate`.
- Invariantes (unicidade, imutabilidade, saldo >= 0) no schema do banco.
- Idempotência persistente (nunca cache em memória); sem lock global.
- Rejeição de negócio é commitada (não faz rollback).
- Todo teste termina checando `wallet.balance == saldo reconstruído do ledger`.

## ADR-001 — Money

- Representação interna: `bigint` em centavos. Sem `number`/float e sem dependência externa (Decimal.js) — aritmética inteira é exata e o escopo é escala fixa 2.
- Entrada/saída: string decimal com escala 2 (`"25.00"`). Aceita `"25"` e `"25.5"` (normalizados); rejeita vazio, `NaN`, `Infinity`, notação científica, sinal `+`, mais de 2 casas, separador `,`.
- `Money.from` rejeita negativos (contratos de entrada). `Money.fromSigned` existe apenas para reidratação/valores derivados (ex.: diferença de reconciliação).
- Moeda: ISO-4217 em 3 letras maiúsculas; o modelo é multi-moeda, mas o desafio usa `BRL`. Operações entre moedas distintas lançam `CurrencyMismatchError`.
- Persistência: `MoneyAmountType` (`src/infrastructure/persistence/money-amount.type.ts`) é um custom type do MikroORM mapeando `NUMERIC(20,2)` ⇄ string decimal exata. Fica na infra, mantendo o domínio puro. A moeda vai em coluna `CHAR(3)` separada (permitido pelo README); o mapper infra→domínio combina as duas colunas em `Money`. Um custom type de coluna única não enxerga a coluna irmã, então ele não instancia `Money` diretamente. Recusa `number` na escrita e na leitura.
- Arredondamento: nunca é feito. Mais de 2 casas é rejeitado (inclusive zeros à direita, ex.: `1.000`), para o provedor não depender de uma regra de arredondamento implícita.
- Constraints de banco (`CHECK (balance >= 0)`) entram na etapa 3.

## ADR-002 — Estrutura, camadas e autenticação

- Camadas em `src/`: `domain` (puro) · `application` (casos de uso e portas) · `infrastructure` (MikroORM, SQS, config, adapters) · `interfaces` (HTTP/Nest). Dependências apontam para dentro; ESLint (`no-restricted-imports`) proíbe `domain` de importar Nest/MikroORM/outras camadas e `application` de importar infra/interfaces.
- Autenticação: fora do escopo de pontuação. `ProviderIdentityPort` (application) + `NoopProviderIdentityAdapter` (infra) + `AuthGuard` global (interfaces). Para ativar OIDC (Keycloak/Zitadel), basta trocar o adapter por um que valide o JWT; o guard não muda. Rotas `@Public()` (health) não passam pelo guard.
- Migrations: MikroORM Migrator com `migrationsList` explícita (sem glob, funciona em Bun/Docker), transacionais e reversíveis (`bun run migrate`, `migrate:down`). A baseline cria `forbid_mutation()`, trigger reutilizável que tornará o ledger append-only no banco.
- Filas: `wager-transactions.fifo` e a DLQ são criadas por `docker/localstack/init-queues.sh` (hook `ready.d`), com redrive após 5 recebimentos. O healthcheck do LocalStack só passa quando a fila existe.
- TypeScript fixado em `~5.9` porque `typescript-eslint` ainda não suporta TS 7.
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
