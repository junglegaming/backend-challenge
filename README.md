# Distributed Wagering Processor

Processador financeiro de apostas com entrada HTTP e SQS, idempotência persistida e ledger auditável. HTTP e consumidor usam o mesmo caso de uso. PostgreSQL confirma inbox, transação, saldo, ledger e outbox em uma única transação; workers publicam os eventos após o commit.

A implementação usa Bun, TypeScript, NestJS/Fastify, MikroORM e PostgreSQL. O ambiente local inclui MiniStack para SQS e Keycloak para autenticação entre serviços. A coordenação ocorre no banco: o mesmo código funciona com várias APIs, consumers e workers.

- [Arquitetura, decisões e contratos](ARCHITECTURE.md)
- [Testes, cenários obrigatórios e reprodução das evidências](docs/verification.md)
- [Metodologia, resultados e limites do teste de carga](docs/load-test.md)
- [Arquitetura visual offline](docs/architecture.html)
- [Resultados visuais de carga: local e AWS](docs/load-report/index.html)

## Começar

Requisitos do host: **Bun 1.4.3** e **Docker com o plugin Docker Compose**. Não é necessário instalar Node, npm, PostgreSQL, AWS CLI, k6 ou Toxiproxy. Execute os comandos na raiz do repositório. Os exemplos de terminal usam Bash; os comandos de aplicação usam Bun.

As imagens e dependências estão fixadas em [compose.yaml](compose.yaml), [Dockerfile](Dockerfile), [package.json](package.json) e `bun.lock`. O primeiro início precisa de rede para baixar imagens e pacotes.

Para uma stack local nova, gere credenciais de demonstração na sessão atual, sem imprimi-las:

```bash
set -euo pipefail
export BUN_CONFIG_NO_ENV_FILE=true
bun install --frozen-lockfile
OPERATOR_SECRET="$(bun -e 'process.stdout.write(crypto.randomUUID())')"
PROVIDER_A_SECRET="$(bun -e 'process.stdout.write(crypto.randomUUID())')"
PROVIDER_B_SECRET="$(bun -e 'process.stdout.write(crypto.randomUUID())')"
export OPERATOR_SECRET PROVIDER_A_SECRET PROVIDER_B_SECRET
export COMPOSE_PROFILES=observability
export API_REPLICAS=3 CONSUMER_REPLICAS=3 WORKER_REPLICAS=2
bun run stack:up
```

Mantenha essas variáveis na sessão para obter tokens e recriar o Keycloak com as mesmas credenciais. Se a stack já existe, use os valores com que ela foi iniciada; gerar outros valores não altera um realm já importado. O Compose também contém defaults públicos exclusivos de desenvolvimento. Não crie arquivo `.env`: os wrappers passam `--env-file /dev/null` ao Compose.

O projeto local se chama `wagering`. O roteiro acima sobe três APIs, três consumers, dois workers e observabilidade. Sem as variáveis de escala, o wrapper usa uma API, um consumer e um worker. O serviço `bootstrap` aplica migrations e cria as três filas automaticamente antes de iniciar a aplicação.

```bash
bun --no-env-file -e 'const r=await fetch("http://127.0.0.1:3000/health/ready"); if(r.status!==200) throw new Error("Readiness failed"); console.log(JSON.stringify({ready:true,httpStatus:r.status}));'
```

| Serviço | Endereço local | Ativação |
| --- | --- | --- |
| API por Nginx | `http://127.0.0.1:3000` | padrão |
| Keycloak | `http://127.0.0.1:8080` | padrão |
| PostgreSQL | porta `5432` | padrão |
| MiniStack/SQS | `http://127.0.0.1:4566` | padrão |
| Prometheus | `http://127.0.0.1:9090` | profile `observability` |
| Grafana | `http://127.0.0.1:3001` | profile `observability` |
| Toxiproxy | `http://127.0.0.1:8474` | profile `chaos`, usado pelos testes de falha |
| Documentação HTML | `http://127.0.0.1:4173` | profile `docs`, independente da aplicação |

As réplicas não publicam portas individuais. O Nginx é a entrada HTTP e descobre as APIs pelo DNS do Docker. Para mudar a escala, ajuste `API_REPLICAS`, `CONSUMER_REPLICAS` e `WORKER_REPLICAS` e repita o mesmo `stack:up`. Essas variáveis são interpretadas pelo wrapper; a opção correspondente do Compose direto é `--scale`, não uma variável do YAML.

## Autenticar e chamar a API

O realm `wagering` usa OAuth 2.0 `client_credentials`. `platform-operator` recebe `wallets.admin` para abrir/consultar wallets, ledger e reconciliação. `provider-a` e `provider-b` recebem `wagering`; o claim `provider_id` restringe cada provedor às suas operações. A API valida assinatura RS256, issuer, audience `wagering-api` e expiração. Não há login de jogador.

Os exemplos curl usam a imagem opcional existente, para manter o roteiro sem instalação de curl no host:

```bash
docker compose --env-file /dev/null -p wagering --profile verification build verification-tools
curl_local() {
  docker compose --env-file /dev/null -p wagering --profile verification run --rm --no-deps -T --entrypoint curl verification-tools "$@"
}
curl_json() {
  local expected="$1"
  shift
  curl_local -fsS --write-out '\n%{http_code}' "$@" \
    | EXPECTED_HTTP_STATUS="$expected" bun --no-env-file -e '
      const raw=await Bun.stdin.text();
      const boundary=raw.lastIndexOf("\n");
      const httpStatus=raw.slice(boundary+1);
      if(boundary<0 || httpStatus!==process.env.EXPECTED_HTTP_STATUS) throw new Error("Unexpected HTTP status");
      const body=JSON.parse(raw.slice(0,boundary));
      process.stdout.write(JSON.stringify({httpStatus,body}));
    '
}
```

