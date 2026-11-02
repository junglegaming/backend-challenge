# Teste de carga

Este experimento compara contenção em uma carteira, distribuição entre mil carteiras,
replays e processamento de backlog SQS. A aceitação combina os resultados HTTP com
operações persistidas, reconciliação e a cadeia completa do ledger. Não existe meta de RPS.

## Estado das evidências

As três rodadas completas A/B/C abaixo são **históricas**, da fonte `06e6165`
e do hash de carga `c99c4ac6e9f568ae3a718b9e0bff973b3a143a355875fbe85e9d4a420e4dd9de`.
A carga completa local posterior e a primeira carga completa AWS de `a98d1e6`
**falharam**. A rodada AWS QUICK passou somente seus próprios gates. Nenhum desses
resultados é apresentado como medição dos instrumentos corrigidos posteriormente.

O [índice visual](load-report/index.html) separa três recortes: os
[FULL locais A/B/C](load-report/local/index.html), o
[FULL3 AWS final aprovado](load-report/aws/index.html), da fonte `d52abed` e carga
`0d029aec`, e o [painel QUICK histórico](load-report/historical/index.html), da
coorte `a98d1e6`/`36b77c2a`. Somente esse último mantém o denominador histórico
**1/1 QUICK elegível e 0/2 FULL nominados elegíveis**. Ele não representa o
resultado final da AWS nem todos os ensaios de setup e diagnóstico.

O FULL3 AWS passou com **80.976 efeitos financeiros, 161.952 eventos na outbox e
DLQ zero**. Os **22.283 descartes reportados** limitam a capacidade demonstrada;
não se afirma que a aplicação sustentou 500 req/s. Há uma rodada FULL AWS aprovada,
sem três repetições para estimar variação. As fontes, os recursos e os instrumentos
locais/AWS diferem, portanto as páginas não calculam uma comparação de desempenho
entre ambientes. A metodologia e as provas finais estão no [relatório AWS](load-test-aws.md).

O QUICK local posterior associado externamente à fonte `d52abed` passou com
3.251 efeitos financeiros e 6.502 eventos na outbox. Seu `environment.json` não
contém `gitHead`; a associação de fonte depende da evidência externa final de
Task 13. Esse gate funcional não é uma quarta rodada FULL nem uma medição de
desempenho comparável às rodadas A/B/C.

O detalhe de concorrência, falhas, recuperação e determinismo está em
[verification.md](verification.md). A candidata de SQL em lote foi **rejeitada e
revertida** por não atingir o benefício previamente exigido; não houve otimização
de throughput retida a partir dessa experiência.

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
Uma série inicial ausente permanece ausente na interpretação, sem delta medido inventado.
O runner atual exige que os oito alvos tenham uma coleta saudável posterior à conclusão.
A implementação usada nas rodadas históricas A/B/C tinha uma limitação nessa barreira,
descrita na análise complementar abaixo. `verification.json` só existe com a prova financeira
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

## Análise complementar da extensão de desempenho

Esta análise foi iniciada depois das rodadas A/B/C, sem substituir seus resultados.
A revisão externa `claude-load-analysis.md`, recebida em 01/11/2026 e preservada nos
registros de execução, orientou perguntas; suas conclusões foram conferidas nos fontes
e nos artefatos citados acima. Seu benchmark isolado de MiniStack é diagnóstico,
com condições diferentes, e não integra nenhuma comparação antes/depois.

### Fatos verificados

O publisher reserva até dez eventos em uma transação SQL, envia um lote SQS fora
dela e confirma os IDs aceitos em outra transação. Na implementação histórica,
`claimDue` faz um `SELECT ... FOR UPDATE SKIP LOCKED` e um `UPDATE` por evento para
persistir a tentativa e o próximo instante; a confirmação também faz um `UPDATE`
por ID aceito. Portanto, um lote completo, totalmente aceito, exige 21 submissões
SQL de dados: uma seleção, dez reservas e dez confirmações. Isso exclui controle
de transação e configuração da sessão. É uma contagem do caminho do código,
não uma medição de seu custo ou demonstração de que ele explica a drenagem.

