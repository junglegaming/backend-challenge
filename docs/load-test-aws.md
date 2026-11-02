# Teste complementar de carga na AWS

**Um FULL foi aprovado integralmente na AWS:** `2026-11-02T16-38-47-783Z-354c2da7`, em 02/11/2026. A execução concluiu as quatro fases HTTP, os 10.000 comandos SQS, a cobertura de eventos e a reconciliação financeira. Os FULL anteriores reprovados conservam esse resultado.

Abra o [relatório HTML AWS](load-report/aws/index.html) para explorar gráficos e contadores offline. O [hub de resultados](load-report/index.html) também oferece os [três FULL locais históricos](load-report/local/index.html) e o [QUICK AWS histórico](load-report/historical/index.html). As fontes e os instrumentos diferem; esses painéis não constituem uma comparação controlada entre ambientes.

## FULL aprovado: fonte, ambiente e método

<a id="quarta-sessão-full3-aprovado"></a>

| Identificação | Valor |
| --- | --- |
| Perfil e alvo | `full/standard/remote`, identificado como FULL3 na quarta sessão |
| Aplicação e imagens | `d52abedad905f02c03c5a10ba5f16598271ef888` |
| Manifesto do núcleo, 115 arquivos | `4e92bf7da9f722005c87f04cd5eb4d277326e20f507cf886edafb6752a654e7d` |
| `loadSourceSha256` | `0d029aecc50c418ba0c6e9154b08d0310911f08399928c2068c5bf5ea4628f5e` |
| Janela do runner, UTC | 02/11/2026, 16:38:47.783 → 16:51:17.815; 12 min 30 s, incluindo preparo, tráfego, drenagem e verificação |
| Orquestração remota, UTC | 16:38:45.416 → 16:51:32.228; comando SSM concluído com sucesso e exit 0 |
| Aceitação | `result.passed=true`; verificação `passed=true/partial=false` |

O ambiente em **us-east-2** tinha ALB interno, três APIs, três consumers, dois workers e um Keycloak em ECS/Fargate, com 1 vCPU/2 GiB por task. O banco era RDS PostgreSQL 17, Single-AZ, `db.m7g.2xlarge`, 100 GiB gp3, com TLS verificado. O runner privado `c7i.2xlarge` usou Bun 1.4.3 e Docker 25.0.18. A rodada começou com banco novo e filas vazias. A topologia e o procedimento estão em [operação AWS](../infra/aws/README.md).

Cada fase HTTP configurou rampas de **25/100/250/500 requisições/s por workload**, por 30 s em cada estágio, até 300 VUs. A fase mista executou duas rampas simultâneas. Taxa configurada é oferta pretendida; os descartes do gerador precisam ser considerados para interpretar a taxa efetiva.

Antes do FULL3, o health check do ALB mudou de `/health/ready` para `/health/live`: no FULL2, o scheduler havia encerrado uma API por health check e a fase mista perdeu a participação saudável exigida. A readiness continua verificando PostgreSQL e as filas; a liveness permite avaliar o processo sem substituí-lo por uma indisponibilidade transitória de dependência. A causa específica que tornou a API unhealthy no FULL2 não foi preservada. O ajuste de infraestrutura estava aplicado e ainda não commitado na medição, fora do manifesto do núcleo.

## Resultados HTTP

Req/s é `iterations.rate` do k6, incluindo replays; p50/p95/p99 são `http_req_duration` do cliente. Lag é o maior valor amostrado de `outbox_lag_seconds` na janela de tráfego, convertido para ms: **não mede entrega SQS**.

| Fase | Requisições | Req/s | p50 ms | p95 ms | p99 ms | Descartes reportados | Pico lag ms |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| Carteira única | 11.521 | 94,49 | 1.691,57 | 2.042,63 | 2.938,74 | 7.303 | 310,49 |
| Mil carteiras | 18.824 | 156,83 | 9,23 | 17,42 | 90,58 | indisponível | 243,29 |
| Replays | 18.824 | 156,84 | 9,09 | 19,18 | 182,68 | indisponível | 256,73 |
| Única + distribuídas | 22.668 | 185,62 | 1.344,01 | 2.553,05 | 2.770,50 | 14.980 | 346,66 |

As quatro fases passaram os checks e thresholds de contrato: erros HTTP inesperados, falhas HTTP, backpressure e recuperação HTTP foram zero. Das 71.837 requisições, 1.882 eram replays; os 69.955 comandos únicos produziram efeitos financeiros. As séries de conflitos de lock estavam ausentes e permanecem **indisponíveis**.

Os **22.283 descartes reportados** impedem afirmar entrega dos alvos de 500 req/s por workload. Ausência da métrica nas fases distribuída e replays não é uma medição de zero. As fases também não isolam o efeito do ambiente, do instrumento ou da correção do ALB.

## SQS e recuperação de throttling

