import { h, icon, downloadFile, put } from '../utils/dom.js';
import { formatMoney } from '../utils/money.js';
import { formatDate, today } from '../utils/dates.js';
import * as repo from '../database/repository.js';
import { persistenceStatus, requestPersistence, storageEstimate } from '../database/db.js';
import { DB_VERSION, APP_VERSION, DB_NAME } from '../database/schema.js';
import { buildBackup, parseBackupText, transactionsToCSV, MAX_BACKUP_BYTES } from '../services/backup.js';
import { cashPosition } from '../services/finance.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { toast, toastError } from '../components/toast.js';
import { field, moneyInput, segmented, intInput, readInt } from '../components/fields.js';
import { openMenu } from '../components/menu.js';
import { pageHead, ACCOUNT_KINDS, ACCOUNT_ICON, accountOptions } from './common.js';
import { applyTheme, currentThemePref, applyMotion, currentMotionPref } from '../theme.js';
import { auditData } from '../services/integrity.js';
import { openEntryForm } from '../components/entry-form.js';

const STORE_LABEL = { transactions: 'lançamentos', categories: 'categorias', blocks: 'blocos', accounts: 'contas e cartões', recurrences: 'recorrências', installmentPlans: 'parcelamentos', budgets: 'orçamentos', investments: 'investimentos', investmentEvents: 'registros de investimento', goals: 'metas' };

const GROUPS = [
  ['aparencia', 'Aparência', 'palette'],
  ['financeiro', 'Preferências financeiras', 'sliders'],
  ['contas', 'Contas e cartões', 'card'],
  ['classificacao', 'Categorias e blocos', 'tag'],
  ['dados', 'Dados e backup', 'database'],
  ['integridade', 'Integridade dos registros', 'shield'],
  ['atalhos', 'Atalhos e sobre', 'info'],
];