A conferência da revisão externa corrigiu o recorte das séries: os primeiros
30 s são excluídos a partir do início real da fase, as duas séries dos publishers
são alinhadas e somadas e o lag compartilhado usa o máximo. Nesse recorte, a
média dos pontos de publicação em hot é 168,693 / 165,246 / 167,352 eventos/s
em A/B/C. Ela não é a média sobre toda a fase nem capacidade sustentada.
Os máximos de lag na janela registrada são:

| Fase | A, s | B, s | C, s |
| --- | ---: | ---: | ---: |
| Hot | 22,871670 | 22,789013 | 22,744591 |
| Distribuída | 49,131490 | 49,382506 | 48,599806 |
| Replays | 44,264064 | 45,749412 | 45,392453 |
| Mista | 63,607897 | 64,301103 | 64,767271 |
| Backlog SQS | 78,158084 | 79,703131 | 77,959727 |

Os valores maiores encontrados nos primeiros pontos da fase seguinte pertencem
à fronteira depois da drenagem anterior. Não são o máximo durante a fase anterior:
não foram guardadas séries contínuas do interior dessas drenagens. A prova SQL
de outbox vazia é independente desses gauges.

### Hipóteses causais ainda não demonstradas

A hipótese inicial era que reduzir as atualizações individuais diminuiria o tempo de
reserva e confirmação. A comparação controlada abaixo mediu separadamente reserva
com commit, chamada SDK ao SQS e confirmação com commit. A redução de SQL ocorreu,
mas o ganho de drenagem não satisfez o critério declarado. Isso não demonstra que
as atualizações individuais expliquem as drenagens históricas.

O crescimento de dados retidos pelo emulador e o trabalho de amostragem de filas
podem afetar o custo local. A sequência fixa das fases também faz o tempo decorrido,
o volume acumulado e a carga variarem juntos. Correlação entre publicação mais lenta
e fases posteriores não distingue esses fatores. Não há evidência que atribua a
variação distribuída a MiniStack, PostgreSQL, MikroORM ou pool isoladamente.

Na carteira concentrada, a serialização da linha protege a ordem das alterações de
saldo. Esperar esse lock não demonstra trabalho evitável dentro da transação nem
mede espera por conexão. A inspeção do caminho protegido orienta oportunidades;
a sua remoção ou a troca por um cálculo concorrente sem proteção violaria o contrato.

### Limitações descobertas no instrumento histórico

A barreira antiga usava `timestamp(up == 1)`. A comparação interna podia colocar
o horário de avaliação no resultado, permitindo que uma coleta anterior fosse
considerada nova. O runner passou a usar `timestamp(up) and (up == 1)`, que conserva
o timestamp real da amostra saudável. Uma regressão com o Prometheus real consulta
um instante entre duas coletas observadas e confere os timestamps de todos os oito
alvos; o controle com a expressão antiga reproduz o defeito.

A correção é do instrumento, sem alteração da aplicação ou dos limites de aceitação.
Ela não transforma A/B/C em resultados da versão corrigida nem invalida suas
reconciliações SQL. Aquelas rodadas não provam a garantia de coleta nova que o runner
pretendia impor; snapshots junto às fronteiras podem conter a última amostra antiga.
Mesmo uma coleta nova pode exportar o último valor de um sampler assíncrono; por isso
um gauge de lag não substitui a consulta SQL de drenagem. As novas medições identificam
separadamente seus fontes e instrumentos.

As rampas full oferecem, pela área dos estágios, aproximadamente 18.825 chegadas
por workload em 120 s, média programada de 156,875/s, e a fase mista oferece o dobro.
O alvo final de 500/s não é um patamar sustentado. Dividir eventos totais pelo tempo
com seed e drenagens também não mede capacidade sustentada. Combinar um teto de VUs,
uma taxa de pico e um percentil da fase não estima tempo de serviço ou espera de pool.

### Oportunidades com benefício ainda não medido

A candidata de atualizações de reserva/confirmação em lote foi medida e descartada,
conforme a comparação abaixo. Aumentar publishers, pools ou recursos não foi aceito
por inspeção: exige ganho consistente, custo explícito e efeito sobre HTTP sob a mesma
taxa total. Patamares constantes de hot, distribuída e mista permitiriam separar esse
efeito da diferença de carga das rampas. Nenhuma dessas possibilidades é apresentada
como melhoria observada nas rodadas históricas.

### Experiência controlada de persistência em lote da outbox

