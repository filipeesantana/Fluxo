# Changelog

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
