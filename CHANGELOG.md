# Changelog

## 3.0.0 — Personalização, confiabilidade e segurança

Evolução incremental da 2.0: mesma identidade visual, mesmo banco local e mesmo formato de endereços. Nenhum dado existente é apagado ou recriado.

### Correção crítica: erro ao abrir o Planejamento

**Sintoma.** Ao abrir *Planejamento* aparecia `{(intermediate value)(intermediate value)…}[tab] is not a function` e a seção ficava em branco.

**Causa.** A 1.0 tinha uma aba chamada `proximos` e gravava a aba aberta no `localStorage` (`gf.planning.tab`), com `proximos` como padrão. A 2.0 renomeou as abas, mas continuou lendo essa preferência **sem validar**: quem chegava em `#/planejamento` sem aba no endereço recebia o valor antigo, e o código procurava a função da aba num objeto literal (`{ recorrencias, programadas, … }[tab]()`). Para `proximos` — ou qualquer valor desconhecido — o resultado era `undefined`, e chamá-lo quebrava a renderização inteira.

**Correção.**

- Um único registro de abas (`PLANNING_TABS`) define rótulo, ícone, ação e renderização; rotas e preferências derivam dele.
- `resolvePlanningTab` aceita apenas ids registrados. Valores antigos são convertidos (`proximos → projecao`) e regravados; qualquer outro valor volta ao padrão. A mesma validação (`readChoice`) vale para outras preferências de escolha.
- Uma falha dentro de uma aba agora aparece só naquela aba, com opção de tentar de novo; o resto do app continua funcionando.
- Teste de regressão cobre `proximos`, valores inválidos, todas as abas, troca de mês e ano, recarga, navegação repetida, banco vazio e com dados.

### Funcionalidades adicionadas

- **Repetir lançamento** no formulário: semanal, a cada duas semanas, mensal, a cada dois meses, trimestral, semestral, anual ou personalizado; início, término (inclusivo), quantidade e dia de vencimento opcionais. Repetição e parcelamento continuam separados.
- **Ações em lançamentos existentes**: duplicar, registrar novamente hoje, registrar em outra data, transformar em recorrente (o original vira a primeira ocorrência, sem cópia) e editar.
- **Escopo em recorrências**: editar ou excluir só esta ocorrência, esta e as próximas, ou a série inteira; lançamentos já realizados nunca são alterados retroativamente. Pausar, retomar e encerrar séries.
- **Detalhamento dos indicadores**: cada indicador da visão geral abre a composição do valor, nível a nível até os lançamentos, e confere que a soma bate com o número exibido. *Disponível para investir* oferece simular aporte, criar meta, planejar investimento e ver projeção — sem registrar nada.
- **Personalização**:
  - modo *Personalizar* na Visão geral e em Investimentos: arrastar pela alça (mouse e toque) ou mover pelo teclado, tamanhos Pequeno/Médio/Metade/Grande/Largura completa, ocultar e adicionar componentes, cor de destaque da paleta ou personalizada (com ajuste automático de contraste), tipo de gráfico adequado a cada dado, desfazer e restaurar padrão;
  - Planejamento: ordem e visibilidade das abas;
  - Lançamentos: lista ou tabela, informações visíveis e colunas organizáveis;
  - Configurações: ordem dos grupos (nenhum pode ser ocultado) e um grupo *Personalização* com restauração por seção ou de toda a aparência, separada dos dados financeiros;
  - a personalização fica no banco local, entra no backup e é validada ao carregar: uma configuração corrompida nunca impede a abertura.
- **Densidade da interface**: Compacta, Padrão e Confortável, por tokens de CSS (sem zoom).
- **Backup 2.0**:
  - nome `Fluxo-backup-AAAA-MM-DD_HH-MM.json`, metadados (id, data, versões, contagens, período) e soma SHA-256;
  - proteção opcional por senha (AES-256-GCM com PBKDF2);
  - prévia da restauração com data, versão, contagens, contas, metas, período, o que será substituído e inconsistências;
  - oferta de backup dos dados atuais antes de restaurar e snapshots internos (os três últimos);
  - lembrete configurável e data do último backup.
