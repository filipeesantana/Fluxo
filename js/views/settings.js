import { h, icon, put } from '../utils/dom.js';
import { formatMoney } from '../utils/money.js';
import { formatDate } from '../utils/dates.js';
import * as repo from '../database/repository.js';
import { dataPanel, dangerPanel, diagnosticsPanel } from './backup-ui.js';
import { DB_VERSION, APP_VERSION, DB_NAME } from '../database/schema.js';
import { APP_AUTHOR } from '../version.js';
import { cashPosition } from '../services/finance.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { toast, toastError } from '../components/toast.js';
import { field, moneyInput, segmented, intInput, readInt } from '../components/fields.js';
import { openMenu } from '../components/menu.js';
import { pageHead, ACCOUNT_KINDS, ACCOUNT_ICON, accountOptions } from './common.js';
import { applyTheme, currentThemePref, applyMotion, currentMotionPref, applyDensity, currentDensity } from '../theme.js';
import { arrangedList, openArrangeDialog, setSectionOptions, flushLayout, resetAllAppearance, resetSection } from '../components/layout.js';
import { auditData } from '../services/integrity.js';
import { openEntryForm } from '../components/entry-form.js';


// Grupos podem ser reordenados, nunca ocultados: funções críticas (backup,
// restauração, diagnóstico) precisam continuar sempre acessíveis.
export const SETTINGS_GROUPS = [
  { id: 'aparencia', label: 'Aparência', icon: 'palette', locked: true },
  { id: 'personalizacao', label: 'Personalização', icon: 'sliders', locked: true },
  { id: 'financeiro', label: 'Preferências financeiras', icon: 'calc', locked: true },
  { id: 'contas', label: 'Contas e cartões', icon: 'card', locked: true },
  { id: 'classificacao', label: 'Categorias e blocos', icon: 'tag', locked: true },
  { id: 'dados', label: 'Dados e backup', icon: 'database', locked: true },
  { id: 'armazenamento', label: 'Armazenamento', icon: 'layers', locked: true },
  { id: 'integridade', label: 'Integridade dos registros', icon: 'shield', locked: true },
  { id: 'sobre', label: 'Sobre o Fluxo', icon: 'info', locked: true },
  { id: 'atalhos', label: 'Atalhos de teclado', icon: 'sparkle', locked: true },
];
const LEGACY_GROUP = { atalhos: 'atalhos' };

