# Medição complementar na AWS

Este módulo implementa D26 para uma campanha temporária em `us-east-2`. A operação exige uma conta
AWS e não faz parte de `bun run test`, da CI ou dos requisitos do avaliador. Os testes entregues
continuam usando Bun e Docker Compose. Uma validação Terraform local não comprova permissões,
quotas, saúde ou remoção de recursos na AWS.

O provider usa exclusivamente o profile `wagering-load`, com a conta esperada em `account_id`.
Não use outro profile, região, sessão Builder ID ou ferramenta AWS MCP. Não leia arquivos de
credenciais nem imprima secrets, tokens, planos completos ou conteúdo do state. Não altere
organização, SCP ou configuração da conta para executar esta campanha.
`operator-policy.template.json` contém as 15 permissões/grupos de permissões autorizados, com
`${AWS_ACCOUNT_ID}` como placeholder; sua presença não instala nem amplia permissões. A política
não promove o grant temporário usado no diagnóstico de envio de eventos.

## Rede e dimensionamento

Não há NAT Gateway, Internet Gateway, EIP, IP público ou SSH. O ALB é interno. Duas subnets privadas
atendem às exigências do ALB e do subnet group do RDS; tasks, runner, RDS e oito endpoints de interface
ficam na AZ primária. O gateway S3 permite o bucket de artefatos e as camadas regionais do ECR.
Security groups autorizam somente os caminhos entre serviços; `/metrics` não tem rota no ALB.

O target group verifica `/health/live` diretamente nas APIs para que uma falha temporária de
PostgreSQL ou SQS não provoque substituição de processos vivos pelo ECS. A admissão da carga
continua exigindo `/health/ready`, que verifica essas dependências. Durante uma indisponibilidade,
o ALB pode encaminhar requisições a uma API viva que responde 503 até a recuperação.

São três APIs, três consumers, dois workers e um Keycloak, cada task com 1 vCPU e 2 GiB. O banco é
PostgreSQL 17, `db.m7g.2xlarge`, Single-AZ, gp3 100 GiB criptografado, com TLS obrigatório, 200 conexões
e timeout de transação ociosa de 10 s. O runner privado `c7i.2xlarge` é acessível por SSM. Não há
autoscaling ou tuning entre rodadas. Keycloak `start-dev` e banco embutido servem somente a este
experimento; não são uma implantação de produção.

## Validação sem acessar a AWS

Use Terraform **1.17.1**. O lockfile fixa `hashicorp/aws` em **6.71.0** e permanece versionado.

```bash
terraform -chdir=infra/aws init -backend=false -input=false -lockfile=readonly
terraform -chdir=infra/aws fmt -check -recursive
terraform -chdir=infra/aws validate
terraform -chdir=infra/aws test
```

Os seis testes usam `mock_provider`, sem chamadas AWS: rede privada/serviços parados, recusa de
startup sem gates, prazo cumulativo e recusa de um segundo além da fronteira,
além da topologia 3/3/2 após os gates. Eles verificam a chave SDK `DbInstanceIdentifier` no target
RDS, API restrita aos metadados das três filas e ausência do grant temporário de envio de eventos.
Eles não demonstram que um schedule executou uma parada real. O atributo de custom health do
Cloud Map conserva a integração privada com ECS; o provider fixado avisa que seu threshold é sempre 1.

## Estado, segredos e origem

Mantenha state, plano salvo, variáveis e ledger fora do checkout, em um diretório protegido da
campanha. Configure `TF_DATA_DIR` externo e o backend local com `path` absoluto antes de qualquer
plan/apply. Nunca execute apply a partir do backend local padrão do repositório. Por exemplo, com
`AWS_EXECUTION_DIR` já apontando para o diretório externo autorizado:

```bash
export TF_DATA_DIR="$AWS_EXECUTION_DIR/terraform-data"
terraform -chdir=infra/aws init -input=false \
  -backend-config="path=$AWS_EXECUTION_DIR/terraform.tfstate"
```

