# Changelog

## 3.1.0 — Inteligência financeira, flexibilidade e refinamento

Atualização incremental da 3.0: mesma identidade visual, mesmo banco local e mesmas rotas.

### Recorrências universais

- **Qualquer receita ou despesa pode se repetir**, seja paga por Pix, dinheiro, débito, cartão de crédito, vale ou outra fonte. A fonte é independente da recorrência e pode ficar **a definir** até o pagamento.
- O controle **Repetir** tem preenchimento progressivo: Não repetir · Semanalmente · A cada 14 dias · Mensalmente · Anualmente · Personalizar (a cada N dias, semanas, meses ou anos).
- **Mensalmente** oferece quatro formas, com nomes simples:
  - **em um dia específico** (internet todo dia 10);
  - **em mais de um dia do mês** (dias 5 e 20, cada um com estado próprio);
  - **com datas flexíveis** (duas consultas por mês: o valor entra no planejamento do mês e as datas ficam a definir, sem datas inventadas);
  - **como previsão mensal** (combustível até R$ 400: gastos vinculados consomem a previsão, o restante aparece como "restante planejado", o excedente é mostrado e o mês pode ser encerrado sem transformar a sobra em despesa).
- **A cada 14 dias** usa intervalos reais de calendário: alguns meses têm três ocorrências.
- Opcionais: início, término (inclusivo), quantidade, dia de vencimento e valor estimado ("a confirmar", sinalizado na interface).
- **Lançamentos sem data**: compromissos previstos podem ter "data a definir", contam no mês e nunca aparecem como atrasados.

### Compromissos (Planejamento → Compromissos)

- Lista mensal de cada recorrência, com as ocorrências uma a uma: pagar, definir a data, ver o progresso ("1 de 2 pagas · R$ 50 restantes") e recolher os concluídos.
- **Estados**: previsto, pendente, data a definir, parcialmente pago, pago/recebido, atrasado (calculado pela data), ignorado e cancelado. Ignorar ou cancelar nunca conta como pagamento.
- **Pagamento simplificado**: o círculo conclui na hora. "Confirmar pagamento…" permite informar data efetiva, valor pago e fonte, inclusive **pagamento parcial**, com o restante continuando previsto. Tudo pode ser desfeito.
- Cada mês tem seu próprio estado. A edição de séries oferece **somente esta ocorrência**, **somente este mês**, **esta e as próximas** ou **toda a série**.

### Ações em lançamentos

- **Copiar para outro mês** e **Replicar para outros meses** (próximo, 3, 6 ou 12 meses, meses específicos ou intervalo), com o mesmo dia, outro dia ou data a definir. Mostra um resumo antes de confirmar e avisa sobre cópias parecidas. As cópias começam como **previstas**: o "pago" nunca é replicado.
- **Transformar em recorrente** com qualquer um dos modos. O lançamento original vira a primeira ocorrência, sem cópia.
- **Calcular com este valor** envia o valor à calculadora.

### Visão geral e personalização

- **Encaixe adaptativo.** Causa dos espaços vazios na 3.0: a grade usava linhas implícitas com `align-items: start`, então cada linha assumia a altura do componente mais alto e os menores deixavam buracos. Agora a grade usa linhas finas de 4 px e cada componente ocupa a altura que realmente tem (medida com ResizeObserver), o que permite encaixar componentes baixos uns sobre os outros ao lado de um alto. São dois modos: **automático** (preenche espaços) e **ordem fixa**.
- **Organizar automaticamente**: fecha lacunas alargando componentes dentro dos tamanhos permitidos, sem reordenar, e pode ser desfeito.
- **Ocultos fora da grade**: no modo de edição, ficam numa bandeja e voltam com um clique.
- **Controles compactos**: alça, título, menu de ajustes (tamanho, formato, cor, restaurar este componente, ocultar) e alça lateral de **redimensionamento** que se encaixa na grade de 12 colunas (também pelo teclado).
- **Refazer**, além de desfazer. O layout do **celular é salvo à parte** e não altera o do computador.
- **Formatos de apresentação** por componente: valor simples, valor com composição, evolução mensal, comparação com o mês anterior (aumento de despesa não aparece como algo bom), barras, rosca, tabela, resumo dos maiores, lista, barra de progresso e indicador percentual.
- **Novos componentes**:
  - **Compromissos do mês**, em resumo (pendente, próximo vencimento, contas restantes e % pago), lista ou progresso;
  - **Atenção**, com avisos discretos;
  - **Destaques**, com alternância opcional, lenta e pausável, desligada com movimento reduzido ou aba em segundo plano.
