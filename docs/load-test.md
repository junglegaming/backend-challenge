# Teste de carga

Este experimento compara contenção em uma carteira, distribuição entre mil carteiras,
replays e processamento de backlog SQS. A aceitação combina os resultados HTTP com
operações persistidas, reconciliação e a cadeia completa do ledger. Não existe meta de RPS.

## Reprodução

Com Bun 1.4.3 e Docker Compose disponíveis, execute na raiz do repositório:

```bash
bun install --frozen-lockfile
bun run test:load
LOAD_PROFILE=full bun run test:load
```

O perfil padrão é `quick`. O runner cria o projeto isolado `wagering-test`, recusa substituir
uma stack existente e remove seus containers e volumes ao terminar. `KEEP_STACK=1` permite
inspeção local depois da execução. Os artefatos ficam em `load/results/<runId>/`, ignorados
pelo Git. O gerador k6 usa a imagem `grafana/k6:2.3.0`; não é necessário instalar k6 no host.

As portas locais são 13000 (Nginx), 15432 (PostgreSQL), 14566 (MiniStack), 18080
(Keycloak), 19090 (Prometheus) e 13001 (Grafana). Elas precisam estar disponíveis.

## Ambiente e parâmetros

Cada execução usa três APIs, três consumers e dois workers, com uma única instância
de PostgreSQL e MiniStack. Todos compartilham o mesmo daemon Docker. O k6 envia HTTP
ao Nginx pela rede Compose; o produtor Bun envia SQS pela porta local. Prometheus e
Grafana permanecem ativos durante a carga.

O runner registra versões, imagens, arquitetura, recursos anunciados pelo Docker,
commit (quando Git está disponível), ID da imagem e hash dos fontes de carga em
`environment.json`. Não registra ambiente completo,
credenciais, tokens ou payloads financeiros. O token do provedor é obtido no Keycloak
real no `setup` de cada fase k6; seu prazo precisa cobrir a fase. O resumo salva somente
uma lista explícita de métricas e metadados, pois o resumo interno do k6 também contém
os dados retornados pelo `setup`.