- **Diagnóstico de armazenamento**: estado do banco, versão do esquema, contagens, último backup, estimativa de uso, armazenamento persistente e inconsistências.
- **Sobre o Fluxo**: o que é, para que serve, como funciona, onde ficam os dados, backups e limitações.
- **Nova identidade**: símbolo original (uma origem e um destino ligados por uma curva contínua), logotipo, marca nominativa, versões monocromática, clara e escura, e favicon, todos em SVG.

### Melhorias

- Tipografia 1 px maior no padrão (secundários +0,5 a 1 px), alturas de controles e espaçamentos ajustados; números tabulares em valores.
- Tokens de duração centralizados (clique, hover, expansão, modal, reorganização e gráficos), animações só com `transform`/`opacity` e respeito a *movimento reduzido*.
- Gráficos de distribuição em barras horizontais, barras verticais, rosca ou tabela; a rosca é desativada quando há valores negativos. Período e totais visíveis nos títulos.
- Investimentos: evolução do patrimônio em área, linha ou tabela.

### Segurança e integridade

- **Content Security Policy** sem `unsafe-inline` e sem `unsafe-eval`; script de inicialização movido para `js/boot.js`; `referrer` desativado.
- **Validação estrutural** de todo registro gravado ou importado: chaves proibidas (`__proto__`, `constructor`, `prototype`), profundidade, tamanho, números finitos e tipos.
- **Concorrência**: revisão por registro (`rev`); gravar sobre uma versão desatualizada gera conflito em vez de sobrescrever. Restaurações coordenadas entre abas (BroadcastChannel e Web Locks).
- **Atomicidade**: criação de recorrência com primeira ocorrência paga, conversão em recorrente, edição de série e restauração acontecem em uma única transação.
- **Ocorrências com identificador determinístico** (`regra:data`), impedindo duplicidade criada pelo sistema.
- *Apagar dados financeiros* agora preserva a aparência, como a tela informava.

### Migração

- Esquema do banco **v2 → v3**: só adiciona o repositório `snapshots`. Nenhum dado existente é alterado ou removido; a migração não apaga nem recria o banco.
- Preferências antigas de abas e gráficos são convertidas ou voltam ao padrão automaticamente.
- Backups da 1.0 e da 2.0 continuam aceitos.

## 2.0.0 — Fluxo

O Guia Financeiro passa a se chamar **Fluxo**. Esta versão evolui a 1.0 sem trocar a arquitetura, o banco local ou o endereço de publicação.

### Funcionalidades adicionadas

- **Calendário financeiro** (Planejamento → Calendário):
  - entradas, saídas, faturas, parcelas, compras no cartão e aportes por dia;
  - painel do dia com totais e ações (pagar, editar, lançar na data);
  - navegação por teclado.
- **Próximos vencimentos** na visão geral, com situação: atrasado, hoje, em X dias ou pago.
- **Projeção de longo prazo** com horizontes de 3, 6, 12, 24 e 60 meses ou personalizado:
  - decomposição em fixas, parcelas, pontuais e variáveis estimadas;
  - aportes planejados e sobra acumulada;
  - aviso explícito quando os gastos variáveis não estão incluídos.
- **Compromissos que terminam**: mostra quando cada parcelamento ou recorrência acaba e quanto libera por mês.
- **Simulação de decisões** sem alterar registros:
  - cancelar uma recorrência, nova despesa mensal, compra parcelada, mudança de renda, redução de categoria ou bloco e aumento de aporte;
  - comparação com o cenário atual e opção de descartar.
- **Leituras do mês** calculadas somente com dados reais: renda comprometida, despesas pagas, variação contra o mês anterior, maior variação de categoria e progresso de meta.
- **Painel contextual** ao clicar em uma categoria, bloco ou fonte, com atalho para Lançamentos já filtrado.
- **Gráficos de evolução**: por dia, acumulado (comparado ao mês anterior, com a projeção tracejada) e receitas × despesas.
- **Seletor pesquisável** para categorias, blocos e contas, com recentes e criação na hora (selecionada automaticamente).
- **Aviso de lançamento semelhante** que não bloqueia: revisar, abrir o existente, registrar mesmo assim ou marcar a recorrência prevista como paga.
- **Integridade dos registros** (Configurações): lista possíveis duplicidades, referências inválidas, parcelamentos e recorrências inconsistentes e registros órfãos. Nada é excluído automaticamente.
- **Metas simplificadas**:
  - só o nome, o valor desejado, quanto já tem e quanto guarda por mês são necessários;
  - opções avançadas, todas opcionais: rentabilidade anual ou mensal, data desejada, aportes extraordinários, usar a sobra projetada de cada mês, aporte no início ou fim do mês;
  - aviso quando o mesmo investimento está em várias metas.