`client_secrets` recebe três valores aleatórios novos de 32 bytes, codificados em hex, por variável
sensível. Não use os defaults locais do Compose. O RDS gerencia sua senha no Secrets Manager; não
forneça senha no Terraform nem publique seu valor. Execution roles injetam os secrets necessários,
separadas das task roles. A API só lê URL/atributos das três filas, conforme exceção de readiness
autorizada em D26. Consumer e worker têm operações de mensagem distintas, nas filas exatas.
As filas de requests e eventos declaram FIFO de alta vazão:
`deduplication_scope=messageGroup` e `fifo_throughput_limit=perMessageGroupId`.
O par de requests foi acrescentado após o FULL falho; seus atributos históricos
não foram preservados, portanto essa mudança não prova a causa daquela falha.
Antes do seed remoto, o instrumento lê os quatro atributos de modo de ambas as
filas e exige FIFO, deduplicação explícita e esse par de alta vazão. O arquivo
`sqs-queue-modes.json` contém somente aliases e valores fechados, sem URL ou ARN.
A DLQ conserva seus atributos. A configuração declarada precisa do readback real
de uma implantação autorizada para ser considerada observada.

O Dockerfile AWS do Keycloak copia o mesmo realm de `docker/keycloak/`; placeholders são resolvidos
com secrets na importação. O bundle público de CAs RDS de Ohio está em
`docker/aws/us-east-2-bundle.crt`, obtido por HTTPS do
[truststore oficial](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html),
SHA-256 `d46e1bdfda05c8e7644e50930806a19b139a222542bf0348082fb59ece2b5fa5`.
É certificado público, sem chave privada. A aplicação valida CA e hostname.

Construa app e Keycloak a partir do commit limpo retido. Espelhe também k6 `2.3.0` e Prometheus
`v3.15.1` nos quatro repositórios ECR antes de iniciar serviços. Registre digests e use-os em
`image_digests`; tags são imutáveis e identificadas pelo SHA do commit. A AMI deve ser a versão
ECS-optimized AL2023 x86_64 resolvida uma vez no preflight e conservada por ID. O runner não tem
acesso a GitHub, Docker Hub ou Quay para instalar ferramentas durante o boot.

## Ordem de operação

Defina `session_started_at`, `previous_runtime_seconds` e `stop_at` antes de aplicar
e mantenha-os fixos na sessão. Reapplies não reiniciam o relógio. Reserve tempo
para coleta e remoção dos recursos dentro do prazo operacional autorizado.

1. Depois da revisão focada, confirme identidade com `aws sts get-caller-identity --profile
   wagering-load --region us-east-2`, validade das credenciais e quotas. Uma
   permissão ausente deve ser reportada pela ação exata, sem outro profile ou contorno.
2. Gere um plano salvo externo. Confira uma projeção em memória que contenha somente tipos,
   operações, flags de exposição, tamanhos, tags e prazos. Confirme explicitamente **zero NAT
   Gateway e zero IP público** antes de aplicar. Não publique o plano JSON completo.
3. O primeiro apply mantém `start_services=false`.
   Verifique os seis schedules reais: quatro `ecs:UpdateService` para zero, `rds:StopDBInstance`
   e `ec2:StopInstances`, com timezone UTC, janela OFF, role e recursos exatos e o mesmo deadline.
   Se algum guardrail falhar, destrua imediatamente; não prossiga para a carga.
4. Suba imagens e bundle offline no bucket: fonte com manifesto de hashes, Bun 1.4.3 e dependências
   Linux extraídas da mesma imagem/lockfile. Não faça `bun install` pela internet no runner.
   Após cloud-init, inicie Docker via SSM; iniciar Docker sincronicamente dentro do user-data pode
   bloquear o cloud-final. Extraia em `/opt/wagering-load` e confira hashes/versões antes da carga.
5. Rode a task `migration` uma vez, com timeout e `StopTask` no caminho de falha, e exija exit 0.
   Só depois de verificar migração, schedules e quatro digests, marque os dois gates e
   `start_services=true`. Espere as nove tasks saudáveis e os três targets do ALB prontos.
6. Execute um `quick` como smoke, depois três `full` em databases novas e seis patamares em outra
   database nova, nesta ordem fixa. Pare os serviços antes de trocar `run_database_name`, migre e
   confirme filas vazias antes de reiniciar. Não altere `db_name` do recurso RDS entre rodadas.
   Preserve cada rodada, inclusive falhas. Não repita para escolher uma rodada favorável.
7. Reserve tempo para parar admissão, coletar e destruir antes do prazo operacional. Não inicie
   uma etapa que não caiba nessa janela. Credenciais inválidas com stack ativa exigem aviso
   imediato; não troque identidade.

