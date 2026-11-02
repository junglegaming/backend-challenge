# Teste complementar de carga na AWS

Esta página separa a campanha histórica a98 da [terceira sessão](#terceira-sessão-fonte-e-resultados), dedicada à fonte posterior às correções de instrumento. A campanha histórica produziu um QUICK diagnóstico aprovado e um FULL reprovado; seu gate de predecessor impediu FULL2, FULL3 e os patamares. Os resultados novos têm fonte e provas próprias e não reclassificam falhas anteriores.

## Ambiente, fonte e parâmetros

A aplicação da campanha histórica foi `a98d1e6fe248f2e6bee4f2cf54317fc961aab062`, com
`loadSourceSha256=36b77c2acde5dc63e35cff9f950c021a8c14601333d87cf590d47de5cc94f161`.
Revisões posteriores de instrumentos e Terraform não renomeiam essa evidência.
Em `us-east-2`, o ambiente usou três APIs, três consumers e dois workers Fargate,
Keycloak, RDS PostgreSQL 17 single-AZ `db.m7g.2xlarge`, gp3 de 100 GB, TLS verificado,
SQS FIFO gerenciado, ALB interno e runner privado `c7i.2xlarge` por SSM. Não houve
NAT Gateway, IP público ou SSH. A topologia e o procedimento estão em
[rede e dimensionamento](../infra/aws/README.md#rede-e-dimensionamento) e
[ordem de operação](../infra/aws/README.md#ordem-de-operação).

O QUICK histórico usou `quick/standard/remote`: quatro fases HTTP com estágios de sete
segundos, 1.001 carteiras e backlog de 1.000 comandos. A aprovação final salvou
`passed=true` e `partial=false`. É uma prova diagnóstica de setup e invariantes;
não equivale a FULL, três rodadas ou capacidade sustentada. As medições, janelas,
lacunas de amostragem e parâmetros estão na seção canônica
[AWS QUICK aprovado](load-test.md#aws-quick-aprovado-alcance-e-valores-dos-gráficos).

## FULL falho e fronteiras da interpretação

O FULL1 histórico usou `full/standard/remote` e terminou com `RequestThrottled`, exit 1.
A operação terminal não foi identificada diretamente. Seus checks HTTP aprovados
não aprovam a rodada inteira; não existem resultado e verificação finais completos
aprovados. A coleta técnica bem-sucedida também não muda o resultado da carga.
Os detalhes permanecem em [AWS FULL1: FAIL](load-test.md#aws-full1-fail-sem-gráficos-de-sucesso).

Depois da parada dos serviços, um snapshot forense read-only confirmou invariantes
financeiros naquele instante, mas encontrou cobertura de eventos incompleta:
`campaignAcceptance=false` e `eventCoverage=false`. Essa consulta posterior não
substitui a verificação final ausente nem reclassifica o FULL. A falha secundária
do verificador parcial e a regressão corrigida posteriormente são tratadas
separadamente em [verificação financeira](verification.md#aws-full-1-fail-verificador-secundário-e-forense-posterior-separados).

A comparação quantitativa FULL local/AWS da coorte histórica está indisponível: ambos os FULL da
coorte retida falharam e são excluídos integralmente. O relatório visual mostra
somente o QUICK elegível, identificado como diagnóstico; os três FULL locais
históricos de outra fonte não preenchem essa lacuna. Ver
[fronteiras e reprodução dos gráficos](load-test.md#relatório-visual-e-reprodução-dos-gráficos).
Não há ganho de desempenho demonstrado nem otimização de desempenho retida.

## Correção local posterior ao FULL falho

O gerador remoto agora trata `RequestThrottled` HTTP 400/403 com até sete
tentativas e prazo total de 20 s por lote. Cada chamada respeita o tempo restante,
com teto de 10 s; o backoff usa jitter e responde ao cancelamento da campanha.
As identidades e os corpos das mensagens permanecem iguais. Respostas parciais
precisam confirmar cada entrada exatamente uma vez: somente entradas com throttle
e `SenderFault=false` são reenviadas. Erro permanente, confirmação inconsistente
ou esgotamento encerra a produção e mantém a rodada reprovada.

Requests passa a declarar o mesmo modo FIFO de alta vazão de events. Um preflight
registra e valida os atributos efetivos antes de criar carteiras. O runner coleta
`sqs-queue-modes.json` e `sqs-producer.json`, com atributos fechados e contadores,
inclusive na falha de produção. A política do SDK compartilhado e o caminho
Compose conservam uma tentativa; os critérios financeiros e de conclusão da
carga permanecem os mesmos.

Essa correção trata uma falha alcançável do gerador, cuja implementação anterior
encerrava no primeiro throttle. A operação terminal histórica continua desconhecida.
Testes com falhas injetadas não comprovam recuperação de throttling AWS real.
A nova medição foi autorizada. A sequência continua QUICK → FULL1 → FULL2 →
FULL3 → patamares, exigindo aprovação integral de cada predecessor. Os resultados anteriores não foram reclassificados. As aprovações e falhas da fonte posterior constam abaixo, sem transferência de métricas entre campanhas.

## Terceira sessão: fonte e resultados

A fonte fixada para a nova campanha é `3fa0f8614d4a7476f1ec495902bd2b407c082cf5`, com `loadSourceSha256=0d029aecc50c418ba0c6e9154b08d0310911f08399928c2068c5bf5ea4628f5e` e manifesto de origem `9f6b94540cec5b53f71296bb8b69a230b8d0de1868f68f5b874da5cd82fcbdf9`. O inventário fixado contém 115 caminhos. A prova de origem de cada unidade iniciada pertence aos respectivos registros; mudanças exclusivamente documentais posteriores não renomeiam a fonte medida.

O ambiente efetivamente observado foi AWS us-east-2, com ALB interno, 3 APIs, 3 consumers, 2 workers e 1 Keycloak em ECS/Fargate; tasks de 1 vCPU/2 GiB; runner c7i.2xlarge com Linux x64, Bun 1.4.3 e Docker 25.0.18; RDS db.m7g.2xlarge com PostgreSQL 17.11, Single-AZ e 100 GiB gp3 criptografados, sem exposição pública. A QUICK usou ramping-arrival-rate com estágios de 5/15/30 operações por segundo por workload durante 7 segundos cada, até 300 VUs por workload; hot_plus_distributed executou hot e distributed simultaneamente; ingress pelo ALB interno. Na FULL1, o mesmo ambiente registrou perfil full com estágios-alvo de 25/100/250/500 operações por segundo por workload, de 30 segundos cada, e até 300 VUs por workload; essas taxas configuradas não representam capacidade atingida. As janelas de medição UTC foram QUICK de 2026-11-02T09:28:44.877Z a 2026-11-02T09:31:03.797Z (138.920 ms no runner); orquestração remota de 2026-11-02T09:28:38.086Z a 2026-11-02T09:31:18.726Z. A janela solicitada ao CloudWatch coincide com a do runner; buckets de recurso podem cobrir frações externas às fases HTTP. FULL1: transport 2026-11-02T09:50:40.299Z→10:02:21.008Z (700.709 ms); janela execution/orquestração 2026-11-02T09:50:54.589Z→10:02:16.539Z, também usada no CW. Como result.json final está ausente, essa janela não é apresentada como janela de uma rodada FULL aceita nem como recorte exclusivo de fase HTTP; buckets CW podem sobrepor fases/setup/drains. FULL2, FULL3 e os seis patamares não possuem janelas de execução. A sequência exige bancos novos nos limites definidos no procedimento, namespaces separados e os critérios originais; coleta técnica e verificação parcial não equivalem a aprovação global.

| Unidade, ordem prevista | Identificador observado | Resultado e alcance |
| --- | --- | --- |
| QUICK | 2026-11-02T09-28-44-876Z-f11a5307 | Aceita como diagnóstico, com resultado completo e verificação financeira não parcial: 1.001 wallets, 3.251 transações/processados/entradas de ledger, 6.502 eventos de outbox publicados e reconhecidos, 1.000 mensagens de requests concluídas; unpublished, unfinished_inbox, duplicate_effects e DLQ em zero. As quatro fases HTTP passaram, com 251/251/251/502 requisições em hot_wallet/distributed_wallets/replays/hot_plus_distributed, 25 replays, sem backpressure nem dropped iterations. Participação observada de 3 APIs, 3 consumers e 2 workers; QUICK não comprova desempenho sustentado de FULL |
| FULL1 | 2026-11-02T09-50-56-943Z-49ff30ff | FAILED, erro primário load/LoadFailed, sem result.json ou verification.json integral. A revisão dirigida infere timeout de 20 segundos na espera de scrape novo e saudável dos oito targets após hot_plus_distributed, pelo fluxo pinado, stack de pollUntil e fronteira dos artefatos; a mensagem completa, o target e a causa de infraestrutura não foram preservados. Os quatro summaries k6 passaram checks/status, com 26.977 dropped iterations reportadas; isso não aprova a rodada. O snapshot financeiro parcial passou, mas não houve fase produtora/backlog SQS de 10.000 comandos nem prova final de participação; sem retry ou execução sucessora |
| FULL2 | não iniciado (sem runId) | FULL2 não iniciado: predecessor FULL1 reprovado; não há execução, métricas ou resultado próprio |
| FULL3 | não iniciado (sem runId) | FULL3 não iniciado: predecessor FULL1 reprovado; não há execução, métricas ou resultado próprio |
| Patamar hot50 | não iniciado (sem runId) | Patamar não iniciado: predecessor FULL1 reprovado; não há execução, métricas ou resultado próprio |
| Patamar distribuída50 | não iniciado (sem runId) | Patamar não iniciado: predecessor FULL1 reprovado; não há execução, métricas ou resultado próprio |
| Patamar mista25+25 | não iniciado (sem runId) | Patamar não iniciado: predecessor FULL1 reprovado; não há execução, métricas ou resultado próprio |
| Patamar mista50+50 | não iniciado (sem runId) | Patamar não iniciado: predecessor FULL1 reprovado; não há execução, métricas ou resultado próprio |
| Patamar distribuída100 | não iniciado (sem runId) | Patamar não iniciado: predecessor FULL1 reprovado; não há execução, métricas ou resultado próprio |
| Patamar hot100 | não iniciado (sem runId) | Patamar não iniciado: predecessor FULL1 reprovado; não há execução, métricas ou resultado próprio |

### Prova financeira

A prova financeira, a cobertura de eventos, a drenagem e a participação das oito réplicas registraram: Prova integral disponível apenas para a QUICK diagnóstica aceita; seus 1.001 wallets, 3.251 efeitos financeiros, 6.502 eventos e participação 3/3/2 permanecem atribuídos àquela execução. Na FULL1, a prova é explicitamente PARCIAL: partial=true/passed=true, 1.001 wallets, transactions=processed=entries=66.284, outbox=132.568, unpublished=unfinished_inbox=duplicate_effects=0, inbox de requests da aplicação=0 e inbox remota com 132.568 eventos, zero requests/unknown. A rotina parcial executou reconciliação por wallet e assertLedgerInvariant; o agregado não discrimina cada subcheck de saldo, cadeia e versões e não substitui o verificador integral ausente. Os 66.284 efeitos reconciliam 1.021 aberturas/seeds e 65.263 comandos HTTP únicos; 1.882 replays não somam efeitos. Observer parcial registrou 132.568 IDs/entregas, zero duplicatas e handlers ativos; faltam anti-join/cobertura integral final, participation e publicação-latência finais. Os três snapshots completos mostram deltas positivos API3/worker2, mas nenhum delta consumer e nenhuma prova final da fase mista. A etapa SQS requests não foi exercitada; não há prova FULL final de filas/DLQ ou das oito réplicas. A verificação parcial não transforma a FULL1 em PASS.

### Filas e confirmação

Os atributos de fila e os contadores do produtor registraram: Na QUICK, requests e events reportaram FifoQueue=true, ContentBasedDeduplication=false, DeduplicationScope=messageGroup e FifoThroughputLimit=perMessageGroupId. O produtor confirmou 1.000 mensagens em 100 batches/100 chamadas externas, com retries, throttled, backoffMs, failedBatches e exhausted em zero. O backlog amostrado atingiu 867; o drain após enqueue foi 4.154 ms. Na confirmação dos eventos, houve RequestThrottled HTTP403 real em DeleteMessageCommand: 6.502 chamadas lógicas, 6.648 tentativas, 146 retries e 4.716 ms de backoff agregado, até 4 tentativas observadas; todos os 6.502 ACKs concluíram, com failed, exhausted e deadlineStopped em zero. Backoff agregado não representa duração de parede; os retries de ACK são distintos do produtor de backlog. Na FULL1, requests/events preservaram os mesmos quatro atributos FIFO; o produtor/backlog de 10.000 comandos não foi alcançado, sqs-producer.json está ausente e requests na inbox remota=0. Os ACKs do observer de eventos registraram 132.568 chamadas e ACKs, 138.816 tentativas, 6.248 retries RequestThrottled, 201.937 ms de backoff agregado, máximo 5 tentativas e failed/exhausted/deadlineStopped=0, fatalError=null; o primeiro erro foi DeleteMessageCommand/RequestThrottled/HTTP403, recuperado e distinto da falha terminal inferida da fence. O sampler observou requests no pico=0 e eventos no pico=14.840, com última amostra requests/events/unpublished=0; amostras não suprem a prova final ausente.

### Métricas e limites

As métricas admitidas e os limites observados foram: Somente para a QUICK aceita, p95/p99 HTTP em ms: hot_wallet 18,61/24,73; distributed_wallets 14,09/18,21; replays 15,14/36,68; hot_plus_distributed 15,80/27,60. Publicação occurred_at→published_at: p50/p95/p99 de 122/371/419 ms em 6.502 eventos, medindo confirmação de publicação, sem equivaler a latência HTTP ou entrega SQS. Foram retidas 28 amostras do sampler. Os consumers tinham baseline sem séries e contadores finais positivos de 309/331/360: isso não estabelece deltas individuais antes/depois. CloudWatch completou 22 consultas, registrando 23 séries/57 pontos, com buckets parciais e 3 séries de erros sem pontos; ausência permanece desconhecida, sem preenchimento com zero. Estes fatos não fornecem comparação de três FULLs, comparação local/AWS da mesma coorte ou capacidade máxima.

Na FULL1 falha, os summaries HTTP preservados são apenas diagnósticos: iterações hot/distribuída/replays/mista=11.030/18.797/18.824/18.494; comandos únicos=11.030/18.797/16.942/18.494; 1.882 replays. p95/p99 de http_req_duration, em ms, foram 2239,40/3050,56; 95,65/415,17; 31,84/160,12; 4403,20/5007,96. Checks.rate=1, unexpected_status.rate=0 e backpressure=0 nas quatro fases; dropped reportado hot/distribuída/mista=7.794/27/19.156 (total26.977), com métrica dropped_iterations ausente em replays, sem preencher esse dado ausente como medição zero. Os thresholds de resposta configurados passaram; latência e dropped não foram os thresholds causadores da falha. CW FULL1: 22 queries, 23 séries e 213 pontos numéricos, três séries sem datapoints e cobertura de buckets incompleta, na janela de orquestração; faltante é desconhecido, sem interpolação ou zero inferido de séries ALB esparsas. As fases não são reutilizadas para formar FULL aceita; não há demonstração da oferta-alvo de500/s por workload, três FULLs comparáveis, patamares steady nem capacidade máxima.

O relatório HTML/SVG continua representando somente a coorte histórica a98/36b. Os resultados desta seção não são incorporados àquele denominador. FULLs incompletos não fornecem fases para rodadas aceitas; valores ausentes permanecem indisponíveis. Não há otimização de desempenho retida, e diferenças entre execuções não demonstram causa ou capacidade máxima de produção.
