# Distributed Wagering Processor

Processador financeiro de apostas com entrada HTTP e SQS, idempotência persistida e ledger auditável. HTTP e consumidor usam o mesmo caso de uso. PostgreSQL confirma inbox, transação, saldo, ledger e outbox em uma única transação; workers publicam os eventos após o commit.

A implementação usa Bun, TypeScript, NestJS/Fastify, MikroORM e PostgreSQL. O ambiente local inclui MiniStack para SQS e Keycloak para autenticação entre serviços. A coordenação ocorre no banco: o mesmo código funciona com várias APIs, consumers e workers.

- [Arquitetura, decisões e contratos](ARCHITECTURE.md)
- [Testes, cenários obrigatórios e reprodução das evidências](docs/verification.md)
- [Metodologia, resultados e limites do teste de carga](docs/load-test.md)
- [Relatório visual offline](docs/load-report/index.html)

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
| `COMPOSE_PROFILES` | perfis opcionais `observability`, `chaos`, `load`, `verification` |
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

## Carga e limites de interpretação

O comando de carga da sequência de verificação usa `quick`. As cinco fases cobrem carteira única, mil carteiras, 10% de replays, carteira única e distribuídas simultâneas, e backlog SQS. A variável `LOAD_PROFILE` também aceita `full`, com rampas maiores e dez mil mensagens; a duração inclui seed, recuperação e drenagem, podendo superar bastante o tempo de tráfego HTTP. O runner guarda artefatos em `load/results/<runId>/`, ignorados pelo Git. A reprodução completa e os resultados históricos estão no relatório de carga.

O relatório distingue throughput e p50/p95/p99 do cliente, respostas transitórias, descartes do gerador, conflitos, lag e drenagem. A aceitação exige prova das identidades financeiras, ledger, inbox/outbox, reconciliação, DLQ vazia e participação das réplicas. Um resultado parcial não é aprovação. A fase HTTP mista histórica oferece duas rampas completas, dobrando a taxa agregada; não é comparação à mesma taxa total. Resultados e limitações da versão medida estão em [docs/load-test.md](docs/load-test.md); não há meta de RPS nem extrapolação para AWS/produção.

**Full retido encerrado e reprovado:** run `2026-11-01T22-25-40-451Z-d9d6e892`, source `a98d1e6fe248f2e6bee4f2cf54317fc961aab062`, perfil/alvo/cenário `full/compose/standard`. O wrapper executou em 01/11/2026 das 22:25:40.248 às 23:05:06.199 UTC e terminou FAILED / exit 1. O verificador parcial passou 1 teste/0 falhas/2.009 assertions: na fotografia salva, 90.351 transações processadas = 90.351 lançamentos, 180.702 eventos, 6.862 ainda não publicados, 9.910 inbox completos e zero efeitos financeiros duplicados contados, em 1.001 wallets observadas. Isso não comprova os 10.000 comandos SQS pretendidos, outbox final vazia, DLQ final ou participação final: os artefatos completos não foram produzidos. O timeout no gate SQS de 180 s é compatível com os dados e foi atribuído pelo responsável; o label do gate e sua última leitura não estão preservados na projeção segura, e a causa do atraso não foi estabelecida. Os três full7/8/9 aprovados continuam históricos da fonte `06e6165cb8611ec650dfc4ec947c6d4513da92cf`; não aprovam esse run nem têm seus valores finais transferidos a ele.

## Relatório visual offline

O HTML e os cinco SVGs pré-gerados em [docs/load-report/index.html](docs/load-report/index.html) abrem diretamente por `file://`, sem servidor, rede ou biblioteca externa. Os seis artefatos foram gerados e inspecionados em quatro modos de navegador: claro e escuro, desktop e mobile. Os testes do renderer passaram com 26 testes e 87 asserções no candidato validado. O renderer é um arquivo Bun independente; não adiciona dependência nem script ao `package.json`.