A campanha local `outbox-comparison-1` terminou com seis braços válidos na ordem
B,C / C,B / B,C. Baseline: `66660b9cec0c38ee241d5332f3630d5022430ceb`; candidata: `39d4b89bf60df533cb16706e0f133356225919b8`.
Cada braço usou dados novos, 10.000 carteiras, 40.000 eventos, dois processos publishers,
lote dez, pool máximo dez por processo, lease de 15 s e retry máximo de 300 s.
PostgreSQL e MiniStack tiveram as mesmas imagens efetivas em todos os braços;
nenhum worker, pool, CPU ou memória foi acrescentado. O host local não era exclusivo.
Fontes, imagens e os quatro instrumentos ficaram congelados até a saída real do coordenador.

O critério foi declarado antes da comparação: mediana de ganho de drenagem de pelo
menos 15% e ganho de pelo menos 10% em **cada** par, além de correção integral e
custo justificável. A contagem de SQLs e o uso de CPU são evidências do mecanismo;
não substituem esse critério depois de observar o resultado.

| Braço, em ordem de execução | Drenagem, s | Chamadas SQL não vazias + vazias | CPU dos publishers, µs/evento | Após go p50 / p95 / p99, s |
| --- | ---: | ---: | ---: | ---: |
| 01-baseline | 200,749 | 108.000 + 8 | 651,853 | 41,036 / 179,125 / 196,221 |
| 02-candidate | 183,829 | 36.000 + 8 | 407,640 | 36,464 / 163,529 / 179,497 |
| 03-candidate | 180,083 | 36.000 + 8 | 397,484 | 37,158 / 159,949 / 175,689 |
| 04-baseline | 186,417 | 108.000 + 8 | 621,485 | 38,402 / 166,209 / 182,252 |
| 05-baseline | 233,293 | 108.000 + 8 | 692,570 | 41,015 / 206,815 / 228,080 |
| 06-candidate | 198,209 | 36.000 + 8 | 412,635 | 40,073 / 175,569 / 193,478 |

| Par predefinido | Braços baseline / candidata | Baseline, s | Candidata, s | Ganho de drenagem |
| --- | --- | ---: | ---: | ---: |
| 1 | 01-baseline / 02-candidate | 200,749 | 183,829 | 8,428546% |
| 2 | 04-baseline / 03-candidate | 186,417 | 180,083 | 3,397665% |
| 3 | 05-baseline / 06-candidate | 233,293 | 198,209 | 15,038269% |

A mediana é **8,428546%**. A candidata **não passou**
o critério de benefício. Seus dois arquivos de produção foram restaurados no commit
`eb3fcf2`, com identidade de bytes confirmada contra o baseline. O resultado e a
regressão de falha SQL após envio foram preservados; as medições da candidata
continuam associadas à fonte experimental, sem atribuí-las à implementação retida.

| Braço | Reserva Σ, s | Envio SDK Σ, s | Confirmação Σ, s | p95 reserva / envio / confirmação, ms |
| --- | ---: | ---: | ---: | ---: |
| 01-baseline | 19,347 | 366,563 | 14,610 | 7,029 / 207,009 / 5,134 |
| 02-candidate | 9,621 | 344,227 | 12,692 | 3,538 / 192,148 / 10,875 |
| 03-candidate | 9,273 | 339,803 | 9,998 | 3,102 / 188,536 / 7,893 |
| 04-baseline | 18,602 | 336,792 | 16,394 | 6,505 / 184,191 / 10,422 |
| 05-baseline | 22,232 | 422,461 | 20,636 | 9,552 / 248,373 / 13,519 |
| 06-candidate | 9,588 | 377,898 | 7,946 | 3,565 / 205,564 / 2,691 |

As somas agregam dois processos sobrepostos e não devem ser somadas à drenagem de
parede. Cada reserva/confirmação inclui sua transação até commit; envio mede o wrapper
do SDK, fora dessas transações. No baseline completo foram observadas 14 chamadas na
reserva e 13 na confirmação; na candidata, cinco e quatro. As oito chamadas dos dois
ciclos vazios ficam separadas. A redução de 66,67% dessas chamadas é real; a redução
de drenagem não atingiu o limiar e a cauda de confirmação não melhorou uniformemente.

