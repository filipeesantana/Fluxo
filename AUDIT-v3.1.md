# Auditoria — Fluxo 3.1

Revisão feita sobre a 3.0 antes e durante a implementação da 3.1: recorrências, motor financeiro, layout, calculadora, datas, duplicidades, laços, persistência, compatibilidade e desempenho. Cada achado traz severidade, causa, impacto, correção e o teste que o cobre. O relatório da versão anterior está em [AUDIT-v3.0.md](AUDIT-v3.0.md).

Severidade: **Crítica** (perda de dados ou app inutilizável) · **Alta** (função principal quebrada ou risco relevante) · **Média** (falha em situação específica) · **Baixa** (inconsistência pontual).

## Achados na versão 3.0

### B1 · Alta · Recorrências limitadas a uma data por período

- **Causa:** o modelo só conhecia regras com uma data por ocorrência (`frequency` + `interval`). A ocorrência era identificada apenas pela data.
- **Impacto:** não havia como representar consultas com datas a combinar, vários vencimentos no mês ou um orçamento de consumo consumido por gastos reais. A solução manual (vários lançamentos soltos) duplicava previsões.
- **Correção:** modos `days`, `flex` e `forecast`, chave estável por ocorrência (`AAAA-MM@dia`, `AAAA-MM#n`, `AAAA-MM`), período (`period`) para itens sem data e previsão consumida por gastos vinculados (`forecastId`).
- **Testes:** `tests/unit/v31-recurrence.test.mjs` e cenários 1, 2, 4, 7 e 8 no navegador.

### B2 · Média · Espaços vazios na grade personalizável

- **Causa:** CSS Grid com linhas implícitas e `align-items: start`. Cada linha tinha a altura do componente mais alto, e componentes menores deixavam buracos embaixo. `grid-auto-flow: dense` só reaproveita células de linhas inteiras, não espaço vertical parcial. Componentes ocultos ainda ocupavam lugar no modo de edição, e os controles quebravam linha, deixando componentes com alturas desiguais.
- **Impacto:** visual fragmentado ao mudar tamanhos.
- **Correção:** linhas de 4 px com `grid-row-end: span N` medido por ResizeObserver (a altura não depende do número de linhas, então não há ciclo), modos automático e de ordem fixa, "Organizar automaticamente" determinístico, ocultos numa bandeja fora da grade e controles num menu compacto.
- **Testes:** cenários 9/10/11 (inclui verificação de sobreposição por geometria) e personalização da 3.0.

### B3 · Média · Clique duplo no "pago" pagava e desfazia

- **Causa:** o botão de situação alternava o estado sem trava.
- **Impacto:** um clique duplo deixava o lançamento como previsto, contrário à intenção.
- **Correção:** trava por item enquanto a operação está em andamento (700 ms).
- **Teste:** coberto pelo fluxo de pagamento dos cenários 1 e 3. A replicação também usa clique duplo de propósito (cenário 6).

### B4 · Baixa · Calculadora sem semântica explícita de porcentagem

- **Causa:** `%` funcionava no estilo de calculadora de bolso, sem forma de expressar "X% de Y" e sem explicação.
- **Correção:** operador `de`, regras documentadas na própria calculadora e ferramentas dedicadas para participação e variação percentual.
- **Teste:** cenário 12.

## Achados durante o desenvolvimento da 3.1 (corrigidos antes da entrega)

| # | Severidade | Problema | Como foi encontrado |
|---|---|---|---|
| D1 | Crítica | Com a nova coleção `calculations`, a soma SHA-256 de **todos** os backups da 3.0 deixaria de conferir e eles seriam recusados. | Teste unitário de compatibilidade |
| D2 | Média | Exceção "cancelada" não era respeitada em recorrências de data única (só "ignorada"). | Teste unitário de estados |
| D3 | Média | Pagar um item recalculava a competência e perdia o mês de fatura ajustado manualmente. | Revisão de código |
| D4 | Média | Busca de lançamentos parecidos falharia com lançamentos sem data (cálculo de distância de datas com `null`). | Revisão de código (todos os usos de `.date`) |
| D5 | Baixa | Durante o arraste, o refluxo da grade disparava reordenações em cascata. | Teste de arraste no navegador |
| D6 | Baixa | O índice único da 3.0 (`recurrenceId + occurrenceDate`) colidiria em meses curtos com "vários dias" (31 e 30 caem no mesmo dia em fevereiro). Por isso, ocorrências desse modo usam só a chave nova. | Análise do esquema |

