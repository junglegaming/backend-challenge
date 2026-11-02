# Verificação financeira, concorrência e recuperação

Este documento registra evidências locais com PostgreSQL e MiniStack reais e evidências AWS
remotas de 1º e 2 de novembro de 2026. A imagem de aplicação tem papéis `api`, `consumer` e `worker`; integração e suítes superiores
exercitam três APIs, três consumers e dois workers. Os resultados históricos permanecem associados
às suas fontes. Não se somam campanhas interrompidas nem se substituem rodadas reprovadas.

As suítes entregues exigem Bun 1.4.3 e Docker Compose. Os experimentos exploratórios históricos
usaram ferramentas do host. A reprodução opcional `bun run verify:manual` usa ferramentas em
containers, fora de `bun run test` e da CI. As ferramentas do host não se tornam pré-requisitos.
Os resultados de carga e suas condições estão em [load-test.md](load-test.md).

Os cinco gates locais de entrega passaram no clone limpo da fonte `d52abed`, em 02/11/2026.
As contagens e os recibos estão em [Gates locais em d52abed](#gates-locais-em-d52abed).
A revisão documental posterior está em trabalho: esses recibos comprovam a fonte identificada,
sem declarar um novo commit validado ou uma execução remota de GitHub Actions.

| Visualização offline | Evidência e limite |
| --- | --- |
| [Índice dos resultados de carga](load-report/index.html) | Acesso às campanhas, com fontes e ambientes separados. |
| [FULL local: rodadas A/B/C](load-report/local/index.html) | Três rodadas históricas da fonte `06e6165`, hash de carga `c99c4ac6…`; condições em [load-test.md](load-test.md). |
| [AWS: FULL3 aprovado](load-report/aws/index.html) | Uma rodada da quarta sessão, aplicação `d52abed` e hash de carga `0d029aec…`, com a correção de infraestrutura descrita em [load-test-aws.md](load-test-aws.md). |
| [QUICK histórico a98](load-report/historical/index.html) | Diagnóstico da coorte `a98d1e6`/`36b77c…`; seus dois FULL nominados permanecem reprovados/excluídos. |
| [Arquitetura](architecture.html) | Fluxo HTTP/SQS, transação SQL e recuperação, complementando [ARCHITECTURE.md](../ARCHITECTURE.md). |

Os FULL locais e o FULL AWS usam fontes e instrumentos distintos. As visualizações preservam essa
fronteira: não demonstram comparação de desempenho sob a mesma campanha nem três rodadas AWS.

<details>
<summary>Histórico das campanhas retidas, restauração da outbox e fronteiras da evidência</summary>

## Estado da versão retida e fronteira da evidência

A candidata de persistência em lote da outbox não foi retida. Os seis braços da comparação passaram
suas verificações técnicas/financeiras, mas o gate de benefício falhou: mediana de 8,428546%, com
pares de 8,428546%, 3,397665% e 15,038269%, contra os requisitos prévios de mediana ≥15% e cada par
≥10%. Somente os dois arquivos de produção da candidata foram restaurados em `eb3fcf2`, com bytes
conferidos contra o baseline. A documentação da comparação foi incorporada depois em `a76f1b0`.
A rejeição é de retenção por benefício, sem inventar uma falha financeira nos seis braços aprovados.

A regressão direcionada sobre a implementação restaurada passou em `eb3fcf2`, árvore limpa:
10 testes, zero falhas, 403 asserções, 16,76 s de suíte. A execução ocorreu de
21:15:26.087 a 21:15:42.863 UTC, com `sourceVerified=true` e `cleaned=true`. O teste de falha SQL
após envio levou 6.080,49 ms; o sucesso parcial, 6.288,48 ms; o caso de dois publishers, 854,46 ms.
Essa regressão não substitui manual completa, stress, determinismo ou carga da versão retida.

| Evidência | Fonte e resultado existente | Alcance na versão retida |
| --- | --- | --- |
| Prova de detecção | `f8a4c1f`: 15 casos, 16 PASS baseline e 16 falhas esperadas em 15 mutantes compiláveis. | Histórico; não é nova campanha de mutação sobre a revisão atual. |
| GNU20 histórica | `d11e8e3`: 20 suítes, 260 PASS/0 FAIL, encerradas em 01/11 às 19:49:33.542 UTC. | Histórico com divulgação de interferência; não é GNU20 de a98. |
| Stress histórico | `d11e8e3`: 13 PASS/0 FAIL. | Fonte histórica própria; posteriores têm seus resultados separados. |
| Manual histórica e tcpdump | `f8a4c1f`: manual 13 PASS/0 FAIL, 71 wallets; captura separada 1 PASS/40 asserções. | Ferramentas host e instrumento próprio; não equivale à portagem integral. |
| Validações da portagem | Rodadas selecionadas anteriores a `bcc0a7b8`, com WIP/hashes declarados. | Preservar os resultados parciais e a falha Toxiproxy. |
| Comparação outbox | `66660b9` / `39d4b89`: seis braços técnicos PASS, gate de benefício FAIL. | Candidata rejeitada; nenhum ganho retido. |
| Regressão pós-restauração | `eb3fcf2`: 10 PASS/0 FAIL, 403 asserções. | Aprovação dirigida; não aprova as cargas posteriores. |
| Primeira manual retida | `a76f1b0`, `manual-retained-1`: global **FAIL**, antes de stress; três comandos encerrados somam 15 PASS/9.826 asserções. | `sourceVerified=false` no resultado global; falha preservada. |
| Segunda manual retida | `9fab360`, `manual-retained-2`: global **PASS**, oito seletores, 29 PASS/0 FAIL/11.939 asserções. | Campanha histórica após correção do launcher; não é a manual a98. |
| Manual a98 entregue | `a98d1e6`: global **PASS**, oito seletores, 29 PASS/0 FAIL/11.819 asserções. | Captura registra source/cleanup verificados e 49 hashes inalterados. |
| GNU a98 com escopo reduzido | Seis rodadas funcionais PASS; GNU exit 0; runner/captura formal **FAIL**, exit 1. | Waiver de nova20 e parada controlada autorizadas. **Não houve 20/20 em a98**. |
| Full local retida | `a98d1e6`: **FAIL**, prova salva somente parcial. | Sem aceitação financeira full nem campos SQS/DLQ/participação finais. |
| AWS full-1 | `a98d1e6`: **FAIL**, erro primário RequestThrottled e falha secundária do verificador parcial. | Coleta técnica PASS não é PASS da carga; operação terminal desconhecida. |
| Forense posterior AWS | Snapshot read-only/repeatable-read: invariantes financeiros true, cobertura de eventos incompleta. | Outro instante; `campaignAcceptance=false`, sem reclassificar full-1. |

A fonte de cada nova campanha deve vir de seu manifesto final: commit completo, estado da árvore,
hashes dos instrumentos e IDs efetivos das imagens. O commit do documento ou a igualdade dos dois
arquivos restaurados não prova, por si, que outra campanha usou a mesma imagem ou todos os mesmos
fontes. Os resultados abaixo são relatados a partir dos registros preservados; leitura de JSON depois
do teardown não constitui nova prova SQL independente.

## Campanhas encerradas em a98 e limites de reutilização

A fonte declarada destas campanhas é `a98d1e6fe248f2e6bee4f2cf54317fc961aab062`.
A coincidência do commit não torna iguais os ambientes, imagens ou inventários das campanhas.

### Manual entregue: oito seletores PASS

`execution/evidence/manual-retained-a98d1e6-1` foi de 01/11/2026 **23:06:21.023 a
23:20:13.862 UTC**, com **832.839,104549 ms** de captura. Os seletores solicitados e concluídos
foram `parallel`, `oha`, `pg-activity`, `pumba`, `toxiproxy`, `netem`, `tcpdump` e `stress`.
Resultado global e captura registram PASS; a captura tem `sourceVerified=true`,
`cleanupVerified=true` e `diagnostics=[]`. Esses campos são desta execução local.

| Comando, todos exit 0 | PASS / FAIL / asserções | Reconciliação e alcance |
| --- | --- | --- |
| Principal | 13 / 0 / 9.422 | Fechamento financeiro em outro comando, abaixo. |
| Reconciliação principal | 1 / 0 / 288 | 71/71 carteiras, conjunto estável e ledger válido. |
| Tcpdump isolado | 1 / 0 / 56 | 1/1 carteira de outra fixture. |
| Suíte de stress | 13 / 0 / 1.549 | Fechamento financeiro em outro comando, abaixo. |
| Reconciliação do stress | 1 / 0 / 504 | 125/125 carteiras de outro stack, conjunto estável e ledger válido. |
| Total dos cinco comandos | **29 / 0 / 11.819** | Não somar carteiras de bancos independentes. |

Os 49 caminhos/hash da captura são iguais antes/depois; os 13 instrumentos entregues coincidem
com seu subconjunto. A auditoria conferiu títulos/resultados/fechamentos salvos, sem repetir SQL
depois do teardown. A campanha anterior `9fab360` tinha 29 PASS/11.939 asserções; a diferença
observada não é demonstração de ganho ou causa. Fonte: `execution/manual-retained-a98d1e6-1-data-audit.md`.

### GNU: seis rodadas funcionais, waiver e falha formal do wrapper

`execution/evidence/determinism-retained-a98d1e6-1` foi de 01/11/2026 **23:20:38.351**
a 02/11/2026 **00:09:11.222 UTC**. Há exatamente seis jobs seriais, exit 0/signal 0, sem job 7.
Cada rodada teve os mesmos treze títulos canônicos e **13 PASS/0 FAIL/1.549 asserções**, seguidos
de reconciliação separada **1 PASS/0 FAIL/504 asserções**, 125/125 carteiras e ledger válido.
Os doze comandos somam **84 PASS/0 FAIL/12.318 asserções**: 78 casos/9.294 asserções das suítes
mais seis casos/3.024 das reconciliações. Não são 750 carteiras de uma única base.

O usuário dispensou a exigência de nova GNU20, inclusive para Task 13/handoff, e autorizou
encerramento controlado sem novos jobs. O responsável registrou SIGHUP ao GNU próprio em
**00:07:17 UTC**; a sexta rodada em andamento terminou. GNU exit 0; **runner entregue e captura
exit 1, `passed=false`**. O responsável atribuiu a falha formal à assertion original de vinte
linhas; a projeção preserva somente `verification-failed`, sem esse texto específico completo.

O runner conserva `sourceVerified=false`; a captura externa registra separadamente
`sourceVerified=true`, `cleanupVerified=true` e 49 hashes inalterados. Não converter esses
níveis em um só PASS, nem inferir alteração de fonte pelo false formal. A soma dos JobRuntime
é **2.901,583 s**; a captura inteira, **2.912.871,028875 ms**, com fronteiras diferentes.
A GNU `d11e8e3` continua histórica **20/20**, com sua divulgação de interferência; não somar
20+6 como uma campanha da mesma versão. As duas campanhas históricas falhas continuam falhas.
Fontes: `execution/determinism-retained-a98d1e6-1-data-audit.md` e o `scope-stop-event.json`
no diretório dessa captura.

### Full local retida: FAIL e prova somente parcial

Run `2026-11-01T22-25-40-451Z-d9d6e892`: **FAIL** observado pelo responsável em 01/11 às
23:05:06 UTC. A prova `partial=true` registra **1.001 carteiras; 90.351 transações processadas
e entradas; 180.702 outbox, 6.862 não publicados; 9.910 inbox; zero inacabados/efeitos duplicados**.
O responsável diagnosticou timeout de 180.000 ms no gate de todos os comandos SQS pretendidos
(9.910/10.000). Os artefatos são compatíveis com essa inferência, mas não retêm o rótulo inteiro
do gate nem medem independentemente os 180 s. Não se demonstra perda, DLQ ou defeito da aplicação.

O verificador parcial teve 1 PASS/2.009 asserções, sem exigir os alvos full. Faltam
`result.json`, `verification.json`, resumo final `sqs_backlog` e participação final;
SQS concluído, DLQ final zero e drenagem integral continuam sem prova. Fonte:
`execution/retained-full-1-data-audit.md`, com falha e postcheck originais preservados.

### AWS full-1: FAIL, verificador secundário e forense posterior separados

Run `2026-11-02T05-25-09-577Z-5faa73a3`, full/standard/remote: execução externa
**05:25:07.393 a 05:36:50.969 UTC**, 703.576 ms. O erro primário salvo é
**RequestThrottled às 05:36:39.687 UTC**; fechamento `LoadFailed`, exit 1. A operação SDK
terminal não foi retida. O primeiro erro SDK latched DeleteMessageCommand/RequestThrottled/403
não é necessariamente o terminal. Os **136.572 ACKs** registrados terminaram aprovados,
com 4.787 retries e zero falhas/esgotamentos; isso não prova o estágio SQS completo.

O verificador parcial falhou depois na comparação total inbox versus requests+events,
`load/verification.test.ts:68:26`. As duas consultas usam statements separados sem snapshot
comum explícito: commits intermediários são hipótese apoiada pela fonte, não diagnóstico
comprovado da falha. Valores esperado/recebido não foram preservados; não se demonstra quebra
de saldo/ledger. O produtor full tem 10.000 comandos em 1.000 batches, concorrência 5 e
SDK maxAttempts 1; throttle desse produtor é compatível, sem operação terminal confirmada.

A coleta fechada validou identidade, com 21 arquivos e nove nomes excluídos. **PASS da coleta
não é PASS da carga.** Faltam resultado/verificação financeiros finais, prova parcial final e
resumo SQS. Não promover quatro subfases HTTP favoráveis a full aprovado. Fonte:
`execution/aws/full1-aggregate-failure-data-audit-1.md`.

A forense posterior `execution/aws/session-f38c56/full1-read-only-financial-snapshot-2.json`
foi de **05:44:34.562 a 05:44:44.189 UTC**, após parada nativa registrada. Declara 115 fontes
verificadas, read-only/repeatable-read e TLS. O snapshot tem **1.001 carteiras; 74.210 transações
processadas e entradas; 148.420 outbox, zero não publicados; 142.662 inbox = 6.090 requests +
136.572 events; zero desconhecidos/inacabados**. Os invariantes financeiros registram true,
com zero carteiras inconsistentes/negativas e efeitos duplicados, mas **11.848 eventos faltantes**,
`eventCoverageComplete=false`. O próprio helper marca `campaignAcceptance=false`,
`loadRetry=false`, zero operações de fila e nenhuma mutação do banco. Outro instante não
corrige a assertion anterior, não prova seu instante e **não reclassifica full-1 como PASS**.

Local retida e AWS declaram o mesmo `loadSourceSha256`
`36b77c2acde5dc63e35cff9f950c021a8c14601333d87cf590d47de5cc94f161`;
o manifesto remoto de 115 fontes declara
`eaaf82f2d50106d8a3d6d4e5ad205a45261ca353d93d865b07a00735f539ec21`.
As duas falhas não fornecem comparação full aprovada. Três históricos c99 permanecem em sua
fonte anterior, sem preencher a coorte atual ou sustentar ganho de performance.

### Reutilização dos caminhos inalterados

As notas `execution/aws/post-aws-five-instrument-proof-reuse-1.md` e
`execution/aws/post-aws-five-instrument-proof-reuse-after-integration-1.md`, esta
última com SHA-256 `696b88b39067cd0c9e2be4317e404ae37bb19394cb63e3d4ffcdfb1d4f91fcbd`,
conferem os cinco deltas: observer de eventos, tipo de EventConsumer, runner de
carga, runner AWS e snapshot SQL do verificador. Quatro estão no inventário manual
de 49 caminhos, todos os cinco no inventário completo de 115; o hash load16 é outro
agregado. Inventário de integridade não significa execução de cada arquivo por
cada seletor.

Manual/GNU exercitam EventConsumer. Nesse helper, a mudança é somente de anotação
de tipo: a transformação documentada produz o arquivo inteiro novo, preservando
o corpo executável byte a byte. Os seletores não chamam o observer remoto, os
runners load/AWS ou `load/verification.test.ts`; sua reconciliação separada usa
outro caminho SQL. Esses cinco deltas não exigem repetir manual8/GNU para executar
código que esses seletores não alcançam. Os resultados continuam atribuídos a
**a98**, sem renomeá-los como uma execução da versão posterior ou declarar o
manifesto completo inalterado.

A integração local dirigida posterior executou os novos caminhos de ACK e snapshot:
**177 PASS / 0 FAIL / 6.703 asserções**, entre 06:40:56 e 06:43:22 UTC de 02/11.
Os hashes dos cinco arquivos foram os mesmos antes e depois desse comando no
staging. Esse resultado não é carga retida nem execução AWS do runner novo. Os
units cobrem prontidão e projeção de erros; os cinco gates finais continuam
obrigatórios para o commit efetivamente entregue.

As 19 substituições das 11 variantes históricas de proof-of-detection mantêm uma
ocorrência por âncora, na ordem de aplicação, nas fontes histórica, a98 e staging.
Os seis arquivos de produção/migration atingidos são byte-idênticos. Essa inspeção
justifica conservar a prova histórica com sua identidade; não é nova execução dos
mutantes nem um manifesto global de fontes iguais. Mudanças adicionais de runtime,
Compose, assertions ou entrypoints exigem nova conferência de dependências; a
waiver dispensa somente uma nova GNU20.

</details>

## Reprodução manual em containers

Os comandos abaixo exigem Bun 1.4.3 e Docker com Compose. As ferramentas manuais rodam nas
imagens do perfil `verification`; não são dependências de `bun run test` nem da CI. O runner
recusa containers ou rede preexistentes do projeto `wagering-test` antes de assumir seu teardown.
Use um daemon local exclusivo para a execução. A implementação usa rede host para alcançar as
mesmas portas da suíte, bind do socket Docker para as ações Pumba e montagem somente leitura
do checkout; as evidências ficam em um diretório externo separado.

```bash
BUN_CONFIG_NO_ENV_FILE=true BUN_CONFIG_NO_AUTO_INSTALL=true bun --no-env-file run verify:manual --list
BUN_CONFIG_NO_ENV_FILE=true BUN_CONFIG_NO_AUTO_INSTALL=true bun --no-env-file run verify:manual
```

A execução padrão inclui corrida HTTP com GNU parallel/curl, oha replay/GET com contraprova
k6 GET, observação pg_activity, kill/pause Pumba, toxics via CLI Toxiproxy, quatro experimentos
netem, captura tcpdump e a suíte completa sob stress de CPU. Cada cenário faz assertions de
efeitos, recuperação e invariantes. A fase manual principal termina com reconciliação de todas
as carteiras; a captura reconcilia todas as carteiras de seu banco isolado antes de removê-lo;
stress e cada rodada GNU usam um filho separado de reconciliação antes do teardown.

`--only` seleciona um ou mais experimentos, separados por vírgula, pelos nomes publicados em
`--list`. Sem esse argumento, o runner executa o conjunto padrão descrito acima. O determinismo é
uma campanha separada, selecionada explicitamente:

```bash
BUN_CONFIG_NO_ENV_FILE=true BUN_CONFIG_NO_AUTO_INSTALL=true bun --no-env-file run verify:manual --only=determinism
```

`determinism` executa vinte repetições **da suíte real** `bun run test:concurrency`, em série,
com `--halt now,fail=1`. Os treze casos originais incluem a espera pela janela FIFO nativa;
não se trata de uma lista demonstrativa de jobs. Stress e determinismo exigem uma árvore limpa
no commit informado pelo manifesto. Não modifique fontes, imagens ou instrumentos nem execute
outros probes durante uma campanha congelada. Uma falha preserva os artefatos e reprova a
execução; o comando não repete rodadas para obter aprovação.

`--output` permite escolher uma pasta de evidências vazia e fora do checkout. Sem esse argumento,
o runner cria uma pasta única em `~/.cache/wagering-verification`. Os JSONs guardam a fonte, hashes dos instrumentos,
identidades das imagens, versões, casos planejados/observados e resultados de reconciliação e
cleanup. A transcrição bruta das ferramentas permanece em memória. Não são salvos tokens,
headers, corpos financeiros ou pcaps. Os sidecars tcpdump usam `logging: none`, filesystem
somente leitura e capacidades `NET_RAW`, `NET_ADMIN` e `SETGID` em `service:postgres` e
`service:ministack`; persistem apenas horário e sentido lógico dos pacotes. A prova correlaciona
tráfego com confirmação de commit, visibilidade SQL independente e chamadas reais ao SDK,
sem decodificar comandos no fio. pg_activity roda em PTY via `script`; somente amostras numéricas
permitidas são retidas. Netem requer suporte do kernel/capacidades do Docker; indisponibilidade
reprova esse experimento, sem substituir perda de pacotes por outro mecanismo.

A imagem de ferramentas usa Debian Bookworm com bases identificadas por digest, Bun 1.4.3,
Docker CLI 29.0.0, Compose 2.40.3 e Buildx 0.29.1. As imagens oha 1.16.0 e Pumba 1.2.1 e o
helper nettools têm conteúdo fixado por digest no Compose/instrumento. Pacotes APT são resolvidos
no build; compare o ID efetivo da imagem e as versões registradas, não apenas o Dockerfile.

Estado da portagem: build, versões e casos selecionados exercitados em Linux x86-64 com Docker
local. Seletores inválidos e recusa de stack preexistente foram verificados sem remover o
sentinela. A validação anterior ao commit preservou uma falha do endereço do CLI Toxiproxy:
o CLI containerizado recebeu a porta publicada no host, em vez da porta interna. Depois da
correção, os três toxics, os quatro casos netem e a captura passaram, com reconciliação e cleanup.
GNU parallel HTTP, oha/k6, pg_activity e kill/pause Pumba também foram exercitados. Essas
execuções têm hashes próprios e árvore de trabalho declarada; não são evidência da versão
retida. A manual a98 passou posteriormente com oito seletores, incluindo stress. A GNU a98
encerrou seis rodadas funcionais após redução autorizada de escopo, conservando a falha formal
do wrapper; resultados e fontes estão na seção de campanhas encerradas.
O runner registra os IDs efetivos das imagens dos serviços, verifica os instrumentos no fim e,
quando parte de árvore limpa, exige que ela permaneça no mesmo commit. Outros sistemas e
daemons remotos não foram testados.

<details>
<summary>Método histórico e prova de detecção: 15 mutantes, 16 falhas esperadas</summary>

## Método e alcance

Cada suíte com containers cria o projeto isolado `wagering-test` e, por padrão, remove seus containers
e volumes ao terminar.
Suítes que usam esse projeto são executadas em sequência. Os testes verificam o saldo reconstruído
do ledger, sua cadeia de saldos e versões e a reconciliação das carteiras afetadas.

Os experimentos manuais conservam somente resultados permitidos: contagens, tempos, códigos HTTP,
identificadores técnicos, eventos estruturados e métricas. Credenciais, cabeçalhos e corpos completos
das operações não integram os artefatos. Na captura de rede, nenhum arquivo pcap foi criado.

A prova de detecção usa o commit `f8a4c1f9c2e099add934853f20554584f40ef158`. Cada caso começa em um
worktree novo sob `$HOME/.cache`, instala o lockfile, executa o teste nomeado na versão íntegra,
retira uma proteção, exige typecheck aprovado e repete o mesmo teste com containers novos. O worktree
é descartado ao final. A falha intencional do mutante só conta após conferir o ponto de detecção;
uma falha exclusiva de preparação ou de um hook não basta.

## Prova de detecção

Entre 11:23:37.963 e 11:50:29.564 UTC, os quinze casos completaram: dezesseis testes aprovados nos
baselines, quinze mutantes compiláveis e dezesseis falhas nos testes nomeados. Não houve mutante
sobrevivente nem experimento inválido nessa campanha. As contagens incluem duas falhas de atomicidade
no mesmo caso e variantes separadas para imutabilidade e claim da outbox.

Na tabela, B/M são os números de testes aprovados no baseline e reprovados no mutante. As asserções
de polling variam com o tempo; sua quantidade não é uma medida de cobertura.

| Proteção retirada / variante | Teste e detector efetivo | B/M |
| --- | --- | --- |
| Lock `FOR UPDATE` da wallet, integração | `100.00 and two simultaneous 80.00 bets produce one debit and one insufficient-funds rejection`: falha no par de estados esperado `PROCESSED`/`REJECTED`. O array recebido não foi preservado. | 1/1 |
| Mesmo lock, HTTP | `scenario 2: two 80.00 bets against 100.00 via http serialize and remain safe on retry`: falha na guarda de respostas permitidas 200/422, antes das contagens financeiras finais. O código recebido não foi preservado. | 1/1 |
| `uq_wager_transactions_provider_key` | `scenario 1: fifty simultaneous HTTP retries through Nginx cause exactly one debit`: falha no probe SQL rollback-only que exige essa constraint em outra wallet com a mesma provider/key. As cinquenta chamadas anteriores não produziram um débito duplicado observado. | 1/1 |
| `ON CONFLICT DO NOTHING` da inbox | `persistent inbox makes redelivery harmless and divergent reuse reaches the DLQ`: timeout compatível com a falta do acknowledgement de redelivery. Localização inferida pela fonte, 30,86 s e três expects; o resumo conserva somente o helper de polling. | 1/1 |
| `ck_wallets_balance_non_negative` | `wallet constraint ck_wallets_balance_non_negative`: falha direta na asserção da constraint para saldo negativo; a falha adicional de reconciliação não é o detector principal. | 1/1 |
| Triggers de imutabilidade, `UPDATE` | `owner cannot mutate ledger: UPDATE`: o proprietário real deixa de receber a proteção `ck_ledger_immutable`, inclusive em atualização sem mudança de valor. | 1/1 |
| Mesmos triggers, `DELETE` | `owner cannot mutate ledger: DELETE`: falha direta na asserção de imutabilidade; a falha posterior do invariante é secundária. | 1/1 |
| Mesmos triggers, `TRUNCATE` | `owner cannot mutate ledger: TRUNCATE`: falha direta na asserção de imutabilidade; a falha posterior do invariante é secundária. | 1/1 |
| Índice parcial `uq_wager_single_processed_reversal` | `a single processed reversal is enforced across REFUND and ROLLBACK, rejected reversals coexist`: a segunda reversão processada deixa de ser impedida pelo schema. | 1/1 |
| Toda a cláusula `FOR UPDATE SKIP LOCKED` da outbox | `concurrent outbox claims SKIP LOCKED rather than claiming the same row`: o segundo claim inclui o ID ainda reservado pelo primeiro. Essa observação é de claim, sem afirmar envio duplicado. | 1/1 |
| Somente `SKIP LOCKED`, preservando `FOR UPDATE` | Mesmo teste: falha em 2.043,72 ms antes do terceiro expect, compatível com o segundo claim bloqueado pelo primeiro e `lock_timeout` de 2 s. O resumo não conserva um erro estruturado; a causa é inferida pela fonte e duração. | 1/1 |
| Inserts de outbox movidos para segunda transação após commit financeiro | `failure after first-event write rolls the submission back completely` e `failure after second-event write rolls the submission back completely`: os efeitos após a falha deixam de coincidir com o snapshot anterior. Os inserts reais da outbox continuam sendo executados. | 2/2 |
| Mesma separação, cenário de crash | `scenario 5: killing the exact replica at consumer.after_commit_before_ack recovers on a different consumer`: falha na igualdade dos `xmin` do ledger e das linhas frescas da outbox, com publishers parados. O mutante falha antes do kill; isso prova transações separadas, sem alegar uma queda no intervalo commit→append. | 1/1 |
| Ack movido para antes do commit | `scenario 5b: killing the exact replica at consumer.before_commit recovers on a different consumer`: timeout do evento de redelivery/completion. Fonte, 80,47 s e 28 expects localizam a espera após o kill; o resumo não conserva o callsite refinado. | 1/1 |
| Entrada no gate do banco impedida | `PostgreSQL outage gates all consumers across the redrive window and every valid message later applies once`: falha direta na asserção de DLQ vazia durante a indisponibilidade, em 7,08 s. A quantidade exata na DLQ não foi preservada. | 1/1 |

Tokens de SQLSTATE ou nomes de constraints extraídos do texto sanitizado podem vir do próprio código
esperado. Eles não foram usados como prova de um erro estruturado emitido pelo PostgreSQL.

### Lacunas de detecção corrigidas

A preparação encontrou duas lacunas nos testes existentes, corrigidas no commit citado: o lock da mesma
wallet podia mascarar a falta da unicidade provider/key, e um append pós-commit já concluído antes do
gate podia escapar do teste de crash. O cenário 1 passou a exigir a constraint em um probe independente
que sempre reverte. Os cenários 5/5b passaram a observar o par exato de eventos, a ligação ao ledger e
seus `xmin`, com workers parados; após redelivery, os IDs já comprometidos devem ser os mesmos.

Essa alteração atingiu somente os testes. Seu baseline completo terminou com 13 testes aprovados,
zero falhas e 1.500 asserções em 427,04 s; lint, tipos e 116 testes unitários também passaram.

</details>

## Rastreabilidade de ASSESMENT.md §13

A tabela abaixo reúne os testes entregues, cobertos pelos [gates da fonte d52abed](#gates-locais-em-d52abed),
e identifica os cenários também presentes nas campanhas históricas. Não declara nova execução do WIP
documental. Unidade exercita o domínio sem containers; integração,
concorrência e falhas usam PostgreSQL e MiniStack reais. Os nomes dos oito cenários representam treze
instâncias de teste, pois há variantes HTTP/SQS/mista e casos extras.

| Item obrigatório | Arquivo / teste aprovado |
| --- | --- |
| Money: precisão, escala, operações e entradas inválidas | `test/unit/money.test.ts`: `Money > is exact, immutable, fixed scale, and supports the numeric(18,2) maximum`; `Money > subtract and negate produce exact negatives without signed zero or rounding`; casos `rejects invalid decimal input` e `rejects invalid currency`. Escala excedente é rejeitada, sem arredondamento silencioso. |
| Wallet e versão | `test/unit/wallet.test.ts`: `opening is audited at version 1, zero opening emits no entry`; `only balance changes advance the version and every movement returns its entry`; `rehydration reconstructs state without reapplying an opening or incrementing a version`. |
| BET, WIN, LOSS, REFUND e ROLLBACK | `test/unit/settlement.test.ts`, tabela `ordered settlement table`: `14 BET debits`, `14 WIN without reference credits`, `12 zero LOSS is informative`, `12 positive LOSS is informative`, `14 REFUND credits`, `14 ROLLBACK of BET credits`, `14 ROLLBACK of WIN debits`, `14 ROLLBACK of REFUND debits`, além de todas as linhas de rejeição da tabela. |
| Moedas conflitantes | `Money > all binary operations reject mixed currencies` e `ordered settlement table > 3 currency mismatch before zero`. |
| Idempotency key com payload divergente | `test/unit/canonical-and-sql-errors.test.ts`: `business hash excludes transport metadata and idempotency key, and includes every business field`; `test/integration/wagering/use-cases.test.ts`: `key payload divergence and external id reuse are distinct persistent conflicts`; `test/integration/http/contracts.test.ts`: `HTTP conflicts distinguish key, external id and duplicate wallet`. |
| Migrations e constraints | `test/integration/persistence/schema.test.ts`: `migration up, down, up works on an isolated scratch database`; os testes nomeados de unicidade, saldo não negativo, reversão processada e imutabilidade da tabela de detecção, mais as demais constraints do schema. |
| Atomicidade wallet/ledger/inbox/outbox | `test/integration/persistence/repositories.test.ts`: `a failure rolls back wallet, wager, ledger, inbox and outbox together`; `test/integration/messaging/consumer.test.ts`: `failure after real inbox insertion rolls back inbox and every financial effect`; falhas após cada write em `wagering/use-cases.test.ts`. |
| Inbox e redelivery | `test/integration/messaging/consumer.test.ts`: `persistent inbox makes redelivery harmless and divergent reuse reaches the DLQ`; `HTTP-first shares provider idempotency across both inputs`; `SQS-first shares provider idempotency across both inputs`. |
| Publishers concorrentes e commit antes da publicação | `test/integration/outbox/publisher.test.ts`: `two publishers claim many rows once per lease, release SQL locks before send, and lose no event`; `an uncommitted outbox is invisible to the publisher, and rollback leaves no event to send`; teste de claim da tabela de detecção. |
| Retry e DLQ/redrive | `test/integration/messaging/consumer.test.ts`: `real wallet lock exhausts native receives without FAILED/inbox and CLI redrive applies once`; `committed FAILED is recovered when redelivery precedes the DLQ handoff`; casos de mensagens inválidas para DLQ. `outbox/publisher.test.ts`: `a real partial SendMessageBatch failure publishes only confirmed IDs and retries the other entry`. |
| Recuperação após restart | Cenário 8 abaixo e `test/failure/recovery.test.ts`: `PostgreSQL restart during mixed traffic recovers existing processes and preserves every original-key effect`. |
| Invariante final | `test/support/database.ts`: `assertLedgerInvariant`, chamado após os testes financeiros; unidade usa `test/unit/domain-fixtures.ts`. A verificação reconstrói saldo, cadeia e versões; os testes de carga também reconciliam todas as carteiras. |

Todos os cenários seguintes pertencem a `test/concurrency/replicas.test.ts`:

| Cenário | Teste aprovado |
| --- | --- |
| 1 — mesma aposta cinquenta vezes | `scenario 1: fifty simultaneous HTTP retries through Nginx cause exactly one debit` |
| 2 — duas apostas de 80 contra 100 | `scenario 2: two 80.00 bets against 100.00 via http serialize and remain safe on retry`; variantes `sqs` e `mixed` com o mesmo restante do título. |
| 3 — wallets distintas | `scenario 3: an independently locked wallet does not block another wallet's overlapping request` |
| 4 — pelo menos três instâncias | `scenario 4: real mixed work is handled by three API and three consumer instance IDs` |
| 5 — crash após commit, antes de ack | `scenario 5: killing the exact replica at consumer.after_commit_before_ack recovers on a different consumer` |
| 6 — dois publishers | `scenario 6: two runtime publishers drain load and a crash after send produces a safe duplicate after the FIFO window` |
| 7 — referência fora de ordem | `scenario 7: ROLLBACK waits for its reference across HTTP and SQS processes in both directions`; variante `REFUND`. |
| 8 — restart durante tráfego | `scenario 8: restarting all eight application replicas during live traffic preserves every expected effect` |
| Extra — crash antes de commit | `scenario 5b: killing the exact replica at consumer.before_commit recovers on a different consumer` |
| Extra — reversões concorrentes | `race: HTTP refunds and SQS rollbacks compete on thirty bets with exactly one accepted reversal` |

As onze provas adicionais de `test/failure/recovery.test.ts` incluem indisponibilidade de PostgreSQL e
SQS, latência com contenção, pause de MiniStack/Keycloak, timeout de transação ociosa, crash de API,
recuperação de lease do publisher e graceful drain de consumer. Elas complementam os oito cenários;
não substituem as variantes da suíte de concorrência.

| Falha e recuperação | Teste aprovado em `test/failure/recovery.test.ts` |
| --- | --- |
| Banco indisponível durante consumo | `PostgreSQL outage gates all consumers across the redrive window and every valid message later applies once` |
| Banco indisponível durante HTTP | `PostgreSQL outage returns HTTP503 Retry-After with live200 ready503 and an original-key retry has one effect` |
| SQS indisponível e retry da outbox | `SQS outage keeps committed outbox events through increasing retries then publishes every expected event` |
| Pause de MiniStack no ack | `pausing MiniStack interrupts a committed message ack and existing consumers recover without recreation` |
| Latência do banco e contenção | `PostgreSQL latency plus observed wallet contention increments lock conflicts and retries without duplicates` |
| Encerramento normal de consumer | `graceful stop drains exact in-flight consumer work and exits0 with one committed effect` |
| Consumer pausado retendo lock | `idle transaction timeout frees a paused consumer wallet and its resumed stale attempt cannot add an effect` |
| API encerrada durante POST | `killing the API that owns an already-sent POST causes one upstream attempt and explicit original-key retry is safe` |
| Publisher encerrado após claim | `publisher killed after claim leaves a persisted lease that another worker recovers without losing its event` |
| Keycloak pausado e cache de chaves | `paused Keycloak serves cached keys on all APIs, unknown-key refresh returns503 and recovers after resume` |
| Restart do PostgreSQL durante tráfego | `PostgreSQL restart during mixed traffic recovers existing processes and preserves every original-key effect` |

<details>
<summary>Campanhas históricas detalhadas: determinismo, stress, falhas, ferramentas e comparação da outbox</summary>

## GNU parallel: vinte suítes completas em sequência

**Objetivo e método.** Repetir `bun run test:concurrency` vinte vezes com
`parallel -j1 --halt now,fail=1 --joblog ...`, sem execução simultânea das suítes. A primeira campanha
usou `f8a4c1f9c2e099add934853f20554584f40ef158`; um invólucro externo confere HEAD e ausência de
mudanças rastreadas antes e depois de cada comando. Cada rodada cria e remove sua própria stack
real 3/3/2 e mantém a espera nativa de cinco minutos da deduplicação FIFO. O invólucro conserva
somente os resultados nomeados, tempos, contagens e códigos de saída. Uma falha interrompe a campanha;
não há retry para substituir um resultado.

**Primeira campanha, reprovada.** Entre 12:12:18.991 e 14:42:58.607 UTC, dezenove rodadas
completaram com 13 testes aprovados; a vigésima terminou com 12 aprovados e uma falha, código 1.
O GNU parallel encerrou com erro. O cenário 6 falhou em 7,309 s na exigência de pelo menos dois
publishers observados, antes da fase de crash e da espera FIFO. O artefato sanitizado não preserva
a cardinalidade recebida nem a distribuição dos logs; não distingue qual dos caminhos abaixo ocorreu.
Os vinte resultados originais foram preservados, sem substituir a rodada reprovada.

**Defeito encontrado no teste.** O burst finito de 72 eventos não garante divisão justa entre os
workers: um pode drená-lo enquanto o outro espera pelo próximo polling. Além disso, o commit de
`published_at` precede a emissão dos logs de conclusão; drenagem SQL não é uma barreira desses logs.
A asserção original exigia uma precondição que o próprio teste não estabelecia.

A correção usa o gate existente depois do claim: cria o backlog com workers parados, inicia um
publisher e observa seu claim, depois inicia o segundo sem recriar o primeiro. O segundo precisa
confirmar trabalho enquanto o evento reservado permanece na tentativa 1 e não publicado. O stop
normal do primeiro libera seu gate; sua confirmação também é aguardada antes de contar os dois
IDs distintos. A exigência de participação, os efeitos únicos por evento e a fase de crash/FIFO
permanecem. A lease de 60 s vale apenas para esse handshake e evita uma recuperação indevida do
claim durante a preparação; a fase de crash restaura os parâmetros originais.

**Baseline da correção.** Entre 14:47:01.029 e 14:54:57.825 UTC, a suíte completa passou com
13 testes, zero falhas e 1.700 asserções: 432,74 s na suíte Bun e 476,796 s no comando completo.
O cenário 6 levou 329,164 s, incluindo a janela FIFO preservada. O patch foi registrado como
`efbca3a59e8c1cf6f1ff9bf7004048aa37d550ab`; o hash do diff commitado coincide com o baseline.
Lint, typecheck e os 116 testes unitários também passaram.

**Segunda campanha, reprovada.** Em `efbca3a`, entre 15:05:47.292 e 16:32:30.693 UTC, dez
rodadas completas passaram; a décima primeira terminou com doze testes aprovados e uma falha,
código 1. O cenário 4 falhou em 3,484 s na exigência de pelo menos três consumers com trabalho
observado. O cenário 6 passou nas onze tentativas. A campanha totalizou 142 PASS/1 FAIL e 18.700
asserções; o GNU parallel interrompeu as rodadas restantes. Não há resultados das rodadas 12–20.
Os onze resultados e o joblog permanecem preservados, sem substituição ou combinação com a campanha
anterior. A cardinalidade e os IDs recebidos na asserção reprovada não foram retidos.

**Precondição de participação dos consumers.** Cada burst traz dezoito mensagens, enquanto cada
consumer pode receber dez e processar dez grupos. Dois processos podem absorver o burst inteiro,
mesmo com três saudáveis; o SQS não promete distribuição justa. Nesse cenário, cada completion já
era aguardado, portanto a janela entre commit e log não explica a falha.

A correção prepara três operações mistas fixas usando o gate pós-commit existente, sem mudar a
aplicação: inicia um consumer com match A, observa seu gate, adiciona B com `--no-recreate` e depois
C da mesma forma. Os containers anteriores conservam sua configuração e permanecem aguardando ack;
o próximo é o único livre para receber a próxima fixture. Batch 1 evita prefetch e a visibility de
180 s protege o handshake limitado. O teste exige três holders distintos e vivos, saldo 80,00 e inbox
processada em cada fixture, libera os gates por stop normal e exige os três completions antes de
recriar os containers. Depois restaura três consumers saudáveis e conserva os bursts mistos e as
asserções originais de pelo menos três IDs. Isso prova três ciclos receive→commit→ack sobrepostos,
sem afirmar três commits SQL simultâneos. O orçamento total explícito de 180 s comporta os três
startups, gates limitados a 30 s, stop e restore; não substitui a asserção que falhou em 3,484 s.

A primeira preparação passou isoladamente (121 asserções, 12,832 s), mas falhou no baseline
completo e na reprodução com os cinco testes anteriores, ambos na espera pelo primeiro gate.
O baseline terminou com 12 PASS/1 FAIL, 1.312 asserções e 467,22 s de suíte. A reprodução preservou
a conclusão da primeira fixture na tentativa 2, aproximadamente cinco segundos após a parada dos
consumers antigos, sem retry da aplicação nos eventos selecionados. Isso demonstra por que o gate,
restrito à tentativa 1, não foi alcançado; não prova sozinho quem recebeu a primeira tentativa.
O código do MiniStack 1.5.28 permite que um long poll continue após a desconexão do cliente e obtenha
uma mensagem posterior. Essa é uma explicação compatível com os eventos, com o limite da coleta
preservado: o [handler de ReceiveMessage](https://github.com/ministackorg/ministack/blob/v1.5.28/ministack/services/sqs.py#L676)
mantém o loop de coleta, e o [dispatch ASGI](https://github.com/ministackorg/ministack/blob/v1.5.28/ministack/app.py#L2734)
não monitora a desconexão durante esse trabalho. A análise é da fonte da versão, sem prova binária
da imagem nem trace da primeira recepção nesta execução. Nenhuma falha financeira da aplicação foi
demonstrada por essa preparação.

A preparação final conclui uma recepção vazia de um segundo no broker após parar os clientes antigos,
antes de criar e enviar a primeira fixture. É uma precondição ligada ao ciclo real de recepção, sem
sleep arbitrário; o gate positivo de tentativa 1 continua obrigatório. Cada fixture SQS alcança seu
gate antes do HTTP correspondente, evitando contenção de wallet não relacionada ao handshake. A
carga mista concorrente original permanece depois da preparação. Lint, tipos e os 116 unitários
passaram (1.153 asserções).

**Baseline final da preparação.** Entre 16:49:23.129 e 16:57:31.635 UTC, a suíte completa passou
com 13 testes, zero falhas e 1.549 asserções: 444,66 s na suíte Bun e 488,506 s no comando completo.
O cenário 4 levou 13,822 s; o cenário 6, 328,619 s com a janela FIFO preservada. O patch foi registrado
como `d11e8e39484bb0cb9b7165c12cbe2bcc3d9cd7f3`; o hash do diff commitado coincide com o baseline.
**Terceira campanha, aprovada e histórica.** Em `d11e8e3`, entre 17:07:07.740 e 19:49:33.542 UTC,
as vinte rodadas completaram: 260 PASS, zero falhas e 30.980 asserções. Todos os treze títulos
canônicos passaram em cada rodada; JSON e GNU registraram exit 0/signal 0. A soma dos comandos
foi 9.735,398 s, a soma dos tempos Bun 8.944,51 s e a parede entre início e fim 9.745,802 s.
O menor/maior comando levou 482,011/509,921 s. Não se combinaram sucessos das campanhas reprovadas.

**Interferência declarada durante o freeze.** Claude executou dois probes contrariando a regra
de não competir com a campanha: um probe curto de ferramentas em container, de horário exato
desconhecido, e um benchmark diagnóstico isolado de MiniStack FIFO aproximadamente 18:38–18:43 UTC.
O segundo sobrepôs a rodada 12, de 18:35:50.382 a 18:44:06.526 UTC: 496,144 s no comando,
457,44 s Bun, treze testes aprovados/1.549 asserções/exit 0. A duração maior e a sobreposição são
observadas; o custo dos probes e sua contribuição causal não foram medidos. As rodadas 13 e 14
também foram mais longas, com comandos de 509,921 e 507,271 s, respectivamente, sem atribuição demonstrada. O horário desconhecido do primeiro probe
impede restringir toda a interferência à rodada 12.

Os vinte resultados continuam válidos como observação de aprovação funcional dos casos executados
nas condições reais; não provam isolamento de recursos, uniformidade ambiental nem comparação de
desempenho. Todos foram preservados, sem descarte ou repetição por causa dessa interferência.
O benchmark externo nunca entra nas comparações de versões. Esta campanha é anterior à extensão
de ferramentas e à experiência de desempenho: não é prova da versão posteriormente modificada.
A campanha posterior a98 encerrou seis rodadas funcionais aprovadas por redução autorizada de
escopo. O usuário dispensou nova GNU20; a falha formal do wrapper original permanece. O prefixo
não substitui, soma ou amplia a GNU20 histórica desta seção.

**Limites e defeitos.** Vinte amostras locais e sequenciais exercitam a configuração e os casos fixos;
não cobrem todos os escalonamentos possíveis nem estimam disponibilidade de produção. As asserções
incluem polling. A duração da suíte Bun exclui partes da preparação e limpeza incluídas no tempo
do comando completo; o joblog mede ainda o alcance do invólucro GNU parallel.

## stress-ng: suíte completa sob CPU

**Objetivo e método.** Executar `bun run test:concurrency` com `stress-ng --cpu 0 --cpu-load 80`,
alterando o escalonamento sem mudar nenhum teste, timeout ou configuração financeira. A carga usa os
doze CPUs disponíveis e permanece ativa desde antes da criação da stack até o encerramento da suíte.
O processo é próprio do experimento e recebe SIGINT após o teste; nenhum processo alheio é encerrado.

**Resultado.** No commit `d11e8e3`, entre 16:57:45.590 e 17:06:50.169 UTC, treze testes
aprovados, zero falhas e 1.549 asserções; 486,85 s na suíte Bun e 544,579 s no comando completo
com bootstrap e limpeza. O stressor permaneceu ativo durante todo o intervalo e terminou com
código zero, sem falhas, após 544,61 s. O cenário de duplicação após a janela FIFO levou
337,176 s; as duas janelas de crash do consumer passaram em 27,630 s e 27,756 s. A participação
dos três consumers passou em 19,152 s. Os invariantes finais
da suíte permaneceram válidos e todos os serviços próprios foram removidos.

As execuções anteriores em `f8a4c1f` e `efbca3a` também passaram (13 testes, 466,41 s e 463,13 s
na suíte), mas a evidência principal acima foi repetida após corrigir ambas as precondições de participação.

**Limites e defeitos.** 80% é a carga solicitada ao stress-ng, não uma medição uniforme de uso de
CPU em cada instante. O host também executa Docker e os instrumentos; uma execução sob carga não
estima estabilidade por horas. O número de asserções inclui polling e não mede cobertura.
Nenhum defeito da aplicação foi observado nesse experimento.

## Campanha manual consolidada

A execução íntegra, após corrigir o parser externo do terminal, terminou com 13 testes aprovados,
zero falhas e 8.865 asserções em 227,48 s. O fechamento reconciliou 71 carteiras. Os valores abaixo
são dessa segunda execução; a primeira foi interrompida pelo instrumento e seus artefatos foram
preservados separadamente. Essa campanha e a amostra tcpdump usam `f8a4c1f`; as correções posteriores
de participação afetam somente a preparação dos cenários 4 e 6 no teste de concorrência, sem alterar
o runtime.

## GNU parallel: mesma operação cinquenta vezes

**Objetivo e método.** Oferecer cinquenta POSTs simultâneos com a mesma chave, via `curl` e Nginx,
usando `parallel -j50 --halt now,fail=1`. Token, chave e corpo ficam no ambiente privado dos filhos;
o joblog conserva referências a variáveis, sem expandir seus valores.

**Resultado.** Cinquenta respostas HTTP 200 em 618 ms, um débito e o par esperado de eventos. A checagem
SQL e a reconciliação conferem o efeito financeiro, além dos códigos HTTP.

**Limites e defeitos.** Uma amostra local de uma operação, sem indisponibilidade nesse experimento.
Não mede capacidade sustentada. Nenhum defeito da aplicação foi observado nesse caso.

## oha e k6: replay e leitura

**Objetivo e método.** Aplicar `oha 1.16.0` por 30 s, 20 conexões e 100 requisições/s a um POST já processado;
depois medir o GET dessa transação com a mesma configuração. O k6 v2.3.0 faz uma terceira amostra de 30 s
do mesmo GET, com 100 chegadas/s e 20 VUs. Cada leitura do k6 exige a identidade correta; o oha exige
respostas 200 e ausência de erros de transporte. A prova SQL posterior confere identidade do replay,
um débito, versão da wallet e conjunto de eventos preservados.

**Resultado.** Cada amostra completou 3.001 respostas HTTP 200, sem erro de transporte. O tick adicional
na fronteira do agendador foi admitido previamente (3.000 ou 3.001), sem ajustar o critério após medir.
O k6 teve 3.001 checks aprovados, zero iterações descartadas e todos os thresholds aprovados.

| Sonda | req/s observado | p50(ms) | p95(ms) | p99(ms) | máximo(ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| oha POST replay | 100,009 | 3,634 | 6,299 | 9,195 | 19,670 |
| oha GET | 100,020 | 1,958 | 2,814 | 4,865 | 9,999 |
| k6 GET, `http_req_duration` | 100,025 | 1,961 | 2,782 | 4,783 | 14,409 |

**Limites e defeitos.** Essas amostras sequenciais compartilham host, banco e stack local; não estimam
capacidade de produção nem possuem intervalo de confiança. `http_req_duration` e latência do oha são
medições de suas ferramentas; o k6 também mede a chamada inteira separadamente (p95 = 3 ms). O oha não
valida o corpo de cada resposta: amostras representativas e a prova SQL posterior sustentam a conclusão
financeira. Nenhum novo efeito financeiro ou defeito da aplicação foi observado nesses probes.

## pg_activity: contenção por carteira e conexões

**Objetivo e método.** Observar uma carteira de 1.000,00 sob dez BETs distintos de 10,00 enquanto
uma transação própria retém seu lock. Um BET de outra carteira deve concluir antes de liberar esse
lock. `pg_activity 3.0.3`, envolvido por `script` para obter um TTY, roda por 35 s; somente o resumo
numérico de sessões é retido. Uma consulta de `pg_blocking_pids` confirma a cadeia de bloqueio.

**Resultado.** Foram obtidas 36 amostras, entre 10 e 23 conexões, de um máximo configurado de 200.
Uma amostra mostrou dez sessões aguardando lock; a consulta independente encontrou cinco sessões na
cadeia no instante de sua leitura. A outra carteira concluiu seu BET com o lock ainda retido.
Após liberar e recuperar pelas chaves originais, os saldos foram 900,00 e 90,00, com ledger consistente.

**Limites e defeitos.** Os instantâneos das duas ferramentas não são simultâneos. O limite de pool da
aplicação é 80 conexões (oito processos × dez), não uma medição de ocupação; os totais do PostgreSQL
incluem as conexões dos instrumentos. O monitor encerrou pelo timeout previsto, código 124.
A primeira tentativa falhou antes do exercício de lock porque o parser externo não removia as
sequências de designação de caracteres do terminal. Um diagnóstico isolado mostrou zero matches no
parser antigo e seis no corrigido sobre a mesma saída. O parser foi corrigido e a campanha completa
foi executada novamente; a falha e seus artefatos foram preservados. Nenhum defeito financeiro foi
observado nesse experimento.

## Pumba: kill e pause durante tráfego

**Objetivo e método.** Selecionar aleatoriamente uma réplica dentro do projeto e papel corretos:
`SIGKILL` de consumer, `SIGKILL` de worker e pause de API por 5 s. Nos kills, lotes contínuos mantêm
tráfego até o comando de falha terminar; a evidência exige o instante do kill dentro da janela de
tráfego. Cada caso usa vinte operações distintas; replays conservam sua identidade. As réplicas
encerradas são reiniciadas explicitamente.

| Caso | Operações distintas / tentativas oferecidas | Observação |
| --- | ---: | --- |
| Consumer | 20 / 160, oito lotes | Uma réplica encerrada; dez redeliveries observadas e conclusão em duas réplicas sobreviventes. |
| Worker | 20 / 140, sete lotes | Um worker encerrado durante tráfego HTTP; outbox drenada após recuperação. |
| API | 20 / 20 | Uma réplica observada em pause; solicitações oferecidas durante essa janela e recuperação posterior. |

**Resultado.** Todos os comandos de falha terminaram com código zero; cada operação teve um efeito
financeiro. O fechamento confirmou os oito processos saudáveis e reconciliação sem divergência.

**Limites e defeitos.** Esses kills são aleatórios: não demonstram, isoladamente, uma queda entre
commit e ack ou entre envio e marcação da outbox. As janelas determinísticas são exercitadas pelos
cenários 5/5b/6 entregues. As tentativas oferecidas incluem duplicatas, não são operações financeiras
distintas. Nenhum defeito da aplicação foi observado nesses três experimentos.

## Toxiproxy CLI: timeout, slicer e limit_data

**Objetivo e método.** Usar `toxiproxy-cli 2.13.0` para explorar três toxics fora do conjunto
automatizado. Nos casos de banco, um REFUND já pendente aguarda uma referência ainda ausente;
o BET de referência é oferecido durante a falha. O caso SQS mantém o toxic até os dois eventos
específicos serem confirmados como publicados. Remoção e reset são obrigatórios no fechamento.

| Toxic / enlace | Parâmetros | Resultado durante a falha |
| --- | --- | --- |
| `timeout`, PostgreSQL | 1.000 ms, downstream | HTTP 503; dependente permanece `PENDING_REFERENCE`, sem `failureCode` ou `FAILED`. |
| `limit_data`, PostgreSQL | 128 bytes, downstream | HTTP 503; a mesma proteção de referência e atomicidade permanece. |
| `slicer`, SQS | Fatias de 64 bytes, variação zero, atraso de 1.000 µs | HTTP 200 e os dois eventos publicados com o slicer ainda ativo. |

**Resultado.** Instalação e remoção aprovadas, proxies habilitados e sem toxics após os casos. A
recuperação usa a chave original: um BET e uma reversão nos casos de banco, saldo final 100,00;
um BET no caso SQS, saldo 90,00. Ledger, eventos e reconciliação foram conferidos.

**Limites e defeitos.** Os casos de referência ocorrem antes do TTL: não provam o comportamento na
fronteira de expiração, que possui testes automatizados próprios. O atraso do slicer é em
microssegundos, não milissegundos. Nenhum defeito da aplicação foi observado nesses casos.

## Pumba netem: atraso e perda nos enlaces de banco e SQS

**Objetivo e método.** Instalar quatro falhas reais por 10 s na saída `eth0` do Toxiproxy, filtrando
o destino PostgreSQL ou MiniStack: atraso de 250 ms sem jitter e perda de 100%. O helper está fixado
por digest (`pumba-alpine-nettools@sha256:bdcfacdd0c42f64cd280319d6dd5d3911f33425ce4a5168bb1b7de9570b72cd1`).
Uma consulta independente de `tc` exige o qdisc `netem` ativo antes do tráfego e a restauração exata
do qdisc inicial após o comando. No enlace SQS, também exige trabalho positivo sob a falha.

| Enlace / falha | HTTP / tempo da chamada | Evidência específica |
| --- | --- | --- |
| PostgreSQL / 250 ms | 200 / 2.766 ms | Chamada oferecida após observar o qdisc; efeito único e recuperação completa. |
| PostgreSQL / perda 100% | 200 / 12.041 ms | A chamada atravessou a janela de falha e concluiu após a recuperação. |
| SQS / 250 ms | 200 / 9 ms | Os dois eventos foram publicados enquanto o qdisc ainda estava ativo. |
| SQS / perda 100% | 200 / 8 ms | Dois eventos não publicados, tentativa 1 e nova falha de publicação observadas com qdisc ativo; publicação posterior confirmada. |

**Resultado.** As quatro instalações e remoções reais passaram, código zero, sem fallback. Todos
os casos terminaram com um débito, saldo 90,00, nenhuma outbox não publicada e reconciliação válida.

**Limites e defeitos.** A falha atinge tráfego de saída do proxy para o destino selecionado, não toda
a rede bidirecional. Um POST HTTP 200 sob perda de SQS confirma o commit financeiro; a entrega dos
eventos ocorre depois. O tempo de uma chamada não mede isoladamente o atraso por pacote. Nenhum
defeito da aplicação foi observado nesses quatro casos.

## tcpdump: commit, publicação e acknowledgement

**Objetivo e método.** Isolar uma mensagem em infraestrutura real, sem réplicas de aplicação
concorrentes. Um consumer de batch 1 usa os adaptadores reais. O callback do ORM confirma o commit;
uma conexão independente observa saldo 90,00, um ledger, uma inbox processada e duas outboxes ainda
não publicadas. Gates controlam a publicação e o ack. Middleware de metadados registra somente nome,
início, fim e sucesso dos comandos reais do SDK, sem alterar seus argumentos.

`tcpdump 4.99.3` captura resumos TCP numéricos nos enlaces de PostgreSQL e SQS. O carrier isolado
usa somente `NET_RAW` e `SETGID`; binário e bibliotecas são montados somente para leitura. Não há
pcap nem impressão de conteúdo. Antes de parar a captura, o instrumento exige bytes positivos de
saída nas janelas já concluídas de publicação e delete.

| Comando real | Início após commit financeiro | Início após snapshot SQL visível | Registros na janela / com dados de saída |
| --- | ---: | ---: | ---: |
| `SendMessageBatchCommand` | 186,807 ms | 106,132 ms | 14 / 3 |
| `DeleteMessageCommand` | 193,231 ms | 112,556 ms | 12 / 3 |

**Resultado.** Um teste aprovado, 40 asserções. Foram retidos 244 registros numéricos, 81 no intervalo
financeiro de PostgreSQL, com dados em ambas as direções. A captura reportou 244 pacotes capturados,
324 recebidos pelo filtro e zero descartes pelo kernel; uma linha não numérica foi rejeitada.
Cada evento teve um efeito no consumidor de prova, a inbox permaneceu única e o ledger reconciliou.

**Limites e defeitos.** A evidência correlaciona tempos de pacote, confirmação do ORM, visibilidade
SQL e identidade das chamadas do SDK. Não decodifica `COMMIT`, publish ou delete no fio. Captura em
`any` pode observar tráfego encaminhado mais de uma vez; esses números não são requisições únicas.
É uma operação amostrada e controlada; concorrência e quedas são cobertas separadamente. Na preparação,
o instrumento ganhou uma espera limitada por metadados já capturados antes do SIGINT, para evitar
perder dados ainda em buffer. Nenhum defeito da aplicação foi observado nessa prova.

## Histórico da portagem para ferramentas em containers

As validações abaixo ocorreram antes do commit de ferramentas `bcc0a7b81248a0104bdef721a6d2b77c3c10a276`.
Os manifestos identificam HEAD `d11e8e3` com alterações de instrumentos ainda não commitadas e hashes
próprios. Não constituem aprovação da versão retida. Os resultados anteriores com ferramentas host
permanecem associados a `f8a4c1f`/`efbca3a`/`d11e8e3` nas seções acima.

- `manual-port-parallel-1`: 19:59:01.438–19:59:05.538 UTC, um caso aprovado, zero falhas,
  doze casos não selecionados e trinta asserções. Cinquenta respostas HTTP 200 e um débito;
  a reconciliação separada conferiu uma de uma carteira, com oito asserções.
- `manual-port-full-1`, **reprovado**: 20:01:31.279–20:04:12.368 UTC, código 1. Há cinco
  aprovações nomeadas preservadas (oha/k6, pg_activity e três ações Pumba) e a falha nomeada
  de Toxiproxy timeout. O resumo parcial não permite classificar o sétimo caso iniciado;
  os casos posteriores não foram executados. A reconciliação após a falha passou em 64/64
  carteiras, 260 asserções; cleanup sem falha.
- O defeito era do instrumento portado: o CLI Toxiproxy no container usava a porta publicada
  do host, em vez da porta interna. A remoção também falhava e podia mascarar a primeira
  asserção. Foram corrigidos somente o endereço e a preservação do erro principal/cleanup.
- `manual-port-network-2`: 20:05:24.728–20:06:36.829 UTC, sete casos aprovados, seis não
  selecionados, zero falhas e 680 asserções. Exercitou os três toxics e quatro netem; a
  reconciliação separada conferiu 7/7 carteiras, 32 asserções. Depois, a captura isolada
  passou com 56 asserções, 82 registros de pacotes (69 PostgreSQL/13 SQS), zero descartes
  pelo kernel e duas linhas rejeitadas pelo parser. Houve nove casos efetivamente aprovados,
  768 asserções incluindo os fechamentos, sem contar skips como aprovação.
- `manual-port-provenance-3`: a captura selecionada passou novamente, 56 asserções, depois
  de acrescentar hash de `package.json`, imagens efetivas e verificação final de fontes.
  `sourceVerified=true` e `cleanupFailed=false`. Essa mudança de metadados é identificada;
  não preenche retroativamente os manifestos mais antigos.

Os seis probes de recusa de preflight passaram: seletores vazio/desconhecido/duplicado,
`--only` repetido, saída dentro do checkout e stack `wagering-test` preexistente. O sentinela
não foi removido pelo runner; somente o próprio probe removeu o ID que havia criado.
A validação de versões/build confirmou as ferramentas no Linux x86-64 local. Não se afirma
portabilidade para outros sistemas ou daemon remoto. APT é resolvido durante o build; hashes
de imagem e versões efetivas distinguem execuções. Manual-retained-2 e manual a98 passaram depois
com os oito seletores, incluindo stress; GNU a98 teve seis rodadas funcionais por redução
explícita de escopo. São fontes próprias; não preencher retroativamente estes experimentos.

## Primeira campanha manual retida: falha do launcher de stress

Os caminhos `execution/...` abaixo identificam registros externos preservados, não arquivos incluídos no repositório entregue.

A execução `manual-retained-1` registra source `a76f1b027358d50c0c22463164634587d5208e13`,
com árvore limpa no manifesto criado em 01/11/2026 às 21:16:03.596 UTC. Seu
resultado global (`execution/evidence/manual-retained-1/result.json`) é **FAIL**: `failed=true`,
`passed=false`, `sourceVerified=false` e `cleanupFailed=false`. Sete das oito famílias
selecionadas constam como concluídas; `stress` não consta. O manifesto inicial e as etapas
aprovadas não substituem a verificação final de fontes que essa campanha não concluiu.
A sessão global terminou às 21:22:07 UTC com exit 1, conforme informado pelo executor;
esse horário e código não são campos do `result.json`.

| Etapa efetivamente encerrada | Evidência e resultado | Alcance |
| --- | --- | --- |
| Principal manual | `execution/evidence/manual-retained-1/manual/test-result.json`: exit 0, **13 PASS/0 FAIL/9.482 asserções**, de 21:16:55.280 a 21:20:53.812 UTC; 238.532,000863 ms do comando e 238,52 s no resumo Bun. | Parallel, oha/k6 GET, pg_activity, três ações Pumba, três toxics e quatro netem, todos com outcome nominal aprovado. Não inclui a suíte de stress. |
| Reconciliação separada do principal | `execution/evidence/manual-retained-1/manual/reconciliation-result.json`: exit 0, **1 PASS/0 FAIL/288 asserções**, de 21:20:53.814 a 21:20:54.202 UTC. `execution/evidence/manual-retained-1/manual/all-wallet-reconciliation.json`: **71/71 carteiras**, conjunto estável e ledger válido. | Verificação fornecida pelo runner sobre todas as carteiras daquele stack; esta leitura posterior dos artefatos não é nova consulta SQL independente. |
| Captura isolada | `execution/evidence/manual-retained-1/tcpdump/test-result.json`: exit 0, **1 PASS/0 FAIL/56 asserções**, de 21:21:49.360 a 21:21:51.347 UTC. `execution/evidence/manual-retained-1/tcpdump/tcpdump.json`: 82 metadados de pacote, 69 no namespace PostgreSQL e 13 no MiniStack, zero descartes pelo kernel, duas linhas rejeitadas e reconciliação final 1/1. | Metadados correlacionados com commit confirmado, visibilidade SQL e chamadas SDK, com campo salvo de pacote de dados de saída positivo em cada intervalo; sem payload, arquivo bruto ou decodificação de comandos no fio. |
| Arranque do stressor | `execution/evidence/manual-retained-1/stress-process.json`: **exit 1**, 56 bytes de saída capturada, `activeAtEnd=false` e nenhum resumo de stress. | Falhou antes da suíte real de concorrência sob stress. Não há aprovação de stress nessa tentativa. |

Os três comandos Bun concluídos somam **15 PASS/0 FAIL/9.826 asserções**, sem converter a
campanha global em PASS. A carteira da captura é uma fixture separada das 71 do principal;
não há um único conjunto reconciliado de 72 carteiras. A conferência final dos artefatos
(`execution/manual-retained-data-audit.md`) não encontrou divergências
nos dados conferidos e preservou a falha global e esses limites de evidência.

O diagnóstico separado do launcher (`execution/evidence/stress-temp-path-regression-1.json`), de
21:25:16.290 a 21:25:17.962 UTC, reproduziu a falha com diretório temporário no checkout somente
leitura: exit 1, 56 bytes de stderr e nenhum dispatch CPU. A única diferença de argumentos do
segundo braço foi `--temp-path /tmp`; ele terminou com exit 0, despachou doze workers CPU e
informou sucesso. Cada braço tinha timeout de um segundo; os comandos duraram respectivamente
306,108663 e 1.333,216794 ms. A fonte declarada era `a76f1b0`, com somente a correção de três
linhas do launcher ainda não commitada. Esse diagnóstico fundamenta a correção limitada à flag;
não executou os treze testes, não mede exposição da suíte sob CPU e não transforma a tentativa
anterior em aprovação. Os artefatos da tentativa reprovada permanecem preservados.

Não se atribui `sourceVerified=true` a `manual-retained-1`, nem se usa seu final principal para
aprovar o comando global. A campanha corrigida `manual-retained-2`, fonte
`9fab36026b375c306a70c0aabaacbd5cdc811526`, manifesto de 21:25:42.130 UTC, terminou
posteriormente **PASS**, oito seletores, **29 PASS/0 FAIL/11.939 asserções**. O responsável
observou o encerramento às 21:40:45 UTC. Resultado global registra `sourceVerified=true` e
`cleanupFailed=false`. Fonte: `execution/manual-retained-2-data-audit.md`. Essa aprovação
histórica não reescreve a primeira falha e não é a posterior manual a98 de 11.819 asserções.

## Experiência controlada de persistência em lote da outbox

A campanha `outbox-comparison-1` terminou em 01/11/2026 às 21:14:21 UTC, com seis braços válidos
na ordem B,C / C,B / B,C. O baseline foi `66660b9cec0c38ee241d5332f3630d5022430ceb`; a candidata,
`39d4b89bf60df533cb16706e0f133356225919b8`. Os três ganhos pareados de drenagem foram
**8,428546%, 3,397665% e 15,038269%**, com mediana **8,428546%**. O critério prévio exigia
mediana ≥15% e cada par ≥10%, além de correção integral e custo justificável: **gate FAIL**.

Todos os braços passaram suas verificações técnicas/financeiras, com 40.000 IDs/efeitos únicos e
reconciliação das 10.000 carteiras por braço; essa aprovação não substitui o gate de benefício.
A candidata foi rejeitada, e somente seus dois arquivos de produção foram restaurados em
`eb3fcf2`, com bytes conferidos contra o baseline. A [regressão pós-restauração](#estado-da-versão-retida-e-fronteira-da-evidência)
passou nos dez testes dirigidos. Campanhas posteriores têm resultado e fonte próprios; sua
aprovação não decorre desse teste dirigido.

As tabelas completas, contagens SQL, CPU, tempos por fase e limites estão em
[load-test.md](load-test.md). A drenagem instrumentada não mede latência HTTP ou capacidade
sustentada; o host não era exclusivo, processos se sobrepõem e o custo do observador não foi
quantificado. A fonte oficial do MiniStack não foi comprovada como equivalente aos bytes da imagem,
e o crescimento do tempo SDK não identifica sua causa. A comparação HTTP condicionada à aprovação
da candidata não foi executada. Nenhum resultado experimental da candidata é atribuído ao produto
retido; piloto e benchmark externo permanecem fora dos seis braços usados para decidir a retenção.

## Verificação dirigida dos instrumentos posteriores à AWS

Após o encerramento das cargas retidas, o observer de prova ganhou retry limitado somente para ACKs de eventos `RequestThrottled`: o commit SQL acontece uma vez, e a confirmação usa o mesmo receipt handle. O runner nativo passou a aguardar prontidão real do Prometheus e a separar o primeiro erro recuperado do erro terminal identificado. O verificador SQL reúne contagens e partição da inbox em um único statement. Nenhuma dessas alterações modifica a aplicação financeira, suas migrations, contratos ou publishers.

Em checkout isolado baseado em `a98d1e6`, com os sete arquivos pertinentes iguais antes/depois, `bun run test:integration` passou em 02/11/2026, **06:40:56 a 06:43:22 UTC**: **177 testes, zero falhas e 6.703 asserções em 21 arquivos**. A regressão de ACK usou PostgreSQL e SQS reais e um 403 injetado no primeiro delete; provou commit único, efeito único e espera pelo ACK antes do shutdown. Isso não mede throttling real da AWS. A regressão do snapshot usou duas conexões PostgreSQL reais: reproduziu a diferença entre dois statements separados e verificou o statement combinado sob commit intermediário controlado, sem sleeps. A reprodução demonstra o defeito possível no oráculo antigo; não estabelece a causa da falha histórica full-1.

O check desse staging passou em **06:47:50 a 06:47:58 UTC**: Biome e TypeScript aprovados, **189 testes unitários, zero falhas e 1.577 asserções**. Esses resultados são verificações dirigidas do staging; não representam o commit final, uma nova campanha full ou uma nova execução AWS. Os gates finais deverão identificar o commit efetivamente entregue.

</details>

## Relatório visual e fronteiras de aceitação

O [índice HTML offline](load-report/index.html) reúne três recortes independentes: os
[FULL locais A/B/C](load-report/local/index.html), o [FULL3 AWS](load-report/aws/index.html)
e o [QUICK histórico a98](load-report/historical/index.html). Os arquivos abrem sem servidor ou
biblioteca externa. As fontes, a aceitação e os limites de cada recorte acompanham os gráficos.

O painel local preserva três FULL históricos da fonte `06e6165` e do hash de carga `c99c4ac6…`.
O painel AWS preserva uma única rodada FULL aprovada da quarta sessão, com aplicação `d52abed`,
hash `0d029aec…` e correção do health check do ALB aplicada antes da medição. Os dois FULL anteriores
dessa sessão continuam reprovados. Os resultados e as condições completos estão em
[load-test.md](load-test.md) e [load-test-aws.md](load-test-aws.md).

A população do painel histórico a98 continua sendo uma QUICK AWS e dois FULL nominados da mesma
fonte/hash. A QUICK é diagnóstica e tem core aprovado; os dois FULL permanecem excluídos integralmente,
com resultado e verificação finais ausentes. Esse recorte não é a taxa de aprovação de todos os smokes
ou diagnósticos, e a aprovação posterior do FULL3 não preenche suas lacunas. O renderer histórico
recusa misturas de fonte ou hash, inclusive em execuções reprovadas.

A/B/C, a comparação rejeitada da outbox, o snapshot forense e os experimentos manuais mantêm seus
registros próprios. Amostras ausentes ou NaN permanecem lacunas; percentis de réplicas não são
promediados, filas replicadas usam máximo por instante e rates alinhadas usam soma. Não se apresenta
comparação de FULL local/AWS sob a mesma fonte e metodologia, três FULL AWS ou capacidade sustentada.
Os descartes do gerador AWS também impedem apresentar os alvos configurados como taxas atingidas.

## Gates finais

Os comandos finais obrigatórios são `bun install --frozen-lockfile`, `bun run check`, `bun run test`,
`bun run test:failure` e `bun run test:load`, executados em clone limpo. A dispensa específica de nova
GNU20 não dispensa esses comandos. Scans de segredos, revisões e demo literal têm recibos próprios.

### Gates locais em `d52abed`

Em 02/11/2026, de **10:44:01.176 a 11:01:35.805 UTC**, o clone limpo de
`d52abedad905f02c03c5a10ba5f16598271ef888`, criado sob `$HOME/.cache`, passou os cinco comandos.
Todos os recibos registram `workingTreeClean=true`, `sourceVerified=true` e exit 0. O PATH permitia
somente Bun, Docker e utilitários básicos de shell; essa restrição de busca não equivale a um sandbox
contra executáveis por caminho absoluto ou ferramentas internas dos containers. PostgreSQL e
MiniStack foram reais, com três APIs, três consumers e dois workers nas suítes aplicáveis.

| Comando | Resultado observado na fonte d52abed |
| --- | --- |
| `bun install --frozen-lockfile` | PASS, exit 0. |
| `bun run check` | Biome e TypeScript PASS; 202 testes unitários, zero falhas e 1.666 asserções. |
| `bun run test` | Unidade: 202/0/1.666; integração: 178/0/7.105; concorrência: 13/0/1.549, em PASS/FAIL/asserções. |
| `bun run test:failure` | 11 PASS, zero falhas e 1.779 asserções. |
| `bun run test:load` | QUICK completo aprovado; oráculo 1 PASS, zero falhas e 2.006 asserções. |

O QUICK `2026-11-02T10-58-40-637Z-88434e1f` teve `passed=true` e `partial=false`: **1.001 wallets,
3.251 transações processadas e lançamentos, 6.502 eventos e 1.000 inbox**, com zero inbox inacabada,
efeitos duplicados, outbox não publicada e DLQ. O projeto local `wagering-test` terminou com zero
containers, redes e volumes. Essa limpeza é exclusivamente local; não declara remoção de recursos AWS.

O manifesto externo `execution/evidence/task-13-final-gates-4.json`, SHA256
`78464a6c090c09cd2b0453cc820800be72cfe5f6c8e6253aec1915ef24bfce80`, reúne 13 recibos aprovados:
clone, cinco comandos, comparação dos blocos/dependências do README, opções literais, resumo QUICK,
inventário opaco, imagem do scanner e limpeza. Seus 13 hashes foram conferidos na revisão documental,
sem ler payloads privados. Os scans literais de histórico e árvore deram zero findings; a lista manual
B15 foi consultada, sem iniciar campanha. O fechamento oficial foi adotado em
`root-task13-official-final-adoption-1.json`, às **11:19:42.575 UTC**, para a mesma fonte.
A execução oficial separada contém 5.013 asserções de integração; esse número não substitui as
7.105 asserções do gate literal acima.

A CI cobre push e pull request com Bun 1.4.3, instalação congelada, `check` (lint, tipos e unidade),
integração, concorrência e Gitleaks. O conteúdo versionado coincide com o SHA256
`53e99bd606f6ac2b3ca1134faf070cc3845e3b21338389ef4a129661cd02844f` da validação local:
parse YAML, 19 verificações estruturais e seis passos ShellCheck aprovados. `actionlint` não estava
disponível; esse registro não é validação de toda a semântica do GitHub nem execução remota de Actions.

Os 19 corpos Bash do README e suas dependências pertinentes foram comparados no clone d52abed.
B15/B17/B18 foram executados nesse clone; B01–B13/B16/B19 conservam execuções históricas,
reutilizadas somente pelo vínculo verificado de corpos e dependências. A dispensa de nova GNU20
permanece explícita. A revisão ampla independente da Task 13 encerrou na fonte `4f304d6`, com
201 caminhos conferidos e sem achado Critical, Important ou novo Minor. A adoção final reutiliza
esse escopo verificado; esta revisão documental é direcionada e não inicia outra auditoria ampla.

A revisão posterior modifica documentação, visualizações e a correção de infraestrutura descrita no
relatório AWS. Enquanto essas alterações permanecerem no WIP, **não há novo commit de entrega nem
novos gates atribuídos a ele**. Os resultados d52abed permanecem válidos para sua fonte e não são
renomeados. Os comandos de reprodução e renderização alterados exigem sua verificação dirigida;
este documento não declara nova execução de containers, nova campanha de carga ou CI remota.

### Verificação da revisão documental e visual

A revisão posterior de 02/11/2026 passou `bun run check`: lint e tipos aprovados,
**209 testes unitários, zero falhas e 1.711 asserções**. Esse total inclui os cinco
novos testes de campanhas FULL e os dois testes do preview HTTP; o recorte do renderer
passou **31 testes**. O lint
terminou sem erros e conserva avisos não bloqueantes. Não foram repetidas as suítes
com containers ou as campanhas de carga: a aplicação financeira e seus instrumentos
de execução não foram alterados por esta revisão.

Os dois comandos de reprodução a partir das projeções versionadas local/AWS foram
executados e geraram HTML idêntico byte a byte ao entregue. O bloco histórico B16
também foi executado novamente, aprovando o QUICK e excluindo os dois FULL incompletos;
seus cinco SVGs coincidem com o arquivo histórico, cujo HTML só recebeu ajuste dos
links relativos. Os 19 corpos Bash do README continuam idênticos aos da fonte d52.

O Chromium conferiu os cinco HTML em desktop/mobile e claro/escuro: **20 observações**,
sem requisições externas, erro JavaScript ou overflow da página. A conferência adicional
dos detalhes dos gráficos cobriu quatro combinações local/AWS e desktop/mobile no tema
escuro, após corrigir o contraste dos SVGs. A arquitetura também passou a verificação
dos seletores HTTP/SQS, abas e navegação por teclado. A revisão independente dos textos,
links e da nova lógica de renderização é dirigida a este escopo.

A verificação posterior com Playwright abriu os detalhes dos gráficos nos 20 cenários e
executou **161 cliques reais**: os 81 links no desktop e os 80 visíveis no mobile.
Todos passaram, incluindo 22 fragmentos HTML, o diretório de código e o download do Compose.
Uma ocorrência adicional de link fica intencionalmente oculta no mobile; as alternativas
visíveis foram verificadas. Os controles HTTP/SQS e as abas local/AWS também passaram
nos quatro modos, com navegação por teclado. Os três links do painel histórico para
fragmentos Markdown abriam o arquivo cru sem saltar à seção; seus destinos foram ajustados
para os documentos completos, mantendo os nomes das seções no texto. O renderer recebeu
o mesmo ajuste e foi executado novamente: seus cinco SVGs e o HTML histórico continuam
reproduzíveis, com somente a adaptação dos caminhos relativos para a pasta do arquivo.
O `bun run check` posterior à correção manteve **207 testes, zero falhas e 1.693 asserções**.

A abertura no host pelo portal do desktop apresentou uma fronteira diferente do
`file://` testado dentro do container: o arquivo isolado em `/run/user/.../doc/...`
não disponibilizava a árvore vizinha dos links relativos. O comando `bun run docs:preview`
serve a documentação por HTTP em `0.0.0.0:4173`, com encaminhamento pela aba **Portas**
do VS Code. A nova verificação Playwright por HTTP repetiu os **20 cenários, quatro
cenários de controles e 161 cliques**, sem falhas, respostas HTTP de erro, requisições
externas ou overflow. Ela valida o servidor local; o encaminhamento e o portal do
host não foram inspecionados pelo browser do container. Os dois testes novos
protegem a navegação e a recusa de arquivos privados, traversal e symlinks para alvos
não servidos. Uma revisão independente dirigida aprovou mais 23 verificações em
fixtures temporárias. O preview não inicia a aplicação nem acessa AWS ou serviços de teste.

O mesmo preview foi incluído no Compose como serviço `docs`, com Bun 1.4.3,
checkout e sistema de arquivos somente para leitura, porta 4173 em loopback e
healthcheck HTTP. A execução real de `docker compose --env-file /dev/null -p wagering
up -d --wait docs` iniciou somente `wagering-docs-1`, que ficou saudável; a porta
alternativa via `DOCS_HOST_PORT` também foi validada na configuração. A revisão
independente confirmou que o serviço fica fora dos perfis padrão, de teste e de
carga. O `bun run check` desta alteração passou com **209 testes, zero falhas e
1.711 asserções**. O Playwright pelo serviço do Compose repetiu os **20 cenários e
161 cliques**, sem problemas. Depois, o tema da arquitetura foi alinhado à paleta
escura dos demais HTMLs: outros quatro cenários desktop/mobile e claro/escuro
aprovaram as cores, os controles, a troca dinâmica de tema e a impressão clara.
O conteúdo fora do CSS e do metadado de tema permaneceu idêntico byte a byte,
incluindo textos, links, marcação dos cinco SVGs e JavaScript.

O Terraform foi validado em cópia externa com backend desativado: **zero erros e um
aviso conhecido**. No provider AWS 6.71.0, remover `failure_threshold` do custom health
faz o SDK omitir a configuração necessária ao ECS no namespace privado. A reprodução
local confirmou esse comportamento; o valor explícito foi mantido e comentado,
conforme a [issue do provider](https://github.com/hashicorp/terraform-provider-aws/issues/44285).
O aviso não foi resolvido. Não houve `plan`, `apply` ou chamada à AWS nesta revisão.

### Navegação, seleção de tema e visualizador de Markdown

A revisão seguinte de 02/11/2026 acrescentou uma barra superior compartilhada pelos
cinco HTML e pelos documentos Markdown servidos no preview. Os links **Início**,
**README**, **Arquitetura** e **Verificação** usam caminhos relativos adequados a cada HTML;
no visualizador, apontam para a raiz HTTP. Início retorna à central de relatórios,
e os atalhos redundantes abaixo da barra foram removidos do índice e do visualizador
Markdown, incluindo README e Verificação. O botão de aparência oferece Automático,
Claro e Escuro, com preferência salva no navegador, indicação da escolha e operação
por teclado. A impressão fica clara e oculta a barra.

O preview passou a renderizar Markdown usando o parser nativo do Bun 1.4.3, sem
dependências externas: títulos, tabelas, código, seções expansíveis e âncoras
explícitas continuam disponíveis. Os IDs dos títulos preservam os acentos usados
pelos links existentes. O HTML resultante passa por uma lista de elementos e
atributos permitidos; as URLs são normalizadas e limitadas a protocolos permitidos.
O script de tema é constante e autorizado pelo hash exato na CSP. Fontes e
configurações citadas pelos documentos continuam consultáveis como texto ou JSON,
com acesso limitado aos caminhos públicos explicitamente permitidos.

O `bun run check` desta versão passou: **212 testes unitários, zero falhas e 1.771
asserções**, além de lint e tipos sem erros. O recorte dos relatórios passou **31
testes e 140 asserções**, e os cinco testes do preview passaram **53 asserções**.
Os novos casos cobrem a renderização Markdown, links relativos, âncoras acentuadas
e duplicadas, HTML ativo, esquemas de URL ofuscados por entidades e a permissão
estrita dos arquivos de configuração. A revisão independente confirmou ainda a
recusa de 14 casos de diretórios, caminhos privados, traversal e symlinks para
conteúdo privado ou fora da raiz.

O Playwright pelo serviço `docs` do Compose aprovou **25 cenários** dos cinco HTML
em desktop, mobile e tela intermediária, em claro/escuro, cinco verificações de persistência entre páginas
e **15 verificações de fallback**: armazenamento bloqueado em HTTP e `file://`,
e leitura com JavaScript desativado. Foram conferidos os três modos de tema,
mudanças dinâmicas do sistema, navegação por teclado, fechamento do menu, foco,
impressão, ausência de overflow e os controles anteriores da arquitetura. Textos,
links e SVGs preexistentes permanecem iguais ao checkpoint anterior, excluindo a
nova barra, a remoção da navegação redundante e a atualização explicativa do rodapé
do índice. Local e AWS continuam
reproduzíveis byte a byte a partir de seus `campaign.json`.

O visualizador também passou uma campanha dirigida de navegação: seis destinos
Markdown descobertos a partir dos HTML, sete âncoras Markdown clicadas com seção
visível e **88 cliques reais** nos quatro links da barra, pelas 11 páginas, em desktop
e mobile. Os 183 links dos seis Markdown corresponderam a **72 URLs internas e 65
recursos públicos**, todos com resposta HTTP 200. Os oito cenários visuais de README
e relatório AWS cobriram claro/escuro e desktop/mobile, incluindo tabelas, código,
seções expansíveis, troca de tema, impressão e retorno ao relatório HTML. Outras duas capturas
conferiram o menu aberto: no mobile ele fica abaixo da barra, sem encobrir os quatro
links; clique fora, segundo clique e Escape com retorno de foco passaram. Nenhum
erro JavaScript, erro de console ou pedido de recurso externo foi observado.

O container `wagering-docs-1` permaneceu saudável. Esses checks exercitam somente a
documentação: não repetem os gates financeiros com containers ou campanhas de carga,
nem acessam AWS. Os HTML continuam autossuficientes para `file://`; a renderização
dos arquivos `.md` depende do servidor. O acesso pelo portal do navegador do host
continua fora do ambiente inspecionado pelo Playwright.

<details>
<summary>Gates e demo históricos anteriores: 3fa0f86 e 4f304d6</summary>

### Gates locais em `3fa0f86`

Em 02/11/2026, um clone limpo de `3fa0f8614d4a7476f1ec495902bd2b407c082cf5` executou os cinco comandos literais com PATH restrito a Bun, Docker e ferramentas básicas de shell. Todos passaram com `sourceVerified=true`:

| Comando | Resultado observado |
| --- | --- |
| `bun install --frozen-lockfile` | PASS, exit 0. |
| `bun run check` | Biome e TypeScript PASS; 202 testes unitários, zero falhas e 1.666 asserções. |
| `bun run test` | Unidade: 202/0/1.666; integração: 178/0/6.905; concorrência: 13/0/1.549, em PASS/FAIL/asserções. |
| `bun run test:failure` | 11 PASS, zero falhas e 1.781 asserções. |
| `bun run test:load` | QUICK completo aprovado; oráculo 1 PASS, zero falhas e 2.006 asserções. |

O QUICK `2026-11-02T08-51-54-497Z-86f388f9` aprovou `passed=true` e `partial=false`: 1.001 wallets, 3.251 transações processadas e lançamentos, 6.502 eventos, 1.000 inbox, zero inbox inacabada, zero efeitos financeiros duplicados, zero outbox não publicada e DLQ zero. O projeto `wagering-test` terminou sem containers, redes ou volumes. Os recibos seguros estão nominados no manifesto externo `task-13-final-gates-3.json`; nenhum payload financeiro bruto integra este documento.

Os 19 corpos Bash do README continuaram idênticos ao ledger literal anterior. No clone atual, B15 (`verify:manual --list`), B17 (Gitleaks histórico disponível) e B18 (Gitleaks árvore) passaram; ambas as varreduras tiveram zero findings. Isso não executa nova campanha manual ou GNU20. A reutilização da demo histórica exige os mesmos corpos e dependências pertinentes; a evidência acima pertence a `3fa0f86`, e os gates do commit entregue têm recibos próprios. A terceira sessão AWS mantém [identidade e resultados separados](load-test-aws.md#terceira-sessão-fonte-e-resultados).

### Demo literal do README em `4f304d6`

Em 02/11/2026, de **07:26:53.722 a 07:28:12.327 UTC**, um clone limpo de `4f304d6701df8738e66e4dc4b60162d229fe2f6b` executou literalmente **B01–B13 e B19: 14 blocos, todos exit 0, em 78,605 s**. Os 19 hashes dos corpos Bash foram conferidos; os cinco blocos fora desse recorte não são declarados executados por esse registro. Uma única sessão Bash preservou as variáveis, com stdin fechado e PATH limitado a Bun, Docker e utilitários básicos de shell.

O recorte confirmou prontidão HTTP200, criação201, BET200 e replay200 da mesma transação; saldo reconciliado após HTTP e SQS, inbox processada e três entradas no ledger. A consulta SQL fechou com uma wallet, três entradas, zero eventos não publicados e zero referências pendentes. Redrive, migrations down/up, reinicialização e comandos de observação terminaram exit0. A limpeza final confirmou **containers0/redes0/volumes0** do projeto `wagering`; fonte e árvore continuaram verificadas. Tokens, corpos e logs ficaram somente em RAM, sem persistência de streams brutos. Recibo seguro: `task-13-literal-demo-2.json`, SHA256 `9d3a78c6ba1360fe3fe93f8a95330f82fd9981f275f3f1cb5793be128c1c39b0`.

A primeira tentativa foi preservada como **FAIL em B01**, antes das operações financeiras, com cleanup confirmado. Seu preparador externo havia criado o clone sob umask077, deixando código0600 e diretórios0700: uma condição estática incompatível com COPY preservando modos e execução não root. O primeiro serviço e a causa primária daquela falha não foram observados porque os streams foram descartados. A V2 usou outro clone criado sob022, verificou arquivos0644/diretórios0755 e manteve recibos privados0600/0700; não alterou aplicação, Dockerfile, README ou blocos para obter aprovação. O PASS da V2 não reclassifica retroativamente a primeira falha.

Os cinco comandos obrigatórios do último commit, os blocos opcionais e os scans conservam seus registros próprios; a demo não constitui aprovação final da entrega.

A revisão final independente da Task 13 encerrou em **07:21:22.739 UTC**, com 201 caminhos da fonte `4f304d6` conferidos antes/depois e nenhum achado Critical, Important ou novo Minor. A revisão focada única da Task 12 foi concluída separadamente. A consolidação que precedeu os gates d52abed preservou os corpos Bash e as dependências pertinentes segundo o recibo daquela versão. A reutilização dessas revisões e da demo depende desse vínculo verificado; alterações posteriores conservam atribuição própria. Os gates finais continuam vinculados à sua fonte por seus próprios recibos.

</details>