Todos os braços confirmaram e receberam os 40.000 IDs, tiveram 40.000 efeitos únicos,
uma tentativa normal por outbox e por SDK, fila de eventos vazia e reconciliação das
10.000 carteiras com ledger global consistente. Esses checks ocorreram fora da janela
de drenagem; não há tráfego HTTP nem consumidor concorrente nessa janela.
O seed é excluído da drenagem. Após go mede o retorno do envio antes da confirmação
SQL; idade desde ocorrência inclui o seed e está preservada nos artefatos. Nenhuma
medida é latência HTTP ou capacidade sustentada. CPU cobre recebimento de go até
shutdown dos filhos; RSS de início/fim e pico lifetime não são uma série da drenagem.
A amostragem Docker/SQL é esparsa, e amostras posteriores à drenagem estão identificadas.
As duas versões usam os mesmos wrappers, mas o custo da instrumentação por chamada
não foi quantificado; reduzir chamadas também reduz esse trabalho do observador.
O ganho observado pertence a esse experimento instrumentado, sem extrapolação automática.

O piloto único, menor, serviu somente para justificar medir a hipótese SQL. Ele e o
benchmark diagnóstico recebido da revisão externa não entram nestas tabelas. Os
snapshots do protocolo, instrumentos, manifestos, linhas por lote, recursos e resultados
integrais permanecem associados a `outbox-comparison-1` nos registros externos.
Não houve retry, exclusão de rodada nem seleção de resultado favorável.

### Hipóteses e oportunidades depois da comparação

O envio SDK ocupa a maior parte dos ciclos com este backlog de 40.000 eventos. Isso
não distingue tempo de servidor, SDK, rede ou scheduling, nem identifica qual função
do MiniStack foi responsável. A análise descritiva dos dois primeiros braços encontrou
crescimento de latência entre o primeiro e o último quartil de lotes; o destino também
acumulava mensagens e o tempo transcorria. Esses fatores não foram isolados.
O código oficial do MiniStack sugere trabalho ligado aos dados retidos e às consultas
de atributos, mas equivalência com os bytes da imagem e contribuição causal exigem
provas próprias. Não foi aceito aumento de publishers, pools ou recursos por esse indício.

Na carteira concentrada, a inspeção encontrou oito chamadas de negócio no UOW HTTP
normal com movimento, sete depois de adquirir o lock, sem SQS/HTTP dentro da seção
protegida. Agrupar os dois inserts adjacentes de outbox poderia reduzir oito para sete;
não foi medido nem implementado. Evitar uma consulta de reversão não utilizada por
WIN/LOSS com referência é outra oportunidade de fonte, fora da carga publicada sem
referências. A serialização por carteira continua necessária. As métricas existentes
não medem tempo retendo lock nem fila de checkout do pool; a causa da variação
entre as rodadas distribuídas permanece sem isolamento.

A comparação HTTP a taxa constante estava condicionada à aprovação desta candidata.
Como o gate de drenagem falhou, seus instrumentos preparados não foram executados;
não há resultado HTTP antes/depois dessa alteração. A hipótese SQL não originou uma
campanha aberta de tuning nem uma segunda alteração de aplicação sem custo demonstrado.

## Limites da interpretação

Este é um experimento local com dependências no mesmo host, MiniStack, dados sintéticos e
tráfego de curta duração. Não estima latência de rede AWS, limites do SQS gerenciado,
capacidade de um PostgreSQL de produção ou estabilidade por horas. Os recursos anunciados
pelo Docker não representam recursos exclusivos do processo. O limite de VUs e as rampas
precisam ser considerados ao atribuir saturação à aplicação. A correção financeira é
verificada no estado final; os cenários determinísticos de crash e indisponibilidade ficam
nas suítes `test:concurrency` e `test:failure`.

## Execuções posteriores: fonte retida e AWS

Esta seção conserva os resultados posteriores separadamente de A/B/C. A fonte da
aplicação foi `a98d1e6fe248f2e6bee4f2cf54317fc961aab062`, com árvore limpa durante
as campanhas. O hash dos 16 fontes de carga foi
`36b77c2acde5dc63e35cff9f950c021a8c14601333d87cf590d47de5cc94f161`.
O inventário completo de 115 caminhos também identifica configuração e instrumentos;
igualdade do commit não implica igualdade entre ambiente local e AWS.

### FULL local retido: FAIL

