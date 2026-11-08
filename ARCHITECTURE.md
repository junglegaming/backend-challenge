# Arquitetura e decisões

## 1. Organização

Um único módulo NestJS, organizado por camada. Fluxo: `controller` (ou `worker`) → `service` → `domain` (regras) + `repositories` (gravação).

| Pasta | Conteúdo |
|---|---|
| `controllers/` | HTTP: carteiras, apostas, health/métricas |
| `services/` | `CarteirasService` e `ApostasService` (HTTP e SQS usam o mesmo `processarAposta`) |
| `repositories/` | um por tabela + `UnidadeDeTrabalho` (uma transação SQL por operação) |
| `domain/` | classes da seção 6 + `LiquidacaoDeAposta` (regras da seção 7, sem I/O) |
| `workers/` | consumidor SQS, publicador da outbox, referências pendentes |
| `database/` | entidades MikroORM e migrations |
| `dto/`, `utils/` | validação (zod), erros, logger, métricas, cliente SQS |

- `domain/` é TypeScript puro (sem NestJS/MikroORM), com construtores privados e factories `create`/`from`/`open`/`rehydrate`; `rehydrate` não revalida transições.
- **Nomes:** o domínio usa os nomes do enunciado. O resto do código e os comentários estão em português. Fica em inglês o que é contrato externo: JSON, rotas, valores, códigos de falha, eventos, tabelas e variáveis de ambiente.
- **Assinaturas adaptadas:** `markProcessed` e `reject` recebem o saldo observado (devolvido no replay); `markPendingReference` recebe a data da próxima verificação; `debit`/`credit` recebem `{ entryId, transactionId, money, at }` e devolvem o lançamento.

## 2. ORM, Money e transações

- **MikroORM 6**: escolhido por eu conhecer a API e o comportamento de lock. As entidades ficam separadas do domínio, e os repositórios convertem entre os dois.
- **Money**: `decimal.js` no domínio e `NUMERIC(20,2)` + `char(3)` no banco. O valor trafega sempre como string e nunca passa por `number`.
- **Transação**: `UnidadeDeTrabalho` abre `em.fork().transactional(...)`. Qualquer erro desfaz tudo (transação, saldo, ledger, inbox e outbox). Cada transação tem `lock_timeout`, para que um lock demorado vire 503/retry em vez de prender conexões.
- O isolamento é `READ COMMITTED`; a reconciliação usa `REPEATABLE READ`.

## 3. Concorrência

A unidade de concorrência é a wallet:

1. **`SELECT ... FOR UPDATE` na wallet.** Só operações da mesma wallet esperam umas pelas outras; não existe lock global.
2. **Update condicionado à versão** (`WHERE version = v`). Se afetar 0 linhas, a operação é repetida.
3. **Constraints**: `balance >= 0`, `UNIQUE (wallet_id, wallet_version)` no ledger, `UNIQUE (idempotency_key)`.

Escolhi o lock pessimista porque, numa wallet muito disputada, o otimista gera uma onda de retries; com o lock, as operações formam uma fila curta. A ordem de lock é sempre wallet → transação, inclusive no worker, então não há deadlock. No cenário da seção 8 (saldo 100, duas BETs de 80), a segunda espera o lock, vê saldo 20 e recebe `INSUFFICIENT_FUNDS`. Os recursos do SQS FIFO são só otimização: a correção vem do banco.

## 4. Idempotência

- `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`. O mesmo id externo com outra key é conflito.
- **payloadHash**: SHA-256 do JSON com chaves ordenadas dos campos de negócio, com `amount` normalizado (`"25"` = `"25.00"`). A key, os headers e o `messageId` ficam de fora.
- **Mesma key e mesmo hash**: replay com o mesmo status e corpo, `idempotentReplay: true` e o saldo daquele momento (`balance_after`). **Hash diferente**: `409 IDEMPOTENCY_CONFLICT`.
- A key é conferida antes **e depois** do lock. Se mesmo assim duas gravarem juntas, o `UNIQUE` estoura e a operação é repetida, terminando em replay ou conflito.
- **Inbox**: `INSERT ... ON CONFLICT DO NOTHING` em `(consumer_name, message_id)`, na mesma transação do efeito. Não há cache em memória.

## 5. Estados da transação

```
PENDING ──► PROCESSED | REJECTED | FAILED          (terminais)
   └──► PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
              └─► PENDING_REFERENCE (nova tentativa)
```

- `PENDING` só existe dentro da transação SQL.
- Transicionar um estado terminal lança `InvariantError`, porque é erro de programação.
- `FAILED`: uma mensagem da fila esgotou as tentativas por falha de infraestrutura. Ela é gravada com `PROCESSING_FAILED` (sem mexer no saldo) antes de ir para a DLQ.

## 6. Regras e interpretações

| Operação | Efeito | Referência |
|---|---|---|
| BET | débito | — |
| WIN | crédito | opcional (BET) |
| LOSS | nenhum; `amount` pode ser `0.00` | opcional (BET) |
| REFUND | crédito | obrigatória (BET) |
| ROLLBACK | inverso da referência | obrigatória (BET, WIN ou REFUND) |

