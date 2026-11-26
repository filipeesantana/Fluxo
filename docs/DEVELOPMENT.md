# Fluxo — notas técnicas

Documento de manutenção. Para conhecer o produto, veja o [README](../README.md).

## Arquitetura

Site estático em HTML, CSS e JavaScript (ES Modules), sem build e sem dependências de execução.

```
index.html              casca da aplicação, menu lateral, ícones SVG, assinatura
js/version.js           fonte única da versão (assinatura, Sobre, diagnóstico, backup)
js/boot.js              aplica tema/densidade antes da primeira pintura (sem script inline, por causa da CSP)
js/app.js               rotas por hash, atalhos, inicialização
js/database/            schema versionado + migrações · db (transações) · repository (estado, validação, abas)
js/services/            regras puras e testáveis
  finance.js            motor financeiro: summarize(), projeções, saldos
  recurrence.js         modos de recorrência e chaves estáveis de ocorrência
  commitments.js        compromissos do mês (estados, progresso, previsões)
  signals.js            avisos discretos (orçamentos, atrasos, vencimentos, déficit)
  calculator.js         parser aritmético seguro (sem eval) e ferramentas rápidas
  calc-refs.js          referências estruturadas da calculadora a dados do Fluxo
  backup.js             formato, checksum, criptografia opcional
  validation.js         validação de registros (inclui proteção estrutural)
js/components/          formulário, "Repetir", calculadora, grade personalizável, gráficos SVG
js/views/               telas (visão geral, lançamentos, planejamento, investimentos, configurações)
tests/                  unitários (node:test), navegador (Playwright) e escala
```

### Regras do motor financeiro

- Valores em centavos inteiros; datas de calendário como texto `AAAA-MM-DD` (nunca convertidas por fuso). Timestamps (`createdAt`, `updatedAt`) usam `Date.now()`.
- Toda movimentação tem uma competência (`month`). Compras no cartão entram na competência da fatura. Compromissos com data a definir pertencem ao período planejado (`period`).
- Recorrências geram ocorrências **projetadas**. Quando uma é paga, editada ou recebe data, vira um lançamento com a mesma **chave estável** e a projeção correspondente deixa de existir.
- Chaves de ocorrência: `AAAA-MM-DD` (data única), `AAAA-MM@dia` (vários dias), `AAAA-MM#n` (datas flexíveis), `AAAA-MM` (previsão mensal). O id do lançamento é `regra:chave`, e o IndexedDB tem índice único `[recurrenceId, occurrenceKey]`.
- Previsão mensal: gastos com `forecastId` consomem o valor planejado; só o restante entra como `forecastLeft`. Não é obrigação, então não soma em "compromissos pendentes".
- Replicar × repetir: "Replicar" para períodos finitos cria **cópias avulsas previstas** (`replicateTransaction`, ids `operação:mês` ou `operação:mês@dia`). "Todos os meses" e "Repetir" criam uma **série** (`convertToRecurring`/`createRecurrence`) em que o lançamento de origem ocupa a vaga do mês (`firstKeyFor`), sem cópia.
- Ocorrência paga fora do mês dela mantém a competência do compromisso (`month` = período, `monthManual`), exceto no cartão; `plannedDate` e `plannedAmount` permitem desfazer.
- Ocorrências extras usam a chave `AAAA-MM#n` além das vagas da regra; ids de lançamento têm no máximo 64 caracteres.
- Identidades conferidas por testes: `sobra = recebidas + previstas − realizadas − pendentes − previsões restantes`; `despesas = fixas + parcelas + pontuais + previsões`.

### Grade personalizável

`js/components/layout.js`. A grade tem 12 colunas e linhas de 4 px. Cada componente mede a própria altura (ResizeObserver) e ocupa `span N` linhas, o que permite o encaixe vertical. A altura depende só do conteúdo e da largura, nunca do número de linhas, por isso não há ciclo de medição.

Há dois modos de encaixe: automático (`dense`) e ordem fixa. "Organizar automaticamente" (`packRows`) alarga componentes dentro dos tamanhos permitidos para fechar lacunas, sem reordenar. O layout do celular é salvo à parte (`seção@m`).

## Execução local

Sirva a pasta com qualquer servidor HTTP estático (módulos ES não carregam via `file://`). O servidor de desenvolvimento reproduz um subdiretório do GitHub Pages:

```bash
node tests/server.mjs
```

## Testes

| Suíte | Comando |
|---|---|
| Unitários | `npm test` |
| Navegador (Chromium) | `npm run test:e2e` |
| Um subconjunto | `ONLY="3.1" npm run test:e2e` |
| Escala | `npm run test:perf` |

Os testes de navegador servem o app em `/guia-financeiro/` e em `/Fluxo/`, e rodam em vários fusos horários.

## Publicação

GitHub Pages a partir da raiz da branch `main`. Todos os caminhos são relativos, a navegação usa `#/rotas` e não há service worker, então o mesmo pacote funciona em qualquer subdiretório.

O IndexedDB pertence à origem (`https://filipeesantana.github.io`), não ao caminho, e o nome do banco (`guia-financeiro.pessoal`) não muda entre versões. Por isso, renomear o repositório mantém os dados no mesmo navegador. Antes de qualquer mudança de endereço, exporte um backup. Não conte com o endereço antigo redirecionando.

## Versão

Altere apenas `js/version.js` (e `package.json`, que é só metadado). Use versionamento semântico. Mudanças de esquema exigem uma nova migração em `js/database/schema.js`, sempre aditiva: nada de `deleteDatabase()` nem de recriar stores existentes.
