# Guia Financeiro

Gerenciador financeiro pessoal **local-first**: lançamentos, cartões e faturas, recorrências, parcelamentos, orçamentos, investimentos, metas e calculadora global. Os dados ficam no IndexedDB do navegador, sem servidor, login, telemetria ou dependências externas. É HTML, CSS e JavaScript puros (ES Modules), sem etapa de build.

## Publicar no GitHub Pages

1. Envie o conteúdo deste pacote para a **raiz** do repositório (o `index.html` deve ficar na raiz).
2. Em **Settings → Pages**, escolha **Deploy from a branch → `main` → `/ (root)`**.
3. Acesse `https://usuario.github.io/nome-do-repositorio/`.

Todos os caminhos são relativos e a navegação usa `#/rotas`, então o app funciona em qualquer subdiretório. O arquivo `.nojekyll` evita o processamento pelo Jekyll.

## Executar localmente

Sirva a pasta por HTTP (abrir via `file://` não é suportado pelos módulos ES):

```bash
node tests/server.mjs          # http://127.0.0.1:8080/guia-financeiro/
# ou
python3 -m http.server 8080    # http://127.0.0.1:8080/
```

## Arquitetura

```
index.html            casca da aplicação + ícones SVG embutidos
css/                  themes (tokens claro/escuro) · base · layout · components
js/app.js             inicialização, rotas por hash, atalhos
js/database/          schema versionado + migrações · db (transações atômicas) · repository (estado, validação, sincronização entre abas)
js/services/          regras puras e testáveis: finance (motor), cards (faturas), recurrence, installments, investments, calculator (parser sem eval), backup, validation, suggest
js/components/        modal, formulário de lançamento, calculadora, gráficos SVG, campos, menu, toast
js/views/             visão geral, lançamentos, planejamento, investimentos, configurações
tests/                unitários (node:test) e aceitação no navegador (Playwright)
```

Regras principais: valores em **centavos inteiros**; datas como texto `AAAA-MM-DD` no calendário local (sem conversão de fuso); compras no cartão entram na competência do **vencimento** da fatura e são obrigações até o pagamento; pagamento de fatura, transferências e aportes **não** são despesas de consumo; benefícios de uso restrito (VA/VR) não entram no valor disponível para investir; juros usam a taxa mensal equivalente `(1 + a)^(1/12) − 1`, com aporte no fim do mês por padrão. O detalhamento está no comentário inicial de `js/services/finance.js`.

## Backup

Em **Configurações → Dados e backup**: exportação completa em JSON versionado, exportação de lançamentos em CSV (separador `;`, protegido contra injeção de fórmulas) e restauração. Antes de restaurar, o arquivo é validado (formato, versão, estrutura, referências) e o impacto é exibido. A substituição acontece em uma única transação: um backup inválido não altera nada. Os backups contêm dados pessoais, então **não os coloque no repositório** (o `.gitignore` já os exclui).

## Testes

```bash
node --test tests/unit/*.test.mjs     # 34 testes: dinheiro, datas, faturas, recorrências, parcelas, motor, juros, calculadora, backup
node tests/e2e/run.mjs                # 22 testes no Chromium (requer o pacote playwright com Chromium)
```

Os testes de navegador servem o app em `/guia-financeiro/` (como no GitHub Pages) e cobrem os 20 cenários de aceitação, além de XSS, sincronização entre abas, clique em todos os botões de cada seção e desempenho com 5.000 lançamentos. Última execução: 34/34 unitários e 22/22 no navegador aprovados.

## Limitações conhecidas

- Os dados existem apenas neste navegador e dispositivo. Não há sincronização entre aparelhos; use backup e restauração.
- O IndexedDB não é criptografado, e aplicações publicadas na mesma origem `usuario.github.io` compartilham a origem: o nome exclusivo do banco evita colisões acidentais, mas não é isolamento de segurança.
- O armazenamento persistente é solicitado, mas a concessão depende do navegador.
- Não há service worker: o app funciona sem rede enquanto a aba estiver aberta, mas não é instalável para uso offline completo.
- Rentabilidades são estimativas informadas pelo usuário; não há cotações nem integração com bancos ou corretoras.
- A competência de faturas segue a regra fechamento/vencimento configurada; quando o banco cobra em data diferente, ajuste manualmente o mês no lançamento.
