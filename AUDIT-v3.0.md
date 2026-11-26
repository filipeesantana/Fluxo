# Auditoria — Fluxo 3.0

Revisão de segurança, integridade de dados, matemática, desempenho e acessibilidade feita durante o desenvolvimento da 3.0, a partir do código da 2.0. Cada achado traz severidade, causa, impacto, correção e o teste que o cobre. Todos os itens abaixo estão corrigidos nesta versão; as limitações que permanecem estão no fim.

Severidade: **Crítica** (perda de dados ou app inutilizável) · **Alta** (função principal quebrada ou risco relevante) · **Média** (falha em situação específica ou defesa ausente) · **Baixa** (inconsistência pontual).

## Achados

### A1 · Crítica · Planejamento quebrava com preferência antiga

- **Causa:** a aba aberta era lida do `localStorage` sem validação. O valor `proximos`, padrão da 1.0, não existia mais na 2.0, e a função da aba era buscada num objeto literal e chamada diretamente (`{…}[tab]()`).
- **Impacto:** para quem veio da 1.0, *Planejamento* não abria (`… is not a function`), e a tela ficava em branco.
- **Correção:** registro único de abas, validação com conversão de valores legados, erro isolado por aba. Detalhes no [CHANGELOG](CHANGELOG.md).
- **Teste:** `3.0 — Planejamento: preferência antiga "proximos", valores inválidos…` (navegador).

### A2 · Alta · Gravações concorrentes sobrescreviam em silêncio

- **Causa:** gravação do tipo "último a gravar vence"; uma aba com dados antigos podia sobrescrever a edição feita em outra.
- **Impacto:** perda silenciosa de uma edição com o app aberto em duas abas.
- **Correção:** campo `rev` por registro, conferido dentro da transação do IndexedDB; versão desatualizada gera conflito e a tela recarrega os dados atuais. Formulários abertos levam a revisão em que foram abertos.
- **Teste:** `3.0 — Concorrência: edição em outra aba gera conflito…`.

### A3 · Alta · Restauração sem coordenação entre abas

- **Causa:** a restauração trocava a base, mas outras abas continuavam com os dados antigos em memória e podiam gravá-los de volta.
- **Impacto:** dados restaurados misturados a dados antigos.
- **Correção:** a aba que restaura avisa as outras (BroadcastChannel), que suspendem gravações e recarregam ao fim; Web Locks impede duas restaurações simultâneas.
- **Teste:** mesmo teste de concorrência (a restauração em uma aba aparece na outra).

### A4 · Média · Ausência de Content Security Policy

- **Causa:** script inline no `index.html` e atributos `style` gerados pelo código impediam uma CSP restritiva.
- **Impacto:** nenhuma defesa adicional caso um XSS fosse introduzido no futuro.
- **Correção:** CSP por meta tag sem `unsafe-inline`/`unsafe-eval`; script inline movido para `js/boot.js`; estilos dinâmicos pela CSSOM.
- **Teste:** `3.0 — Segurança: CSP sem violações em todas as seções…` registra `securitypolicyviolation` em todas as seções.

### A5 · Média · Backup sem verificação de integridade

- **Causa:** o formato 1 não tinha checksum nem contagens.
- **Impacto:** um arquivo truncado ou alterado só era percebido se quebrasse a validação de tipos.
- **Correção:** formato 2 com SHA-256 sobre serialização determinística e contagens no cabeçalho; ambos conferidos antes da prévia.
- **Teste:** unitários de backup (adulterado, truncado) e `3.0 — Backup: … adulterado é rejeitado`.

### A6 · Média · Registros importados sem validação estrutural

- **Causa:** a validação conferia campos esperados, mas não rejeitava chaves como `__proto__`, estruturas muito profundas ou valores não finitos.
- **Impacto:** risco de comportamento inesperado com arquivos maliciosos.
- **Correção:** validação estrutural aplicada a todo registro gravado ou importado, com limites próprios para metadados.
- **Teste:** unitário de poluição de protótipo e o teste de navegador com arquivo contendo `__proto__`.

