# Segurança do Fluxo

O Fluxo é um site estático que guarda dados financeiros pessoais no navegador. Este documento descreve o que ele protege, o que não protege e como reportar um problema.

## Como reportar uma vulnerabilidade

Abra uma *security advisory* privada no repositório (aba **Security → Report a vulnerability**). Evite issues públicas com detalhes que permitam explorar o problema antes da correção.

## Modelo de ameaças

**O que existe para proteger:** lançamentos, saldos, metas e preferências guardados no IndexedDB do navegador, e os arquivos de backup que o usuário exporta.

**O que o Fluxo assume:**

- o dispositivo e o perfil do navegador são de uso pessoal e não estão comprometidos;
- o site é servido pelo GitHub Pages via HTTPS;
- os arquivos de backup podem vir de qualquer lugar e são tratados como entrada não confiável.

| Ameaça | Mitigação | Limite |
|---|---|---|
| Texto do usuário interpretado como HTML ou script (XSS armazenado) | Toda a interface é montada com `createElement`/`textContent`; não há `innerHTML`, `eval`, `new Function` nem `document.write` no código. CSP restritiva. | — |
| Backup malicioso (scripts, chaves `__proto__`, estruturas gigantes, tipos errados) | O arquivo é lido como JSON e validado por inteiro antes de qualquer gravação: tamanho máximo (50 MB), objetos simples, chaves proibidas (`__proto__`, `constructor`, `prototype`), profundidade e tamanho por registro, tipos, datas, identificadores e relacionamentos. | Um backup válido com dados falsos é aceito: o app não tem como saber se os números são verdadeiros. |
| Backup corrompido ou truncado | Soma SHA-256 sobre a serialização determinística dos dados e contagens no cabeçalho. | O checksum **não é assinatura**: quem altera o arquivo de propósito pode recalculá-lo. |
| Leitura do backup por terceiros | Opção de proteger o arquivo com senha (AES-256-GCM, PBKDF2-SHA-256, 600 mil iterações, sal de 16 bytes, IV de 12 bytes, via Web Crypto). | Senha fraca pode ser descoberta por força bruta. Senha perdida = backup irrecuperável. |
| Perda de dados por falha durante restauração ou migração | Restauração e migrações em uma única transação do IndexedDB; snapshot interno do estado anterior; nenhuma migração apaga ou recria o banco. | Snapshots ficam no mesmo navegador: limpar os dados do site apaga tudo. |
| Duas abas gravando ao mesmo tempo | Controle de revisão por registro (`rev`), conflito informado ao usuário em vez de sobrescrever; BroadcastChannel e Web Locks coordenam restaurações. | Navegadores sem Web Locks usam só o BroadcastChannel. |
| Expressões da calculadora (digitadas ou salvas) | Parser próprio de aritmética (sem `eval`/`new Function`); gramática fechada (números, `+ − × ÷ ( ) %`, `de` e referências `@n`); limites de 400 caracteres, 200 símbolos, 32 níveis de parênteses e resultado finito até 10¹⁵; divisão por zero gera erro. | — |
| Cálculos salvos dinâmicos | Guardam só texto da expressão e referências estruturadas `{ kind, entityId, month }` a dados financeiros (nunca a outros cálculos: sem dependência circular possível). Referência inválida fica "indisponível", nunca vira zero. Cálculos são apenas informativos e não gravam lançamentos. | — |
| Duplicidade técnica de recorrências | Identidade estável por ocorrência (`regra:chave`), índice único no IndexedDB `[recurrenceId, occurrenceKey]`, replicação com ids por operação e trava contra clique duplo. | Duas despesas legítimas iguais continuam permitidas (só geram aviso). |
| Configuração de aparência corrompida | Layout salvo é normalizado (tipos desconhecidos, tamanhos e cores inválidos voltam ao padrão); falha num componente não derruba a tela. | — |
| Rastreamento e vazamento por rede | Nenhuma requisição para outros domínios; CSP `connect-src 'self'`; `referrer` desativado; sem analytics ou telemetria. | Os links "Repositório" e "Endereço do aplicativo" em *Sobre o Fluxo* abrem o GitHub quando clicados. |
| Acesso de outra pessoa ao dispositivo | Nenhuma (fora do escopo). | O IndexedDB **não é criptografado**. Quem acessa o perfil do navegador lê os dados. |
| Outros sites em `filipeesantana.github.io` | Banco com nome exclusivo. | Páginas na mesma origem podem ler o mesmo IndexedDB. Não é isolamento de segurança. |