Requests e events eram FIFO de alta vazão: `ContentBasedDeduplication=false`, `DeduplicationScope=messageGroup` e `FifoThroughputLimit=perMessageGroupId`. Os IDs explícitos de deduplicação foram preservados.

| Medição | Resultado |
| --- | --- |
| Produtor de requests | 10.000 mensagens confirmadas; 1.000 batches; 1.011 tentativas; **11 retries** por throttling |
| Enqueue e backlog | 2.313 ms de enqueue; pico amostrado de 9.169 mensagens |
| Drenagem | Requests concluídos 32.282 ms após enqueue; drenagem adicional de efeitos/ACKs de 32.849 ms |
| ACK de eventos | **161.952 ACKs concluídos**, em 169.437 tentativas; **7.485 retries** `DeleteMessageCommand/RequestThrottled/HTTP403` |
| Falhas terminais | Zero failed/exhausted no produtor e no ACK; zero deadlineStopped ou erro fatal no observer |

O produtor acumulou 606 ms de backoff; o ACK, 239.378 ms, com até seis tentativas observadas. Backoff agregado soma esperas concorrentes e não representa duração de parede. A recuperação de throttling real foi demonstrada nesses dois caminhos do instrumento remoto. O limite de tentativas do SDK compartilhado e os retries da aplicação não foram ampliados por essa correção.

## Prova financeira e participação

A verificação **integral**, sem modo parcial, aprovou saldo reconstruído pelo ledger, cadeia e versões, identidades persistidas e cobertura exata dos eventos:

| Conjunto final | Quantidade |
| --- | ---: |
| Carteiras reconciliadas | 1.001 |
| Transações = processados = lançamentos de ledger | **80.976** |
| Eventos de outbox publicados e observados | **161.952** |
| Inbox de requests / eventos | 10.000 / 161.952 |
| Não publicados, inbox inacabada, efeitos duplicados, eventos desconhecidos e DLQ | **0** |

Os 80.976 efeitos correspondem a 1.001 aberturas + 20 seeds + 69.955 comandos HTTP únicos + 10.000 comandos SQS. Não houve eventos missing/extra/invalid, duplicatas observadas ou handlers ainda ativos. A publicação `occurred_at → published_at` registrou p50/p95/p99 de **38/188/252 ms**, distinta da latência HTTP e da entrega SQS.

As três APIs, os três consumers e os dois workers tiveram contadores finais positivos. APIs/workers possuem correspondência ao baseline. Os consumers não tinham séries no baseline; seus contadores finais de 3.914/3.003/3.083 comprovam processamento, sem estabelecer deltas individuais antes/depois. O sampler coletou 150 amostras sem falha. CloudWatch concluiu 22 consultas, com 23 séries e 227 pontos; três séries não tinham datapoints e os buckets tinham cobertura incompleta. Lacunas são desconhecidas, sem interpolação ou preenchimento com zero.

## Histórico e limites

<a id="terceira-sessão-fonte-e-resultados"></a>

| Fonte / campanha | Resultado preservado |
| --- | --- |
| `a98d1e6 / 36b77c…` | QUICK smoke5 aprovado como diagnóstico; FULL1 reprovado com `RequestThrottled`, sem operação terminal diretamente identificada e sem resultado integral. A fotografia financeira posterior não comprovou cobertura completa de eventos. Ver [histórico](load-test.md#aws-full1-fail-sem-gráficos-de-sucesso). |
| `3fa0f86 / 0d029…`, terceira sessão | QUICK `2026-11-02T09-28-44-876Z-f11a5307` aprovado: 3.251 efeitos/6.502 eventos. FULL1 `2026-11-02T09-50-56-943Z-49ff30ff` reprovado; revisão dirigida infere timeout na espera de scrape saudável após a fase mista. Snapshot parcial: 66.284 efeitos/132.568 eventos; fase SQS de 10.000 comandos não iniciada. FULL2/FULL3 e patamares não começaram. |
| `d52abed / 0d029…`, quarta sessão | FULL1 e FULL2 reprovados. **FULL3 aprovado**, descrito nesta página. A aprovação posterior não reclassifica as duas falhas. |

Há **uma rodada FULL AWS aprovada**, sem três FULL comparáveis, patamares sustentados ou capacidade máxima demonstrada. Os três FULL locais A/B/C pertencem à fonte histórica `06e6165 / c99c4a…`, com diferenças de instrumento documentadas no [relatório local](load-test.md). Não há comparação local/AWS controlada nem ganho de desempenho atribuído à correção do health check.

Os HTML usam projeções fechadas dos agregados, com fonte e hashes, sem payloads financeiros ou identificadores de recursos. A [reprodução dos relatórios](load-test.md#relatório-visual-e-reprodução-dos-gráficos) funciona offline; os agregados privados completos não acompanham o clone. A revisão desses artefatos confirma sua consistência e integridade, sem constituir uma nova consulta independente ao banco após a campanha.
