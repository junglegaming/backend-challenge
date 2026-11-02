# Teste complementar de carga na AWS

Esta página registra o resultado da extensão AWS prevista no plano de medição. O
experimento previa smoke de setup, três rodadas FULL e patamares constantes, com
dados novos e parâmetros fixos. A primeira sessão falhou na implantação. A segunda
produziu um QUICK diagnóstico aprovado e um FULL reprovado; o gate de predecessor
aprovado impediu FULL2, FULL3 e todos os patamares. Falhas anteriores foram
preservadas. Uma terceira e última sessão foi autorizada após a correção local descrita
abaixo; sua execução ainda não está comprovada nesta revisão.

## Ambiente, fonte e parâmetros

A aplicação medida foi `a98d1e6fe248f2e6bee4f2cf54317fc961aab062`, com
`loadSourceSha256=36b77c2acde5dc63e35cff9f950c021a8c14601333d87cf590d47de5cc94f161`.
Revisões posteriores de instrumentos e Terraform não renomeiam essa evidência.
Em `us-east-2`, o ambiente usou três APIs, três consumers e dois workers Fargate,
Keycloak, RDS PostgreSQL 17 single-AZ `db.m7g.2xlarge`, gp3 de 100 GB, TLS verificado,
SQS FIFO gerenciado, ALB interno e runner privado `c7i.2xlarge` por SSM. Não houve
NAT Gateway, IP público ou SSH. A topologia e o procedimento estão em
[rede e dimensionamento](../infra/aws/README.md#rede-e-dimensionamento) e
[ordem de operação e orçamento](../infra/aws/README.md#ordem-de-operação-e-orçamento).

O QUICK usou `quick/standard/remote`: quatro fases HTTP com estágios de sete
segundos, 1.001 carteiras e backlog de 1.000 comandos. A aprovação final salvou
`passed=true` e `partial=false`. É uma prova diagnóstica de setup e invariantes;
não equivale a FULL, três rodadas ou capacidade sustentada. As medições, janelas,
lacunas de amostragem e parâmetros estão na seção canônica
[AWS QUICK aprovado](load-test.md#aws-quick-aprovado-alcance-e-valores-dos-gráficos).

## FULL falho e fronteiras da interpretação

O FULL1 usou `full/standard/remote` e terminou com `RequestThrottled`, exit 1.
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

A comparação quantitativa FULL local/AWS está indisponível: ambos os FULL da
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
O usuário autorizou uma terceira e última sessão de até três horas incluindo limpeza,
com teto acumulado de US$ 18. Os 60 minutos finais ficam reservados para coleta e
limpeza. A sequência continua QUICK → FULL1 → FULL2 → FULL3 → patamares, exigindo
aprovação integral de cada predecessor. Os resultados anteriores não foram
reclassificados, e ainda não há FULL AWS aprovado nesta fonte.

## Custo e encerramento

As duas primeiras sessões tinham teto acumulado de US$ 10. A autorização posterior
elevou o teto acumulado a US$ 18 e permitiu uma terceira e última sessão. O custo final atribuível ao projeto
permanece **UNAVAILABLE**. Budgets reportou US$ 0,00 para a conta, sem filtro de
projeto e sem informação de atualização; isso não demonstra custo zero, execução
gratuita ou saldo disponível. Os modelos usados na admissão não são faturamento.

O destroy terminou aprovado. A verificação posterior confirmou as três
service-linked roles ausentes e leituras nativas sem falha (`FAILED=0`), mas o índice
de tags ainda continha 44 referências conhecidas. O fechamento foi classificado
sob a exceção autorizada de metadados assíncronos: não significa zero literal de
tags, exclusão permanente independentemente provada das revisões ECS ou
faturamento encerrado. `cleanupVerified=false` e `billingVerified=false` permanecem
nos recibos. O alcance exato está em
[estado operacional e gates finais](verification.md#estado-operacional-e-gates-finais)
e no [contrato de coleta e destruição](../infra/aws/README.md#coleta-e-destruição-verificadas).