Os parâmetros são os operacionais: pool de dez conexões por processo, `lock_timeout`
de 2 s, PostgreSQL com 200 conexões, consumers com concorrência dez e lotes de dez,
long polling de 20 s, visibilidade de 30 s, redrive após cinco recebimentos,
retry SQS de 2–30 s e lease/retry máximo da outbox de 15/300 s. As barreiras de crash
estão desativadas e `NODE_ENV=production`. O Nginx permite 2.048 conexões por worker,
e o Compose fixa os limites soft/hard de descritores em 4.096. Clientes e upstreams
consomem sockets distintos: até 600 VUs mistos podem exigir aproximadamente 1.200 sockets.
Um ensaio com o padrão de 512 conexões terminou em `EOF`. Depois de aumentar os slots,
outro ensaio misto atingiu o limite efetivo de 1.024 descritores herdado do Docker e
falhou por timeout. A reprodução preservada mostrou o worker em 1.024 descritores e
erros de `accept4()` e `socket()` por falta de descritores. Esses ensaios foram
reprovados e não entram nas estatísticas de sucesso. A contagem de sockets segue a
[documentação do Nginx](https://nginx.org/en/docs/ngx_core_module.html#worker_connections).

## Metodologia

Antes das medições, o runner abre 1.001 carteiras pela API e cria vinte transações para
replay. Cada carteira começa com saldo decimal suficiente para o experimento; cada
operação usa a string `"1.00"`. Não há cálculo monetário em ponto flutuante. A seed e a
drenagem inicial ficam fora das latências HTTP medidas.

| Fase | Carga |
| --- | --- |
| `hot_wallet` | Uma carteira; `BET` e `WIN` alternados por operação |
| `distributed_wallets` | Mesma rampa, seleção circular entre mil carteiras |
| `replays` | Carteiras distribuídas; cada décima requisição repete exatamente uma chave já processada na seed |
| `hot_plus_distributed` | Dois executores simultâneos: carteira única e mil carteiras; cada um recebe a rampa inteira |
| `sqs_backlog` | Produtor Bun, cinco lotes simultâneos de até dez mensagens, distribuídas entre mil grupos FIFO |

O executor HTTP é `ramping-arrival-rate`, sem pausa ao final da iteração. Em `quick`,
parte de 2 req/s e passa por alvos 5, 15 e 30, em estágios de 7 s. Em `full`, parte de
5 req/s e passa por 25, 100, 250 e 500, em estágios de 30 s. São rampas contínuas,
sem patamares de estabilização. A fase mista dobra a taxa total oferecida. Cada workload
tem até 300 VUs; a pré-alocação é de 30 no rápido e 100 no completo. O gerador pode
descartar iterações se atingir sua capacidade; `dropped_iterations` fica no resultado.
O backlog contém mil mensagens no rápido e dez mil no completo.

Somente `200/PROCESSED`, com o indicador de replay correto, é sucesso financeiro esperado
nessas fixtures. `503` com `Retry-After: 1` é backpressure, contado separadamente.
Qualquer outro status, resposta inválida ou divergência de contrato falha o experimento.
Não se esperam rejeições de negócio, referências pendentes ou conflitos de identidade
nesses dados. As latências incluem também as respostas 503; replays têm uma série própria.

Após cada fase, o runner compara as identidades determinísticas e os campos das operações
com PostgreSQL. Cada resposta iniciada deixa um registro mínimo de quatro campos em
`<fase>-responses.jsonl`: workload, índice, status e transactionId. O parser exige os tipos
exatos, coordenadas completas sem duplicatas e UUID válido nos sucessos. Cada 200 novo
precisa devolver o mesmo transactionId da sua chave determinística no SQL; cada replay
precisa devolver o ID original da seed. Um 503 precisa corresponder a uma operação
ausente no banco. Somente essas operações ausentes são reenviadas, com a chave e corpo originais,
fora da janela medida. O ID retornado pela recuperação também precisa coincidir com o SQL. Nenhum registro
individual guarda corpo, header ou token. O relatório separa esse tempo de recuperação. Depois, espera a
outbox zerar e registra a drenagem residual. O limite por drenagem é de três minutos no
`quick` e trinta minutos no `full`; atingir esse limite reprova a execução. As quatro
fases HTTP completas oferecem carga durante cerca de oito minutos, mas o tempo total
inclui seed, scrapes, backlog SQS e drenagem. Essa duração pode superar a estimativa
inicial de dez minutos quando a publicação acumula eventos. Um ensaio completo com
limite de três minutos falhou ainda com 13.756 eventos pendentes; a prova financeira
parcial passou e o ensaio não conta como execução completa aprovada. A conclusão SQS exige todas as operações
esperadas em `PROCESSED` e nenhuma mensagem de entrada visível, em voo ou atrasada.

Ao final, a execução falha se houver qualquer uma destas condições: contagem inesperada
de transações, mais de um efeito no ledger, inbox incompleto, quantidade/tipos de eventos
incompatíveis, outbox pendente, DLQ não vazia ou reconciliação inconsistente. A verificação
também confere a cadeia de saldos/versões e o saldo reconstruído de todas as 1.001 carteiras.
Para cada operação processada que altera saldo, exige exatamente dois eventos: um
`WagerTransactionProcessed` e um `WalletBalanceChanged`, com os tipos dos envelopes
serializados iguais aos tipos das linhas. Tipo ausente ou divergente também reprova.

## Como ler os artefatos

`<fase>.json` contém as métricas k6, incluindo contagens, p50 (`med`), p95 e p99 em ms.
`result.json` identifica fases, recuperação dos 503, descartes do gerador e drenagem.
Nas tabelas, zero de descartes é o valor registrado pelo runner; quando o k6 omite
a série `dropped_iterations`, isso não é apresentado como uma série numérica emitida.
`sqs_backlog.json` registra envio, conclusão, grupos e pico de backlog amostrado a cada
250 ms; esse pico é uma aproximação, não uma observação contínua.

`<fase>-prometheus.json` preserva consultas e séries por `role,instance`, com passo de
5 s. Throughput de transações novas usa o contador de outcomes sem `OPENING`; tentativas
incluem replays e falhas transitórias. Os percentis de processamento e espera de lock são
estimativas dos buckets existentes, em segundos. Valores ausentes/`NaN` significam falta
de observações, não latência zero. Workers que apenas publicam não têm histograma de
publicação; seus percentis de processamento/lock são N/A nesse experimento.

As taxas e histogramas usam janelas móveis de 30 s. Os primeiros 30 s de uma fase podem
conter observações anteriores; não devem ser usados para atribuir desempenho à nova fase.
`lock_conflicts` é um incremento móvel de 30 s: somar suas amostras contaria eventos várias
vezes. As séries cumulativas permitem comparar amostras sem essa soma. Outbox lag e
profundidade de fila representam estado compartilhado: a visão global usa o máximo entre
réplicas, nunca a soma. O lag publicado é o maior valor amostrado.

`<fase>-counters.json` e `participation.json` guardam snapshots brutos. Contadores finais positivos
nas três APIs, três consumers e dois workers, comparados aos baselines existentes,
comprovam participação; as séries das janelas de tráfego confirmam trabalho após a seed.
Uma série inicial ausente permanece ausente na interpretação, sem delta medido inventado. Um scrape posterior à conclusão evita tomar uma
amostra antiga como resultado final. `verification.json` só existe com a prova financeira
aprovada; `result.json` com `passed: true` só é escrito depois de todas as verificações.
O contador de publicação mede confirmações e pode repetir um mesmo evento em retries
permitidos pelo contrato at-least-once. A quantidade exata de eventos distintos por
transação e a ausência de efeitos financeiros duplicados são verificadas no PostgreSQL.

## Resultados medidos

Os ensaios diagnósticos reprovados não são aceitação. A execução A foi escolhida
como referência detalhada antes de conhecer os resultados de B e C.

### Identificação e ambiente

As execuções foram feitas em 1º de novembro de 2026, em Linux x64, com Bun 1.4.3,
Docker 29.9.2-2 e Compose 2.40.3. O daemon anunciou 12 CPUs e 67.340.574.720 bytes
de memória; esses recursos não eram exclusivos da aplicação. As imagens usadas foram
`oven/bun:1.4.3`, `postgres:17.11-alpine`, `ministackorg/ministack:1.5.28`,
`quay.io/keycloak/keycloak:26.8.1`, `nginx:1.31.8-alpine`,
`prom/prometheus:v3.15.1`, `grafana/grafana:13.3.0` e `grafana/k6:2.3.0`.

O HEAD registrado era `06e6165cb8611ec650dfc4ec947c6d4513da92cf`, com a árvore
limpa durante as medições. As três rodadas apontam para o mesmo hash dos dez
fontes de carga/configuração:
`c99c4ac6e9f568ae3a718b9e0bff973b3a143a355875fbe85e9d4a420e4dd9de`.
Esse hash identifica os arquivos enumerados em `scripts/load-test.ts`; o ID Docker
identifica a imagem da aplicação. Ele não é um hash de todo o repositório.

### Três execuções completas

As três rodadas abaixo passaram integralmente. As contagens financeiras incluem 1.001 aberturas e vinte comandos da seed; replays devolvem efeitos existentes. A execução A foi escolhida como referência detalhada antes dos resultados de B e C.

| Rodada | runId | Início → fim, UTC em 01/11/2026 | Duração, s | Transações = entradas no ledger | Eventos distintos |
| --- | --- | --- | ---: | ---: | ---: |
| A | `2026-11-01T09-08-31-505Z-33137235` | 09:08:31.571 → 09:48:03.636 | 2.372,065 | 91.225 | 182.450 |
| B | `2026-11-01T09-48-21-364Z-684a5de9` | 09:48:21.440 → 10:28:20.320 | 2.398,88 | 91.576 | 183.152 |
| C | `2026-11-01T10-28-36-009Z-160b3ad6` | 10:28:36.069 → 11:08:30.554 | 2.394,485 | 91.529 | 183.058 |

Em todas: 1.001 carteiras reconciliadas, 10.000 registros inbox concluídos, nenhuma outbox pendente, nenhuma mensagem na DLQ e nenhum efeito financeiro duplicado. Os oito processos tiveram participação positiva depois da seed. Cada prova final passou com 2.006 asserções.

| Rodada | ID registrado da imagem da aplicação |
| --- | --- |
| A | `sha256:2cf25c28245897624f40daf832fefab17e35f077fabd8c63ca6645cd0fd465c6` |
| B | `sha256:fbe8d13ea040127e0a783ab0fb620bdf9cc8b21677b8e33f1f88b1aba8371cfa` |
| C | `sha256:2cf25c28245897624f40daf832fefab17e35f077fabd8c63ca6645cd0fd465c6` |

A e C registraram o mesmo ID, com rótulo Compose `bootstrap`; B registrou outro ID, com rótulo `api`. A inspeção desses IDs confirmou as mesmas onze camadas de arquivos, na mesma ordem. Os IDs completos e os rótulos são metadados distintos; a equivalência das camadas foi verificada separadamente do hash dos fontes.

### HTTP por rodada

As taxas são as médias dos contadores emitidas pelo k6. Os percentis são do cliente, em ms, sobre a fase inteira. `Replay` é uma resposta bem-sucedida que não cria outra transação financeira.

| Rodada | Fase / workload | Sucessos HTTP | Requisições/s | p50, ms | p95, ms | p99, ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| A | `hot_wallet` / hot | 15.352 | 126,656 | 233,34 | 1.248,21 | 1.311,012 |
| A | `distributed_wallets` / distributed | 18.446 | 153,694 | 6,511 | 476,567 | 1.494,363 |
| A | `replays` / distributed | 16.942 | 141,161 | 4,948 | 8,298 | 13,536 |
| A | `replays` / replay | 1.882 | 15,681 | 3,04 | 4,745 | 7,107 |
| A | `hot_plus_distributed` / hot | 14.476 | 119,429 | 48,826 | 1.477,019 | 1.576,369 |
| A | `hot_plus_distributed` / distributed | 14.988 | 123,653 | 8,34 | 1.346,889 | 1.429,285 |
| B | `hot_wallet` / hot | 15.469 | 127,648 | 151,536 | 1.220,75 | 1.298,436 |
| B | `distributed_wallets` / distributed | 18.824 | 156,837 | 4,951 | 8,436 | 13,437 |
| B | `replays` / distributed | 16.942 | 141,164 | 4,942 | 9,132 | 16,112 |
| B | `replays` / replay | 1.882 | 15,681 | 3,048 | 6,084 | 13,988 |
| B | `hot_plus_distributed` / hot | 14.396 | 118,778 | 54,835 | 1.494,705 | 1.574,399 |
| B | `hot_plus_distributed` / distributed | 14.924 | 123,134 | 59,019 | 1.361,475 | 1.424,784 |
| C | `hot_wallet` / hot | 15.481 | 127,849 | 40,44 | 1.232,973 | 1.305,34 |
| C | `distributed_wallets` / distributed | 18.824 | 156,836 | 4,935 | 8,793 | 18,635 |
| C | `replays` / distributed | 16.943 | 141,157 | 4,948 | 8,785 | 18,559 |
| C | `replays` / replay | 1.882 | 15,68 | 3,043 | 5,482 | 10,893 |
| C | `hot_plus_distributed` / hot | 14.378 | 118,478 | 165,718 | 1.518,915 | 1.620,537 |
| C | `hot_plus_distributed` / distributed | 14.882 | 122,631 | 89,611 | 1.383,864 | 1.478,067 |

Todas as requisições iniciadas nessas rodadas corresponderam a 200 esperado e as checagens de contrato passaram. A taxa observada de status inesperado foi zero. As séries `backpressure_*` estavam ausentes e os contadores de sucessos igualaram os de requisições: nenhum 503 foi observado. Não houve reenvio de recuperação. As quantidades de replays e comandos novos são as mostradas por workload na tabela.

### Carga entregue e drenagem residual

| Fase | Requisições iniciadas A / B / C | Iterações descartadas A / B / C | Pico de VUs A / B / C | Drenagem outbox A / B / C, s |
| --- | ---: | ---: | ---: | ---: |
| `hot_wallet` | 15.352 / 15.469 / 15.481 | 3.473 / 3.355 / 3.343 | 300 / 300 / 300 | 101,977 / 104,964 / 104,513 |
| `distributed_wallets` | 18.446 / 18.824 / 18.824 | 378 / 0 / 0 | 300 / 5 / 12 | 336,627 / 344,127 / 344,092 |
| `replays` | 18.824 / 18.824 / 18.825 | 0 / 0 / 0 | 4 / 4 / 17 | 318,734 / 322,792 / 323,035 |
| `hot_plus_distributed` | 29.464 / 29.320 / 29.260 | 8.184 / 8.328 / 8.388 | 600 / 600 / 600 | 718,485 / 724,531 / 721,211 |

O total programado em cada resumo é a soma de iterações iniciadas e descartadas; o scheduler pode variar uma iteração entre as rampas. Descartes não chegaram à aplicação. O pico de VUs e os descartes de cada rodada permanecem explícitos, sem atribuir toda perda de chegada a uma única causa.

### Backlog SQS

| Medida | A | B | C |
| --- | ---: | ---: | ---: |
| Comandos novos | 10.000 | 10.000 | 10.000 |
| Grupos FIFO | 1.000 | 1.000 | 1.000 |
| Envio pelo produtor, s | 85,809 | 87,654 | 87,205 |
| Taxa média de envio, comandos/s | 116,538 | 114,085 | 114,672 |
| Conclusão após último envio, s | 170,639 | 173,583 | 172,057 |
| Início do produtor até processamento SQL e fila de entrada vazia, s | 256,448 | 261,237 | 259,262 |
| Pico amostrado do backlog de entrada | 7.130 | 7.110 | 7.140 |
| Drenagem residual da outbox SQS, s | 110,125 | 110,378 | 108,134 |
| Soma das cinco drenagens residuais, s | 1.585,948 | 1.606,792 | 1.600,985 |

A conclusão SQS combina todas as operações em `PROCESSED` com a fila de entrada vazia. O envio e o consumo se sobrepõem. O intervalo após o último envio não é throughput isolado do consumer nem percentil por mensagem. Ele inclui a espera pelo commit e depois pelos acks; a proximidade de 180 s não equivale à folga exata de um único prazo. Os histogramas dos consumers medem a tentativa após a entrega e excluem a espera na fila.

Os artefatos citados são `load/results/<runId>/environment.json`, `result.json`, `verification.json`, os quatro resumos HTTP, os cinco arquivos `*-prometheus.json` e `participation.json`. Eles ficam fora do Git, conforme a política de resultados reproduzíveis. Os números publicados acima foram extraídos desses arquivos; nenhum ensaio diagnóstico parcial foi incluído.

### Amostra por réplica da execução A

Os valores abaixo são taxas móveis de 30 s no mesmo ponto final de cada fase.
Os percentis do servidor são estimativas dos buckets, em ms. A fase hot termina
em 09:11:11.405 UTC, a mista em 09:29:52.478 e a SQS em 09:46:08.171.
Os primeiros 30 s de cada intervalo foram excluídos. As séries terminam antes
da drenagem residual. IDs de rede pertencem apenas a essa stack.

| Fase / réplica | Novas transações/s ou eventos/s | Processamento p50 / p95 / p99, ms | Espera de lock p50 / p95 / p99, ms |
| --- | ---: | --- | --- |
| Hot / API `10.250.1.12:3000` | 83,60 tx/s | 1.295,822 / 1.929,582 / 1.985,916 | 155,990 / 240,924 / 248,474 |
| Hot / API `10.250.1.13:3000` | 84,28 tx/s | 1.258,099 / 1.925,810 / 1.985,162 | 155,487 / 240,549 / 248,110 |
| Hot / API `10.250.1.9:3000` | 83,96 tx/s | 1.272,696 / 1.927,270 / 1.985,454 | 155,857 / 240,747 / 248,293 |
| Hot / worker `10.250.1.10:3000` | 83,60 eventos/s | N/A | N/A |
| Hot / worker `10.250.1.7:3000` | 82,80 eventos/s | N/A | N/A |
| Mista / API `10.250.1.12:3000` | 150,52 tx/s | 1.345,565 / 1.934,557 / 1.986,911 | 2,382 / 231,162 / 247,259 |
| Mista / API `10.250.1.13:3000` | 151,96 tx/s | 1.343,415 / 1.934,342 / 1.986,868 | 2,286 / 231,124 / 248,101 |
| Mista / API `10.250.1.9:3000` | 154,32 tx/s | 1.307,361 / 1.930,736 / 1.986,147 | 2,480 / 230,271 / 247,195 |
| Mista / worker `10.250.1.10:3000` | 28,00 eventos/s | N/A | N/A |
| Mista / worker `10.250.1.7:3000` | 28,40 eventos/s | N/A | N/A |
| SQS / consumer `10.250.1.11:3000` | 15,20 tx/s | 30,000 / 48,000 / 49,600 | 4,430 / 9,443 / 9,889 |
| SQS / consumer `10.250.1.14:3000` | 15,20 tx/s | 30,000 / 48,000 / 49,600 | 4,880 / 9,488 / 9,898 |
| SQS / consumer `10.250.1.8:3000` | 15,20 tx/s | 30,000 / 48,000 / 49,600 | 4,722 / 9,472 / 9,894 |
| SQS / worker `10.250.1.10:3000` | 28,40 eventos/s | N/A | N/A |
| SQS / worker `10.250.1.7:3000` | 28,80 eventos/s | N/A | N/A |

Somando apenas os pontos alinhados, as APIs fizeram 251,84 tx/s no fim de hot e
456,80 tx/s no fim da fase mista; os consumers fizeram 45,60 tx/s no fim de SQS.
Esses valores não são médias da fase nem patamares sustentados. Os histogramas das
APIs na fase mista combinam as duas carteiras de trabalho. A interpolação dos buckets
e a janela de 30 s impedem comparar diretamente esses percentis com os percentis
exatos do cliente sobre a fase inteira. Nos workers, N/A indica que a publicação
não possui esse histograma. Nos papéis inativos, falta observação de processamento.

Nos intervalos retidos, os oito alvos tiveram `up=1`, os erros de processamento dos
papéis ativos tiveram razão observada zero e a taxa de falha de publicação foi zero.
As séries móveis e cumulativas de conflito de lock estavam ausentes: não houve série
observada, o que não equivale a uma medição numérica de zero conflitos. Houve espera
normal de lock, como mostram os histogramas. O máximo amostrado de lag compartilhado
foi 22,871670 s em hot, 63,607897 s na fase mista e 78,158084 s em SQS. Esses números
cobrem as janelas de tráfego registradas, não o máximo durante a drenagem posterior.
Razões de erro NaN nos canais ociosos também não são medições de zero.

Os snapshots finais mostraram contadores positivos em todas as três APIs, três
consumers e dois workers. Na execução A, os consumers terminaram com 3.330, 3.320 e
3.350 tentativas SQS; os workers com 90.877 e 91.573 confirmações de publicação.
Baselines existentes mostraram incrementos positivos; séries iniciais ausentes
permanecem ausentes. As janelas de tráfego confirmam as três APIs e os três consumers
ativos. As contagens de participação não substituem os totais financeiros exatos no SQL.

### Análise e alcance

A carteira concentrada alcançou o teto de 300 VUs e a fase mista alcançou 600,
com descartes de iterações programadas. Isso evidencia que as rampas oferecidas não
foram integralmente entregues. A espera por uma única linha de carteira aparece
nos histogramas, mas o experimento não isola todos os custos de pool, CPU e serviços
compartilhados. Não há base para chamar a taxa média obtida de capacidade máxima.

As carteiras distribuídas tiveram latência maior na fase mista que na fase isolada,
mas a fase mista também dobra a taxa total oferecida. A comparação não controla a
carga agregada e não quantifica isoladamente o custo da carteira concentrada para
outras carteiras. A grande variação entre os percentis distribuídos das rodadas
precisa permanecer visível; ela não estabelece um SLO nem tem causa demonstrada.

A publicação ficou atrás da criação de eventos durante partes da carga e exigiu
drenagens residuais longas. Na execução A, as cinco drenagens somaram 1.585,948 s,
cerca de 26 min 26 s dos 39 min 32 s totais. O relatório separa esse tempo da latência
do endpoint e do esvaziamento da fila de entrada. MiniStack, PostgreSQL, geradores e
aplicação compartilham o host; sem uma análise causal isolada, esses números não
determinam o limite de SQS gerenciado ou de cada componente de produção.

As três rodadas terminaram com outbox vazia, DLQ vazia, nenhuma duplicação
financeira, inbox concluído e as 1.001 carteiras consistentes. Isso demonstra a
correção observada nos workloads efetivamente executados. Falhas e crashes com
sincronização determinística são cobertos pelas suítes de integração, concorrência
e indisponibilidade; os resultados de carga não substituem essas provas.

## Limites da interpretação

Este é um experimento local com dependências no mesmo host, MiniStack, dados sintéticos e
tráfego de curta duração. Não estima latência de rede AWS, limites do SQS gerenciado,
capacidade de um PostgreSQL de produção ou estabilidade por horas. Os recursos anunciados
pelo Docker não representam recursos exclusivos do processo. O limite de VUs e as rampas
precisam ser considerados ao atribuir saturação à aplicação. A correção financeira é
verificada no estado final; os cenários determinísticos de crash e indisponibilidade ficam
nas suítes `test:concurrency` e `test:failure`.