A execução `2026-11-01T22-25-40-451Z-d9d6e892` durou 2.365,950 s
(39 min 26 s). As quatro fases HTTP terminaram, mas o backlog SQS não chegou às
10.000 operações exigidas dentro de 180 s. A observação posterior de 9.910 não
satisfaz a barreira nem transforma a rodada em PASS. Não existe `result.json`
completo aprovado dessa execução.

A prova parcial registrou 1.001 carteiras, 90.351 transações e 180.702 eventos
outbox, ainda com 6.862 não publicados. A parcial passou 2.009 asserções dentro do
seu próprio alcance; não comprova aceitação FULL, esvaziamento final da outbox,
DLQ vazia ou participação final de todas as réplicas. As quatro drenagens HTTP
foram 105.105, 354.193, 335.984 e 728.587 ms, somando 1.523.869 ms.
O PASS manual e as repetições de concorrência não substituem essa reprovação.

### Ambiente AWS e limites da campanha

O [relatório específico AWS](load-test-aws.md) reúne os resultados desta extensão e os links para suas evidências canônicas.

O ambiente da medição usou somente `us-east-2`, com três APIs, três
consumers e dois workers Fargate (1 vCPU/2 GB cada), Keycloak, RDS PostgreSQL 17
single-AZ `db.m7g.2xlarge` com gp3 de 100 GB e TLS verificado, FIFO SQS gerenciado,
ALB interno e runner privado `c7i.2xlarge` por SSM. Não houve NAT Gateway, IP público
ou SSH. A aplicação foi a mesma fonte a98; permissões, filas e instrumentação
operacional têm suas próprias revisões e recibos.

O objetivo prévio era smoke, três FULL e patamares constantes. Falhas de setup
e diagnóstico foram preservadas; o QUICK aprovado foi seguido de um FULL
reprovado, e a dependência de aprovação do predecessor impediu FULL2, FULL3 e
patamares. Não houve repetição de rodada para escolher resultado favorável.
Não há capacidade sustentada AWS medida.

### AWS QUICK aprovado: alcance e valores dos gráficos

A execução `2026-11-02T05-03-13-035Z-f8c997b6` terminou com `passed=true` e
verificação `partial=false`. Sua janela global foi **05:03:13.036–05:05:33.738 UTC**
(140,702 s), incluindo seed, barreiras e drenagens; não é duração de tráfego HTTP.
Foram 1.001 carteiras reconciliadas, 3.251 transações processadas/entradas ledger,
6.502 eventos outbox publicados e 7.502 inbox (1.000 requests + 6.502 events).
O verificador salvo aprovou as assertions de não negatividade e igualdade entre saldo
e reconstrução do ledger; esses dois contadores não foram exportados no agregado.
Os contadores exportados de efeitos duplicados, eventos faltantes, eventos extras,
inbox inacabado e DLQ foram zero nessa prova final.

| Workload QUICK | Requisições concluídas | k6 p50 / p95 / p99, ms |
| --- | ---: | ---: |
| Carteira concentrada | 251 | 13,164591 / 19,8727835 / 22,8096465 |
| Distribuída | 251 | 12,164116 / 17,673816 / 20,6960605 |
| Replays: operações novas | 226 | 11,546586 / 14,9114485 / 17,5743135 |
| Replays: repetidas | 25 | 8,322784 / 12,3270192 / 14,37993352 |
| Mista: concentrada | 251 | 11,209330 / 18,599419 / 45,151222 |
| Mista: distribuída | 251 | 11,002815 / 17,261541 / 41,1588095 |

As quatro fases totalizaram 1.255 respostas, sendo 1.230 novas e 25 replays.
O resumo de conclusão registrou zero descartes, mas a série k6
`dropped_iterations` não foi emitida: ausência da métrica não é uma amostra zero.
As quatro fases usaram no máximo 1/1/1/2 VUs. A drenagem residual da outbox foi
1/0/0/1 ms; as barreiras de cobertura de eventos levaram 8/9/10/11 ms.
Esses tempos de barreira são distintos de latência HTTP e de publicação por evento.

O backlog QUICK tinha 1.000 mensagens e grupos, enqueue de 167 ms, último commit
4.418 ms depois do enqueue, 4.585 ms desde o início e pico observado de 998.
A drenagem residual outbox foi 0 ms e a barreira final de eventos levou 1.889 ms.
Os contadores de cobertura 2.544/3.046/3.498/4.502/6.502 são cumulativos; não devem
ser somados. Todas as três APIs e os dois workers tiveram contadores positivos;
as séries de consumers não fornecem baseline completo por réplica, portanto
não se inventa uma distribuição individual de commits.