- **Avisos discretos e configuráveis**: orçamento ou previsão perto do limite (padrão 80%), limite atingido, excedente, contas atrasadas, vencimentos próximos, déficit projetado e sobra abaixo da margem. Nada pisca e nada se repete.

### Calculadora integrada

- **Porcentagem com semântica explícita**: "10% de 800" = 80, "800 + 10%" = 880, "800 − 10%" = 720, "800 × 10%" = 80. Uma ajuda curta explica as regras.
- **Ferramentas rápidas**: porcentagem de um valor, acréscimo, desconto, quanto % um valor representa, variação percentual, dividir despesa, valor por parcela, média, renda comprometida, quanto guardar por mês e % da renda.
- **Usar valores do Fluxo**: sobra projetada, disponível para investir, receitas, despesas, compromissos, patrimônio, total de categoria, bloco ou fonte, saldo de conta, valor ou restante de meta, valor de lançamento e restante de compromisso. O mês de cada valor fica sempre identificado.
- **Cálculos salvos** no IndexedDB (entram no backup): **estáticos** guardam os valores do momento; **dinâmicos** recalculam com os dados atuais e mostram os valores usados. Se a referência deixar de existir, o cálculo fica "indisponível", nunca vira zero. É possível nomear, editar, duplicar, favoritar, reutilizar, copiar e excluir.
- **Integração**: "Usar na calculadora" nos indicadores, "Calcular com este valor" nos lançamentos e "Lançamento" para criar um lançamento com o resultado. Nenhum dado é gravado sem confirmação no formulário.
- **Modo compacto**. A calculadora sempre volta para dentro da tela após mudanças de tamanho.

### Identidade e documentação

- **Assinatura institucional** "Desenvolvido por Filipe Santana" com a versão, no pé do menu lateral. No menu recolhido aparece uma marca discreta ("FS") e, no celular, a assinatura fica no fim da página. Ela não é um componente personalizável.
- **Versão centralizada** em `js/version.js` (assinatura, Sobre, diagnóstico e backups).
- **README** reescrito para quem quer usar o Fluxo. As informações técnicas foram para `docs/DEVELOPMENT.md`. A seção **Sobre o Fluxo** foi atualizada.

### Correções

- **Compatibilidade de backups**: com a nova coleção de cálculos, a soma SHA-256 dos backups da 3.0 deixaria de conferir. A verificação agora usa as coleções de cada versão do formato.
- **Clique duplo** no círculo de pagamento podia pagar e desfazer em seguida. Agora há uma trava por item enquanto a operação está em andamento.
- **Exceção "cancelada"** passa a ser respeitada também em recorrências de data única.
- **Arraste**: a grade em refluxo podia disparar reordenações em cascata. A histerese evita saltos inesperados, e soltar num espaço livre usa o componente mais próximo.
- **Pagamento** preserva o mês de fatura ajustado manualmente.

### Migração

- Esquema do banco **v3 → v4**: cria a coleção `calculations` e um índice único `[recurrenceId, occurrenceKey]`. Só acrescenta: registros antigos não são reescritos, o banco não é apagado nem recriado e o nome interno continua o mesmo.
- **Backup formato 3** (inclui cálculos salvos). Os formatos 2 (3.0) e legado (1.0/2.0) continuam aceitos.

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
