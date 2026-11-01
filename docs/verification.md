# Verificação e reprodução

Esta entrega mantém as evidências de versões anteriores identificadas por fonte. A campanha
histórica de determinismo de `d11e8e39484bb0cb9b7165c12cbe2bcc3d9cd7f3` terminou em
01/11/2026 às 19:49:33 UTC: vinte rodadas seriais dos treze casos, 260 PASS e zero FAIL.
Ela antecede as ferramentas desta seção e qualquer otimização posterior, portanto não valida essas
mudanças. As duas campanhas anteriores reprovadas permanecem no registro de execução.

Durante o congelamento dessa campanha houve dois probes externos divulgados pelo usuário:
um probe curto de ferramentas com horário desconhecido e um diagnóstico FIFO MiniStack entre
aproximadamente 18:38 e 18:43 UTC. O segundo sobrepôs a rodada 12, que passou e durou
496,144 s. As rodadas 13 e 14 duraram 509,921 e 507,271 s. Não há medição causal dessas
diferenças; não se afirma isolamento do host nem se usam essas durações como benchmark.
Nenhuma rodada foi apagada ou repetida em razão dessa divulgação.

## Experimentos opcionais em containers

O comando abaixo exige Bun 1.4.3 e Docker com Compose. As ferramentas manuais rodam nas
imagens do perfil `verification`; não são dependências de `bun run test` nem da CI. O runner
recusa containers ou rede preexistentes do projeto `wagering-test` antes de assumir seu teardown.
Use um daemon local exclusivo para a execução. A implementação usa rede host para alcançar as
mesmas portas da suíte, bind do socket Docker para as ações Pumba e montagem somente leitura
do checkout; as evidências ficam em um diretório externo separado.

```bash
BUN_CONFIG_NO_ENV_FILE=true BUN_CONFIG_NO_AUTO_INSTALL=true bun --no-env-file install --frozen-lockfile
BUN_CONFIG_NO_ENV_FILE=true BUN_CONFIG_NO_AUTO_INSTALL=true bun --no-env-file run verify:manual --list
BUN_CONFIG_NO_ENV_FILE=true BUN_CONFIG_NO_AUTO_INSTALL=true bun --no-env-file run verify:manual
```

A execução padrão inclui corrida HTTP com GNU parallel/curl, oha replay/GET com contraprova
k6 GET, observação pg_activity, kill/pause Pumba, toxics via CLI Toxiproxy, quatro experimentos
netem, captura tcpdump e a suíte completa sob stress de CPU. Cada cenário faz assertions de
efeitos, recuperação e invariantes. A fase manual principal termina com reconciliação de todas
as carteiras; a captura reconcilia todas as carteiras de seu banco isolado antes de removê-lo;
stress e cada rodada GNU usam um filho separado de reconciliação antes do teardown.

Para selecionar experimentos e preservar uma pasta nova de evidências:

```bash
BUN_CONFIG_NO_ENV_FILE=true BUN_CONFIG_NO_AUTO_INSTALL=true bun --no-env-file run verify:manual --only=parallel,oha,pg-activity,pumba,toxiproxy,netem,tcpdump --output=/tmp/wagering-manual-run-1
BUN_CONFIG_NO_ENV_FILE=true BUN_CONFIG_NO_AUTO_INSTALL=true bun --no-env-file run verify:manual --only=stress --output=/tmp/wagering-stress-run-1
BUN_CONFIG_NO_ENV_FILE=true BUN_CONFIG_NO_AUTO_INSTALL=true bun --no-env-file run verify:manual --only=determinism --output=/tmp/wagering-determinism-run-1
```

`determinism` executa vinte repetições **da suíte real** `bun run test:concurrency`, em série,
com `--halt now,fail=1`. Os treze casos originais incluem a espera pela janela FIFO nativa;
não se trata de uma lista demonstrativa de jobs. Stress e determinismo exigem uma árvore limpa
no commit informado pelo manifesto. Não modifique fontes, imagens ou instrumentos nem execute
outros probes durante uma campanha congelada. Uma falha preserva os artefatos e reprova a
execução; o comando não repete rodadas para obter aprovação.

A pasta de saída precisa estar vazia e fora do checkout. Sem `--output`, o runner cria uma
pasta única em `~/.cache/wagering-verification`. Os JSONs guardam a fonte, hashes dos instrumentos,
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
retida. Stress, GNU20 e a execução manual completa do commit retido continuam gates de entrega.
O runner registra os IDs efetivos das imagens dos serviços, verifica os instrumentos no fim e,
quando parte de árvore limpa, exige que ela permaneça no mesmo commit. Outros sistemas e
daemons remotos não foram testados.