Prometheus guardou cinco instantes de cinco em cinco segundos por fase HTTP,
sem série contínua da drenagem. As consultas de taxa/quantis usam sua janela
de lookback de 30 s, que pode alcançar a fase anterior; não representam patamar
estável dos estágios de 7 s. Algumas amostras de quantis estão ausentes/NaN,
e conflitos de lock não foram emitidos. O único ponto Prometheus do backlog
antecede o produtor em cerca de 2 ms: ele não forma uma curva de drenagem.
Gaps, baseline ausente e métricas indisponíveis continuam explícitos nos gráficos.

### AWS FULL1: FAIL, sem gráficos de sucesso

A execução `2026-11-02T05-25-09-577Z-5faa73a3` terminou com `RequestThrottled`
e exit 1. As quatro fases HTTP passaram seus checks, mas o FULL global não passou.
Foram preservados os resumos HTTP, artefatos parciais e diagnósticos; não existem
`result.json` e `verification.json` completos aprovados. O renderer exclui a
rodada inteira e não usa suas fases verdes como gráficos aprovados.

O observador confirmou 136.572 ACKs em 141.359 tentativas, com 4.787 retries e
zero falhas finais de ACK. O primeiro erro SDK registrado era um DeleteMessage
403 recuperado; **não é a operação fatal posterior**, que não foi preservada.
SendMessageBatch é uma inferência forte pelo fluxo e pela interrupção do enqueue,
sem comprovação direta da operação terminal. O verificador parcial também falhou
na igualdade entre total inbox e suas classes; esperados/recebidos não foram
retidos. A possibilidade de snapshots distintos foi reproduzida depois, mas não
estabelece retrospectivamente a causa dessa falha específica.

Depois de parar os quatro serviços, uma única consulta forense read-only,
REPEATABLE READ e TLS, às **05:44:34–05:44:44 UTC**, encontrou 1.001 carteiras
consistentes, zero negativas, 74.210 transações processadas e entradas ledger,
148.420 outbox e zero não publicados. Duplicações, pares financeiros inválidos e
ledger órfão foram zero. Porém havia **136.572 efeitos de eventos e 11.848
faltantes**, com zero extras: cobertura incompleta. São 142.662 inbox (6.090
requests + 136.572 events). A invariância financeira desse snapshot é válida;
`campaignAcceptance=false` e `eventCoverage=false` permanecem. Não se promoveu
essa observação posterior a verificação final do FULL.

### Correções posteriores dos instrumentos

O suporte nativo ao ACK transitório ficou restrito ao consumidor de eventos do
teste de carga, com limite de tentativas e tempo, cancelamento e drain no shutdown.
O efeito SQL já commitado não é reexecutado para repetir DeleteMessage. O runner
também trata explicitamente permissão do YAML não secreto do Prometheus e sua
prontidão, preserva a identidade entre erro SDK terminal e diagnóstico e colhe as
classes inbox no mesmo statement SQL que seu total. Nenhuma mudança altera
dinheiro, transação financeira, locking por carteira, idempotência, ledger,
outbox de produção, migrations ou contratos HTTP/SQS.

