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