### A7 · Média · Ocorrências recorrentes com identificador aleatório

- **Causa:** pagar ou editar uma ocorrência criava um lançamento com id aleatório.
- **Impacto:** dois eventos quase simultâneos (clique duplo, duas abas) podiam materializar a mesma ocorrência duas vezes.
- **Correção:** id determinístico `regra:data`; a mesma ocorrência sempre resolve para o mesmo registro.
- **Teste:** `3.0 — Repetir lançamento: Internet mensal…` e os testes de recorrência.

### A8 · Média · Criação de recorrência paga em duas gravações

- **Causa:** regra e primeira ocorrência paga eram gravadas em transações separadas.
- **Impacto:** uma falha entre as duas deixava uma regra sem a ocorrência paga (ou o contrário).
- **Correção:** `createRecurrence` grava as duas na mesma transação; também vale para conversão em recorrente e edição de série.
- **Teste:** `3.0 — Recorrência: término inclusivo, quantidade, dia 31…`.

### A9 · Baixa · Editar "esta e as próximas" perdia o dia 31

- **Causa:** a continuação da série começava na data da ocorrência editada (ex.: 28/02) e passava a usar esse dia como referência.
- **Impacto:** depois de uma edição em fevereiro, vencimentos do dia 31 passavam a cair no dia 28.
- **Correção:** dia-âncora guardado na regra e preservado na continuação.
- **Teste:** unitário de dia-âncora em 400 regras aleatórias e o teste de navegador do dia 31.

### Achados durante o desenvolvimento da 3.0 (corrigidos antes da entrega)

| # | Severidade | Problema | Como foi encontrado |
|---|---|---|---|
| D1 | Alta | O limite de profundidade da validação estrutural recusava o layout salvo; a personalização não persistia. | Teste de navegador de persistência |
| D2 | Média | Layout adulterado com tipo `__proto__` resolvia para o protótipo do registro de componentes. Falha contida (o componente mostrava erro), corrigida com `Object.hasOwn`. | Teste de configuração maliciosa |
| D3 | Média | *Apagar dados financeiros* também apagava a personalização, contrariando o aviso da tela. | Revisão de código |
| D4 | Baixa | *Simular aporte* sobrescrevia as outras preferências salvas do simulador. | Revisão de código |
| D5 | Baixa | Rolagem horizontal em Configurações no celular (diagnóstico e seletor de lembrete). | Teste de resoluções |
| D6 | Baixa | Posição salva da calculadora era usada sem validar o tipo. | Revisão de código |

## Superfícies revisadas sem achados

- **Injeção de HTML:** nenhum uso de `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval` ou `new Function`. Texto do usuário sempre entra por `textContent`. Testado com `<script>`, `onerror`, `javascript:`, SVG com `onload`, expressões de template, 5.000 caracteres e caracteres especiais e de controle bidirecional.
- **URLs:** os únicos links externos são fixos no código (repositório e endereço do app); nenhum valor do usuário vira `href` ou `src`.
- **CSV:** campos que começam com `=`, `+`, `-`, `@`, tabulação ou retorno recebem prefixo, evitando injeção de fórmulas em planilhas.
- **Calculadora:** parser próprio, sem `eval`.
- **Rede:** nenhuma requisição para outros domínios (verificado pela CSP e por teste que procura URLs no código).
- **Dependências:** nenhuma de execução. Ferramentas de teste não são publicadas.
- **Segredos:** nenhuma chave, token ou credencial no repositório.

## Matemática

Todos os valores exibidos vêm de `summarize()` (`js/services/finance.js`). O detalhamento dos indicadores refaz as somas a partir dos componentes e mostra se conferem. Testes independentes (`tests/unit/v3-math.test.mjs`) geram dados aleatórios com semente fixa e conferem, para cada mês:

