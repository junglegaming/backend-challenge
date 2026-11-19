# Teste de carga

```bash
docker compose up --build     # stack completo, 3 instâncias
bun run test:load             # ~3 minutos; LOAD_SECONDS=15 por cenário (padrão)
```

O objetivo não era atingir um número de RPS, e sim responder três perguntas: o sistema continua
correto sob carga? Onde ele satura? O que acontece com uma hot wallet e com a outbox?

## Ambiente

| | |
|---|---|
| Máquina | MacBook, Apple M3 Pro (11 núcleos), 18 GB, macOS 26.6 |
| Containers | Colima (VM Linux aarch64) com **4 vCPUs e 4 GiB**, Docker 29.5 |
| Dentro da VM | PostgreSQL 17, LocalStack 3.8 (SQS) e 3 instâncias da aplicação (Bun 1.4), sem limite de CPU por container |
| Gerador de carga | `test/load/run.ts`, um processo Bun **na mesma máquina**, fora da VM |

Tudo divide os mesmos 4 vCPUs. Os números valem como comparação entre cenários neste ambiente, não
como capacidade de produção.

## Metodologia

- **Laço fechado:** N clientes virtuais; cada um envia `POST /wagering/transactions`, espera a
  resposta e envia a próxima. A latência medida é a vista pelo cliente, de ponta a ponta. Por ser
  laço fechado, a taxa de chegada cai quando o sistema fica lento — as latências de cauda estão
  subestimadas em relação a uma carga de taxa fixa (omissão coordenada).
- **Distribuição:** round-robin entre as 3 instâncias.
- **Mistura:** 70% `BET`, 20% `WIN`, 10% `LOSS`, valor fixo de 1.00; 5% das requisições repetem a
  anterior, para exercitar o replay idempotente. Saldo inicial alto: nenhuma aposta é rejeitada.
- **Cenários HTTP:** 500 wallets com 16, 64 e 256 clientes; 1 wallet (hot) com 16 e 64 clientes.
  15 segundos cada, depois de um aquecimento descartado.
- **Cenário SQS:** 5.000 mensagens para 500 wallets em `wager-transactions.fifo`; mede do primeiro
  envio até as três instâncias terem processado todas (o tempo inclui ~1s de enfileiramento).
- **Erros:** falha de transporte ou status ≥ 500. **Conflitos de lock:** variação de
  `wager_lock_conflicts_total` (lock timeout e deadlock). **Outbox lag:** `wager_outbox_lag_seconds`
  amostrado a cada 500 ms, e o tempo até zerar depois que a carga para.
- **Verificação:** ao fim de cada cenário, todas as wallets usadas passam por
  `POST /wallets/:id/reconciliation`.
- **Uma execução por cenário.** Não há intervalo de confiança; diferenças pequenas entre linhas são
  ruído.

## Resultados

Versão entregue (outbox publicando em lote):

| Cenário | Clientes | Requisições | req/s | p50 (ms) | p95 (ms) | p99 (ms) | máx (ms) | Erros | Replays | Conflitos de lock | Outbox lag máx | Outbox zera em | Wallets consistentes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 500 wallets | 16 | 18132 | 1208 | 11.9 | 26.2 | 36.3 | 77.4 | 0.00% | 904 | 0 | 2.33s | 0.8s | 500/500 |
| 500 wallets | 64 | 23606 | 1568 | 38.0 | 77.3 | 103.4 | 191.5 | 0.00% | 1148 | 0 | 7.94s | 4.1s | 500/500 |
| 500 wallets | 256 | 23925 | 1579 | 161.7 | 317.3 | 411.6 | 511.9 | 0.00% | 1152 | 0 | 11.58s | 5.9s | 500/500 |
| 1 wallet (hot) | 16 | 6328 | 421 | 38.0 | 58.5 | 83.5 | 252.1 | 0.00% | 323 | 0 | 0.27s | 0.2s | 1/1 |
| 1 wallet (hot) | 64 | 5807 | 384 | 139.4 | 404.9 | 564.5 | 918.4 | 0.00% | 292 | 0 | 0.88s | 0.2s | 1/1 |

SQS: 5.000 mensagens processadas em 11,2 s (**446 msg/s**), nenhuma na DLQ.

## Análise

**Correção.** Em todos os cenários: zero erros, zero conflitos de lock e todas as wallets
reconciliadas (saldo materializado igual ao ledger). Os replays foram reconhecidos como replays.

**Saturação por volta de 1.500 req/s.** De 16 para 64 clientes o throughput sobe 30%; de 64 para 256
não sobe nada, e a latência cresce na proporção do número de clientes (p50 de 38 ms para 162 ms). O
sistema está saturado e o excesso vira fila. Com tudo nos mesmos 4 vCPUs, o limite é CPU da VM; não
medi a divisão entre Postgres, aplicação e LocalStack, então não sei qual deles satura primeiro.

**Hot wallet: cerca de 400 req/s, independente do número de clientes.** É o custo previsto do lock
pessimista (ARCHITECTURE.md, 2.3): as operações de uma wallet são seriais, cada uma leva ~2,4 ms sob
o lock, e mais clientes só aumentam a fila — p50 vai de 38 ms para 139 ms e o p99 passa de 500 ms.
Nenhuma requisição chegou ao `lock_timeout` de 5 s, mas com algumas centenas de clientes na mesma
wallet chegaria, e viraria `503`. O sistema fica correto e lento, não incorreto.

**A outbox é o gargalo de propagação, e o teste de carga encontrou isso.** Na primeira medição o
publisher fazia uma chamada ao SQS por evento:

| Cenário | Clientes | req/s | Outbox lag máx | Outbox zera em |
|---|---|---|---|---|
| 500 wallets (antes) | 16 | 1329 | 21.95s | 22.1s |
| 500 wallets (antes) | 64 | 1206 | 22.44s | 22.4s |
| 500 wallets (antes) | 256 | 1449 | 27.24s | 27.6s |

Cada transação gera em média 1,9 evento, então ~1.300 req/s produzem ~2.500 eventos/s, e os
publishers davam conta de ~1.000. O lag crescia durante toda a carga. Troquei para
`SendMessageBatch` (até 10 eventos por chamada, no máximo um por wallet em cada chamada, para manter
a ordem). O lag máximo caiu para 2 a 12 s e o tempo para zerar, de 22–28 s para 1–6 s.

**Mas o problema não sumiu:** a 1.500 req/s o lag ainda cresce durante a carga (11,6 s no pior caso).
Sob carga sustentada nesse nível a outbox atrasaria indefinidamente. A carga financeira não é
afetada — o lag atrasa a notificação, não o saldo — mas um consumidor dos eventos veria dados
velhos. Próximos passos, não feitos: enviar os lotes de um mesmo ciclo em paralelo, aumentar o lote,
ou separar o publisher em processo próprio. A métrica `wager_outbox_lag_seconds` existe para alarmar
exatamente isso.

**SQS mais lento que HTTP (446 msg/s contra ~1.500 req/s).** Esperado neste desenho: o consumidor
busca no máximo 10 mensagens por recebimento, com um laço por instância, e processa os grupos do lote
antes de buscar o próximo. Mais laços de recebimento por instância aumentariam isso; não testei.

## Limitações do experimento

- Gerador de carga e sistema na mesma máquina, disputando CPU.
- LocalStack não é o SQS: latência e limites reais são diferentes.
- Uma execução de 15 s por cenário; sem repetição, sem carga de longa duração, sem taxa fixa.
- Dados pequenos: as tabelas tinham no máximo algumas centenas de milhares de linhas.
- Não houve injeção de falha durante a carga (isso está nos testes de concorrência).