## Auditorias específicas

### Duplicidade técnica

- Ocorrências têm id determinístico `regra:chave` e índice único `[recurrenceId, occurrenceKey]` no IndexedDB. Duas abas pagando a mesma ocorrência resultam em **um** registro (cenário 16).
- Mudar a data de uma ocorrência flexível atualiza o mesmo registro (cenário 4).
- Conversão em recorrente reaproveita o lançamento original (cenário 5).
- Replicação usa id por operação e mês. Repetir o clique não cria cópias (cenário 6).
- Restaurar o mesmo backup duas vezes não duplica (teste da 3.0).
- Semelhança financeira (mesmo valor, data e descrição) continua permitida, apenas com aviso.

### Laços e terminação

- Recorrências: intervalo inteiro ≥ 1 validado (`interval` 0 ou negativo é recusado), progressão sempre crescente, no máximo 2.400 passos por consulta, horizonte sempre finito (`[from, to]`) e no máximo 31 ocorrências por mês.
- Calculadora: profundidade e tamanho limitados; referências nunca apontam para cálculos, então não existe recursão entre cálculos salvos; valores dinâmicos são recalculados só quando a lista de salvos está visível e os dados mudam.
- Layout: `packRows` faz no máximo 12 passagens por linha e sempre termina com um layout válido. O ResizeObserver só grava `span` quando o valor muda, e a altura medida não depende do `span`. Observadores são desconectados quando a grade sai do DOM.
- Destaques: um único `setInterval`, liberado quando o componente sai da tela e inativo com aba oculta ou movimento reduzido.

### Datas e fusos

- Datas financeiras são texto `AAAA-MM-DD`. A aritmética de dias usa UTC internamente (`Date.UTC`) e nunca converte a data por fuso. O único `new Date(...)` aplicado a valores é para timestamps (`Date.now()`) e exibição de data/hora de backup.
- Testado no navegador às 23:50 de 30/11 nos fusos `Pacific/Kiritimati` (UTC+14), `Asia/Tokyo`, `UTC`, `America/New_York` e `America/Los_Angeles`: "hoje", data padrão do formulário, competência gravada e destaque do calendário permanecem em 30/11. Uma regra semanal atravessando o fim do horário de verão (01/11 nos EUA) mantém as datas.
- Dia 31, fevereiro, anos bissextos, término inclusivo e "a cada 14 dias" com três ocorrências no mês são cobertos por testes unitários e de navegador.
- Compra no cartão continua com competência da fatura (data de compra ≠ mês de cobrança).

### Segurança

- Sem `eval`/`new Function`/`innerHTML` no código. CSP sem `unsafe-inline`/`unsafe-eval` preservada e verificada.
- Novas entradas (nome e expressão de cálculo, dias, quantidade por mês, chaves de ocorrência, meses encerrados) são validadas antes de gravar e na importação. Chaves de ocorrência seguem um padrão fechado, então `__proto__` e similares são recusados.
- Nenhuma dependência nova, nenhuma requisição externa, nenhuma telemetria.

### Compatibilidade

- Detecção de recursos: sem `ResizeObserver`, a grade funciona como grade comum (sem encaixe vertical). Sem `BroadcastChannel`/Web Locks, a coordenação entre abas fica reduzida, mas os dados continuam protegidos pela revisão por registro. Sem Clipboard API, o texto é selecionado para cópia manual. Sem Web Crypto, o backup informa que não pode ser gerado.
- **Navegadores testados:** somente Chromium (Playwright). Firefox e WebKit não estão instalados no ambiente de testes, então a compatibilidade com eles **não foi verificada**. Os testes de "celular" usam emulação do Chromium (viewport, toque e escala do iPhone 13) e **não** substituem um aparelho real. O teclado virtual não pode ser emulado.

## Desempenho

Chromium headless, base sintética com 5 anos de histórico, 12 recorrências fixas, 6 parcelamentos e, nesta versão, também 4 recorrências com datas flexíveis, 3 com vários dias, 1 a cada 14 dias, 3 previsões mensais (com gastos vinculados), 10 cálculos dinâmicos e um layout personalizado (`npm run test:perf`). Os valores variam com o hardware e entre execuções.