- A referência precisa ter o mesmo provider, wallet, player, rodada e moeda, e o mesmo valor no caso de reversões.
- **Cada transação é revertida no máximo uma vez, seja por REFUND ou por ROLLBACK.** Isso é mais restritivo que "uma vez por tipo" e evita creditar duas vezes. É garantido por um índice único parcial.
- Wallet inexistente: `422 WALLET_NOT_FOUND`, sem gravar nada (não há wallet para a FK).
- Rejeições são gravadas, não mexem no saldo e repetem no replay. `OPENING` é interno e não é aceito pela API nem pela fila.

**Referências fora de ordem:** a transação fica `PENDING_REFERENCE` (HTTP 202) e um worker tenta de novo com backoff `min(1s·2ⁿ, 60s)`. O limite é 10 min ou 30 tentativas, e depois disso vira `REJECTED` com `REFERENCE_NOT_FOUND`. Os 10 min cobrem com folga o reenvio de um provedor e a janela de retry do SQS; o valor é configurável. O worker trava a wallet e relê o status, então duas instâncias não processam a mesma linha.

**Códigos de falha:**

| Código | Quando | Provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | não reenviar |
| `REVERSAL_INSUFFICIENT_FUNDS` | reversão deixaria o saldo negativo | escalar |
| `WALLET_NOT_FOUND` / `WALLET_PLAYER_MISMATCH` / `CURRENCY_MISMATCH` | wallet, dono ou moeda errados | corrigir o payload |
| `REFERENCE_NOT_FOUND` | referência não chegou no prazo | corrigir |
| `REFERENCE_MISMATCH` / `REFERENCE_KIND_NOT_ALLOWED` / `REVERSAL_AMOUNT_MISMATCH` | referência inválida | corrigir o payload |
| `REFERENCE_NOT_PROCESSED` / `REFERENCE_ALREADY_REVERSED` | referência rejeitada ou já revertida | não reenviar |
| `PROCESSING_FAILED` | falha de infraestrutura (`FAILED`) | escalar |

## 7. Garantias no banco

- `wallets`: saldo `>= 0`, `UNIQUE (player_id, currency)`.
- `wager_transactions`: as duas UNIQUE de idempotência, CHECK de kind e status, referência obrigatória para REFUND/ROLLBACK, `failure_code` se e somente se REJECTED/FAILED, índice de reversão única.
- `wallet_ledger_entries`: valores positivos, CHECK da aritmética (`after = before ± amount`), um lançamento por transação, versão única por wallet e trigger que bloqueia UPDATE/DELETE.
- `inbox_messages`: PK `(consumer_name, message_id)`. As migrations são versionadas e têm `down`.

## 8. SQS e Outbox

**Consumidor** (`wager-transactions.fifo`):
- processa em ordem as mensagens de um mesmo `MessageGroupId`, com grupos diferentes em paralelo;
- faz o ack só depois do commit;
- trata cada erro de um jeito:
  - erro de negócio já está gravado, então faz ack;
  - mensagem inválida vai direto para a DLQ;
  - qualquer outro erro devolve a mensagem com backoff (2 s, 4 s… até 5 min) e, depois de `SQS_MAX_ATTEMPTS`, grava `FAILED` e manda para a DLQ;
- no SIGTERM, termina o que está em andamento e devolve o resto para a fila.

Se o processo morrer entre o commit e o ack, a mensagem volta e o inbox reconhece a duplicata.

**Outbox:** os eventos são gravados na mesma transação da mudança e publicados por um worker com `FOR UPDATE SKIP LOCKED`, para que instâncias diferentes peguem lotes diferentes. A linha só é marcada como publicada no commit, depois do envio. Uma queda antes do envio deixa outra instância publicar; uma queda depois do envio publica de novo, o que é seguro porque o `eventId` (= `MessageDeduplicationId`) é estável. Falhas são reagendadas com backoff, sem descartar nada. Os eventos são `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference` e `WalletBalanceChanged`. Todos são subclasses de `IntegrationEvent`, com `data` em `MoneyProps`.

## 9. Observabilidade

- **Logs JSON** (pino) com `correlationId`/`messageId` em todo log e valores financeiros ocultados.
- **Métricas** em `/metrics`: transações, duplicatas, conflitos, retries, DLQ, atraso da outbox, latência e divergências de reconciliação.
- **Health**: `/health/live` e `/health/ready` (Postgres + SQS), sem autenticação.
- **Reconciliação**: compara saldo e ledger, registra a divergência (log + métrica + `consistent: false`) e **nunca corrige sozinha**.

## 10. Autenticação (não implementada)

Ficou de fora para priorizar correção, concorrência e idempotência. O ponto de extensão é o `AutenticacaoGuard` no-op (`utils/autenticacao.guard.ts`), aplicado nos endpoints de negócio. Desenho previsto: Keycloak com um client OIDC por provedor (client credentials). O guard validaria o JWT via JWKS e exigiria que o claim do provedor fosse igual ao `providerId` do payload (senão, 403). A fila é canal interno confiável.

## 11. Limitações

- Numa wallet muito disputada, as operações se serializam, então a vazão por wallet fica limitada à latência de uma transação.
- Publishers diferentes podem publicar eventos da mesma wallet fora de ordem; o consumidor ordena por `walletVersion`.
- Não há limpeza das linhas já publicadas da outbox, nem ledger de partidas dobradas.
