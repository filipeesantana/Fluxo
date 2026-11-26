# Auditoria 3.2: onde estava a burocracia

As jornadas foram executadas no navegador sobre a 3.1.1 antes das mudanças.

## Causas do esforço desnecessário

1. **A fonte era pedida sempre.** Não existia vínculo entre bloco e fonte: para "Fatura Nubank" era preciso escolher também "Cartão Nubank" em todo lançamento. A fonte padrão era a "mais recente", que às vezes levava uma conta comum para o cartão sem motivo.
2. **A ordem do formulário não era a da fala.** Valor e data vinham antes da descrição, e categoria, fonte, bloco e situação estavam misturados na mesma grade.
3. **"Dia" da repetição escondido.** Para "todo dia 5" era preciso abrir opções; a data do lançamento não acompanhava o dia escolhido.
4. **O histórico ajudava pouco.** As sugestões preenchiam a classificação, mas não o valor. Não avisavam que a conta já era recorrente, então o usuário criava uma segunda despesa.
5. **"Salvar e novo" esquecia o contexto.** Mantinha só tipo, data e fonte. Bloco e categoria eram escolhidos de novo a cada assinatura.
6. **Copiar para o mês seguinte passava por um painel.** Não havia seleção de vários lançamentos nem "trazer do mês anterior".
7. **Blocos eram só barras do gráfico.** O painel mostrava lista e total, sem pago/pendente, comparação, evolução ou "adicionar aqui".

## Interações (medidas pelos testes)

| Jornada | 3.1.1 | 3.2 |
|---|---|---|
| Spotify mensal no cartão (bloco + categoria) | abrir, Mensal, escolher fonte, bloco e categoria, Salvar | abrir, **Mensalmente**, bloco, categoria, **Salvar**; fonte e fatura automáticas |
| Copiar para o próximo mês | 2 cliques (Replicar, Replicar) | **1 clique** |
| Transformar em mensal pela linha | 3 cliques | **2 cliques** (⋯, Repetir mensalmente) |
| Copiar 3 despesas para outro mês | 3 painéis × 2 cliques | **5 cliques** (Selecionar, 3 marcações, Copiar) |
| Cadastrar 5 assinaturas no mesmo bloco | bloco, categoria e fonte 5 vezes | 1 vez; nas outras 4 só descrição e valor |
| Abrir um bloco | 1 clique | 1 clique (agora com ações) |

## Bugs e riscos tratados
- Fonte "mais recente" pré-preenchida levava contas comuns para o cartão.
- Teste de pagamento de fatura com data futura: o pagamento futuro fica previsto (comportamento correto, teste ajustado).
- Sem laço entre bloco e fonte: o bloco só preenche a fonte quando o usuário não a escolheu, e a fonte nunca altera o bloco.
- Cópias em lote numa única transação, com ids por operação; conflitos não são copiados, apenas informados.

## Limitações
- Só o Chromium foi testado; Firefox e WebKit não estão disponíveis no ambiente.
- Celular testado por emulação (viewport e toque), não em aparelho físico; o teclado virtual não foi testado.
- O vínculo automático pelo nome só ocorre quando exatamente uma conta corresponde; nos demais casos a fonte fica para o usuário (ou para o histórico do bloco).