Os schedules têm precisão de um minuto, e a parada do RDS é assíncrona. Eles são a proteção de
emergência contra perda da sessão e não substituem a remoção dos recursos.
**Destroy é obrigatório em todo desfecho.**
Uma falha parcial de apply não é atômica: recursos podem existir antes dos schedules; destrua-os
imediatamente se a proteção não puder ser confirmada.

## Runner de carga

`scripts/aws-runner.ts` executa uma unidade no runner privado, recebendo somente um manifesto de
identificadores/URLs. Ele busca secrets com a instance role em memória, inicia Prometheus por digest
e chama o mesmo `scripts/load-test.ts` com `LOAD_TARGET=remote`. Não executa Compose. O script recusa
arquivos de origem alterados e exige banco migrado novo/filas vazias. Não imprima o environment do
processo. `LOAD_PROFILE=quick|full` conserva os parâmetros existentes; `LOAD_SCENARIO=plateaus` é
uma seleção separada e exige `full`.

O bundle inclui exatamente o inventário versionado em `load/source-files.ts`: aplicação, migrations,
scripts, observador, oráculos, suporte e arquivos de build/dependências. Gere os hashes desses arquivos
com `git show HEAD:<caminho>` a partir do commit retido limpo e confira os bytes do checkout antes de
empacotar. O manifesto JSON tem `{commit, files: {caminho: sha256}}`; entradas ausentes, adicionais ou
alteradas são recusadas. Fixe também o SHA-256 dos bytes do próprio manifesto na evidência do operador
e em `sourceManifestSha256` do manifesto do runner (`LOAD_SOURCE_MANIFEST_SHA256` no subprocesso).
Esse digest fica igual entre unidades e é revalidado antes e depois da medição; não o regenere no runner.

Cada unidade marcada como iniciada grava `execution.json` mesmo quando falha ao buscar secrets,
autenticar Docker, baixar imagem ou iniciar Prometheus. Falha primária, cleanup e coleta têm campos
separados. O runner tenta exportar esse registro mesmo sem runId; se o S3 falhar, o registro local
permanece para coleta por SSM e a unidade termina com erro. Perda do host pode impedir a coleta e deve
ser registrada como limitação, sem repetir a unidade para obter um resultado favorável.

Os patamares são 180 s cada, em ordem hot50, distribuída50, mista25+25, mista50+50, distribuída100,
hot100. Os primeiros 30 s são excluídos apenas das métricas `steady_*`, usando o início real do
executor. Todas as identidades iniciadas permanecem na prova financeira. Há uma observação por
célula e crescimento do histórico entre células: não alegue máximo de capacidade ou ganho causal.
O observador reutiliza `EventConsumer`, registra efeito único e inbox processado em SQL e só conta
ack depois de `DeleteMessage` concluir. Ele compartilha o processo Bun e pool com a orquestração;
CPU/RSS medidos nesse processo não são o custo isolado do consumidor de eventos.

## Coleta e destruição verificadas

Colete somente artefatos allowlisted, métricas, contagens, identidades técnicas e manifestos. Nunca
colecione `.env`, credenciais, tokens, state, arquivos de variáveis, Docker auth config, headers ou
payload financeiro completo. Faça scans Gitleaks redigidos antes/depois da sessão e nos downloads.
Baixe os resultados do bucket **antes** de destruí-lo; falha de coleta não suspende o prazo.

```bash
terraform -chdir=infra/aws destroy -input=false -auto-approve
aws resourcegroupstaggingapi get-resources --profile wagering-load --region us-east-2 \
  --tag-filters Key=Project,Values=wagering-load
```

Além da consulta paginada sem recursos tagueados, confirme a ausência dos nomes/IDs inventariados:
roles/profile IAM, seis schedules/grupo, repos ECR/imagens, bucket/objetos, logs/secrets, DB/backups,
ECS/services/tasks, Cloud Map/hosted zone, ALB, endpoints/ENIs, runner/EBS e rede. Não trate erro 403
como ausência. O provider apenas deregistra task definitions: registre **todas** as revisões criadas,
apague as INACTIVE exclusivas com `ecs:DeleteTaskDefinitions` e confira o desfecho. Service-linked
roles compartilhadas/preexistentes precisam ser inventariadas antes do apply; a autorização não
permite apagar indiscriminadamente recursos de outra finalidade.

Com três full reconciliados, publique resultados complementares; com falta de acesso, prazo
ou setup sem sucesso, documente a limitação e siga com a entrega principal.
Nenhum número AWS representa produção,
Multi-AZ, latência do Brasil ou uma comparação isolada entre SQS e MiniStack.