- sobra projetada = recebidas + previstas − realizadas − pendentes;
- despesas = realizadas + pendentes = fixas + parcelas + pontuais;
- cada distribuição (categoria, bloco, fonte) soma exatamente o total de despesas;
- cadeia do disponível para investir, nunca negativo;
- receitas e despesas recalculadas a partir dos registros brutos;
- transferências não alteram a sobra;
- recorrências sem datas repetidas, ordenadas e no dia-âncora correto; quantidade ↔ data final equivalentes;
- parcelas somam exatamente o total, com diferença máxima de 1 centavo entre elas (2.000 combinações).

Nenhuma divergência encontrada no motor.

## Desempenho

Chromium headless, base sintética com 5 anos de histórico, 12 recorrências e 6 parcelamentos (`npm run test:perf`). Medições desta máquina; os valores variam com o hardware.

| Lançamentos | Abrir | Histórico completo | Trocar mês | Criar | Editar | Buscar | Projeção 60 meses | Visão geral |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 151 ms | 166 ms | 50 ms | 30 ms | 36 ms | 25 ms | 313 ms | 65 ms |
| 1.000 | 148 ms | 184 ms | 50 ms | 55 ms | 48 ms | 18 ms | 427 ms | 49 ms |
| 10.000 | 200 ms | 397 ms | 52 ms | 37 ms | 48 ms | 24 ms | 327 ms | 50 ms |
| 50.000 | 899 ms | 1.722 ms | 55 ms | 61 ms | 54 ms | 14 ms | 342 ms | 65 ms |

Comparação com a 2.0 (medição registrada no README da 2.0, mesmo roteiro, ambiente de CI equivalente): abrir com 50.000 lançamentos foi de 912 ms para 899 ms, e com 10.000, de 280 ms para 200 ms; trocar de mês ficou entre 39 e 56 ms na 2.0 e entre 50 e 55 ms na 3.0. Dentro da variação entre execuções, a grade personalizável e o detalhamento não trouxeram custo perceptível.

Backup e restauração (novos na medição):

| Lançamentos | Gerar backup | Tamanho | Validar | Restaurar |
|---:|---:|---:|---:|---:|
| 100 | 14 ms | 0,1 MB | 7 ms | 50 ms |
| 1.000 | 57 ms | 0,3 MB | 17 ms | 205 ms |
| 10.000 | 409 ms | 2,7 MB | 81 ms | 1,5 s |
| 50.000 | 2,1 s | 13,5 MB | 380 ms | 7,8 s |

A restauração de 50.000 lançamentos leva cerca de 8 segundos porque inclui a cópia do estado anterior como snapshot, na mesma transação.

## Testes executados

- **Unitários:** 57 aprovados (`npm test`).
- **Navegador:** 59 aprovados (`npm run test:e2e`), incluindo os 20 novos da 3.0: Planejamento, recorrências, escopo, detalhamento, personalização (teclado, arraste, configuração inválida), gráficos com negativos, lançamentos em tabela, densidade, backup (nome, checksum, adulterado, duas restaurações, senha, interrupção), concorrência, apagar dados, CSP e entradas hostis, publicação em `/fluxo/`, celular com movimento reduzido e densidades.
- **Escala:** 100, 1.000, 10.000 e 50.000 lançamentos, sem erros.

## Limitações que permanecem

- O IndexedDB não é criptografado. A proteção por senha vale só para o arquivo de backup.
- A CSP por meta tag não aplica `frame-ancestors`; o GitHub Pages não permite cabeçalhos próprios.
- Páginas publicadas na mesma origem `filipeesantana.github.io` compartilham o armazenamento do navegador.
- Os testes automatizados rodam no Chromium. Firefox e WebKit não estavam disponíveis no ambiente de teste; a compatibilidade com eles não foi verificada.
- Com dezenas de milhares de lançamentos, a restauração leva vários segundos e não mostra barra de progresso.
- Sincronização entre aparelhos continua fora do escopo.