Para regenerar, forneça três diretórios externos de agregados e um diretório de saída **novo**. Os artefatos financeiros brutos e os diretórios de entrada não acompanham o clone. Defina `AWS_QUICK_AGGREGATES`, `LOCAL_FULL_AGGREGATES`, `AWS_FULL_AGGREGATES` e `RENDER_OUTPUT` com esses caminhos no ambiente da sessão; o comando não possui defaults privados ou fallback com números embutidos:

```bash
BUN_CONFIG_NO_ENV_FILE=true BUN_CONFIG_NO_AUTO_INSTALL=true \
bun --no-env-file scripts/render-load-report.ts \
  --aws-quick "$AWS_QUICK_AGGREGATES" \
  --local-full "$LOCAL_FULL_AGGREGATES" \
  --aws-full-1 "$AWS_FULL_AGGREGATES" \
  --output-dir "$RENDER_OUTPUT"
```

O CLI exige as quatro opções; recusa destino existente, entradas ausentes, provas inválidas ou mistura de identidade. Ele gera `index.html`, `overview.svg`, `hot_wallet.svg`, `distributed_wallets.svg`, `replays.svg` e `hot_plus_distributed.svg`. Lê somente agregados autorizados e nunca fixtures, respostas, headers ou payloads completos. A regeneração é opcional para ler o relatório pré-gerado; registre sua execução com a fonte, os agregados externos de entrada e os hashes dos artefatos gerados.

O painel quantitativo usa apenas smoke5 **QUICK diagnóstico**, uma execução da coorte `a98/36b77c…`. Os dois fulls dessa coorte são excluídos integralmente por ausência dos agregados finais obrigatórios; não se reaproveitam suas fases para construir uma rodada aceita. A/B/C da coorte `c99…` são contexto histórico textual separado. Não há três fulls aceitos, comparação full local/AWS ou custo faturado disponível. Os cinco pontos HTTP de cada QUICK ficam antes do recorte de 30 s e o único ponto Prometheus SQS precede o produtor; as respectivas séries estáveis e curva de throughput SQS são indisponíveis, sem interpolação ou zero inventado.

## Extensão AWS opcional

A [operação AWS](infra/aws/README.md) descreve uma extensão separada, com endpoints privados, imagens por digest, manifesto de origem fixado e infraestrutura própria. O [relatório AWS](docs/load-test-aws.md) registra os resultados observados e as limitações da tentativa. Ela não acrescenta AWS CLI, conta AWS ou ferramentas de cloud aos requisitos do roteiro local. O bootstrap local continua criando filas; na extensão, `BOOTSTRAP_CREATE_QUEUES=false` deixa essa propriedade com o Terraform. A ausência do par de credenciais estáticas permite a role pela cadeia padrão do SDK.

Para PostgreSQL remoto, `DB_SSL_CA_FILE` habilita TLS com CA e identidade verificadas. O bundle público de `us-east-2` está em [docker/aws/us-east-2-bundle.crt](docker/aws/us-east-2-bundle.crt); sua origem e hash estão em [ARCHITECTURE.md](ARCHITECTURE.md). A readiness e o sampler continuam consultando PostgreSQL e as três filas. A role da API recebe somente `sqs:GetQueueUrl` e `sqs:GetQueueAttributes` nessas filas, sem enviar, receber ou remover mensagens.

No alvo remoto, um observador real consome eventos e persiste inbox/efeito por `eventId`; o oráculo compara as identidades esperadas e observadas nos dois sentidos, além da prova financeira. Um resultado parcial só comprova os efeitos já persistidos que conseguiu verificar e mantém a campanha global reprovada. A observação remota não modifica o fluxo local, que deixa a fila de eventos para destinatários externos.

