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
com PostgreSQL. Cada 200 novo precisa corresponder a uma operação persistida. Somente as
operações ausentes correspondentes aos 503 são reenviadas, com a chave e corpo originais,
fora da janela medida. O relatório separa esse tempo de recuperação. Depois, espera a
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

## Como ler os artefatos

`<fase>.json` contém as métricas k6, incluindo contagens, p50 (`med`), p95 e p99 em ms.
`result.json` identifica fases, recuperação dos 503, descartes do gerador e drenagem.
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

`<fase>-counters.json` e `participation.json` guardam snapshots brutos. Deltas positivos
de tentativas nas três APIs e nos três consumers e de eventos nos dois workers comprovam
trabalho nas oito réplicas após a seed. Um scrape posterior à conclusão evita tomar uma
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

O HEAD registrado era `637e10b5955ba0d83a0593e9f91d99c5f9851399`, com as alterações
da carga ainda locais. As três rodadas apontam para o mesmo hash dos oito
fontes de carga/configuração:
`ad9d6c41b7917eccbd9a29e8a80fe31277b904a9f6f1b32099b304156d78c1d1`.
Esse hash identifica os arquivos enumerados em `scripts/load-test.ts`; o ID Docker
identifica a imagem da aplicação. Ele não é um hash de todo o repositório.

### Três execuções completas

As três rodadas abaixo passaram integralmente. As contagens financeiras incluem 1.001 aberturas e vinte comandos da seed; replays devolvem efeitos existentes. A execução A foi escolhida como referência detalhada antes dos resultados de B e C.

| Rodada | runId | Início → fim, UTC em 01/11/2026 | Duração, s | Transações = entradas no ledger | Eventos distintos |
| --- | --- | --- | ---: | ---: | ---: |
| A | `2026-11-01T06-54-45-433Z-36e8cf6c` | 06:54:45.493 → 07:34:44.245 | 2.398,752 | 91.606 | 183.212 |
| B | `2026-11-01T07-35-00-374Z-8e545fa0` | 07:35:00.438 → 08:14:51.018 | 2.390,58 | 91.765 | 183.530 |
| C | `2026-11-01T08-15-07-216Z-c711bca9` | 08:15:07.297 → 08:54:46.607 | 2.379,31 | 91.722 | 183.444 |

Em todas: 1.001 carteiras reconciliadas, 10.000 registros inbox concluídos, nenhuma outbox pendente, nenhuma mensagem na DLQ e nenhum efeito financeiro duplicado. Os oito processos tiveram participação positiva depois da seed. Cada prova final passou com 2.006 asserções.

| Rodada | ID registrado da imagem da aplicação |
| --- | --- |
| A | `sha256:baa379a60ea0ea02cccfc36dbbc6ac722236e56990365f18a20815df1ce86694` |
| B | `sha256:6cba84b5ced8a3d95c56df3b509b564c32a0a66cc37ae6ad677cf5ceba4e4ef5` |
| C | `sha256:8d03692059e04a1e508171ed7b2901f08b6c0cd34a2ebfc2625ca629e26b478a` |

Os IDs diferem; a inspeção dos três IDs mostrou as mesmas onze camadas de arquivos e rótulos de serviço Compose diferentes (`api`, `consumer`, `worker`). As medições usam os mesmos fontes e arquivos de aplicação, mas os IDs completos não são apresentados como idênticos.

### HTTP por rodada

As taxas são as médias dos contadores emitidas pelo k6. Os percentis são do cliente, em ms, sobre a fase inteira. `Replay` é uma resposta bem-sucedida que não cria outra transação financeira.