Essas correções são posteriores aos resultados a98 acima. Sua aprovação depende
dos testes dirigidos e gates da fonte final, identificados em
[verification.md](verification.md). A medição posterior está identificada no [relatório AWS](load-test-aws.md#terceira-sessão-fonte-e-resultados); esses testes locais não autorizam atribuir às correções o QUICK anterior nem demonstram ganho causal. A política de falhar diante de
assertion, reconciliação, identidade ou limite violado continua a mesma.

## Relatório visual e reprodução dos gráficos

O [índice HTML](load-report/index.html) abre as páginas
[local](load-report/local/index.html), [AWS](load-report/aws/index.html) e
[histórica QUICK](load-report/historical/index.html). Para navegar no browser do host,
execute `docker compose --env-file /dev/null -p wagering up -d --wait docs` na raiz
do repositório e abra `http://localhost:4173/docs/load-report/index.html`. O serviço
`docs` usa Bun 1.4.3, monta os arquivos somente para leitura e sobe sozinho,
sem dependências da aplicação. Seu perfil opcional o mantém fora das campanhas
de teste. `DOCS_HOST_PORT` altera a porta publicada; para parar somente o preview,
use `docker compose --env-file /dev/null -p wagering stop docs`. A alternativa
sem Docker continua sendo `bun run docs:preview`. No Dev Container, encaminhe a
porta escolhida na aba **Portas** do VS Code se necessário. Cada página também funciona por
`file://` quando o navegador tem acesso à árvore completa; o portal do desktop pode
compartilhar só o arquivo aberto e impedir os links vizinhos. As páginas ficam
em português, nos temas claro/escuro e em tela estreita. Os
gráficos são SVG inline: o HTML é autossuficiente, com JavaScript local para o
menu de aparência Automático/Claro/Escuro na barra superior e sem bibliotecas externas. Pelo
servidor, os links para Markdown abrem documentos formatados com a mesma barra e a preferência
de tema salva; títulos, tabelas, código e âncoras permanecem navegáveis. As fontes de cada campanha permanecem visíveis, sem juntar fases de
fontes diferentes.

As páginas FULL incluem quantis HTTP por fase, vazão observada, descartes do
gerador, séries de commits, erros de processamento, conflitos de lock, lag da
outbox, backlog SQS e o oráculo financeiro final. Os gráficos usam eixos Y a partir
de zero e fronteiras de fase. Não há suavização, downsampling que esconda picos ou
média entre percentis. `NaN` e amostras ausentes são lacunas. Uma métrica ausente
continua `UNKNOWN`, incluindo `dropped_iterations` ausente no resumo k6, mesmo
quando o runner registrou zero por fallback. As séries `rate()` mantêm sua janela
anterior: o gráfico mostra os primeiros 30 s, sem chamá-los de regime estável.

As projeções fechadas [local](load-report/local/campaign.json) e
[AWS](load-report/aws/campaign.json) são versionadas com o relatório. Contêm
somente contagens, quantis, configuração numérica, séries anônimas e SHA-256 dos
agregados originais. Não contêm payloads financeiros, fixtures, identificadores
de infraestrutura ou caminhos privados. Com Bun 1.4.3, a partir da raiz do clone,
é possível recriar cada HTML sem os caches originais, Docker ou AWS. Os destinos
abaixo precisam ainda não existir:

A contagem de rodadas, a fonte, a janela UTC, a topologia e os parâmetros numéricos
são derivados da projeção. Detalhes externos, como o tipo da instância RDS e a
mudança do health check do ALB, aparecem somente quando a identidade corresponde
à campanha conhecida; para outras entradas esses metadados permanecem `UNKNOWN`.

```bash
BUN_CONFIG_NO_ENV_FILE=true BUN_CONFIG_NO_AUTO_INSTALL=true bun --no-env-file scripts/render-load-report.ts \
  --campaign-data docs/load-report/local/campaign.json \
  --output-dir /tmp/wagering-load-report-local
```

```bash
BUN_CONFIG_NO_ENV_FILE=true BUN_CONFIG_NO_AUTO_INSTALL=true bun --no-env-file scripts/render-load-report.ts \
  --campaign-data docs/load-report/aws/campaign.json \
  --output-dir /tmp/wagering-load-report-aws
```

Para recalcular a projeção a partir dos agregados originais, o mesmo script aceita
`--campaign local` ou `--campaign aws`, um `--run DIR` para cada rodada e
`--output-dir NEW_DIR`. Cada campanha precisa ser FULL, aprovada, não parcial e
compartilhar fonte e hash de carga. O renderer abre somente nomes literais de
`environment.json`, `result.json`, `verification.json`, resumos k6, counters e
Prometheus permitidos. Não enumera o diretório, não lê JSONL, fixtures, manifests
privados ou credenciais. Provas financeiras inconsistentes, hash divergente,
diretórios repetidos, symlinks e destino existente/sobreposto são recusados.

A CLI histórica com `--aws-quick`, `--local-full`, `--aws-full-1` e `--output-dir`
continua disponível para reproduzir o recorte `a98d1e6`/`36b77c2a` a partir de
seus três diretórios. Seus SVGs exportados estão em
[historical/](load-report/historical/index.html), com as exclusões originais.