A opção containerizada usa rede host e o perfil de ferramentas monta o socket Docker; destina-se ao daemon local em Linux. Outros sistemas/daemons remotos não têm validação deste roteiro. Isso não é requisito dos testes obrigatórios. Quem já possui curl pode fazer as mesmas chamadas diretamente no host. `curl_json` conserva status e corpo em memória e exige o código HTTP indicado. Os exemplos seguintes usam apenas dados sintéticos; retenha somente os resumos, sem tokens, headers nem corpos financeiros completos.

Após preparar a imagem de ferramentas, na mesma sessão do setup, obtenha os tokens com Bun. Assim, o tempo do primeiro build não consome a validade dos tokens. A função escreve o token somente no stdout capturado pela atribuição; não use `set -x`, `echo` de tokens ou `curl -v`:

```bash
token() {
  CLIENT_ID="$1" CLIENT_SECRET="$2" bun --no-env-file -e '
    const response = await fetch("http://127.0.0.1:8080/realms/wagering/protocol/openid-connect/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: process.env.CLIENT_ID, client_secret: process.env.CLIENT_SECRET }),
    });
    if (response.status!==200) throw new Error(`Token request failed: HTTP ${response.status}`);
    const body = await response.json();
    if (typeof body.access_token !== "string") throw new Error("Missing access token");
    process.stdout.write(body.access_token);
  '
}
OPERATOR_TOKEN="$(token platform-operator "$OPERATOR_SECRET")"
PROVIDER_TOKEN="$(token provider-a "$PROVIDER_A_SECRET")"
export OPERATOR_TOKEN PROVIDER_TOKEN
```

Crie uma wallet de `100.00 BRL` e capture seu ID:

```bash
PLAYER_ID="$(bun --no-env-file -e 'process.stdout.write(crypto.randomUUID())')"
export PLAYER_ID
WALLET_ID="$(curl_json 201 -X POST http://127.0.0.1:3000/wallets \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H 'Content-Type: application/json' \
  --data "{\"playerId\":\"$PLAYER_ID\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}" \
  | bun --no-env-file -e 'const {httpStatus,body:w}=await Bun.stdin.json(); if(httpStatus!=="201"||typeof w.id!=="string"||w.playerId!==process.env.PLAYER_ID||w.balance?.amount!=="100.00"||w.balance?.currency!=="BRL") throw new Error("Unexpected wallet result"); process.stdout.write(w.id)')"
export WALLET_ID
EXTERNAL_ID="$(bun --no-env-file -e 'process.stdout.write(crypto.randomUUID())')"
export EXTERNAL_ID
export IDEMPOTENCY_KEY="provider-a:$EXTERNAL_ID"
WAGER_BODY="$(bun --no-env-file -e 'process.stdout.write(JSON.stringify({providerId:"provider-a",externalTransactionId:process.env.EXTERNAL_ID,playerId:process.env.PLAYER_ID,walletId:process.env.WALLET_ID,roundId:"demo-round",gameId:"demo-game",kind:"BET",money:{amount:"10.00",currency:"BRL"}}))')"
submit_bet() {
  curl_json 200 -X POST http://127.0.0.1:3000/wagering/transactions \
    -H "Authorization: Bearer $PROVIDER_TOKEN" -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $IDEMPOTENCY_KEY" --data "$WAGER_BODY"
}
BET_RESULT="$(submit_bet)"
REPLAY_RESULT="$(submit_bet)"
printf '%s\n%s\n' "$BET_RESULT" "$REPLAY_RESULT" | bun --no-env-file -e '
  const [firstResponse,replayResponse]=(await Bun.stdin.text()).trim().split("\n").map(line=>JSON.parse(line));
  const first=firstResponse.body, replay=replayResponse.body;
  if(firstResponse.httpStatus!=="200"||replayResponse.httpStatus!=="200"||first.status!=="PROCESSED"||replay.status!=="PROCESSED"||first.idempotentReplay!==false||replay.idempotentReplay!==true||typeof first.transactionId!=="string"||first.transactionId!==replay.transactionId||first.balance?.amount!=="90.00"||replay.balance?.amount!=="90.00"||first.balance?.currency!=="BRL"||replay.balance?.currency!=="BRL") throw new Error("Unexpected bet/replay result");
  console.log(JSON.stringify({walletHttpStatus:201,betHttpStatus:firstResponse.httpStatus,replayHttpStatus:replayResponse.httpStatus,processed:true,replayed:true,sameTransaction:true}));
'
```

A criação retorna `201`. A aposta retorna `200`, `status: PROCESSED`, saldo `90.00` e `idempotentReplay: false`. O roteiro repete a chamada com a mesma chave e o mesmo corpo e compara as respostas em memória: a transação e o saldo observado permanecem, com `idempotentReplay: true`. Uma chave reutilizada com outro payload gera conflito. As respostas de criação, aposta e replay e a reconciliação após HTTP e SQS foram confirmadas na demo literal de `4f304d6`, em 02/11/2026; o escopo e os limites dessa execução estão em [docs/verification.md](docs/verification.md).