## Content Security Policy

Definida por `<meta http-equiv="Content-Security-Policy">` no `index.html`:

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:;
font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'none';
object-src 'none'; base-uri 'none'; form-action 'none'
```

- Sem `'unsafe-inline'` e sem `'unsafe-eval'`: o script de inicialização fica em `js/boot.js` e estilos dinâmicos usam a CSSOM.
- `img-src data: blob:` existe para ícones SVG embutidos e para o download de arquivos gerados localmente.
- Os testes de navegador verificam que nenhuma seção gera violação de CSP.

**Limitações da CSP por meta tag:** o GitHub Pages não permite definir cabeçalhos HTTP. Por isso `frame-ancestors`, `report-uri`/`report-to` e `sandbox` **não têm efeito** (são ignorados em `<meta>`), e o site pode ser exibido dentro de um `<iframe>` de terceiros. Não há cabeçalhos `X-Frame-Options`, `Strict-Transport-Security` ou `Permissions-Policy` configurados pelo projeto; o que existe é o padrão do GitHub Pages.

## Armazenamento

- **IndexedDB** (`guia-financeiro.pessoal`, esquema v4): todos os dados financeiros, recorrências e compromissos, cálculos salvos (`calculations`), modelos de lançamento (chave `templates`, validados um a um, no máximo 60, e incluídos no backup), preferências financeiras e a personalização das telas (chave `ui.layout`, separada dos dados). O nome não mudou desde a 1.0 para não perder dados existentes; migrações só acrescentam.
- **localStorage** (`gf.*`): apenas preferências de exibição (tema, densidade, movimento, menu recolhido, posição da calculadora, adiamento do lembrete de backup). O histórico temporário da calculadora fica no `sessionStorage` e some ao fechar a aba. Nunca dados financeiros, e não há fallback para localStorage se o IndexedDB falhar: nesse caso o app informa o erro e não grava nada.
- O app pede **armazenamento persistente** (`navigator.storage.persist`). O resultado aparece em *Configurações → Armazenamento*.

## Formato do backup

```
{
  "format": "fluxo-backup",
  "version": 3,
  "backupId": "uuid",
  "createdAt": "ISO 8601",
  "appVersion": "3.2.0",
  "schemaVersion": 4,
  "counts": { "transactions": 0, ... },
  "period": { "from": "AAAA-MM-DD", "to": "AAAA-MM-DD" } | null,
  "checksum": { "algorithm": "SHA-256", "value": "hex" },
  "data": { "transactions": [], "categories": [], "blocks": [], "accounts": [], "recurrences": [],
            "installmentPlans": [], "budgets": [], "investments": [], "investmentEvents": [], "goals": [],
            "calculations": [], "meta": [] }
}
```

- O checksum é calculado sobre `data` serializado com chaves em ordem alfabética, usando as coleções que existiam na versão do formato (a 2 não tinha `calculations`). Assim, uma coleção nova nunca invalida backups antigos.
- Formato 2 (Fluxo 3.0) continua aceito.
- Formato legado aceito: `guia-financeiro-backup` versão 1 (Guia Financeiro 1.0 e Fluxo 2.0), sem checksum.
- Formatos ou versões desconhecidos e esquemas mais novos que o do app são recusados com mensagem clara.
- Arquivo protegido: `{ "format": "fluxo-backup-encrypted", "version": 1, "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations", "salt" }, "cipher": { "name": "AES-GCM", "iv" }, "ciphertext" }` (valores binários em base64). O conteúdo decifrado é um backup `fluxo-backup` normal.

## Dependências

Não há dependências de execução: o app usa apenas APIs nativas do navegador e não carrega scripts, fontes ou estilos de terceiros. As ferramentas de teste (Node.js e Playwright) não fazem parte do site publicado.

## Segredos

O repositório não contém chaves, tokens ou credenciais, e o app não precisa de nenhum. Backups e exportações estão no `.gitignore` para evitar que dados pessoais sejam versionados por engano.