| Rodada | Fase / workload | Sucessos HTTP | Requisições/s | p50, ms | p95, ms | p99, ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| A | `hot_wallet` / hot | 15.481 | 127,811 | 24,594 | 1.220,535 | 1.280,833 |
| A | `distributed_wallets` / distributed | 18.592 | 154,907 | 7,224 | 460,935 | 945,372 |
| A | `replays` / distributed | 16.942 | 141,165 | 4,965 | 8,086 | 13,922 |
| A | `replays` / replay | 1.882 | 15,681 | 3,05 | 5,267 | 8,061 |
| A | `hot_plus_distributed` / hot | 14.519 | 119,591 | 125,395 | 1.459,394 | 1.556,325 |
| A | `hot_plus_distributed` / distributed | 15.051 | 123,973 | 169,428 | 1.322,071 | 1.425,433 |
| B | `hot_wallet` / hot | 15.514 | 128,112 | 122,603 | 1.217,967 | 1.266,829 |
| B | `distributed_wallets` / distributed | 18.824 | 156,846 | 4,91 | 8,643 | 18,192 |
| B | `replays` / distributed | 16.942 | 141,166 | 4,928 | 8,407 | 18,446 |
| B | `replays` / replay | 1.882 | 15,681 | 3,027 | 5,343 | 13,079 |
| B | `hot_plus_distributed` / hot | 14.479 | 119,507 | 114,304 | 1.452,638 | 1.527,67 |
| B | `hot_plus_distributed` / distributed | 14.985 | 123,683 | 87,033 | 1.317,948 | 1.388,694 |
| C | `hot_wallet` / hot | 15.553 | 128,431 | 24,959 | 1.226,749 | 1.296,409 |
| C | `distributed_wallets` / distributed | 18.796 | 156,611 | 5,106 | 72,787 | 212,614 |
| C | `replays` / distributed | 16.942 | 141,153 | 4,968 | 7,879 | 12,017 |
| C | `replays` / replay | 1.882 | 15,68 | 3,06 | 4,811 | 7,597 |
| C | `hot_plus_distributed` / hot | 14.431 | 119,053 | 93,377 | 1.472,963 | 1.628,028 |
| C | `hot_plus_distributed` / distributed | 14.979 | 123,574 | 19,596 | 1.333,568 | 1.482,312 |

Todas as requisições iniciadas nessas rodadas corresponderam a 200 esperado e as checagens de contrato passaram. A taxa observada de status inesperado foi zero. As séries `backpressure_*` estavam ausentes e os contadores de sucessos igualaram os de requisições: nenhum 503 foi observado. Não houve reenvio de recuperação. Cada fase de replay teve 1.882 replays e 16.942 comandos novos.

### Carga entregue e drenagem residual

| Fase | Requisições iniciadas A / B / C | Iterações descartadas A / B / C | Pico de VUs A / B / C | Drenagem outbox A / B / C, s |
| --- | ---: | ---: | ---: | ---: |
| `hot_wallet` | 15.481 / 15.514 / 15.553 | 3.343 / 3.310 / 3.271 | 300 / 300 / 300 | 106,33 / 104,452 / 104,422 |
| `distributed_wallets` | 18.592 / 18.824 / 18.796 | 232 / 0 / 28 | 243 / 8 / 35 | 339,23 / 343,144 / 342,03 |
| `replays` | 18.824 / 18.824 / 18.824 | 0 / 0 / 0 | 8 / 12 / 4 | 321,86 / 321,355 / 319,571 |
| `hot_plus_distributed` | 29.570 / 29.464 / 29.410 | 8.078 / 8.184 / 8.238 | 600 / 600 / 600 | 728,561 / 722,895 / 717,058 |

Cada fase simples programou 18.824 iterações; a mista programou 37.648. Descartes não chegaram à aplicação. Em A, a fase distribuída teve descartes mesmo com pico observado de 243 VUs, abaixo do máximo de 300; sua causa não foi demonstrada como esgotamento desse teto.

### Backlog SQS

| Medida | A | B | C |
| --- | ---: | ---: | ---: |
| Comandos novos | 10.000 | 10.000 | 10.000 |
| Grupos FIFO | 1.000 | 1.000 | 1.000 |
| Envio pelo produtor, s | 87,001 | 86,845 | 86,16 |
| Taxa média de envio, comandos/s | 114,941 | 115,148 | 116,063 |
| Conclusão após último envio, s | 173,272 | 172,082 | 169,818 |
| Início do produtor até processamento SQL e fila de entrada vazia, s | 260,273 | 258,927 | 255,978 |
| Pico amostrado do backlog de entrada | 7.110 | 7.100 | 7.110 |
| Drenagem residual da outbox SQS, s | 108,123 | 109,625 | 106,853 |
| Soma das cinco drenagens residuais, s | 1.604,104 | 1.601,471 | 1.589,934 |

A conclusão SQS combina todas as operações em `PROCESSED` com a fila de entrada vazia. O envio e o consumo se sobrepõem. O intervalo após o último envio não é throughput isolado do consumer nem percentil por mensagem. Ele inclui a espera pelo commit e depois pelos acks; a proximidade de 180 s não equivale à folga exata de um único prazo. Os histogramas dos consumers medem a tentativa após a entrega e excluem a espera na fila.