```bash
curl_json 200 "http://127.0.0.1:3000/wallets/$WALLET_ID" -H "Authorization: Bearer $OPERATOR_TOKEN" \
  | bun --no-env-file -e 'const {httpStatus,body:w}=await Bun.stdin.json(); if(w.id!==process.env.WALLET_ID||w.balance?.amount!=="90.00"||w.balance?.currency!=="BRL") throw new Error("Unexpected wallet balance"); console.log(JSON.stringify({httpStatus,walletChecked:true}));'
curl_json 200 "http://127.0.0.1:3000/wallets/$WALLET_ID/ledger?limit=50" -H "Authorization: Bearer $OPERATOR_TOKEN" \
  | bun --no-env-file -e 'const {httpStatus,body:l}=await Bun.stdin.json(); if(!Array.isArray(l.items)||l.items.length!==2) throw new Error("Unexpected ledger"); console.log(JSON.stringify({httpStatus,ledgerEntries:l.items.length}));'
curl_json 200 -X POST "http://127.0.0.1:3000/wallets/$WALLET_ID/reconciliation" -H "Authorization: Bearer $OPERATOR_TOKEN" \
  | bun --no-env-file -e 'const {httpStatus,body:r}=await Bun.stdin.json(); if(r.walletId!==process.env.WALLET_ID||r.consistent!==true||r.storedBalance?.amount!=="90.00"||r.calculatedBalance?.amount!=="90.00"||r.difference?.amount!=="0.00"||r.checkedEntries!==2) throw new Error("Reconciliation failed"); console.log(JSON.stringify({httpStatus,consistent:r.consistent,checkedEntries:r.checkedEntries}));'
curl_json 200 "http://127.0.0.1:3000/providers/provider-a/wagering/transactions/$EXTERNAL_ID" -H "Authorization: Bearer $PROVIDER_TOKEN" \
  | bun --no-env-file -e 'const {httpStatus,body:t}=await Bun.stdin.json(); if(t.externalTransactionId!==process.env.EXTERNAL_ID||t.walletId!==process.env.WALLET_ID||t.status!=="PROCESSED") throw new Error("Unexpected transaction status"); console.log(JSON.stringify({httpStatus,transactionFound:true,status:t.status}));'
```

O ledger retorna `items` e `nextCursor`; envie o cursor recebido na próxima consulta, sem construí-lo manualmente. O limite máximo é 100. A reconciliação compara o saldo persistido com o reconstruído pelo ledger e retorna `consistent`; divergências são sinalizadas e contabilizadas, sem correção silenciosa. Há também `GET /wagering/transactions/:transactionId`.

Valores monetários são strings com exatamente duas casas e moeda de três letras maiúsculas, por exemplo `{"amount":"10.00","currency":"BRL"}`. São rejeitados números JSON, notação científica, arredondamento implícito e zeros iniciais excedentes. `BET`, `WIN`, `REFUND` e `ROLLBACK` exigem valor positivo; `LOSS` pode ser zero e não altera saldo. `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`.

| HTTP | Significado / ação |
| --- | --- |
| `200` | Transação processada; replay retorna o resultado persistido |
| `202` | `PENDING_REFERENCE`; consultar o estado posteriormente |
| `400` | Payload/header inválido |
| `401` / `403` | Token inválido / scope ou provedor incompatível |
| `404` | Recurso consultado não encontrado |
| `409` | Identidade em conflito, ou wallet duplicada por jogador/moeda |
| `422` | Rejeição de negócio persistida, com `failureCode` |
| `500` | Resultado financeiro `FAILED` por erro permanente registrado |
| `503` | Indisponibilidade transitória; `Retry-After: 1`, reenviar a mesma chave/corpo |

Um `502` do gateway também exige preservar a identidade da tentativa: a resposta não prova ausência de commit. Os detalhes dos códigos de negócio e das decisões de referência/reversão estão em [ARCHITECTURE.md](ARCHITECTURE.md). Renove os tokens quando expirarem.

## Enviar uma operação por SQS

As filas criadas pelo bootstrap são `wager-transactions.fifo` (entrada), `wager-transactions-dlq.fifo` (DLQ) e `wagering-events.fifo` (eventos do outbox). O consumidor reutiliza o caso de uso HTTP e confirma a mensagem somente depois do commit.

Com a wallet do exemplo anterior já reconciliada em `90.00`, envie outra aposta de `10.00`, com identidades novas. O envelope é gerado por Bun e segue por stdin; não é necessário AWS CLI nem arquivo de payload. O mesmo processo que envia conserva a identidade e aguarda a conclusão SQL usando o `pollUntil` já existente. A janela para iniciar observações é de 60 s, com limite de 2 s para cada leitura; a última leitura pode terminar até 2 s depois dessa janela. O intervalo do helper é somente a cadência de observação, não uma espera presumindo conclusão:

```bash
bun --no-env-file -e '
  const id=crypto.randomUUID();
  process.stdout.write(JSON.stringify({
    messageId:id, type:"WagerTransactionRequested", occurredAt:new Date().toISOString(),
    data:{providerId:"provider-a",externalTransactionId:id,idempotencyKey:`provider-a:${id}`,
      playerId:process.env.PLAYER_ID,walletId:process.env.WALLET_ID,roundId:"demo-round",gameId:"demo-game",
      kind:"BET",money:{amount:"10.00",currency:"BRL"}}
  }));
' | docker compose --env-file /dev/null -p wagering exec -T api bun --no-env-file -e '
  import { Configuration } from "./src/config/config.ts";
  import { SqsTransport } from "./src/messaging/infrastructure/sqs-transport.ts";
  import { bounded, QUEUES } from "./src/observability/health/dependencies.ts";
  import { Database } from "./src/shared/infrastructure/database.ts";
  import { pollUntil } from "./test/support/stack.ts";
  const configuration=new Configuration();
  const transport=new SqsTransport(configuration);
  const database=new Database(configuration);
  let passed=false;
  try {
    const message=await Bun.stdin.json();
    const orm=await bounded(database.orm,2000);
    await transport.send(QUEUES.requests,JSON.stringify(message),message.data.walletId,message.messageId);
    await pollUntil("README SQS committed effect",async()=>{
      const rows=await bounded(orm.em.getConnection().execute(`SELECT
        t.id, t.status, t.wallet_id, t.player_id, t.kind, t.idempotency_key,
        t.amount::text AS amount, t.currency,
        w.balance::text AS stored_balance, w.currency AS wallet_currency,
        (SELECT COALESCE(sum(CASE WHEN direction = ? THEN amount ELSE -amount END),0)::numeric(18,2)::text
          FROM wallet_ledger_entries WHERE wallet_id = w.id) AS calculated_balance,
        (SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = w.id) AS ledger_entries,
        (SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = w.id AND transaction_id = t.id) AS transaction_entries,
        (SELECT count(*)::text FROM inbox_messages WHERE consumer_name = ? AND message_id = ? AND processed_at IS NOT NULL) AS completed_inbox
        FROM wager_transactions t JOIN wallets w ON w.id = t.wallet_id
        WHERE t.provider_id = ? AND t.external_transaction_id = ?`,
        ["CREDIT","wager-transactions-processor",message.messageId,message.data.providerId,message.data.externalTransactionId]),2000);
      const row=rows[0];
      if(!row) return undefined;
      if(row.status!=="PROCESSED"||row.wallet_id!==message.data.walletId||row.player_id!==message.data.playerId||row.kind!=="BET"||row.idempotency_key!==message.data.idempotencyKey||row.amount!=="10.00"||row.currency!=="BRL"||row.wallet_currency!=="BRL"||row.stored_balance!=="80.00"||row.calculated_balance!=="80.00"||row.ledger_entries!=="3"||row.transaction_entries!=="1"||row.completed_inbox!=="1") throw new Error("Unexpected committed SQS effect");
      return row;
    },60000);
    passed=true;
  } catch {
    process.exitCode=1;
  } finally {
    transport.close();
    try { await database.onModuleDestroy(); } catch { passed=false; process.exitCode=1; }
  }
  console.log(JSON.stringify({sqsProcessed:passed,walletReconciled:passed,ledgerEntries:passed?3:null,inboxCompleted:passed}));
'
```

