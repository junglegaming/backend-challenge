# Teste de carga

## Execução

Use **somente um ambiente descartável e isolado**: o teste cria carteiras, transações, lançamentos e eventos permanentes; não há limpeza automática porque o ledger é append-only. A autenticação padrão é no-op. Não use dados ou serviços de produção.

1. Prepare Postgres e LocalStack, aplique `bun run migrate` e inicie a aplicação conforme o [README](../README.md). Confira `GET /health/ready` e `/metrics`.
2. Execute `bun run test:load`. A saída é JSON; código de saída não zero indica falha de setup, métricas, requisições, idempotência ou consistência. Para salvar somente o JSON: `bun scripts/load-test.ts > load-result.json`.
3. Configure, se necessário, `LOAD_BASE_URL` (padrão `http://127.0.0.1:3000`), `LOAD_WALLETS` (30, máximo 1000), `LOAD_REQUESTS` (300 por cenário, máximo 100000), `LOAD_CONCURRENCY` (30, máximo 1000) e `LOAD_TIMEOUT_MS` (15000, máximo 120000). URLs não locais exigem `LOAD_ALLOW_REMOTE=1`.

O teste cria `2 × LOAD_WALLETS + 1` carteiras com saldo inicial de `1000000.00 BRL`. Os cenários são sequenciais: transações únicas distribuídas entre as primeiras carteiras; transações únicas numa única hot wallet; pares consecutivos com o mesmo payload e idempotency key distribuídos entre as demais carteiras (se o número de requisições for ímpar, a última é única). Cada aposta é de `1.00 BRL`. Setup, leitura de métricas e verificação final não entram nas latências ou no tempo do cenário. Há no máximo `LOAD_CONCURRENCY` requisições em voo, em modelo **closed-loop**, sem taxa fixa, warm-up ou pausa entre cenários; os resultados posteriores acumulam o backlog dos anteriores.

O relatório mede requisições concluídas por segundo (incluindo erros), latências HTTP de ponta a ponta em milissegundos com percentis *nearest rank*, contagens por status, erros de transporte ou qualquer resultado diferente de `200/PROCESSED`, e divergências nas respostas de cada grupo de idempotência. Cada par bem-sucedido deve retornar um ID de transação único, com exatamente uma execução original e um replay. Não há retry automático no gerador.

Conflitos de lock são o delta de `wager_lock_conflicts_total` entre o início e o fim de cada cenário; o lag é `wager_outbox_oldest_unpublished_seconds`, amostrado antes, depois e aproximadamente a cada segundo durante a carga. Os valores são observações, não máximos garantidos entre amostras. O endpoint deve apontar para **uma mesma instância** durante a medição: o contador é por processo e um balanceador pode produzir deltas incorretos. O scrape depende de Postgres e SQS; falhas são reportadas, não substituídas por zero.

Ao final, para **cada carteira criada e identificada**, o script consulta o saldo e todas as páginas do ledger, soma créditos e débitos em centavos com `bigint` e compara os valores e moedas. Nenhuma escrita de teste fica em andamento normalmente nesse momento. Se a criação de uma carteira expirar depois de ser commitada, o cliente pode não conhecer seu ID; nesse caso o comando falha e não consegue verificar essa carteira desconhecida. Um timeout de transação também pode ter resultado ambíguo no servidor, portanto uma execução com erros exige investigação posterior. O teste não verifica invariantes de carteiras preexistentes.

## Execução registrada

**Data:** 2026-11-07, ambiente local compartilhado, uma execução, sem repetir ou estabilizar a máquina. Bun 1.4.4, Linux x86_64 6.12.8+, 2 CPUs disponíveis, aproximadamente 7,5 GiB de memória; Docker 29.1.3, PostgreSQL 16 Alpine e LocalStack 3.8. A aplicação Nest e o gerador rodaram no mesmo host, com os serviços em containers; rede local e logs JSON habilitados. Uma única instância de cada componente e `LOCK_TIMEOUT_MS` padrão de 5000 ms. Não é um benchmark de produção nem uma medição sob carga sustentada.

**Parâmetros:** 30 wallets por cenário distribuído, 1 hot wallet, 300 requisições por cenário, 30 em voo. Total: 61 carteiras, 900 requisições e 750 transações financeiras únicas. A tabela mostra medidas do cliente:

| Cenário | Duração (s) | req/s | p50 (ms) | p95 (ms) | p99 (ms) | Erros | Conflitos de lock | Lag antes → depois (s) |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Muitas wallets | 0,871 | 344,4 | 82,8 | 106,4 | 112,3 | 0/300 | 0 | 0,34 → 1,22 |
| Hot wallet | 1,287 | 233,2 | 112,5 | 207,8 | 249,5 | 0/300 | 0 | 1,23 → 2,51 |
| Mistura com duplicatas | 0,722 | 415,7 | 66,0 | 93,0 | 98,0 | 0/300 | 0 | 2,52 → 3,24 |

Todos os 900 resultados foram HTTP 200; na mistura houve 150 replays esperados e observados, sem divergências de ID ou de original/replay. Todas as 61 carteiras foram verificadas contra a soma integral do ledger, sem divergência. Os maiores lags amostrados nos três cenários foram, respectivamente, 1,22 s, 2,51 s e 3,24 s.

Uma consulta posterior ao banco, aproximadamente 20,8 s depois da criação do evento pendente mais antigo, encontrou **1.262 eventos pendentes e 360 publicados**, de 1.622 gerados. É um instantâneo posterior, não o backlog no fim exato de cada cenário; não foi medido o tempo de drenagem completo.

## Análise e limites

- A hot wallet foi cerca de 32% mais lenta em throughput que a carga distribuída e seu p99 foi cerca de 2,2 vezes maior. O lock SQL por wallet serializa as alterações e é um gargalo plausível, mas esta execução não isola outros fatores, como pool de conexões, concorrência de CPU e I/O de logs.
- O throughput maior da mistura não significa maior capacidade financeira: metade das requisições é replay, sem nova movimentação ou par de eventos. Compare transações únicas e operações de entrada separadamente.
- A outbox acumulou trabalho. O worker processa no máximo 20 eventos por ciclo e espera aproximadamente um segundo antes do próximo; cada transação financeira deste teste gera dois eventos, além dos eventos de abertura. A idade cresce mesmo sem conflitos de lock. O teto real depende também da latência de publicação; métricas de banco e uma execução longa são necessárias antes de dimensionar mais workers.
- Não houve aquecimento, repetição, isolamento do gerador, testes com múltiplas instâncias ou carga aberta. As amostras são pequenas e duram menos de 1,3 s por cenário; percentis e throughput podem oscilar. Não extrapole esses números para uma SLO ou produção. Para capacidade, repita em infraestrutura isolada, com múltiplas durações e níveis de concorrência, monitore CPU, pool, locks, fila e drenagem, e investigue taxas de erro e latências.
