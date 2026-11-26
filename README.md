<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/fluxo-logo-dark.svg">
    <img src="assets/brand/fluxo-logo-light.svg" alt="Fluxo" width="200">
  </picture>
</p>

# Fluxo

Organizador financeiro pessoal que roda inteiro no navegador. Sem conta, sem servidor e sem telemetria: os dados ficam no seu dispositivo.

## Acesse o Fluxo

**https://filipeesantana.github.io/fluxo/**

> Enquanto o repositório não for renomeado para `fluxo`, o endereço em uso é https://filipeesantana.github.io/guia-financeiro/. Veja [Execução local e publicação](#execução-local-e-publicação) antes de trocar de endereço: os dados do navegador ficam ligados ao endereço onde foram criados.

## O que é o Fluxo?

O Fluxo junta, num só lugar, o que entrou, o que saiu, o que ainda vai vencer e quanto sobra no mês. Ele responde perguntas práticas — quanto ainda vou gastar, quanto posso investir, quando uma meta fica pronta — com números que você consegue conferir: cada indicador abre a conta que levou até ele.

Ele não movimenta dinheiro, não se conecta a bancos e não envia seus dados para lugar nenhum.

## Principais funcionalidades

- **Visão geral** com sobra projetada, disponível para investir, receitas e despesas realizadas e previstas. Clique em qualquer indicador para ver a composição do valor e os lançamentos de cada parte.
- **Lançamentos** com busca, filtros, agrupamento, visualização em lista ou tabela e colunas organizáveis.
- **Repetição de lançamentos** (semanal, quinzenal, mensal, bimestral, trimestral, semestral, anual ou personalizada), com início, término, quantidade e dia de vencimento. Alterações em séries perguntam se valem só para uma ocorrência, para as próximas ou para a série inteira.
- **Cartões de crédito** com fechamento, vencimento e faturas calculadas, sem contar a compra duas vezes quando a fatura é paga.
- **Planejamento**: calendário financeiro, projeção de até 60 meses, simulações que não alteram seus registros, recorrências, parcelamentos e orçamentos.
- **Investimentos e metas**, com rentabilidade opcional e simulador de aportes.
- **Personalização**: reorganize, redimensione, oculte e destaque componentes; escolha a visualização dos gráficos; ajuste a densidade da interface.
- **Backup completo** em JSON com verificação de integridade, opção de proteção por senha e restauração com prévia.
- **Tema claro e escuro**, atalhos de teclado e calculadora integrada.

## Como utilizar

1. Abra o Fluxo e cadastre suas contas e cartões em **Configurações → Contas e cartões** (para cartões, informe fechamento e vencimento).
2. Registre um lançamento com **Novo lançamento** (atalho `N`). Valor, descrição e data bastam; categoria, bloco e fonte ajudam nas análises.
3. Para contas que se repetem, escolha uma opção em **Repetir lançamento** no próprio formulário.
4. Marque como pago ou recebido pelo círculo à esquerda de cada lançamento previsto.
5. Na **Visão geral**, clique em um indicador para entender como ele foi calculado.
6. Use **Planejamento** para ver o calendário do mês, a projeção dos próximos meses e simular decisões.
7. Em **Investimentos**, crie metas e use o simulador; nada é registrado sem sua confirmação.
8. Use **Personalizar** para organizar as telas do seu jeito. Só a aparência muda.
9. Gere um backup em **Configurações → Dados e backup** e guarde o arquivo fora do navegador.

## Como funciona

Todos os números vêm de um único motor de cálculo (`js/services/finance.js`), usado pela visão geral, pelo calendário, pela projeção e pelos detalhamentos. Por isso os valores conferem entre telas.

- Valores são guardados em **centavos inteiros**; datas, como `AAAA-MM-DD` no calendário local.
- Compras no cartão entram na competência da fatura e são compromissos até o pagamento. Pagamento de fatura, transferências e aportes não são despesas de consumo.
- Benefícios de uso restrito (VA/VR) não entram no valor disponível para investir.
- Ocorrências de recorrências são projetadas, não gravadas uma a uma. Quando uma ocorrência é paga ou editada, ela ganha um identificador fixo (`regra:data`), o que impede duplicidades.
- A rentabilidade é opcional (0% por padrão). Quando informada, os juros são compostos com a taxa mensal equivalente `(1 + a)^(1/12) − 1`.

## Privacidade e armazenamento

Os dados ficam no **IndexedDB** do navegador, no banco `guia-financeiro.pessoal`. Não existe servidor, conta, sincronização, rastreamento ou analytics, e o app não faz requisições para outros domínios.

O que isso significa na prática:

- o IndexedDB **não é criptografado**: quem tiver acesso a este perfil do navegador consegue ler os dados;
- limpar os dados do site, usar navegação privada ou trocar de navegador ou aparelho pode fazer os dados desaparecerem;
- os dados ficam ligados à **origem** (`https://filipeesantana.github.io`). Outros apps publicados na mesma origem compartilham o mesmo espaço do navegador; o nome exclusivo do banco evita colisões, mas não é uma barreira de segurança;
- o Fluxo pede ao navegador armazenamento persistente, mas a concessão depende do navegador.

Mais detalhes em [SECURITY.md](SECURITY.md).

## Backup e recuperação

Em **Configurações → Dados e backup**:

- **Exportar backup completo**: arquivo `Fluxo-backup-AAAA-MM-DD_HH-MM.json` com todos os registros, preferências e personalização, contagens e uma soma **SHA-256** que detecta arquivos corrompidos ou alterados. A soma não é uma assinatura: ela não prova quem gerou o arquivo.
- **Protegido por senha** (opcional): o conteúdo é cifrado com AES-256-GCM e chave derivada por PBKDF2 (600 mil iterações). Sem a senha, não há como recuperar o arquivo.
- **Restaurar backup**: o arquivo é validado por inteiro (estrutura, versão, tipos, relacionamentos, checksum) e uma prévia mostra data, versão, quantidades e o que será substituído. A troca acontece em uma única transação; se algo falhar, nada muda. Antes da troca, o Fluxo oferece baixar um backup dos dados atuais e guarda um snapshot interno (que não substitui um backup externo).
- **Lembrete** configurável (desligado, 7 dias, 15 dias ou mensal) e data do último backup gerado.
- Backups do Guia Financeiro 1.0 e do Fluxo 2.0 continuam aceitos. Arquivos de uma versão futura desconhecida são recusados.

O formato está documentado em [SECURITY.md](SECURITY.md#formato-do-backup). Backups contêm dados pessoais: não os publique nem os adicione a repositórios.

## Tecnologias utilizadas

- HTML, CSS e JavaScript (ES Modules), sem framework e sem etapa de build;
- IndexedDB para armazenamento local;
- Web Crypto (SHA-256, AES-GCM, PBKDF2), BroadcastChannel e Web Locks, todos nativos do navegador;
- gráficos em SVG desenhados pelo próprio app;
- testes com `node:test` e Playwright (Chromium).

Não há dependências de execução: nenhum script, fonte ou recurso é carregado de terceiros.

## Execução local e publicação

O Fluxo é um site estático. Para rodar localmente, sirva a pasta do projeto com qualquer servidor HTTP estático (módulos ES não funcionam abrindo o `index.html` direto do disco). O projeto inclui um servidor simples que reproduz o subdiretório do GitHub Pages:

```bash
node tests/server.mjs
```

A publicação usa o GitHub Pages a partir da raiz da branch `main`. Todos os caminhos são relativos e a navegação usa `#/rotas`, então o app funciona em qualquer subdiretório (`/guia-financeiro/`, `/fluxo/` ou outro).

**Mudança de endereço.** O navegador separa os dados por origem (`https://filipeesantana.github.io`), não pelo caminho. Renomear o repositório de `guia-financeiro` para `fluxo` mantém a mesma origem, e o nome do banco não depende do caminho, então os dados continuam acessíveis no novo endereço do mesmo navegador. Mesmo assim:

1. gere um **backup completo** antes de renomear;
2. depois de renomear, confira se o novo endereço foi publicado em *Settings → Pages*;
3. não conte com o endereço antigo redirecionando: o GitHub redireciona o repositório, mas o redirecionamento do site publicado não é garantido.

## Testes e manutenção

| Suíte | Comando | O que cobre |
|---|---|---|
| Unitários | `npm test` | regras financeiras, datas, faturas, recorrências, backup, criptografia, validação |
| Navegador | `npm run test:e2e` | fluxos completos no Chromium, servido em `/guia-financeiro/` e em `/fluxo/` |
| Escala | `npm run test:perf` | 100, 1.000, 10.000 e 50.000 lançamentos sintéticos |

Os testes de navegador e de escala usam o Playwright com Chromium. Medições mais recentes e achados de auditoria estão em [AUDIT-v3.0.md](AUDIT-v3.0.md); o histórico de mudanças, em [CHANGELOG.md](CHANGELOG.md).

Limitações conhecidas:

- não há sincronização entre aparelhos; use backup e restauração;
- não há service worker: o app funciona sem rede com a aba aberta, mas não é instalável para uso offline completo;
- projeções consideram o que foi cadastrado; gastos variáveis futuros só entram quando você informa uma estimativa mensal;
- a compatibilidade foi verificada no Chromium. Firefox e Safari devem funcionar por usarem apenas APIs padrão, mas não foram testados automaticamente nesta versão.