O resumo só informa sucesso após observar a identidade enviada em `PROCESSED`, exatamente um lançamento da aposta, inbox concluído, três lançamentos totais e saldo persistido/reconstruído de `80.00`. Antes da linha aparecer, o SQL e as respostas permanecem em memória. Uma ausência inicial apenas continua a observação; erro de SQL, resultado inesperado ou prazo esgotado reprova o comando, sem reenviar a aposta. Confirme também pelo endpoint de reconciliação:

```bash
curl_json 200 -X POST "http://127.0.0.1:3000/wallets/$WALLET_ID/reconciliation" -H "Authorization: Bearer $OPERATOR_TOKEN" \
  | bun --no-env-file -e 'const {httpStatus,body:r}=await Bun.stdin.json(); if(r.walletId!==process.env.WALLET_ID||r.consistent!==true||r.storedBalance?.amount!=="80.00"||r.calculatedBalance?.amount!=="80.00"||r.difference?.amount!=="0.00"||r.checkedEntries!==3) throw new Error("Post-SQS reconciliation failed"); console.log(JSON.stringify({httpStatus,sqsWalletReconciled:true,checkedEntries:r.checkedEntries}));'
```

O `MessageGroupId` precisa ser o `walletId`; o `MessageDeduplicationId` do transporte usa o `messageId`. O envelope exige `messageId` ASCII imprimível de até 128 caracteres. A deduplicação FIFO não substitui as constraints de idempotência e o inbox persistidos no PostgreSQL.

Erros de negócio são terminais e confirmados. Falhas transitórias usam retry com backoff e redrive nativo após o limite de recebimentos; indisponibilidade do PostgreSQL pausa o polling. Payload inválido/falha permanente é encaminhado à DLQ. Uma referência ainda ausente pode confirmar `PENDING_REFERENCE`; o worker retoma pelo agendamento persistido, com prazo padrão de 24 h contado da primeira entrada, sem renovar o prazo em replay/reinício.

## SQL, migrations e recuperação

Para consultar contagens operacionais com Bun e a configuração já fornecida ao container:

```bash
docker compose --env-file /dev/null -p wagering exec -T api bun --no-env-file -e '
  import { Configuration } from "./src/config/config.ts";
  import { Database } from "./src/shared/infrastructure/database.ts";
  const database=new Database(new Configuration());
  try {
    const orm=await database.orm;
    const rows=await orm.em.getConnection().execute(`select
      (select count(*)::text from wallets) as wallets,
      (select count(*)::text from wallet_ledger_entries) as ledger_entries,
      (select count(*)::text from outbox_messages where published_at is null) as unpublished_events,
      (select count(*)::text from wager_transactions where status = ?) as pending_references`,["PENDING_REFERENCE"]);
    console.log(JSON.stringify(rows));
  } finally { await database.onModuleDestroy(); }
'
```

Essas contagens não substituem a prova financeira. Consulte o endpoint de reconciliação para a wallet; os testes verificam também a cadeia completa de saldos e versões.

Migrations são versionadas, transacionais e reversíveis. O início normal já aplica `up`. Com as dependências da stack ativas, a CLI de redrive recebe a configuração pelo container:

```bash
docker compose --env-file /dev/null -p wagering run --rm --no-deps bootstrap bun --no-env-file run dlq:redrive
```

O redrive mantém o corpo e o grupo, envia à entrada com novo dedup ID e só então remove a mensagem da DLQ. Pode haver redelivery se o processo morrer entre essas duas ações; a idempotência SQL continua válida. Corrija a causa antes de executá-lo: o comando não conserta payloads nem reabre um resultado financeiro terminal. Ele termina no primeiro recebimento vazio; mensagens invisíveis ou atrasadas podem continuar na fila.

`migration:down` reverte o schema e pode remover dados. O exemplo abaixo faz a reversão e reaplica a migration em banco descartável, com a aplicação parada. Execute-o somente após concluir o roteiro financeiro e guardar seus resumos; ele não preserva as wallets criadas acima:

