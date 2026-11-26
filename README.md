# Fluxo

Finanças pessoais **local-first**: lançamentos, cartões e faturas, calendário financeiro, recorrências, parcelamentos, orçamentos, projeções de longo prazo, simulação de decisões, investimentos, metas e calculadora global. Os dados ficam no IndexedDB do navegador. Não há servidor, login, telemetria ou dependência externa. É HTML, CSS e JavaScript puros (ES Modules), sem etapa de build.

> O Fluxo é a evolução do **Guia Financeiro 1.0**. O banco local, os identificadores e o endereço de publicação continuam os mesmos: quem já usava a versão anterior mantém todos os dados.

## Publicar no GitHub Pages

1. Envie o conteúdo deste pacote para a **raiz** do repositório (o `index.html` deve ficar na raiz).
2. Em **Settings → Pages**, escolha **Deploy from a branch → `main` → `/ (root)`**.
3. Acesse `https://usuario.github.io/nome-do-repositorio/`.

Os caminhos são relativos e a navegação usa `#/rotas`, então o app funciona em qualquer subdiretório. O `.nojekyll` evita o processamento pelo Jekyll.

## Executar localmente

Sirva a pasta por HTTP (abrir via `file://` não funciona com módulos ES):

```bash
node tests/server.mjs          # http://127.0.0.1:8080/guia-financeiro/
```

## Arquitetura

```
index.html            casca da aplicação, menu lateral e ícones SVG embutidos
css/                  themes (cores claro/escuro) · base (tipografia, espaço, movimento, botões) · layout · components
js/app.js             inicialização, rotas por hash, menu recolhível, atalhos
js/database/          schema versionado + migrações · db (transações atômicas, consultas indexadas) · repository (estado, validação, sincronização entre abas)
js/services/          regras puras e testáveis:
                      finance (motor) · cards (faturas) · recurrence · installments · investments (metas, juros)
                      calendar (eventos por dia) · scenarios (projeção e simulação) · insights (comparações reais)
                      integrity (semelhança e auditoria) · calculator (parser sem eval) · backup · validation · suggest
js/components/        modal/gaveta, formulário de lançamento, seletor pesquisável, calculadora, gráficos SVG, menu, toast
js/views/             visão geral, lançamentos, planejamento (calendário, projeção, simulações…), investimentos, configurações
tests/                unitários (node:test), aceitação no navegador (Playwright) e escala
```

Principais regras:

- Valores ficam em **centavos inteiros**.
- Datas são texto `AAAA-MM-DD` no calendário local, sem conversão de fuso.
- Compras no cartão entram na competência do **vencimento** da fatura e são obrigações até o pagamento.
- Pagamento de fatura, transferências e aportes **não** são despesas de consumo.
- Benefícios de uso restrito (VA/VR) não entram no valor disponível para investir.
- A rentabilidade é **opcional** (0% por padrão). Quando informada, os juros são compostos, com a taxa mensal equivalente `(1 + a)^(1/12) − 1`.

O detalhamento está nos comentários de `js/services/finance.js`, `calendar.js` e `scenarios.js`.

**Carga dos dados:** a abertura lê pelo índice `month` só os últimos 13 meses e o futuro. O histórico antigo chega em seguida, em segundo plano. Saldos, exportação e auditoria esperam a carga completa e nunca mostram valores parciais.

## Backup

Em **Configurações → Dados e backup** você encontra:

- exportação completa em JSON versionado;
- exportação dos lançamentos em CSV (separador `;`, protegido contra injeção de fórmulas);
- restauração de backups.

Backups do **Guia Financeiro 1.0** são aceitos. Antes de restaurar, o arquivo é validado e o impacto é exibido; a troca acontece em uma única transação, então um arquivo inválido não altera nada. Backups contêm dados pessoais: **não os coloque no repositório** (o `.gitignore` já os exclui).

## Testes

```bash
node --test tests/unit/*.test.mjs     # 43 testes das regras financeiras e de datas
node tests/e2e/run.mjs                # 39 testes no Chromium (requer o pacote playwright)
node tests/perf/scale.mjs             # escala com 100, 1.000, 10.000 e 50.000 lançamentos sintéticos
```

Última execução: **43/43 unitários** e **39/39 no navegador** aprovados. Os testes de navegador servem o app em `/guia-financeiro/`, como no GitHub Pages. Medições de escala (Chromium headless, máquina de CI; os valores variam com o hardware):

| Lançamentos | Abrir | Histórico completo | Trocar mês | Criar | Editar | Buscar (todos os meses) |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 144 ms | 171 ms | 39 ms | 37 ms | 43 ms | 15 ms |
| 1.000 | 143 ms | 188 ms | 56 ms | 51 ms | 68 ms | 18 ms |
| 10.000 | 280 ms | 481 ms | 46 ms | 45 ms | 47 ms | 21 ms |
| 50.000 | 912 ms | 1.792 ms | 49 ms | 44 ms | 54 ms | 17 ms |

## Limitações conhecidas

- Os dados existem apenas neste navegador e dispositivo. Não há sincronização entre aparelhos; use backup e restauração.
- O IndexedDB não é criptografado. Apps publicados na mesma origem `usuario.github.io` compartilham essa origem: o nome exclusivo do banco evita colisões, mas não isola por segurança.
- O armazenamento persistente é solicitado, mas a concessão depende do navegador.
- Não há service worker: o app funciona sem rede enquanto a aba estiver aberta, mas não é instalável para uso offline completo.
- Projeções consideram receitas previstas, contas fixas, parcelas, faturas e compras programadas. Gastos variáveis futuros só entram quando você informa uma estimativa mensal.
- Rentabilidades são estimativas informadas por você; não há cotações nem integração com bancos ou corretoras.
