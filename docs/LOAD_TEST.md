# Teste de carga

```bash
docker compose up -d --build                                        # 3 réplicas + nginx + PostgreSQL + MiniStack
OTEL_ENABLED=true docker compose --profile observability up -d      # opcional: Prometheus (conflitos/retries), Grafana, Jaeger
bun run test:load -- --duration 30 --concurrency 64 --wallets 200 --sqs-messages 3000
bun run load/sqs-ceiling.ts                                         # vazão bruta do emulador SQS, isolada
bun run load/sqs-drain.ts prepare   # depois: bun run load/sqs-drain.ts measure (vazão pura do consumidor, veja "Lote por wallet")
```

Cada execução grava um JSON em `load/results/` (ignorado pelo git) e **termina com erro se qualquer wallet tocada estiver inconsistente**. A métrica de sucesso não é o RPS, e sim a reconciliação.

## Ambiente

| | |
|---|---|
| Host | Windows 11 Pro, Intel i5-9400F (6 núcleos, sem HT), 16 GB RAM |
| Docker | Docker Desktop 27.4 (VM WSL2: 6 vCPU, 8 GB) |
| Stack | 3 réplicas `bun src/main.ts` (todos os papéis, pool de 20 conexões cada) + nginx + PostgreSQL 17.6 + MiniStack 1.5.22 |
| Gerador | o próprio `load/run.ts` (Bun 1.4.2) **na mesma máquina**, acessando via nginx (`localhost:8080`) |

Tudo divide os mesmos 6 núcleos. Os números são relativos a um desktop e **não** são uma estimativa de produção.

## Metodologia

- **Closed loop:** `concurrency` usuários virtuais, cada um envia a próxima requisição quando a anterior responde. A latência inclui a fila. Pela lei de Little, latência média ≈ VUs / vazão.
- Cada requisição tem um `externalTransactionId` único, sem replays. O custo de idempotência aparece, mas não há atalho de cache.
- **Cenários:**
  - **distributed**: 200 wallets, mistura de 60% BET, 20% WIN e 20% LOSS, valores aleatórios;
  - **hot-wallet**: 64 VUs na **mesma** wallet, pior caso para o lock por wallet;
  - **sqs**: 3.000 mensagens em 100 wallets, enfileiradas de uma vez; mede a drenagem de ponta a ponta.
- **Coletado:**
  - vazão e latência p50/p95/p99/máx;
  - distribuição de status HTTP;
  - outbox lag, amostrado no banco a cada 1 s;
  - conflitos de lock e retries transitórios (delta das métricas no Prometheus);
  - eventos recebidos por um consumidor downstream simulado, que drena `wallet-events.fifo` e conta duplicatas por `eventId`;
  - **reconciliação de todas as wallets tocadas**.

## Resultados

Execução final, 30 s por cenário, 64 VUs:

| Cenário | OTel | Vazão | p50 | p95 | p99 | máx | Erros | Conflitos de lock / retries |
|---|---|---:|---:|---:|---:|---:|---:|---|
| distributed | ligado | **334,7 req/s** | 160 ms | 414 ms | 503 ms | 632 ms | 0 % | 0 / 0 |
| distributed | desligado | **342,9 req/s** | 168 ms | 377 ms | 448 ms | 627 ms | 0 % | — |
| hot-wallet | ligado | **122,7 req/s** | 538 ms | 882 ms | 1.040 ms | 1.492 ms | 0 % | 0 / 0 |
| hot-wallet | desligado | **128,9 req/s** | 476 ms | 857 ms | 1.054 ms | 1.543 ms | 0 % | — |
| sqs (3.000 msgs) | ligado | 16,2 msg/s de ponta a ponta¹ | — | — | — | — | 0 perdidas, 0 duplicadas | — |

¹ **Correção posterior:** essa medição rodou numa stack que já tinha backlog acumulado no emulador (outbox atrasada e fila de eventos grande, veja o item 4 da análise). Refeita em stack zerada (`docker compose down -v`), com 2.000 mensagens em 10 wallets, deu **146,5 msg/s** de ponta a ponta sem lote e **214,7 msg/s** com lote, com 4.020 eventos entregues e 0 duplicatas. A drenagem pura está na seção "Lote por wallet".

- **Reconciliação:** 301/301 wallets consistentes, com saldo = Σledger, cadeia contínua e journal balanceado.
- **Consumidor downstream:** 10.420 eventos recebidos, **0 duplicatas**.
- **Outbox lag:** máximo de ~27 s no cenário distribuído, chegando a ~210 s no cenário SQS, com backlog acumulado. Veja a análise abaixo.

Primeira execução, antes das otimizações descritas abaixo: distributed 273,5 req/s (p50 220 ms, p99 560 ms) e hot-wallet 110,9 req/s.

## Análise