Os patamares fixos de 50/100 requisições por segundo são um cenário separado das rampas `full`: duram 180 s, separam os primeiros 30 s nas métricas estáveis e preservam todas as identidades na prova financeira. Não estabelecem capacidade máxima nem isolam o efeito de trocar MiniStack por SQS. O plano original fixou 270 minutos cumulativos; instruções posteriores do usuário autorizaram extensões limitadas dentro do mesmo orçamento de US$ 10 e de duas sessões. A última configuração operacional registrada usa 350 minutos cumulativos, encerramento automático às 06:53:04 UTC de 02/11/2026 e reserva para limpeza, sem terceira sessão. O runbook deve preservar o histórico dessas autorizações e dos controles realmente verificados. Parar compute não elimina todos os custos; custo final faturado permanece desconhecido.

**AWS encerrado no escopo de carga:** smoke5 QUICK diagnóstico aceito; FULL1 FAILED após quatro fases HTTP, ao entrar no backlog SQS, com `RequestThrottled` preservado e operação SDK terminal não diretamente identificada. Não existem `result.json` e `verification.json` completos desse full. A prova posterior READ ONLY/REPEATABLE READ/TLS reconciliou as 1.001 wallets, sem negativos, inconsistências, duplicatas ou órfãos contados; encontrou 74.210 transações processadas/lançamentos, 148.420 eventos e 11.848 eventos ainda sem efeito observado. Essa fotografia financeira não comprova cobertura completa de eventos, dez mil comandos ou uma rodada full aceita. Full2, full3 e patamares ficaram bloqueados pelo predecessor reprovado. O destroy terminou como processo exit 0 às 06:19:03.065 UTC, mas esse resultado isolado não prova ausência nativa final, zero literal de tags, exclusão permanente de task definitions ou custo faturado. As verificações nativas posteriores não encontraram os recursos faturáveis acompanhados nem falhas de leitura. A exclusão da service-linked role do ALB foi confirmada às 07:16:14.771 UTC; os inventários posteriores confirmaram as três roles de serviço ausentes. O fechamento às 07:32:19.609 UTC ocorreu sob a exceção autorizada para metadados assíncronos: 44 referências conhecidas ainda no índice de tags, nenhuma referência estrangeira ou desconhecida e zero regras de security group nas APIs nativas. Isso não é zero literal de tags, prova de exclusão permanente das 35 revisões ECS com ACK ou confirmação de faturamento encerrado. O custo final faturado permanece desconhecido; os vínculos e limites estão em [docs/verification.md](docs/verification.md).

**Verificação do candidato:** o clone isolado passou `check` com 193 testes/1.611 asserções e a integração real com 177 testes/6.703 asserções. A revisão focada da Task 12 encerrou sem achados Critical ou Important. Esses resultados pertencem ao candidato correspondente. A demo literal executou 14 blocos deste README em clone limpo de `4f304d6`: B01–B13 e B19 passaram em 78,605 s, incluindo HTTP, SQS, reconciliação financeira, migrations e limpeza final com zero containers, redes e volumes. Os cinco comandos finais exigem evidência própria no último commit entregue. Os artefatos visuais publicados não mudam o resultado de qualquer campanha.

A prevenção de segredos mantém as regras padrão do scanner e permite somente os quatro defaults locais exatos já existentes. Arquivos `*.key`/`*.pem` não são versionados; o teste TLS gera chaves temporárias em runtime. O histórico, a árvore e os artefatos de execução têm escopos de varredura próprios. As classificações de falsos positivos ficam vinculadas aos fingerprints exatos de seus contextos e arquivos, sem exclusão ampla de caminhos ou regras. O scan pós-AWS original preservado registrou 30 findings: dez previamente conhecidos e vinte cópias dos quatro seletores públicos CloudWatch, verificadas por igualdade exata de linha/contexto em RAM. Isso não é zero findings bruto. O scanner externo v4 reconhece somente essas provas exatas e reprova qualquer achado extra ou alterado; os resultados de histórico, árvore, execução e artefatos opacos mantêm registros próprios, vinculados às respectivas fontes. Nenhum valor é publicado ou considerado seguro apenas pelo caminho.

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
