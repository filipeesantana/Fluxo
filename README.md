<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/fluxo-logo-dark.svg">
    <img src="assets/brand/fluxo-logo-light.svg" alt="Fluxo" width="200">
  </picture>
</p>

# Fluxo

Uma ferramenta gratuita para organizar a vida financeira pessoal: o que entra, o que sai, o que ainda vai vencer e quanto sobra no mês. Funciona direto no navegador, sem cadastro.

## Acesse o Fluxo

**[filipeesantana.github.io/Fluxo](https://filipeesantana.github.io/Fluxo/)**

Basta abrir o link. Não é preciso instalar nada nem criar conta.

## O que é o Fluxo?

O Fluxo ajuda a responder perguntas do dia a dia com números que você consegue conferir: quanto ainda vou gastar este mês, quanto já paguei das contas, quanto sobra para guardar, quando uma meta fica pronta.

Você registra receitas e despesas, organiza tudo por categoria, bloco (pessoal, casa, moto…) e fonte de pagamento, e o Fluxo monta o resumo do mês, o calendário de vencimentos e a projeção dos próximos meses. Cada número da visão geral pode ser aberto para mostrar de onde veio.

Ele não movimenta dinheiro, não se conecta a bancos e não envia seus dados para lugar nenhum.

## Como começar

1. Acesse o Fluxo pelo navegador.
2. Registre suas receitas e despesas com **Novo lançamento** (atalho `N`). Valor, descrição e data bastam para começar.
3. Organize os lançamentos por categoria, bloco e fonte. Isso deixa os gráficos e resumos mais úteis.
4. Configure as despesas recorrentes usando **Repetir** no próprio formulário.
5. Acompanhe o resumo mensal na **Visão geral**.
6. Planeje os próximos meses em **Planejamento**: compromissos, calendário e projeção.
7. Personalize as telas do seu jeito em **Personalizar**.
8. Faça backups regularmente em **Configurações → Dados e backup**.

## O que você pode fazer

- **Ver o mês com clareza.** Sobra projetada, disponível para investir, receitas e despesas realizadas e previstas. Clique em qualquer indicador para ver a conta que levou até ele.
- **Registrar rápido.** O formulário sugere categoria e fonte pelo histórico e avisa quando um lançamento parece repetido, sem impedir lançamentos legítimos.
- **Acompanhar cartões.** Com fechamento e vencimento cadastrados, as compras caem na fatura certa e o pagamento da fatura não conta a despesa duas vezes.
- **Planejar.** Calendário de vencimentos, projeção de até cinco anos e simulações de decisões ("e se eu cancelar esta assinatura?") que não alteram seus registros.
- **Acompanhar compromissos.** Uma lista mensal das contas, para marcar o que já foi pago, uma a uma.
- **Ser avisado com discrição.** Orçamentos perto do limite, contas atrasadas e vencimentos próximos aparecem num quadro de "Atenção", sem alertas piscando.
- **Calcular com seus dados.** A calculadora faz contas comuns e porcentagens fáceis, e pode usar valores reais do Fluxo.
- **Guardar backups completos**, com verificação de integridade e proteção opcional por senha.

## Recorrências e planejamento

Quase tudo pode se repetir, independentemente de como você paga: Pix, dinheiro, débito, cartão de crédito, vale-alimentação ou outra fonte. A fonte pode até ficar para depois: escolha no momento de pagar.

Ao escolher **Repetir → Mensalmente**, o Fluxo oferece quatro jeitos:

- **Em um dia específico.** Internet de R$ 100 todo dia 10.
- **Em mais de um dia do mês.** R$ 50 nos dias 5 e 20 (R$ 100 no mês).
- **Com datas flexíveis.** Duas consultas de R$ 50 por mês, com datas a combinar. O mês já conta R$ 100 no planejamento, e você define cada data quando souber, sem o Fluxo inventar datas.
- **Como previsão mensal.** Até R$ 400 de combustível. Cada abastecimento registrado consome a previsão: depois de R$ 300 gastos, restam R$ 100. Se passar do previsto, o excedente aparece. Se sobrar, você encerra o mês e a sobra não vira despesa.

Também há **A cada 14 dias**, com intervalos reais: começando em 04/11, as ocorrências caem em 04/11, 18/11, 02/12, 16/12 e 30/12. Por isso, dezembro pode ter três ocorrências.

Em **Planejamento → Compromissos**, cada mês tem sua própria lista, com o progresso ("1 de 2 consultas pagas · R$ 50 restantes"). Pagar em novembro não marca dezembro. Ao pagar, você pode confirmar a data, o valor e a fonte, registrar um pagamento parcial e desfazer, se precisar.

Lançamentos avulsos também podem ser **copiados ou replicados** para outros meses, ou **transformados em recorrentes** sem criar cópias.

## Investimentos e metas

Cadastre reservas e aplicações com o saldo atual e crie metas informando quanto quer juntar e quanto consegue guardar por mês. O simulador mostra quando a meta fica pronta e pode usar a sobra do mês como referência.

A rentabilidade é opcional e sempre tratada como estimativa: projeções não são retorno garantido.

## Personalização

Em **Personalizar**, arraste os componentes pela alça (ou use as setas do teclado), escolha o tamanho, a cor de destaque e o formato de cada informação: valor simples, valor com composição, evolução mensal, comparação com o mês anterior, barras, rosca, tabela e outros, conforme o que fizer sentido para cada dado.

O encaixe automático aproveita os espaços livres sem embaralhar a ordem escolhida, e **Organizar automaticamente** ajusta as larguras para fechar lacunas. Tudo pode ser desfeito. No celular, a organização é guardada à parte, sem mexer na do computador.

Também dá para escolher a densidade da interface (compacta, padrão ou confortável), o tema claro ou escuro e reduzir as animações.

## Privacidade e armazenamento

O Fluxo é **local-first**:

- não é necessário criar conta;
- os registros ficam guardados no próprio navegador, no **IndexedDB**, neste dispositivo;
- os dados **não são sincronizados** com outros aparelhos;
- limpar os dados do site, usar navegação privada ou trocar de navegador pode **apagar os registros**;
- por isso, **backups externos são fundamentais**;
- o armazenamento local **não é criptografia**: quem tiver acesso ao seu perfil do navegador consegue ler os dados;
- a segurança depende também do seu dispositivo, do navegador e da integridade do código publicado.

O Fluxo não usa rastreamento, anúncios nem telemetria. Mais detalhes em [SECURITY.md](SECURITY.md).

## Backup e recuperação

Para guardar uma cópia:

1. Abra **Configurações → Dados e backup**.
2. Clique em **Exportar backup completo** e escolha entre arquivo comum ou protegido por senha.
3. Guarde o arquivo num lugar seguro, fora do navegador.

Para recuperar:

1. Em **Configurações → Dados e backup**, clique em **Restaurar backup** e escolha o arquivo.
2. Confira a prévia: data, quantidades e o que será substituído.
3. Confirme. Se algo der errado no meio do caminho, seus dados atuais continuam intactos.

O backup inclui lançamentos, recorrências, compromissos, cálculos salvos e a personalização. Se você usar senha e esquecê-la, não há como recuperar o arquivo.

## Sobre o projeto

O Fluxo é feito com HTML, CSS e JavaScript, sem frameworks e sem dependências externas, e é publicado como site estático. A ideia é simples: poucos campos para registrar, cálculos transparentes e nenhuma surpresa com os seus dados.

Desenvolvido por **Filipe Santana**.

Informações técnicas para manutenção estão em [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). O histórico de versões está em [CHANGELOG.md](CHANGELOG.md).