export function renderSettings(root, sub) {
  const nav = h('nav', { class: 'settings-nav', 'aria-label': 'Grupos de configurações' },
    ...GROUPS.map(([id, label, ic]) => h('a', { href: `#/configuracoes/${id}`, dataset: { group: id }, class: sub === id ? 'is-active' : '', onclick: (ev) => { ev.preventDefault(); document.getElementById(`cfg-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); nav.querySelectorAll('a').forEach((x) => x.classList.toggle('is-active', x === ev.currentTarget)); } }, icon(ic), label)));
  const groups = [
    group('aparencia', 'Aparência', 'Tema e movimento. Preferências deste navegador.', appearance()),
    group('financeiro', 'Preferências financeiras', 'Usadas nos cálculos de sobra e projeção.', planning()),
    group('contas', 'Contas e cartões', 'Fontes de pagamento. Cartões com fechamento e vencimento calculam as faturas sozinhos.', accounts()),
    group('classificacao', 'Categorias e blocos', 'Categoria é a natureza do gasto; bloco é o contexto (pessoal, casa, moto…).', namedSection('categories', 'Categorias'), namedSection('blocks', 'Blocos')),
    group('dados', 'Dados e backup', 'Seus dados ficam somente neste navegador, neste dispositivo.', dataSection()),
    group('integridade', 'Integridade dos registros', 'Revisão de possíveis duplicidades e inconsistências. Nada é alterado automaticamente.', integrity()),
    group('atalhos', 'Atalhos e sobre', null, shortcuts(), about()),
  ];
  put(root, pageHead('Configurações', { sub: 'Preferências, cadastros e dados' }), h('div', { class: 'settings-layout' }, nav, h('div', { class: 'stack-lg' }, ...groups)));
  if (sub) requestAnimationFrame(() => document.getElementById(`cfg-${sub}`)?.scrollIntoView({ block: 'start' }));
}

function group(id, title, hint, ...children) {
  return h('section', { class: 'panel settings-group', id: `cfg-${id}` },
    h('div', { class: 'panel-head' }, h('h2', null, title), hint ? h('p', null, hint) : null),
    h('div', { class: 'stack-lg' }, ...children));
}

function section(title, hint, ...children) {
  return h('div', { class: 'stack' }, title ? h('h3', null, title) : null, hint ? h('p', { class: 'faint small' }, hint) : null, ...children);
}

function settingsRow(label, desc, control) {
  return h('div', { class: 'settings-row' }, h('div', { class: 'label' }, h('strong', null, label), desc ? h('span', null, desc) : null), control);
}

function appearance() {
  const seg = segmented({ label: 'Tema', value: currentThemePref(), options: [{ value: 'system', label: 'Sistema', icon: 'monitor' }, { value: 'light', label: 'Claro', icon: 'sun' }, { value: 'dark', label: 'Escuro', icon: 'moon' }], onChange: (v) => applyTheme(v) });
  const motion = segmented({ label: 'Animações', value: currentMotionPref(), options: [{ value: 'system', label: 'Padrão' }, { value: 'reduced', label: 'Reduzidas' }], onChange: (v) => { applyMotion(v); toast(v === 'reduced' ? 'Animações reduzidas' : 'Animações padrão'); } });
  const collapsed = segmented({ label: 'Menu lateral', value: document.documentElement.classList.contains('sidebar-collapsed') ? 'collapsed' : 'expanded', options: [{ value: 'expanded', label: 'Expandido' }, { value: 'collapsed', label: 'Recolhido' }], onChange: (v) => document.querySelector('[data-action="collapse"]')?.click() });
  return h('div', null,
    settingsRow('Tema', 'Sistema acompanha a preferência do sistema operacional.', seg),
    settingsRow('Animações', 'Reduzidas desliga transições; o sistema também é respeitado.', motion),
    settingsRow('Menu lateral', 'Recolhido mostra só ícones. Atalho: [', collapsed));
}

// ——— Contas e cartões ———

function accounts() {
  const list = repo.list('accounts').sort((a, b) => Number(a.archived) - Number(b.archived) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'pt-BR'));
  const bal = cashPosition(repo.context()).balances;
  const rows = list.map((a) => {
    const card = a.kind === 'credit';
    const info = card
      ? (a.closingDay && a.dueDay ? `fecha dia ${a.closingDay} · vence dia ${a.dueDay}${a.limit ? ` · limite ${formatMoney(a.limit)}` : ''}` : 'fechamento e vencimento não configurados')
      : repo.isFullyLoaded() ? `saldo ${formatMoney(bal.get(a.id) || 0)}` : 'saldo: carregando histórico…';
    const more = h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': `Ações de ${a.name}` }, icon('more'));
    more.addEventListener('click', () => openMenu(more, archiveMenu('accounts', a, () => openAccountForm(a))));
    return h('div', { class: `list-row${a.archived ? ' is-archived' : ''}` },
      h('span', { class: 'list-icon' }, icon(ACCOUNT_ICON[a.kind] || 'wallet', 'icon-sm')),
      h('button', { class: 'list-main', type: 'button', onclick: () => openAccountForm(a) },
        h('span', { class: 'truncate' }, a.name, a.archived ? h('span', { class: 'faint' }, ' · arquivada') : null),
        h('span', { class: 'faint small truncate' }, `${ACCOUNT_KINDS[a.kind]} · ${info}`)),
      more);
  });
  return section(null, null,
    h('div', { class: 'list' }, ...rows, rows.length ? null : h('p', { class: 'empty-line' }, 'Nenhuma conta ou cartão cadastrado.')),
    h('button', { class: 'btn', type: 'button', onclick: () => openAccountForm() }, icon('plus', 'icon-sm'), 'Adicionar conta ou cartão'));
}

function archiveMenu(store, row, onEdit) {
  const used = repo.usageOf(store, row.id);
  return [
    { label: 'Editar', icon: 'edit', onSelect: onEdit },
    row.archived
      ? { label: 'Reativar', icon: 'undo', onSelect: () => repo.setArchived(store, row.id, false).then(() => toast('Reativado')).catch(toastError) }
      : { label: 'Arquivar', icon: 'download', onSelect: () => repo.setArchived(store, row.id, true).then(() => toast('Arquivado: some das listas, mas o histórico continua intacto')).catch(toastError) },
    'sep',
    { label: used ? `Excluir (em uso em ${used})` : 'Excluir', icon: 'trash', danger: true, disabled: used > 0, onSelect: () => removeNamed(store, row) },
  ];
}

async function removeNamed(store, row) {
  if (!(await confirmDialog({ title: `Excluir “${row.name}”?`, message: 'Este item não está em uso e será removido definitivamente.', confirmLabel: 'Excluir', danger: true }))) return;
  try { await repo.deleteNamed(store, row.id); toast('Excluído'); } catch (err) { toastError(err); }
}

function openAccountForm(a = null) {
  const name = h('input', { class: 'input', value: a?.name || '', maxlength: 80, placeholder: 'Ex.: Conta Nubank, Cartão Nubank, Banco do Brasil' });
  const kind = h('select', { class: 'select' }, ...Object.entries(ACCOUNT_KINDS).map(([v, l]) => h('option', { value: v }, l)));
  kind.value = a?.kind || 'checking';
  const opening = moneyInput({ value: a?.openingBalance ?? 0, allowZero: true });
  const closing = intInput({ value: a?.closingDay, min: 1, max: 31, placeholder: 'Ex.: 3' });
  const due = intInput({ value: a?.dueDay, min: 1, max: 31, placeholder: 'Ex.: 10' });
  const limit = moneyInput({ value: a?.limit ?? null });
  const pay = h('select', { class: 'select' }, h('option', { value: '' }, 'Não definida'), ...accountOptions({ keep: a?.payAccountId, filter: (x) => x.kind !== 'credit' && x.id !== a?.id }).map((o) => h('option', { value: o.value }, o.label)));
  pay.value = a?.payAccountId || '';
  const fName = field('Nome', name);
  const cardBox = h('div', { class: 'form-grid' }, field('Dia de fechamento', closing, { hint: 'Compras a partir deste dia vão para a próxima fatura' }), field('Dia de vencimento', due), field('Limite', limit, { hint: 'Opcional' }), field('Conta de pagamento', pay, { hint: 'Sugerida ao pagar a fatura' }));
  const fOpening = field('Saldo inicial', opening, { hint: 'Saldo real na data em que começou a usar o app' });
  const sync = () => { const c = kind.value === 'credit'; cardBox.hidden = !c; fOpening.hidden = c; };
  kind.addEventListener('change', sync);
  sync();
  const save = h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
    fName.setError(name.value.trim() ? '' : 'Informe um nome');
    if (!name.value.trim()) return;
    const isCard = kind.value === 'credit';
    const c = readInt(closing, { min: 1, max: 31 }), d = readInt(due, { min: 1, max: 31 });
    if (isCard && (Number.isNaN(c) || Number.isNaN(d))) { toast('Dias devem estar entre 1 e 31', { tone: 'error' }); return; }
    if (isCard && (c == null) !== (d == null)) { toast('Informe fechamento e vencimento, ou deixe ambos em branco', { tone: 'error' }); return; }
    const row = { ...(a || {}), name: name.value, kind: kind.value, openingBalance: isCard ? 0 : opening.getValue() ?? 0, closingDay: isCard ? c : null, dueDay: isCard ? d : null, limit: isCard ? limit.getValue() : null, payAccountId: isCard ? pay.value || null : null };
    try {
      if (a) await repo.saveNamed('accounts', row); else await repo.createNamed('accounts', row);
      m.close(); toast(a ? 'Conta atualizada' : 'Conta criada', { tone: 'success' });
    } catch (err) { toastError(err); }
  } }, 'Salvar');
  const m = openModal({ title: a ? 'Editar conta ou cartão' : 'Nova conta ou cartão', body: h('div', { class: 'stack' }, h('div', { class: 'form-grid' }, fName, field('Tipo', kind)), fOpening, cardBox,
    a && a.kind === 'credit' ? h('p', { class: 'faint small' }, 'Alterar fechamento ou vencimento recalcula a fatura das compras que não tiveram o mês ajustado manualmente.') : null),
  footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), save] });
}

// ——— Categorias e blocos ———

function namedSection(store, title, hint = null) {
  const all = repo.list(store).sort((a, b) => Number(a.archived) - Number(b.archived) || (a.order ?? 1e9) - (b.order ?? 1e9) || a.name.localeCompare(b.name, 'pt-BR'));
  const groups = store === 'categories' ? [['expense', 'Despesas'], ['income', 'Receitas']] : [[null, null]];
  const body = groups.map(([type, label]) => {
    const rows = all.filter((x) => type == null || x.type === type);
    return h('div', { class: 'stack' },
      label ? h('h3', { class: 'faint small' }, label) : null,
      h('div', { class: 'tags-list' }, ...rows.map((x) => {
        const used = repo.usageOf(store, x.id);
        const b = h('button', { class: `tag-item${x.archived ? ' is-archived' : ''}`, type: 'button', title: used ? `Usado em ${used} registro(s)` : 'Sem uso' }, x.name, used ? h('span', { class: 'faint num' }, String(used)) : null);
        b.addEventListener('click', () => openMenu(b, archiveMenu(store, x, () => renameNamed(store, x)), { align: 'start' }));
        return b;
      }),
      h('button', { class: 'tag-item tag-add', type: 'button', onclick: () => renameNamed(store, { type }) }, icon('plus', 'icon-sm'), store === 'categories' ? 'Categoria' : 'Bloco')));
  });
  return section(title, hint, ...body, h('p', { class: 'faint small' }, 'Itens em uso não podem ser excluídos: arquive-os para escondê-los das listas sem alterar o histórico.'));
}

function renameNamed(store, row) {
  const isNew = !row.id;
  const name = h('input', { class: 'input', value: row.name || '', maxlength: 80 });
  const fName = field('Nome', name);
  const save = h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
    if (!name.value.trim()) { fName.setError('Informe um nome'); return; }
    try {
      if (isNew) await repo.createNamed(store, store === 'categories' ? { name: name.value, type: row.type || 'expense' } : { name: name.value });
      else await repo.saveNamed(store, { ...row, name: name.value });
      m.close();
    } catch (err) { fName.setError(err.message); }
  } }, isNew ? 'Criar' : 'Salvar');
  name.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); save.click(); } });
  const m = openModal({ title: isNew ? (store === 'categories' ? `Nova categoria de ${row.type === 'income' ? 'receita' : 'despesa'}` : 'Novo bloco') : 'Renomear', size: 'sm', body: fName,
    footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), save] });
}

// ——— Planejamento ———

function planning() {
  const prefs = repo.prefs();
  const margin = moneyInput({ value: prefs.safetyMargin || 0, allowZero: true });
  margin.input.addEventListener('change', async () => {
    const v = margin.getValue() ?? 0;
    if (v < 0) return;
    try { await repo.setPrefs({ safetyMargin: v }); toast('Margem de segurança salva'); } catch (err) { toastError(err); }
  });
  const variable = moneyInput({ value: prefs.variableEstimate || 0, allowZero: true });
  variable.input.addEventListener('change', async () => {
    const v = variable.getValue() ?? 0;
    if (v < 0) return;
    try { await repo.setPrefs({ variableEstimate: v }); toast('Estimativa de gastos variáveis salva'); } catch (err) { toastError(err); }
  });
  margin.style.width = variable.style.width = '220px';
  return h('div', null,
    settingsRow('Margem de segurança mensal', 'Reserva descontada do valor disponível para investir.', margin),
    settingsRow('Gastos variáveis estimados', 'Aplicados às projeções dos próximos meses (mercado, lazer, transporte…).', variable));
}

// ——— Integridade ———

function integrity() {
  const out = h('div', { class: 'stack' });
  const LABEL = { duplicate: 'Possível duplicidade', ref: 'Referência inválida', plan: 'Parcelamento', recurrence: 'Recorrência', orphan: 'Registro órfão' };
  const run = async () => {
    if (!repo.isFullyLoaded()) put(out, h('p', { class: 'faint small' }, 'Carregando o histórico completo…'));
    const issues = auditData(await repo.fullSnapshot());
    if (!issues.length) { put(out, h('div', { class: 'audit-ok' }, icon('check', 'icon-sm'), 'Nenhuma inconsistência encontrada.')); return; }
    const shown = issues.slice(0, 60);
    put(out,
      h('p', { class: 'small muted' }, `${issues.length} ${issues.length === 1 ? 'ocorrência encontrada' : 'ocorrências encontradas'}. Revise cada uma; lançamentos idênticos podem ser legítimos.`),
      h('div', { class: 'audit-list' }, ...shown.map((it) => {
        const tx = it.refs.map((id) => repo.get('transactions', id)).filter(Boolean);
        return h('div', { class: 'audit-item' },
          h('span', { class: `sev ${it.severity}`, title: it.severity }),
          h('span', null, h('strong', { class: 'small' }, LABEL[it.type] || it.type), h('br'), h('span', { class: 'small muted' }, it.message),
            tx.length ? h('span', { class: 'faint xsmall' }, ` · ${tx.map((t) => `${formatDate(t.date)} ${formatMoney(t.amount)}`).join(' / ')}`) : null),
          tx.length ? h('div', { class: 'row' }, ...tx.slice(0, 3).map((t, i) => h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openEntryForm({ tx: t }) }, tx.length > 1 ? `Abrir ${i + 1}` : 'Abrir'))) : h('span'));
      })),
      issues.length > shown.length ? h('p', { class: 'faint small' }, `… e mais ${issues.length - shown.length}.`) : null);
  };
  run();
  return h('div', { class: 'stack-lg' }, out, h('div', null, h('button', { class: 'btn', type: 'button', onclick: async () => { await run(); toast('Verificação concluída'); } }, icon('shield', 'icon-sm'), 'Verificar novamente')));
}

// ——— Dados ———

function dataSection() {
  const status = h('span', { class: 'faint small' }, 'verificando…');
  const usage = h('span', { class: 'faint small' });
  persistenceStatus().then((s) => {
    status.textContent = { granted: 'Armazenamento persistente concedido pelo navegador.', denied: 'O navegador ainda não concedeu armazenamento persistente.', unsupported: 'Este navegador não informa o status de persistência.' }[s];
    if (s === 'denied') status.append(' ', h('button', { class: 'link-btn', type: 'button', onclick: async () => { const r = await requestPersistence(); toast(r === 'granted' ? 'Persistência concedida' : 'O navegador não concedeu agora; ele pode decidir automaticamente com o uso.'); renderAgain(); } }, 'Solicitar'));
  });
  storageEstimate().then((e) => { if (e?.usage != null) usage.textContent = `Uso aproximado: ${(e.usage / 1024 / 1024).toFixed(1).replace('.', ',')} MB`; });
  const file = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: (ev) => { const f = ev.target.files[0]; ev.target.value = ''; if (f) importFile(f); } });
  const counts = Object.entries(STORE_LABEL).map(([s, l]) => [l, repo.list(s).length]).filter(([, n]) => n);
  return section(null, null,
    h('div', { class: 'notice' }, icon('alert', 'icon-sm'), h('p', null, 'Nada é enviado para servidores. Limpar os dados do site, usar navegação privada ou trocar de navegador pode apagar as informações. O IndexedDB não é criptografado: faça backups regulares e guarde-os em local seguro.')),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn', type: 'button', onclick: exportJSON }, icon('download', 'icon-sm'), 'Exportar backup (JSON)'),
      h('button', { class: 'btn', type: 'button', onclick: exportCSV }, icon('download', 'icon-sm'), 'Exportar lançamentos (CSV)'),
      h('button', { class: 'btn', type: 'button', onclick: () => file.click() }, icon('upload', 'icon-sm'), 'Restaurar backup'), file),
    h('p', { class: 'faint small' }, counts.length ? `Base atual: ${counts.map(([l, n]) => `${n} ${l}`).join(', ')}.` : 'Base vazia.'),
    h('div', { class: 'stack' }, status, usage),
    h('div', { class: 'danger-zone' }, h('div', null, h('strong', null, 'Apagar todos os dados'), h('p', { class: 'faint small' }, 'Remove permanentemente todos os registros deste navegador.')),
      h('button', { class: 'btn btn-danger', type: 'button', onclick: wipe }, 'Apagar tudo')));
}

function renderAgain() { window.dispatchEvent(new HashChangeEvent('hashchange')); }

export async function exportJSON() {
  const b = buildBackup(await repo.fullSnapshot());
  downloadFile(`fluxo-backup-${today()}.json`, JSON.stringify(b, null, 1), 'application/json');
  toast('Backup exportado', { tone: 'success' });
}

async function exportCSV() {
  await repo.whenFullyLoaded();
  const maps = { categories: new Map(repo.list('categories').map((c) => [c.id, c])), blocks: new Map(repo.list('blocks').map((c) => [c.id, c])), accounts: new Map(repo.list('accounts').map((c) => [c.id, c])) };
  downloadFile(`fluxo-lancamentos-${today()}.csv`, transactionsToCSV(repo.list('transactions'), maps), 'text/csv;charset=utf-8');
  toast('CSV exportado', { tone: 'success' });
}

async function importFile(file) {
  if (file.size > MAX_BACKUP_BYTES) { toast('Arquivo grande demais para ser um backup.', { tone: 'error' }); return; }
  let text;
  try { text = await file.text(); } catch { toast('Não foi possível ler o arquivo.', { tone: 'error' }); return; }
  const res = parseBackupText(text);
  if (!res.ok) {
    const m = openModal({ title: 'Backup inválido', size: 'sm', body: h('div', { class: 'stack' },
      h('p', null, 'Nenhum dado foi alterado. Problemas encontrados:'),
      h('ul', { class: 'issues' }, ...res.errors.map((e) => h('li', null, e)))),
    footer: [h('span', { class: 'grow' }), h('button', { class: 'btn btn-primary', type: 'button', onclick: () => m.close() }, 'Entendi')] });
    return;
  }
  const current = Object.entries(STORE_LABEL).map(([s, l]) => `${repo.list(s).length} ${l}`);
  const incoming = Object.entries(STORE_LABEL).map(([s, l]) => [l, res.counts[s] || 0]).filter(([, n]) => n);
  const keepCopy = h('input', { type: 'checkbox', checked: true });
  const details = h('div', { class: 'stack small' },
    h('div', { class: 'impact' },
      h('div', null, h('div', { class: 'faint' }, 'Será importado'), h('div', null, incoming.length ? incoming.map(([l, n]) => `${n} ${l}`).join(', ') : 'nenhum registro')),
      h('div', null, h('div', { class: 'faint' }, 'Será substituído'), h('div', null, current.filter((c) => !c.startsWith('0 ')).join(', ') || 'base vazia'))),
    res.exportedAt ? h('p', { class: 'faint' }, `Backup gerado em ${formatDate(res.exportedAt.slice(0, 10))}.`) : null,
    res.warnings.length ? h('ul', { class: 'issues is-warn' }, ...res.warnings.map((w) => h('li', null, w))) : null,
    h('label', { class: 'check' }, keepCopy, h('span', null, 'Baixar uma cópia dos dados atuais antes de restaurar')));
  const ok = await confirmDialog({ title: 'Restaurar backup?', message: 'A base atual será substituída pelo conteúdo do backup em uma única operação. Se algo falhar, nada é alterado.', confirmLabel: 'Restaurar', danger: true, details });
  if (!ok) return;
  try {
    if (keepCopy.checked && !repo.isEmpty()) await exportJSON();
    await repo.importData(res.backup.data);
    toast('Backup restaurado', { tone: 'success' });
  } catch (err) { toastError(err); toast('A restauração falhou; os dados anteriores foram preservados.', { tone: 'error' }); }
}

async function wipe() {
  const input = h('input', { class: 'input', placeholder: 'Digite APAGAR', autocomplete: 'off' });
  const go = h('button', { class: 'btn btn-danger btn-solid', type: 'button', disabled: true, onclick: async () => {
    try { await repo.wipeAll(); m.close(); toast('Todos os dados foram apagados'); location.hash = '#/visao-geral'; } catch (err) { toastError(err); }
  } }, 'Apagar definitivamente');
  input.addEventListener('input', () => { go.disabled = input.value.trim().toUpperCase() !== 'APAGAR'; });
  const m = openModal({ title: 'Apagar todos os dados?', size: 'sm', body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Esta ação não pode ser desfeita. Exporte um backup antes, se quiser guardar uma cópia.'),
    h('button', { class: 'btn', type: 'button', onclick: exportJSON }, icon('download', 'icon-sm'), 'Exportar backup agora'), field('Confirmação', input)),
  footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), go] });
}

function shortcuts() {
  const list = [['[', 'Recolher ou expandir o menu'], ['Ctrl+Enter', 'Salvar o formulário aberto'], ['N', 'Novo lançamento'], ['C', 'Calculadora (Alt+C dentro de campos)'], ['/', 'Buscar lançamentos'], ['← →', 'Mês anterior / próximo'], ['T', 'Voltar ao mês atual'], ['1–5', 'Ir para cada seção'], ['Shift+Enter', 'Salvar e criar outro'], ['Ctrl+Enter', 'Na calculadora: inserir o resultado no campo'], ['Esc', 'Fechar janelas']];
  return section('Atalhos de teclado', null, h('div', { class: 'shortcuts' }, ...list.map(([k, l]) => h('div', { class: 'shortcut' }, h('span', { class: 'keys' }, ...k.split(' ').map((x) => h('kbd', null, x))), h('span', { class: 'muted small' }, l)))));
}

function about() {
  return section('Sobre', null, h('p', { class: 'faint small' }, `Fluxo ${APP_VERSION} · esquema de dados v${DB_VERSION} · banco “${DB_NAME}”. Aplicação local-first: sem contas, sem servidores, sem telemetria.`));
}
