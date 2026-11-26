# Auditoria 3.1.1: replicação, repetição e uso diário

## 1. Por que a replicação "não funcionava"

Antes de mudar o código, as jornadas foram executadas no navegador (Chromium, base vazia) sobre a 3.1.0.

| Etapa | Situação na 3.1.0 |
|---|---|
| Motor e persistência | **Funcionavam.** `replicateTransaction` gravava as cópias numa transação, com ids por operação. Criar "Internet · Mensal" pelo formulário gerava uma regra e uma ocorrência prevista por mês, sem cartão. |
| Interface | **Era aqui que falhava.** A funcionalidade existia, mas não era encontrada. |

Causas concretas na interface:

1. **Botão invisível.** As ações de cada linha (`.tx-more`) tinham `opacity: 0` até passar o mouse. Num desktop, quem não passasse o mouse sobre a linha não via nenhum acesso à replicação.
2. **Menu longo e sobreposto.** "Replicar para outros meses…" era o 6º de 10 itens, ao lado de "Copiar para outro mês…" e "Transformar em recorrente…". Eram três conceitos diferentes para a mesma intenção, e "Replicar" não oferecia **todos os meses**.
3. **O gesto natural não levava a lugar nenhum.** Clicar no lançamento abria a edição, e a edição escondia "Repetir" (`isEdit ? null : fRepeat`). Não havia caminho de "este lançamento" para "todo mês" a partir dele.
4. **Repetir parecia configuração.** No cadastro, "Repetir" era uma lista suspensa de 6 opções no meio de outros campos. Ao escolher "Mensalmente", abria um painel com 4 cartões e opções, mesmo quando o padrão bastava.
5. **"Transformar em recorrente" tinha restrições ocultas.** Só aparecia para lançamentos com data, fora de previsão e de parcelamento.

**Solução, de ponta a ponta:**

- **Interface:**
  - "Repetir" virou **Não repetir · Mensal · Personalizar**, também na edição;
  - **Replicar** ganhou um botão em cada linha e o primeiro lugar no menu;
  - um único painel junta cópias e série contínua.
- **Validação:** `repeatFields.validate()`, limites de dias e meses e limite de ids.
- **Motor:** `convertToRecurring` aceita as alterações do formulário na mesma transação, o dia de referência e lançamentos sem data. `firstKeyFor` define a vaga do mês que o original ocupa.
- **Persistência:** transações únicas (regra + lançamento; cópias em lote), com ids determinísticos.
- **Agregação:** a ocorrência paga mantém a competência do compromisso.
- **Apresentação:** listas ordenadas com "data a definir" no fim.

## 2. Bugs encontrados e corrigidos

| # | Problema | Como apareceu | Correção |
|---|---|---|---|
| 1 | Pagar hoje uma ocorrência de dezembro movia o valor para novembro (dezembro caía de R$ 100 para R$ 50) | Teste de aceitação 4.2 | `payItem` mantém `month` = período da ocorrência (fora do cartão); `plannedDate` permite desfazer |
| 2 | "Desfazer pagamento" mantinha a data do pagamento | Revisão do item 1 | `unpayItem` devolve a data prevista |
| 3 | Ocorrência extra recusada ("id ausente"): id com mais de 64 caracteres | Teste de aceitação 3/4/8 | id determinístico `regra:AAAA-MM#n`; idempotência por operação em memória |
| 4 | Itens sem data misturados aos datados na Visão geral e em Lançamentos (comparação com `null`) | Captura de tela | `byDateDesc`: datados primeiro, "Data a definir" no fim |
| 5 | Mensal de dia fixo com lançamento já pago em outro dia: o pagamento não era registrado como a ocorrência do mês | Revisão do formulário | A 1ª ocorrência é o próprio lançamento (`firstKey`) |
| 6 | Duplicar exigia "Registrar mesmo assim" (aviso de semelhança para uma cópia pedida) | Teste de regressão | Sem aviso quando a cópia é explícita |
| 7 | Abas do Planejamento cortadas a 1360 px; filtros ocupando a primeira tela no celular | Capturas de tela | Abas mais justas; filtros recolhidos no celular |

## 3. Interações (antes × depois)

"Depois" foi **medido** pelos testes de aceitação, que contam cada clique da jornada. "Antes" foi **contado sobre a interface da 3.1.0**, não por teste automatizado.

| Jornada | 3.1.0 | 3.1.1 |
|---|---|---|
| Nova despesa mensal (abrir, Repetir, salvar) | 4 (abrir, abrir lista, escolher, salvar) | **3** (abrir, Mensal, Salvar) |
| Replicar para os próximos 3 meses | 4 + revelar o botão invisível | **3** (Replicar, Próximos 3, Replicar) |
| Replicar para o próximo mês | 3 (⋯, Copiar para outro mês, Copiar) | **2** (Replicar, Replicar) |
| Transformar lançamento em mensal | 3, com o botão invisível e só no menu | **3** pela linha (Replicar, Todos os meses, Repetir todo mês) ou pela edição (lançamento, Mensal, Salvar) |
| Duplicar e revisar | 2, mas gravava na hora, sem revisão | **2** para abrir a cópia preenchida |
| Marcar compromisso como pago | 1 | 1 |
| Lançamentos de uma categoria no mês | 1 | 1 |

## 4. Verificações por área

- **Anti-duplicidade.** Clique duplo em Salvar, Ctrl+Enter repetido, clique duplo em Replicar e em Adicionar ocorrência, três recargas e doze trocas de mês: nenhum registro técnico duplicado (teste 9/10). As duas abas pagando a mesma ocorrência continuam cobertas pelo cenário 16 da 3.1.
- **Datas.** O dia 31 é preservado em meses curtos e no bissexto, a série "a cada 14 dias" usa intervalos reais, início e término são respeitados e o pagamento antecipado não muda a competência. Os cinco fusos da 3.1 continuam passando.
- **Banco.** Sem migração: o esquema continua v4 e o backup, formato 3. O campo opcional `plannedDate` é validado e aceito por backups antigos e novos.
- **Segurança.** Sem `eval`/`new Function`, sem `innerHTML`, sem rede externa. A CSP continua sem violações (teste de segurança da 3.0).

## 5. Limitações conhecidas

- Os testes de navegador rodaram só no Chromium. Firefox e WebKit não estão disponíveis neste ambiente.
- Os testes "de celular" usam emulação de viewport e toque, não aparelhos físicos. O teclado virtual não foi testado.
- "Alterar data" de uma ocorrência aceita só datas dentro do mês do compromisso. Para mudar de mês, ignore a ocorrência e adicione uma extra no outro mês.
- Pagamento de ocorrência no cartão segue a fatura da data da compra, como qualquer compra no cartão.