export function renderSettings(root, sub) {
  const order = arrangedList('settings', 'groups', SETTINGS_GROUPS);
  sub = LEGACY_GROUP[sub] || sub;
  const nav = h('nav', { class: 'settings-nav', 'aria-label': 'Grupos de configurações' },
    ...order.map(({ id, label, icon: ic }) => h('a', { href: `#/configuracoes/${id}`, dataset: { group: id }, class: sub === id ? 'is-active' : '', onclick: (ev) => { ev.preventDefault(); document.getElementById(`cfg-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); nav.querySelectorAll('a').forEach((x) => x.classList.toggle('is-active', x === ev.currentTarget)); } }, icon(ic), label)));
  const rerender = () => renderSettings(root, sub);
  const build = {
    aparencia: () => group('aparencia', 'Aparência', 'Tema, densidade e movimento.', appearance()),
    personalizacao: () => group('personalizacao', 'Personalização', 'Organização das telas. Só a aparência é afetada; dados financeiros nunca são alterados aqui.', personalization(rerender)),
    financeiro: () => group('financeiro', 'Preferências financeiras', 'Usadas nos cálculos de sobra e projeção.', planning()),
    contas: () => group('contas', 'Contas e cartões', 'Fontes de pagamento. Cartões com fechamento e vencimento calculam as faturas sozinhos.', accounts()),
    classificacao: () => group('classificacao', 'Categorias e blocos', 'Categoria é a natureza do gasto; bloco é o contexto (pessoal, casa, moto…).', namedSection('categories', 'Categorias'), namedSection('blocks', 'Blocos')),
    dados: () => group('dados', 'Dados e backup', 'Backups completos, restauração validada e lembretes.', dataPanel(), dangerPanel()),
    armazenamento: () => group('armazenamento', 'Diagnóstico de armazenamento', 'Estado do banco local neste navegador.', diagnosticsPanel()),
    integridade: () => group('integridade', 'Integridade dos registros', 'Revisão de possíveis duplicidades e inconsistências. Nada é alterado automaticamente.', integrity()),
    sobre: () => group('sobre', 'Sobre o Fluxo', null, about()),
    atalhos: () => group('atalhos', 'Atalhos de teclado', null, shortcuts()),
  };
  // Um grupo com falha mostra o erro no lugar e não impede o acesso aos demais (inclusive backup).
  const groups = order.map(({ id, label }) => { try { return build[id](); } catch (err) { console.error(err); return h('section', { class: 'panel section-error', id: `cfg-${id}`, role: 'alert' }, h('strong', null, `Não foi possível exibir “${label}”.`), h('p', { class: 'small muted' }, String(err?.message || err))); } });
  put(root, pageHead('Configurações', { sub: 'Preferências, cadastros e dados', actions: h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openArrangeDialog({ section: 'settings', key: 'groups', defs: SETTINGS_GROUPS, title: 'Ordem dos grupos', note: 'Os grupos podem ser reordenados. Nenhum pode ser ocultado, para que backup, restauração e diagnóstico continuem sempre à mão.', onDone: rerender }) }, icon('sliders', 'icon-sm'), 'Organizar') }), h('div', { class: 'settings-layout' }, nav, h('div', { class: 'stack-lg' }, ...groups)));
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
  const density = segmented({ label: 'Densidade', value: currentDensity(), options: [{ value: 'compact', label: 'Compacta' }, { value: 'default', label: 'Padrão' }, { value: 'comfortable', label: 'Confortável' }],
    onChange: (v) => { const d = applyDensity(v); setSectionOptions('global', { density: d }, { undo: false }); flushLayout(); } });
  return h('div', null,
    settingsRow('Tema', 'Sistema acompanha a preferência do sistema operacional.', seg),
    settingsRow('Densidade', 'Tamanho do texto e espaçamento. Compacta mostra mais informação; Confortável amplia a leitura.', density),
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
  // Limites dos avisos discretos (orçamentos, previsões e vencimentos próximos).
  const warnAt = segmented({ label: 'Avisar orçamento a partir de', size: 'segmented-sm', value: String(prefs.budgetWarnAt ?? 80), options: ['70', '80', '90', '100'].map((v) => ({ value: v, label: `${v}%` })),
    onChange: async (v) => { try { await repo.setPrefs({ budgetWarnAt: Number(v) }); toast('Limite de atenção salvo'); } catch (err) { toastError(err); } } });
  const dueSoon = segmented({ label: 'Antecedência dos vencimentos', size: 'segmented-sm', value: String(prefs.dueSoonDays ?? 3), options: [['0', 'No dia'], ['1', '1 dia'], ['3', '3 dias'], ['7', '7 dias']].map(([v, l]) => ({ value: v, label: l })),
    onChange: async (v) => { try { await repo.setPrefs({ dueSoonDays: Number(v) }); toast('Antecedência salva'); } catch (err) { toastError(err); } } });
  return h('div', null,
    settingsRow('Margem de segurança mensal', 'Reserva descontada do valor disponível para investir.', margin),
    settingsRow('Gastos variáveis estimados', 'Aplicados às projeções dos próximos meses (mercado, lazer, transporte…).', variable),
    settingsRow('Atenção nos orçamentos', 'Orçamentos e previsões mensais mudam para “atenção” ao atingir esse percentual. Ao passar de 100%, o excedente é mostrado.', warnAt),
    settingsRow('Vencimentos próximos', 'Quanto tempo antes um compromisso aparece em “Atenção”.', dueSoon));
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

function shortcuts() {
  const list = [['[', 'Recolher ou expandir o menu'], ['Ctrl+Enter', 'Salvar o formulário aberto'], ['N', 'Novo lançamento'], ['C', 'Calculadora (Alt+C dentro de campos)'], ['/', 'Buscar lançamentos'], ['← →', 'Mês anterior / próximo'], ['T', 'Voltar ao mês atual'], ['1–5', 'Ir para cada seção'], ['Shift+Enter', 'Salvar e criar outro'], ['Ctrl+Enter', 'Na calculadora: inserir o resultado no campo'], ['Esc', 'Fechar janelas']];
  return section(null, null, h('div', { class: 'shortcuts' }, ...list.map(([k, l]) => h('div', { class: 'shortcut' }, h('span', { class: 'keys' }, ...k.split(' ').map((x) => h('kbd', null, x))), h('span', { class: 'muted small' }, l)))));
}

const REPO_URL = 'https://github.com/filipeesantana/Fluxo';
const APP_URL = 'https://filipeesantana.github.io/Fluxo/';

function personalization(rerender) {
  const SECTIONS = [['overview', 'Visão geral', '#/visao-geral'], ['planning', 'Planejamento (abas)', '#/planejamento'], ['entries', 'Lançamentos (exibição)', '#/lancamentos'], ['investments', 'Investimentos', '#/investimentos'], ['settings', 'Configurações (ordem dos grupos)', '#/configuracoes']];
  const rows = SECTIONS.map(([id, label, href]) => settingsRow(label, null, h('div', { class: 'row' },
    h('a', { class: 'btn btn-sm', href }, 'Abrir'),
    h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: async () => {
      if (!(await confirmDialog({ title: `Restaurar ${label}?`, message: 'A organização desta seção volta ao padrão. Nenhum dado financeiro é alterado.', confirmLabel: 'Restaurar seção' }))) return;
      resetSection(id); await flushLayout(); toast('Seção restaurada'); rerender();
    } }, 'Restaurar seção'))));
  return h('div', { class: 'stack-lg' },
    h('p', { class: 'faint small' }, 'Use “Personalizar” na Visão geral e em Investimentos para mover, redimensionar, ocultar e colorir componentes. A organização fica salva no banco local e entra nos backups.'),
    h('div', null, ...rows),
    h('div', { class: 'settings-row' }, h('div', { class: 'label' }, h('strong', null, 'Restaurar toda a aparência'), h('span', null, 'Volta todas as telas, a densidade e as cores ao padrão. Lançamentos, contas, metas e backups não são tocados.')),
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        if (!(await confirmDialog({ title: 'Restaurar toda a aparência?', message: 'Layouts, ordem de abas, colunas, cores e densidade voltam ao padrão. Seus dados financeiros permanecem exatamente como estão.', confirmLabel: 'Restaurar aparência' }))) return;
        try { await resetAllAppearance(); applyDensity('default'); toast('Aparência restaurada', { tone: 'success' }); rerender(); } catch (err) { toastError(err); }
      } }, 'Restaurar toda a aparência')));
}

function about() {
  const p = (...c) => h('p', { class: 'small' }, ...c);
  const sub = (x) => h('h3', null, x);
  return h('div', { class: 'stack-lg about' },
    h('div', { class: 'about-brand' }, h('img', { src: 'assets/brand/fluxo-symbol.svg', alt: '', width: 40, height: 40 }),
      h('div', null, h('strong', null, 'Fluxo'), h('div', { class: 'faint small' }, `Versão ${APP_VERSION} · esquema de dados v${DB_VERSION}`), h('div', { class: 'faint small' }, `Desenvolvido por ${APP_AUTHOR}`))),
    section(null, null,
      sub('Para que serve'),
      p('O Fluxo é uma ferramenta gratuita de organização financeira pessoal. Ela ajuda a registrar o que entra e o que sai, entender para onde o dinheiro vai, planejar as contas dos próximos meses e ver quanto sobra para guardar ou investir.'),
      sub('Como começar'),
      p('Cadastre suas contas e cartões, registre receitas e despesas e use “Repetir” para o que se repete. A Visão geral mostra o resumo do mês; cada indicador abre a conta que levou até ele.'),
      sub('Recorrências e compromissos'),
      p('Qualquer receita ou despesa pode se repetir, seja paga por Pix, dinheiro, débito, cartão ou benefício. Há quatro jeitos de repetir por mês: num dia fixo, em vários dias, com datas flexíveis (ex.: duas consultas por mês, datas a combinar) ou como previsão mensal (ex.: até R$ 400 de combustível, consumidos pelos gastos que você registrar). Em Planejamento → Compromissos, cada mês tem sua lista: marque o que foi pago, defina datas e acompanhe o que falta.'),
      sub('Calculadora'),
      p('Calculadora comum, com porcentagens fáceis (10% de 800, 800 + 10%), ferramentas rápidas e a opção “Usar valores do Fluxo” para calcular com dados reais, como 70% da sobra do mês. Cálculos podem ser salvos como estáticos (guardam os valores do momento) ou dinâmicos (acompanham os dados). Nada é gravado nos lançamentos sem sua confirmação.'),
      sub('Personalização'),
      p('Use “Personalizar” para mover, redimensionar, ocultar e colorir componentes e escolher como cada informação aparece. O encaixe automático aproveita os espaços sem bagunçar a ordem. No celular, a organização é guardada à parte.'),
      sub('Onde ficam seus dados'),
      p('No IndexedDB deste navegador, neste dispositivo. Não há conta, servidor, sincronização nem rastreamento. O IndexedDB não é criptografado: quem tiver acesso a este perfil do navegador pode ler os dados, e limpar os dados do site pode apagá-los.'),
      sub('Backups'),
      p('O backup é um arquivo completo, com lançamentos, recorrências, cálculos salvos e personalização, conferido por uma soma SHA-256. Pode ser protegido por senha — sem a senha, não há recuperação. Guarde as cópias fora do navegador.'),
      sub('Limitações'),
      p('Sem sincronização entre aparelhos e sem conexão com bancos. Os números dependem do que foi registrado; projeções e simulações são estimativas, não garantias. Os testes automatizados rodam no Chromium; outros navegadores modernos devem funcionar, mas não foram verificados automaticamente.'),
      h('div', { class: 'row wrap' },
        h('a', { class: 'btn btn-sm', href: APP_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Endereço do aplicativo'),
        h('a', { class: 'btn btn-sm', href: REPO_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Repositório')),
      h('p', { class: 'faint xsmall' }, `Banco local “${DB_NAME}”.`)));
}