**1. A API é limitada por I/O, não por CPU do Bun.** Um perfil de CPU (`bun --cpu-prof-md`) de uma instância sob carga mostra o processo **ocupado em menos de 7% do tempo**: 1.490 amostras de 1 ms em 22 s. O restante é espera pelos ~10 round-trips ao PostgreSQL por transação, cada um cruzando a rede virtual do Docker Desktop. Do CPU que existe, os maiores itens são `EntityManager.fork()` e a construção do EM do MikroORM (~12%), escrita em buffers de I/O, rede e stdout (~6%) e validação zod (~2%). Com 64 VUs a ~340 req/s, a latência média de ~187 ms é quase toda fila (lei de Little).

**2. Hot wallet: o teto é o tempo de lock.** ~125–129 TPS numa única wallet equivalem a **~8 ms de lock por transação**: o lock, a busca de idempotência, as escritas (transação, saldo, ledger, journal, outbox) e o COMMIT com os triggers diferidos, tudo serializado. É o comportamento esperado do desenho (ADR-03): **0 erros, 0 lock timeouts** e saldo exato. A alavanca para subir esse teto é reduzir os round-trips dentro do lock, com uma stored procedure ou uma CTE única. Wallets diferentes não sofrem esse limite.

**3. O caminho assíncrono é limitado pelo emulador SQS.** Durante o cenário SQS, o `docker stats` mostrou:

| contêiner | CPU |
|---|---:|
| MiniStack (Python) | **96–99 %** |
| PostgreSQL | 8–16 % |
| apps | 2–10 % cada |

Em isolamento (`load/sqs-ceiling.ts`), o mesmo emulador aceita ~2.900 msg/s com 4 conexões. Sob carga ele atende ao mesmo tempo três fontes, e satura com um core:
- os publishers da outbox, com ~2 eventos por transação;
- os long polls dos 3 consumidores;
- o consumidor downstream.

Daí o outbox lag e os 16 msg/s dessa rodada, que já carregava backlog de rodadas anteriores (veja a correção na tabela de resultados). Em SQS real, que escala horizontalmente e tem *high throughput FIFO*, esse teto não existe. O desenho, porém, se comportou corretamente sob saturação: nada foi publicado antes do commit, nada se perdeu e não houve duplicata no downstream.

**4. A outbox não pode crescer sem consumidor.** Numa primeira rodada, `wallet-events.fifo` acumulou **88 mil** mensagens sem consumidor, e o emulador degradou. O teste agora drena essa fila como um consumidor real faria.

**5. Overhead do OTel:** ~2% de vazão e ~10% de p99 com auto-instrumentação de HTTP e PostgreSQL ligada.

## Lote por wallet no consumidor SQS (ADR-14)

**Pergunta:** quanto o lote por wallet muda a drenagem de uma fila?

**Por que um benchmark à parte.** No cenário `sqs` do `test:load`, o próprio gerador leva ~4 s para enfileirar 2–3 mil mensagens, e o resultado de ponta a ponta mede o produtor tanto quanto o consumidor. O `load/sqs-drain.ts` isola o consumidor:
1. sobe a stack só com o papel `api`, com consumidores desligados;
2. cria as wallets e **pré-carrega** a fila;
3. liga os consumidores;
4. mede a vazão pelos timestamps do inbox no banco (`received_at` do primeiro e do último processado);
5. conta quantas transações SQL houve (`received_at` distintos).

Cada medição usa stack zerada (`docker compose down -v`), 4.000 mensagens de BET e 3 réplicas, e roda **sem o papel `outbox`**, para que o emulador atenda só receive e delete.

```bash
APP_ROLES=api SQS_BATCH_PER_WALLET=true docker compose up -d
bun run load/sqs-drain.ts prepare --messages 4000 --wallets 10
APP_ROLES=api,consumer,pending-ref SQS_BATCH_PER_WALLET=true docker compose up -d app
bun run load/sqs-drain.ts measure
```

| Tráfego | Lote | Vazão | Transações SQL | Mensagens / transação | CPU MiniStack | CPU PostgreSQL |
|---|---|---:|---:|---:|---:|---:|
| concentrado (10 wallets) | desligado | 222 msg/s | 3.265 | ~1,2 | 79 % | 79 % |
| concentrado (10 wallets) | **ligado** | **328 msg/s (+48 %)** | **924 (−72 %)** | **4,3** | **42 %** | 80 % |
| espalhado (100 wallets) | desligado | 250 msg/s | 2.679 | ~1,5 | 101 % | 101 % |
| espalhado (100 wallets) | ligado | 235 msg/s | 2.772 | ~1,4 | 105 % | 101 % |

A contagem de transações "desligado" fica abaixo do número de mensagens porque duas transações podem cair no mesmo milissegundo.

**Leitura:**
- **Com tráfego concentrado**, o lote faz o que promete:
  - um lock e um COMMIT para ~4 mensagens;
  - 3,5× menos transações;
  - o ack em lote (`DeleteMessageBatch`) quase **corta pela metade o CPU do emulador**.