- **Evolução do patrimônio informado** nos últimos 12 meses.
- **Aportes e resgates** aparecem nas movimentações do mês, identificados como não consumo.
- **Preferências**: animações reduzidas, menu lateral recolhido e gastos variáveis estimados.

### Melhorias

- Nova identidade **Fluxo**: nome, símbolo, favicon, metadados e manifesto.
- Sistema de design refeito com tokens centralizados de tipografia (títulos de 26 px, texto de 14 px), espaçamento, superfícies, cores semânticas e movimento.
- Superfícies em camadas, nos temas claro e escuro: canvas, menu, painéis e elementos elevados.
- Hierarquia explícita de botões (primário, secundário, contextual, destrutivo, ícone) com estados de foco, pressionado, desabilitado e processando.
- Menu lateral de 236 px:
  - seção atual com superfície própria e indicador lateral;
  - recolhível, com dicas acessíveis e preferência salva;
  - no mobile, barra inferior com ação central "Lançar";
  - uma única ação global de novo lançamento no desktop.
- Indicadores com prioridade: sobra projetada e disponível para investir em destaque, com fundos tonalizados por natureza.
- Formulário de lançamento progressivo:
  - parcelamento, repetição e observação ficam em chaves opcionais;
  - `Ctrl+Enter` salva e `Shift+Enter` salva e abre outro;
  - sugestões do histórico preenchem só o que não foi escolhido manualmente e podem ser desfeitas.
- Barras de distribuição com cor estável por item e tooltips flutuantes em todos os gráficos.
- Os eixos dos gráficos ficam legíveis em qualquer largura, do celular ao ultrawide.
- Calculadora: teclas maiores, feedback visual ao digitar no teclado físico e histórico identificado.
- Transição suave na troca de tema.
- Lançamentos: subtotal por dia, indicador de tipo em cada linha e busca com índice normalizado.
- Configurações em grupos com navegação lateral.

### Bugs corrigidos

- Clique perdido em "Salvar": o preenchimento automático no `blur` deslocava o modal entre o pressionar e o soltar do mouse. A sugestão agora é aplicada durante a digitação, e os modais ficam ancorados no topo.
- Propriedades CSS customizadas (`--bar-color`) passadas em objetos de estilo não eram aplicadas.
- Lançamentos: o mesmo formulário não cria registros duplicados em clique duplo ou envio repetido (identificador estável por formulário). O parcelamento também ficou idempotente.

### Arquitetura

- Novos serviços puros e testáveis: `calendar.js`, `scenarios.js`, `insights.js` e `integrity.js`. O motor financeiro agora decompõe o mês em fixas, parcelas e pontuais.
- **Carga em duas fases** pelo índice `month`: a abertura lê só 13 meses e o futuro. Com 50 mil lançamentos, a abertura caiu de 1,93 s para 0,91 s.
- **Sincronização entre abas incremental**: a outra aba relê só os registros alterados, não a base inteira.
- Os saldos das contas são calculados uma vez por versão dos dados.

### Migrações e compatibilidade

- **Nenhuma migração de esquema foi necessária.** O banco continua `guia-financeiro.pessoal`, na versão 2, e os campos novos de metas são opcionais.
- O banco e os backups da 1.0 abrem normalmente; há testes automatizados para os dois casos.
- O formato do backup continua `guia-financeiro-backup` na versão 1. O novo nome do arquivo exportado é `fluxo-backup-AAAA-MM-DD.json`.
- Nenhum arquivo da 1.0 precisa ser excluído do repositório. Os arquivos novos são apenas acréscimos.