| Lançamentos | Abrir (3.0 → 3.1) | Histórico completo | Trocar mês | Projeção 60 meses | Visão geral | Compromissos (novo) |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 151 → 184 ms | 166 → 208 ms | 50 → 45 ms | 313 → 434 ms | 65 → 64 ms | 76 ms |
| 1.000 | 148 → 166 ms | 184 → 218 ms | 50 → 52 ms | 427 → 433 ms | 49 → 47 ms | 77 ms |
| 10.000 | 200 → 246 ms | 397 → 436 ms | 52 → 49 ms | 327 → 437 ms | 50 → 64 ms | 73 ms |
| 50.000 | 899 → 881 ms | 1.722 → 1.608 ms | 55 → 47 ms | 342 → 319 ms | 65 → 64 ms | 107 ms |

| Lançamentos | Gerar backup | Tamanho | Validar | Restaurar | 10 cálculos dinâmicos | Gerar 8 anos de ocorrências (23 regras) |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 13 ms | 0,1 MB | 6 ms | 39 ms | 1 ms | 3 ms (3.569 ocorrências) |
| 1.000 | 49 ms | 0,3 MB | 13 ms | 207 ms | 1 ms | 3 ms |
| 10.000 | 402 ms | 2,8 MB | 98 ms | 1,7 s | 1 ms | 4 ms |
| 50.000 | 1,97 s | 13,7 MB | 455 ms | 7,7 s | 2 ms | 4 ms |

A base da 3.1 tem mais regras que a da 3.0 (23 contra 12 recorrências, mais previsões). Mesmo assim, abrir, trocar de mês e montar a visão geral continuam na mesma faixa. Nas bases pequenas, a projeção ficou cerca de 100 ms mais lenta, por causa das regras extras projetadas por 60 meses. As medições sem a mesma base de regras não são diretamente comparáveis. A grade com encaixe mede alturas só quando um componente muda de tamanho, então não há custo contínuo.

## Testes executados

- **Unitários:** 67 aprovados (`npm test`). Inclui `v31-recurrence.test.mjs` (psicóloga, 14 dias, vários dias, combustível, fontes, pagamento parcial, estados, intervalos, validação) e testes matemáticos por propriedades.
- **Navegador (Chromium):** 81 aprovados (`npm run test:e2e`), 22 deles novos da 3.1:
  - cenários 1 a 8 (recorrências e compromissos pela interface);
  - 9/10/11 (grade: sem sobreposição, organizar automaticamente, ocultos, formatos, persistência após recarregar e navegar);
  - layout do celular separado do desktop;
  - 12 a 15 (calculadora percentual, dinâmica, estática, referência inválida);
  - 16 (duas abas pagando a mesma ocorrência);
  - 17 (backup com todas as novidades restaurado equivalente);
  - 18 (migração de uma base da 3.0 para o esquema v4);
  - 19 (cinco fusos horários perto da meia-noite);
  - 20 (celular emulado, com teclado virtual não emulável);
  - 22 (assinatura e versão);
  - 23 (README).
- Os testes da 3.0 continuam passando, incluindo o de resoluções, agora com 320, 360 e 430 px e a aba Compromissos.
- **Escala:** 100, 1.000, 10.000 e 50.000 lançamentos, sem erros.
- **Navegadores:** somente Chromium. Firefox e WebKit não foram testados (não estão disponíveis no ambiente).

## Limitações que permanecem

- O IndexedDB não é criptografado. A proteção por senha vale só para o arquivo de backup.
- A CSP por meta tag não aplica `frame-ancestors`, porque o GitHub Pages não permite cabeçalhos próprios.
- Firefox, Safari e dispositivos móveis reais não foram testados automaticamente.
- Lançamentos com data a definir não aparecem na grade do calendário (ficam listados à parte) e não entram no fluxo de caixa diário até ganharem uma data.
- Previsões mensais não entram nas faturas de cartão até que os gastos reais sejam registrados.
- Em telas estreitas o layout passa a ter uma ou duas colunas: os tamanhos escolhidos no computador viram preferências de largura.