- **Com tráfego espalhado não há ganho**, dentro do ruído. Cada `ReceiveMessage` traz no máximo 10 mensagens, distribuídas por vários grupos, então sobra ~1 mensagem por wallet. O lote mira o teto **por wallet**, e não aumenta a vazão global quando esse teto não está em jogo.
- **Com a outbox ligada**, as duas configurações ficam em ~185–231 msg/s com o MiniStack a 103% de CPU. Ele passa a atender também os ~2 eventos publicados por transação, e volta a ser o teto. Mesmo assim, o lote reduziu as transações SQL de forma igual (896 para 4.000 mensagens, 4,5 por transação).

**Regressão no HTTP.** O caminho HTTP agora é um lote de 1. Medido depois da mudança, sem regressão:

| Cenário | Antes | Depois |
|---|---:|---:|
| distributed (64 VUs) | 342,9 req/s · p99 448 ms | 341,1 req/s · p99 447 ms |
| hot-wallet (64 VUs) | 128,9 req/s · p99 1.054 ms | 136,4 req/s · p99 1.209 ms |

Em todas as execuções: 0 erros e reconciliação consistente em todas as wallets tocadas.

## Borda endurecida (nginx com rate limit)

Depois da revisão de segurança, o nginx passou a aplicar limites por IP (ARCHITECTURE §7). Com os limites padrão, o teste de carga completo (uma execução de 20 s por cenário) passa sem erro:

| Cenário | Resultado |
|---|---|
| distributed (64 VUs) | **397,7 req/s** · p99 358 ms · 8.044 × 201 |
| hot-wallet (64 VUs) | 137,8 req/s · p99 1.085 ms · 2.821 × 201 |
| reconciliação | 301/301 wallets consistentes |

- **O nginx ficou mais rápido, não mais lento.** A borda passou a manter conexões keep-alive com as réplicas (antes, cada requisição abria uma conexão TCP). O ganho no cenário distribuído foi de ~340 para ~398 req/s, numa única execução: é preciso repetir para cravar o número.
- **Um 502 apareceu na primeira tentativa, e foi corrigido.** A borda reusou uma conexão keep-alive que a aplicação fechava naquele instante (o keep-alive do servidor Bun/Node é de 5 s), e um POST nunca é repetido em outra réplica. O `keepalive_timeout` do upstream ficou em 4 s, abaixo do da aplicação. Além disso, um 502/504 da borda agora vira `503 TRANSIENT_FAILURE` com `Retry-After`, como no contrato da API.
- **O runner aprendeu a esperar o 429.** A reconciliação final chama um endpoint com limite próprio (10 r/s por IP). O runner respeita o `Retry-After`, e uma wallet não verificada é reportada à parte (`unchecked`), nunca como "inconsistente".
- **Benchmarks acima de ~500 req/s a partir de um único host** precisam subir o limite da borda: `LB_RATE_LIMIT_RPS=100000 LB_RATE_LIMIT_BURST=100000 docker compose up -d lb`.
- O cenário SQS da mesma execução (18 msg/s) roda depois dos cenários HTTP, com a fila de eventos cheia no emulador. É a mesma contaminação por backlog descrita acima, não um efeito do nginx, que nem fica no caminho do SQS.

## O que o teste de carga encontrou (e foi corrigido)

1. **Clock skew entre instâncias.** Na primeira execução, 26 de 8.130 requisições (0,32%) deram 500. A constraint `wallets_timestamps_ck` (`updated_at >= created_at`) rejeitou a escrita. A wallet foi criada pela réplica A às 42,571 e debitada pela réplica B, cujo relógio estava às 42,446: um skew de mais de 125 ms. Como o **schema recusou** o estado incoerente, nenhum dado ficou errado. A correção foi manter o `updatedAt` monotônico no domínio. Timestamps são informativos; a ordem é dada por `version`. Há teste unitário cobrindo. Depois da correção: 0 erros.
2. **Outbox sequencial.** O publisher passou a usar *lanes* particionadas por `aggregateId`: a ordem por wallet se mantém e a falha de uma lane interrompe só essa lane. Lote padrão de 100.
3. **Round-trips no caminho quente:** uma única consulta para as duas chaves de idempotência, e a linha do inbox já gravada como processada. Juntas com o item 2, elas levaram o cenário distribuído de 273 para ~340 req/s e o p99 de 560 para 448–503 ms.

## Limitações do experimento

- O gerador de carga, o banco, o emulador e as 3 réplicas disputam os mesmos 6 núcleos.
- A rede do Docker Desktop no Windows (host → nginx → app → PostgreSQL) adiciona latência a cada hop.
- O closed loop mede a capacidade sob saturação, não a latência com carga leve. A latência com pouca carga não foi medida nesta stack.
- Os números de SQS refletem o MiniStack, não a AWS.
- Execuções curtas (30 s): não medem efeitos de longo prazo, como crescimento de tabelas, autovacuum e retenção.