```bash
docker compose --env-file /dev/null -p wagering stop nginx api consumer worker
docker compose --env-file /dev/null -p wagering run --rm --no-deps bootstrap bun --no-env-file run migration:down
docker compose --env-file /dev/null -p wagering run --rm --no-deps bootstrap bun --no-env-file run migration:up
bun run stack:up
```

Os scripts `migration:up`, `migration:down` e `dlq:redrive` também podem ser chamados pelo Bun no host, mas exigem a configuração completa da aplicação. O caminho containerizado acima já a recebe do Compose.

Um reinício normal usa os volumes existentes. Em `SIGTERM`, a readiness passa a indisponível antes da drenagem; o consumer cancela o long polling e tenta concluir/devolver mensagens dentro do prazo configurado. Após crash, consumidores retomam por redelivery e publishers retomam por lease persistido. Não remova registros de inbox/idempotência nem edite o ledger para tentar liberar uma operação.

## Logs, métricas e configuração

Com `observability` ativo, abra [Grafana](http://127.0.0.1:3001/d/wagering) e [Prometheus](http://127.0.0.1:9090). O dashboard provisionado `Wagering Processor` permite leitura anônima no ambiente local. Mostra transações, duplicatas, retries, DLQ, locks, latência, filas, outbox, referências pendentes, divergências e saúde por réplica.

```bash
docker compose --env-file /dev/null -p wagering logs --tail 20 api consumer worker
```

Os logs da aplicação são JSON com campos permitidos e IDs de correlação, sem headers/tokens/corpos financeiros completos. `/health/live` verifica o processo; `/health/ready` verifica PostgreSQL e as três filas, sem autenticação. `/metrics` é acessível na rede interna e retorna `404` no Nginx. Prometheus coleta cada réplica; gauges de estado compartilhado, como lag da outbox, usam máximo entre réplicas, não soma. Histogramas do servidor estão em segundos e não substituem latência do cliente. Prometheus não possui volume persistente de TSDB neste Compose.

Defaults operacionais não sensíveis, alteráveis por variáveis do processo antes de subir a stack:

| Variáveis | Default / significado |
| --- | --- |
| `API_REPLICAS`, `CONSUMER_REPLICAS`, `WORKER_REPLICAS` | `1`, `1`, `1` no wrapper local |
| `API_HOST_PORT`, `POSTGRES_HOST_PORT`, `SQS_HOST_PORT`, `KEYCLOAK_HOST_PORT` | `3000`, `5432`, `4566`, `8080` |
| `PROMETHEUS_HOST_PORT`, `GRAFANA_HOST_PORT`, `TOXIPROXY_HOST_PORT` | `9090`, `3001`, `8474` |
| `DOCS_HOST_PORT` | `4173`, publicada somente em loopback |
| `COMPOSE_PROFILES` | perfis opcionais `docs`, `observability`, `chaos`, `load`, `verification` |
| `CONSUMER_CONCURRENCY`, `SQS_BATCH_SIZE` | `10`, `10` |
| `SQS_WAIT_SECONDS`, `SQS_VISIBILITY_SECONDS`, `SQS_MAX_RECEIVES` | `20`, `30`, `5` |
| `SQS_RETRY_BASE_SECONDS`, `SQS_RETRY_MAX_SECONDS` | `2`, `30` |
| `SHUTDOWN_DRAIN_MS` | `25000` |
| `OUTBOX_LEASE_MS`, `OUTBOX_RETRY_MAX_MS` | `15000`, `300000`; lease deve exceder 2 s, máximo deve ser ≥ lease |
| `REFERENCE_TTL_MS` | `86400000` (24 h) |
| `APP_IMAGE_TAG`, `NODE_ENV` | `local`, `development` |
| `APP_DB_HOST`, `APP_DB_PORT`, `APP_SQS_ENDPOINT` | `postgres`, `5432`, `http://ministack:4566`; rotas internas usadas também pelos testes de falha |
| `POSTGRES_PASSWORD`, `OPERATOR_SECRET`, `PROVIDER_A_SECRET`, `PROVIDER_B_SECRET` | credenciais locais; manter fora de logs/evidências |
| `LOAD_PROFILE`, `KEEP_STACK` | `quick` por padrão; `KEEP_STACK=1` preserva a stack de teste para diagnóstico |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Par opcional na aplicação; ausência de ambos usa a cadeia padrão do SDK. Par incompleto falha. O Compose fornece o par local. |
| `DB_SSL_CA_FILE` | Ausente por padrão; quando informado, exige CA legível e verificação TLS do servidor. |
| `BOOTSTRAP_CREATE_QUEUES` | `true` por padrão; `false` aplica migrations sem criar cliente SQS/filas. |
| `LOAD_TARGET`, `LOAD_SCENARIO` | `compose` e `standard` por padrão; alvo remoto e patamares exigem seleção explícita. |

O Compose fornece `APP_ROLE`, `PORT`, `DB_*`, `SQS_ENDPOINT`, `AWS_*`, `AUTH_ISSUER` e `AUTH_JWKS_URL`; seus contratos estão em [config.ts](src/config/config.ts). No modo local, endpoints de aplicação e credenciais são fornecidos pelo Compose. `TEST_SYNC_POINTS` e `TEST_SYNC_MATCH` são instrumentação dos testes de crash; ativar sync points fora de `NODE_ENV=test` aborta o início.

## Verificar

Após o roteiro local, encerre a stack de demonstração antes das suítes, evitando manter outra topologia 3/3/2 concorrendo pelos recursos do mesmo daemon. Esse encerramento preserva seus volumes:

```bash
bun run stack:down
```

Execute em série, na raiz do repositório:

```bash
bun install --frozen-lockfile
bun run check
bun run test
bun run test:failure
bun run test:load
```

| Script do manifesto | Escopo |
| --- | --- |
| `check` | lint, tipos e unidade |
| `test:unit` | domínio e contratos isolados |
| `test:integration` | migrations, constraints, atomicidade, inbox/outbox e HTTP |
| `test:concurrency` | paralelismo real, réplicas, crash, reversões e reinício |
| `test` | unidade + integração + concorrência |
| `test:failure` | interrupção/latência PostgreSQL/SQS, pausa/reinício e drenagem |
| `test:load` | k6 containerizado, perfil `quick` |

A sequência anterior executa os checks e as suítes. O manifesto também oferece lint e tipos separadamente, além de `lint:fix`, que altera arquivos; não é necessário executar variantes adicionais para seguir este roteiro.

A [CI versionada](.github/workflows/ci.yml) está configurada para push e pull request: varreduras de histórico e árvore com Gitleaks 8.30.1, instalação congelada, `check`, integração e concorrência. As actions usam commits fixados e a varredura de histórico faz checkout completo. A configuração está implementada; não há execução remota de GitHub Actions atribuída a esta entrega.

As suítes com infraestrutura usam PostgreSQL/MiniStack reais e três APIs, três consumers e dois workers no projeto isolado `wagering-test`. Incluem 50 submissões paralelas da mesma aposta, disputa pelo saldo, wallets independentes, participação de várias instâncias, crash entre commit/ack, publishers concorrentes, referência fora de ordem e recuperação após reinício. O invariante é saldo persistido igual ao reconstruído pelo ledger, com verificação da cadeia e das versões.

As portas de teste são `13000`, `15432`, `14566`, `18080`, `19090`, `13001` e, nos testes de falha, `18474`. Deixe-as livres. Os wrappers recusam substituir containers existentes desse projeto e removem seus volumes ao terminar. Execute uma suíte por vez. A opção de diagnóstico `KEEP_STACK=1` transfere ao operador a responsabilidade pela remoção posterior do projeto `wagering-test` e seus volumes; o roteiro normal deixa essa limpeza com o runner.

Verificação manual opcional, separada dos testes obrigatórios e da CI:

```bash
bun run verify:manual --list
```

O modo padrão disponível na ferramenta inclui GNU parallel, oha/k6, pg_activity, Pumba, Toxiproxy, netem, tcpdump e stress. A opção `--only` seleciona um experimento ou uma lista separada por vírgulas; os nomes válidos são informados por `--list`. O seletor de determinismo é separado do padrão e, se escolhido voluntariamente, executa vinte rodadas seriais, encerrando na primeira falha. **Uma nova GNU20 foi explicitamente dispensada para esta entrega, inclusive Task 13, comandos literais e handoff; não integra o roteiro executável acima.**

Esses experimentos usam ferramentas containerizadas, daemon local exclusivo e capacidades de rede do Docker em Linux. Stress e determinismo exigem o commit com árvore limpa. Cada execução de experimentos cria uma pasta nova externa em `~/.cache/wagering-verification`; `--list` apenas informa as opções. A opção `--output` permite escolher outra pasta vazia fora do checkout. Não altere código, imagens ou instrumentos nem execute outros probes durante uma campanha congelada. Veja [docs/verification.md](docs/verification.md) para escopo, restrições e evidências por versão.

**Manual retido encerrado:** `manual-retained-a98d1e6-1`, source `a98d1e6fe248f2e6bee4f2cf54317fc961aab062`, captura de 01/11/2026 às 23:06:21.023–23:20:13.862 UTC. Os oito seletores concluíram com resultado global PASS, filho exit 0 e source/cleanup aprovados pela captura. Os cinco comandos somam 29 PASS/0 FAIL/11.819 assertions: principal 13/0/9.422, reconciliação 1/0/288, tcpdump 1/0/56, stress 13/0/1.549 e reconciliação do stress 1/0/504. Foram reconciliados conjuntos separados de 71, 1 e 125 wallets. O `pg_activity` preserva exit 124 da ferramenta, apesar do PASS do caso; tcpdump correlaciona confirmação ORM, snapshot SQL e chamadas SDK com metadados, sem decodificar COMMIT no fio. O auditor leu artefatos, sem uma segunda consulta SQL após teardown ou inspeção Git/Docker. O PASS histórico de `manual-retained-2` em `9fab36026b375c306a70c0aabaacbd5cdc811526` permanece separado, com 29 testes e 11.939 assertions. A GNU retida encerrou seis rodadas seriais, todas exit 0/signal 0; o runner original conservou FAILED por exigir vinte, enquanto a captura comprovou source e cleanup no seu escopo. O usuário dispensou a nova GNU20 na Task 13, no roteiro literal e no handoff. O histórico d11 com vinte rodadas permanece outra campanha; não se somam as versões. O comportamento opcional de determinismo é descrito apenas como referência; não há comando de nova campanha no roteiro literal desta entrega.

## Carga e resultados visuais

O roteiro de verificação usa `quick`. As cinco fases cobrem carteira única, mil carteiras, 10% de replays, carteira única e distribuídas simultâneas, e backlog SQS. `LOAD_PROFILE=full` seleciona rampas maiores e dez mil mensagens. A duração inclui preparo, tráfego, recuperação e drenagem. Os agregados completos ficam em `load/results/<runId>/`, ignorados pelo Git.

A aceitação exige ledger e saldo reconciliados, identidades persistidas, cobertura de eventos, inbox/outbox concluídas, DLQ vazia e participação das réplicas. Um snapshot parcial ou quatro fases HTTP aprovadas não aprovam uma rodada inteira. Os métodos, as métricas e as limitações estão no [relatório de carga](docs/load-test.md).

O [hub HTML offline](docs/load-report/index.html) reúne páginas independentes, com gráficos, fonte e limites de interpretação:

| Relatório | Evidência representada |
| --- | --- |
| [FULL local A/B/C](docs/load-report/local/index.html) | Três rodadas históricas aprovadas, fonte `06e6165 / c99c4a…`. |
| [FULL AWS](docs/load-report/aws/index.html) | Uma rodada FULL3 aprovada, fonte `d52abed / 0d029a…`: 80.976 efeitos financeiros, 161.952 eventos e 10.000 comandos SQS. |
| [QUICK AWS histórico](docs/load-report/historical/index.html) | Diagnóstico smoke5 da fonte `a98d1e6 / 36b77c…`, preservado com os FULL reprovados excluídos dos gráficos. |

As instruções para abrir os relatórios no navegador do host ficam em [Servidor de documentação](#servidor-de-documentação), no final deste README.

Cada HTML também abre sem servidor quando o navegador tem acesso à árvore completa do checkout. A abertura de um arquivo isolado pelo portal do desktop (`/run/user/.../doc/...`) pode impedir o acesso aos links relativos; nesse caso, use o preview HTTP. A [reprodução a partir das projeções versionadas](docs/load-test.md#relatório-visual-e-reprodução-dos-gráficos) usa Bun e dispensa o cache privado. Fontes e instrumentos diferentes impedem tratar esses painéis como comparação controlada local/AWS. O FULL local retido de `a98d1e6` permanece reprovado e separado dos três FULL históricos aprovados.

O renderer também conserva o modo histórico abaixo. Para reproduzi-lo, defina `AWS_QUICK_AGGREGATES`, `LOCAL_FULL_AGGREGATES` e `AWS_FULL_AGGREGATES` com diretórios externos dos agregados originais, e `RENDER_OUTPUT` com uma pasta de saída nova:

```bash
BUN_CONFIG_NO_ENV_FILE=true BUN_CONFIG_NO_AUTO_INSTALL=true \
bun --no-env-file scripts/render-load-report.ts \
  --aws-quick "$AWS_QUICK_AGGREGATES" \
  --local-full "$LOCAL_FULL_AGGREGATES" \
  --aws-full-1 "$AWS_FULL_AGGREGATES" \
  --output-dir "$RENDER_OUTPUT"
```

Nesse modo, as quatro opções são obrigatórias. O CLI recusa destino existente, entradas ausentes, provas inválidas ou mistura de fonte; gera HTML e cinco SVGs, lendo apenas agregados autorizados. Os dados financeiros brutos não acompanham o clone.

## Extensão AWS opcional

A [operação AWS](infra/aws/README.md) descreve endpoints privados, imagens por digest, manifesto de origem e infraestrutura própria. Não acrescenta ferramentas de cloud aos requisitos do roteiro local. No alvo remoto, `BOOTSTRAP_CREATE_QUEUES=false` deixa as filas com o Terraform, e a cadeia padrão do SDK usa a role quando o par de credenciais estáticas está ausente.

`DB_SSL_CA_FILE` habilita PostgreSQL com TLS e identidade verificada. O bundle público de `us-east-2` está em [docker/aws/us-east-2-bundle.crt](docker/aws/us-east-2-bundle.crt); origem e hash constam na [arquitetura](ARCHITECTURE.md). A readiness consulta PostgreSQL e as três filas; a role da API recebe apenas `sqs:GetQueueUrl` e `sqs:GetQueueAttributes` nessas filas. O ALB usa liveness para avaliar o processo; a admissão da carga continua exigindo readiness e os oito targets saudáveis.

O [FULL AWS aprovado](docs/load-test-aws.md#quarta-sessão-full3-aprovado) terminou com prova financeira integral e participação 3/3/2. Os retries do produtor remoto e do ACK do observer recuperaram throttling SQS real. Houve **22.283 descartes reportados pelo gerador**: não há entrega demonstrada dos alvos de 500 req/s, três FULL AWS aprovados, patamares sustentados ou capacidade máxima. Os FULL anteriores falhos e a QUICK da terceira sessão estão resumidos no [histórico AWS](docs/load-test-aws.md#terceira-sessão-fonte-e-resultados).

O observador remoto persiste inbox/efeito por `eventId`, e o oráculo compara conjuntos esperados e observados nos dois sentidos. Esse instrumento não muda a integração local, que deixa a fila de eventos para destinatários externos. A leitura posterior dos agregados não constitui nova verificação SQL independente.

## Estado da verificação

A **Task 13 foi concluída para `d52abed`**. Os cinco gates em clone limpo com PATH restrito passaram: instalação congelada, `check`, `test`, `test:failure` e QUICK `test:load`. Foram 202 testes unitários, 178 de integração, 13 de concorrência e 11 de falha, sem falhas. O QUICK reconciliou 1.001 carteiras, 3.251 efeitos e 6.502 eventos, com pendências e DLQ zeradas. A [matriz de requisitos e os recibos](docs/verification.md#gates-locais-em-d52abed) detalham as fontes, as asserções e os comandos do README.

A CI está configurada para push e pull request; sua validação local não representa execução remota no GitHub. As alterações documentais, visuais e de infraestrutura posteriores têm verificações próprias e não constituem novo commit com aqueles cinco gates. Os resultados históricos continuam vinculados às versões medidas.

## Varredura opcional de segredos

Estes comandos usam somente Docker e a imagem fixada `ghcr.io/gitleaks/gitleaks:v8.30.1`, sem Gitleaks instalado no host. Execute na raiz de um clone completo, com seu diretório `.git` dentro do checkout. A montagem é somente leitura; a configuração Git abaixo vale apenas para o processo no container e permite ler esse checkout sem depender de seu UID. O histórico cobre todas as referências **disponíveis no clone**; `--all` não baixa referências ausentes nem completa um clone shallow.

Para o histórico Git completo disponível:

```bash
docker run --rm --mount "type=bind,source=$PWD,target=/repo,readonly" \
  --env GIT_CONFIG_COUNT=1 --env GIT_CONFIG_KEY_0=safe.directory --env GIT_CONFIG_VALUE_0=/repo \
  ghcr.io/gitleaks/gitleaks:v8.30.1 git /repo \
  --redact --no-banner --config /repo/.gitleaks.toml --log-opts=--all
```

Para os arquivos presentes no checkout, incluindo alterações ainda não commitadas:

```bash
docker run --rm --mount "type=bind,source=$PWD,target=/repo,readonly" \
  ghcr.io/gitleaks/gitleaks:v8.30.1 dir /repo \
  --redact --no-banner --config /repo/.gitleaks.toml
```

As duas varreduras se complementam e usam a configuração restrita versionada: regras padrão e somente quatro defaults locais exatos permitidos. `--redact` oculta valores; retenha apenas status, contagens, nomes de regras e caminhos necessários. Não remova a configuração, amplie a allowlist ou exclua caminhos para obter aprovação. O hook instalado neste clone é uma proteção opcional para contribuidores, não uma dependência dos testes, da stack ou destes comandos; hooks locais não são transportados automaticamente ao clonar. Registre cada varredura com a fonte, a imagem efetivamente usada, seu status e as contagens de achados; resultados classificados preservam o total bruto e as provas exatas de classificação. A execução local desses comandos não implica aprovação remota do CI.

## Encerrar e limitações locais

O encerramento mostrado antes das suítes remove os containers do projeto local e preserva os volumes PostgreSQL/MiniStack. Para apagar **todos os dados locais** desse projeto:

```bash
docker compose --env-file /dev/null -p wagering down --volumes --remove-orphans
```

O Compose é demonstrativo: usa Keycloak `start-dev`, não configura TLS, publica portas de API/PostgreSQL/MiniStack/Keycloak e contém defaults de desenvolvimento. Não o exponha como implantação de produção. A observabilidade não preserva seu histórico após recriação. Entrega de eventos é *at-least-once*: um crash após confirmação SQS e antes da marcação SQL pode repetir `eventId`; consumidores externos precisam deduplicá-lo. Os grupos FIFO usam `aggregateId`, e não há ordem total entre tipos/agregados nem garantia adicional de ordem entre publishers concorrentes. A aplicação não consome a fila de eventos; sua retenção e integração com destinatários externos ficam fora deste fluxo local.

## Servidor de documentação

Para servir os HTMLs e navegar entre seus links, execute na raiz do repositório:

```bash
docker compose --env-file /dev/null -p wagering up -d --wait docs
```

O serviço `docs` usa a imagem Bun 1.4.3 e monta o checkout somente para leitura. Precisa apenas de Docker Compose no host, sem build ou instalação de dependências; o primeiro início pode baixar a imagem. O comando inicia somente a documentação, sem subir a aplicação, PostgreSQL ou SQS.

| Página | Endereço |
| --- | --- |
| Central de relatórios | <http://localhost:4173/docs/load-report/index.html> |
| Arquitetura visual | <http://localhost:4173/docs/architecture.html> |
| FULL local | <http://localhost:4173/docs/load-report/local/index.html> |
| FULL AWS | <http://localhost:4173/docs/load-report/aws/index.html> |
| README formatado | <http://localhost:4173/README.md> |
| Decisões de arquitetura | <http://localhost:4173/ARCHITECTURE.md> |

No Dev Container, encaminhe a porta **4173** pela aba **Portas** do VS Code se ela não aparecer automaticamente. O serviço publica a porta somente em loopback. Para escolher outra porta, por exemplo 4174:

```bash
DOCS_HOST_PORT=4174 docker compose --env-file /dev/null -p wagering up -d --wait docs
```

Nesse caso, use `http://localhost:4174` e encaminhe 4174 no Dev Container. Alterações nos documentos ficam disponíveis sem reconstruir a imagem; atualize a página no navegador.

O perfil opcional `docs` mantém o preview fora das suítes de integração e carga. Para iniciá-lo junto da stack, inclua `docs` em `COMPOSE_PROFILES`, por exemplo `COMPOSE_PROFILES=docs,observability bun run stack:up`. Para parar somente a documentação:

```bash
docker compose --env-file /dev/null -p wagering stop docs
```

Os relatórios, a arquitetura visual e o visualizador de Markdown compartilham uma barra superior com links para **Início**, **README**, **Arquitetura** e **Verificação**, além de um botão de aparência à direita. **Início** retorna à central de relatórios. O botão de aparência mostra o tema atual e abre as opções **Automático**, **Claro** e **Escuro**. Automático acompanha a preferência do sistema; a escolha manual prevalece e fica salva no navegador, inclusive ao navegar entre as páginas pelo mesmo endereço HTTP. O menu aceita teclado e fecha com Escape ou clique fora. Se o armazenamento do navegador estiver bloqueado, a troca continua funcionando na página aberta; a persistência entre arquivos `file://` depende do navegador. A impressão usa o tema claro e oculta a barra.

Pelo servidor, os links para `.md` abrem documentos formatados, com títulos, tabelas, blocos de código e seções expansíveis. Os endereços e as âncoras dos documentos continuam válidos, incluindo títulos com acentos. Os links relativos permitem ir do relatório para sua documentação e voltar. A renderização usa o parser nativo do Bun, sem bibliotecas externas ou acesso à rede; HTML ativo e URLs executáveis são filtrados. Arquivos de código e configuração continuam disponíveis como texto para consulta.

Como alternativa sem Docker, `bun run docs:preview` inicia o mesmo servidor com Bun no host; aceita `--port 4174`. Use uma forma por porta. Os HTMLs também abrem diretamente por `file://` quando o navegador tem acesso à árvore completa de arquivos; abrir um arquivo isolado pelo portal do desktop pode impedir a navegação pelos links relativos. O visualizador de Markdown depende do servidor; abrir um `.md` diretamente fica a cargo do navegador ou editor.