Os artefatos citados são `load/results/<runId>/environment.json`, `result.json`, `verification.json`, os quatro resumos HTTP, os cinco arquivos `*-prometheus.json` e `participation.json`. Eles ficam fora do Git, conforme a política de resultados reproduzíveis. Os números publicados acima foram extraídos desses arquivos; nenhum ensaio diagnóstico parcial foi incluído.

### Amostra por réplica da execução A

Os valores abaixo são taxas móveis de 30 s no mesmo ponto final de cada fase.
Os percentis do servidor são estimativas dos buckets, em ms. A fase hot termina
em 06:57:26.848 UTC, a mista em 07:16:17.790 e a SQS em 07:32:48.791.
Os primeiros 30 s de cada intervalo foram excluídos. As séries terminam antes
da drenagem residual. IDs de rede pertencem apenas a essa stack.

| Fase / réplica | Novas transações/s ou eventos/s | Processamento p50 / p95 / p99, ms | Espera de lock p50 / p95 / p99, ms |
| --- | ---: | --- | --- |
| Hot / API `10.250.1.11:3000` | 85,04 tx/s | 1.330,605 / 1.933,060 / 1.986,612 | 157,361 / 240,736 / 248,147 |
| Hot / API `10.250.1.14:3000` | 84,56 tx/s | 1.322,001 / 1.932,200 / 1.986,440 | 157,237 / 240,724 / 248,145 |
| Hot / API `10.250.1.8:3000` | 84,20 tx/s | 1.168,641 / 1.916,864 / 1.983,373 | 152,379 / 240,238 / 248,048 |
| Hot / worker `10.250.1.12:3000` | 88,40 eventos/s | N/A | N/A |
| Hot / worker `10.250.1.9:3000` | 86,80 eventos/s | N/A | N/A |
| Mista / API `10.250.1.11:3000` | 153,92 tx/s | 1.436,768 / 1.943,677 / 1.988,735 | 1,627 / 230,543 / 246,610 |
| Mista / API `10.250.1.14:3000` | 154,04 tx/s | 1.389,312 / 1.938,931 / 1.987,786 | 1,627 / 231,167 / 247,059 |
| Mista / API `10.250.1.8:3000` | 156,24 tx/s | 1.441,681 / 1.944,168 / 1.988,834 | 1,000 / 230,459 / 246,760 |
| Mista / worker `10.250.1.12:3000` | 28,80 eventos/s | N/A | N/A |
| Mista / worker `10.250.1.9:3000` | 28,40 eventos/s | N/A | N/A |
| SQS / consumer `10.250.1.10:3000` | 14,80 tx/s | 30,000 / 48,000 / 49,600 | 4,877 / 9,488 / 9,898 |
| SQS / consumer `10.250.1.13:3000` | 15,20 tx/s | 30,000 / 48,000 / 49,600 | 4,203 / 9,420 / 9,884 |
| SQS / consumer `10.250.1.7:3000` | 15,20 tx/s | 30,000 / 48,000 / 49,600 | 4,639 / 9,464 / 9,893 |
| SQS / worker `10.250.1.12:3000` | 28,40 eventos/s | N/A | N/A |
| SQS / worker `10.250.1.9:3000` | 28,40 eventos/s | N/A | N/A |

Somando apenas os pontos alinhados, as APIs fizeram 253,80 tx/s no fim de hot e
464,20 tx/s no fim da fase mista; os consumers fizeram 45,20 tx/s no fim de SQS.
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
foi 23,417454 s em hot, 65,045012 s na fase mista e 78,902659 s em SQS. Esses números
cobrem as janelas de tráfego registradas, não o máximo durante a drenagem posterior.

Os snapshots finais comprovaram trabalho em todas as três APIs, três consumers e dois
workers depois da seed. Na execução A, os consumers terminaram com 3.330, 3.330 e
3.340 tentativas SQS; os workers com 91.543 e 91.669 confirmações de publicação.
As contagens de participação não substituem os totais financeiros exatos no SQL.

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
drenagens residuais longas. Na execução A, as cinco drenagens somaram 1.604,104 s,
cerca de 26 min 44 s dos 39 min 59 s totais. O relatório separa esse tempo da latência
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
na suíte `test:failure`.
