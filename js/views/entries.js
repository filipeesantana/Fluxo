import { h, icon, debounce, put } from '../utils/dom.js';
import { formatMoney } from '../utils/money.js';
import { formatDayHeading, today, formatMonth, formatDateShort } from '../utils/dates.js';
import * as repo from '../database/repository.js';
import { monthItems, expenseValue, NONE } from '../services/finance.js';
import { fold } from '../services/suggest.js';
import { openEntryForm } from '../components/entry-form.js';
import { ui, emitUI, resetEntriesFilter } from '../state.js';
import { monthNav, pageHead, panel, investRow, txRow, categoryName, blockName, accountName, emptyState, categoryOptions, blockOptions, accountOptions, capitalize, amountText, kindOf } from './common.js';
import { openItem, itemMenu, toggleStatus } from './actions.js';
import { getSectionOptions, setSectionOptions, arrangedList, openArrangeDialog, flushLayout } from '../components/layout.js';
import { openModal } from '../components/modal.js';
import { segmented } from '../components/fields.js';

// Colunas da visualização em tabela. Descrição e valor não podem ser ocultados.
export const ENTRY_COLUMNS = [
  { id: 'date', label: 'Data' },
  { id: 'description', label: 'Descrição', locked: true },
  { id: 'category', label: 'Categoria' },
  { id: 'block', label: 'Bloco' },
  { id: 'source', label: 'Fonte' },
  { id: 'status', label: 'Situação' },
  { id: 'amount', label: 'Valor', locked: true },
];
const FIELD_LABELS = { category: 'Categoria', block: 'Bloco', source: 'Fonte' };

/** Preferências de exibição normalizadas (valores inválidos voltam ao padrão). */
export function entryViewOptions() {
  const o = getSectionOptions('entries');
  const fields = {};
  for (const k of Object.keys(FIELD_LABELS)) fields[k] = !(o.fields && o.fields[k] === false);
  return { view: o.view === 'table' ? 'table' : 'list', fields, columns: arrangedList('entries', 'columns', ENTRY_COLUMNS).filter((c) => !c.hidden) };
}

function openViewOptions(rerender) {
  const o = entryViewOptions();
  const seg = segmented({ label: 'Visualização', value: o.view, options: [{ value: 'list', label: 'Lista' }, { value: 'table', label: 'Tabela' }], onChange: (v) => { setSectionOptions('entries', { view: v }); rerender(); } });
  const checks = Object.entries(FIELD_LABELS).map(([k, l]) => {
    const cb = h('input', { type: 'checkbox', checked: o.fields[k] });
    cb.addEventListener('change', () => { setSectionOptions('entries', { fields: { ...entryViewOptions().fields, [k]: cb.checked } }); rerender(); });
    return h('label', { class: 'row arrange-row' }, cb, h('span', null, l));
  });
  const m = openModal({ title: 'Exibição dos lançamentos', size: 'sm', body: h('div', { class: 'stack-lg' },
    h('div', { class: 'stack' }, h('strong', { class: 'small' }, 'Visualização'), seg),
    h('div', { class: 'stack' }, h('strong', { class: 'small' }, 'Informações na lista'), ...checks),
    h('div', { class: 'stack' }, h('strong', { class: 'small' }, 'Colunas da tabela'), h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { m.close(); openArrangeDialog({ section: 'entries', key: 'columns', defs: ENTRY_COLUMNS, title: 'Colunas da tabela', note: 'Descrição e valor ficam sempre visíveis.', onDone: rerender }); } }, 'Organizar colunas…')),
    h('p', { class: 'faint small' }, 'Filtros e ordenação valem nas duas visualizações; o agrupamento aparece na lista. Só a aparência muda.')),
  footer: [h('span', { class: 'grow' }), h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { flushLayout(); m.close(); } }, 'Concluir')] });
}

const CELL = {
  date: (it) => h('td', { class: 'num nowrap' }, formatDateShort(it.date)),
  description: (it) => h('td', null, h('span', { class: 'td-desc' }, h('span', { class: 'truncate' }, it.description || '—'), it.installment ? h('span', { class: 'tag' }, `${it.installment.index}/${it.installment.count}`) : null, it.recurrenceId ? h('span', { class: 'tag tag-icon', title: 'Recorrente' }, icon('repeat', 'icon-sm')) : null)),
  category: (it) => h('td', { class: 'faint' }, it.type === 'transfer' ? '—' : categoryName(it.categoryId)),
  block: (it) => h('td', { class: 'faint' }, it.blockId ? blockName(it.blockId) : '—'),
  source: (it) => h('td', { class: 'faint' }, it.type === 'transfer' ? `${accountName(it.sourceId)} → ${accountName(it.toAccountId)}` : accountName(it.sourceId)),
  status: (it) => h('td', null, h('span', { class: `pill ${it.status === 'done' ? 'pill-done' : it.date < today() && it.type !== 'income' ? 'pill-overdue' : 'pill-planned'}` }, it.status === 'done' ? (it.type === 'income' ? 'Recebido' : 'Realizado') : it.date < today() && it.type !== 'income' ? 'Atrasado' : 'Previsto')),
  amount: (it) => h('td', { class: `right num strong ${it.type === 'income' ? 'pos' : ''}` }, amountText(it)),
};

function entriesTable(rows, columns) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table entries-table' },
    h('thead', null, h('tr', null, ...columns.map((c) => h('th', { class: c.id === 'amount' ? 'right' : '', scope: 'col' }, c.label)))),
    h('tbody', null, ...rows.map((it) => h('tr', { class: `is-link${it.status === 'planned' ? ' is-planned' : ''}`, tabindex: '0', 'aria-label': `${kindOf(it).label}: ${it.description}, ${amountText(it)}`, onclick: () => openItem(it), onkeydown: (e) => { if (e.key === 'Enter') openItem(it); } },
      ...columns.map((c) => CELL[c.id](it)))))));
}

const PAGE = 150;
let shown = PAGE;
let lastKey = '';
// Índice de busca: texto normalizado por movimentação, refeito quando os dados mudam.
let searchCtx = null;
let searchCache = new WeakMap();
function searchText(t, ctx) {
  if (searchCtx !== ctx) { searchCtx = ctx; searchCache = new WeakMap(); }
  let v = searchCache.get(t);
  if (v === undefined) {
    v = fold([t.description, categoryName(t.categoryId), blockName(t.blockId), accountName(t.sourceId), t.note || ''].join(' | '));
    searchCache.set(t, v);
  }
  return v;
}

function filterItems() {
  const f = ui.entries;
  const ctx = repo.context();
  let items = f.scope === 'month' ? monthItems(ctx, ui.month) : repo.list('transactions');
  const q = fold(f.query.trim());
  const nums = f.query.replace(/[^\d,.]/g, '');
  if (f.type === 'invest') return [];
  items = items.filter((t) => {
    if (f.type === 'expenses' && !(t.type === 'expense' || t.type === 'refund')) return false;
    if (f.type && f.type !== 'expenses' && t.type !== f.type) return false;
    if (f.status && t.status !== f.status) return false;
    if (f.categoryId && (f.categoryId === NONE ? t.categoryId : t.categoryId !== f.categoryId)) return false;
    if (f.blockId && (f.blockId === NONE ? t.blockId : t.blockId !== f.blockId)) return false;
    if (f.sourceId && (f.sourceId === NONE ? t.sourceId : t.sourceId !== f.sourceId)) return false;
    if (q) {
      const amountMatch = nums && formatMoney(t.amount).includes(nums);
      if (!amountMatch && !searchText(t, ctx).includes(q)) return false;
    }
    return true;
  });
  const cmp = {
    date: (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0)),
    amount: (a, b) => b.amount - a.amount,
    description: (a, b) => a.description.localeCompare(b.description, 'pt-BR'),
  }[f.sort] || ((a, b) => 0);
  return items.sort(cmp);
}

function totals(items) {
  let income = 0, expense = 0;
  for (const t of items) { if (t.type === 'income') income += t.amount; expense += expenseValue(t); }
  return { income, expense };
}

function selectFilter(label, key, options, emptyLabel) {
  const sel = h('select', { class: 'select select-sm', 'aria-label': label },
    h('option', { value: '' }, emptyLabel), h('option', { value: NONE }, `${label}: não definido`),
    ...options.map((o) => h('option', { value: o.value }, o.label)));
  sel.value = ui.entries[key] || '';
  if (sel.value !== (ui.entries[key] || '')) sel.value = '';
  sel.addEventListener('change', () => { ui.entries[key] = sel.value; shown = PAGE; emitUI('filter'); });
  return sel;
}

export function renderEntries(root) {
  const f = ui.entries;
  const key = JSON.stringify({ ...f, m: ui.month });
  if (key !== lastKey) { shown = PAGE; lastKey = key; }
  const items = filterItems();
  const t = totals(items);

  const search = h('input', { class: 'input search-input', type: 'search', placeholder: 'Buscar por descrição, categoria, bloco, fonte ou valor', value: f.query, id: 'entries-search', 'aria-label': 'Buscar lançamentos' });
  search.addEventListener('input', debounce(() => { f.query = search.value; shown = PAGE; emitUI('filter'); }, 90));

  const scope = h('div', { class: 'segmented segmented-sm', role: 'radiogroup', 'aria-label': 'Período' },
    ...[['month', 'Mês selecionado'], ['all', 'Todos os meses']].map(([v, l]) => h('button', { type: 'button', role: 'radio', class: 'seg', 'aria-checked': String(f.scope === v), onclick: () => { f.scope = v; emitUI('filter'); } }, l)));

  const type = h('select', { class: 'select select-sm', 'aria-label': 'Tipo' },
    ...[['', 'Todos os tipos'], ['expenses', 'Despesas e reembolsos'], ['expense', 'Somente despesas'], ['income', 'Receitas'], ['transfer', 'Transferências'], ['refund', 'Reembolsos'], ['invest', 'Aportes e resgates']].map(([v, l]) => h('option', { value: v }, l)));
  type.value = f.type;
  type.addEventListener('change', () => { f.type = type.value; emitUI('filter'); });
  const status = h('select', { class: 'select select-sm', 'aria-label': 'Situação' }, h('option', { value: '' }, 'Toda situação'), h('option', { value: 'done' }, 'Realizados'), h('option', { value: 'planned' }, 'Previstos'));
  status.value = f.status;
  status.addEventListener('change', () => { f.status = status.value; emitUI('filter'); });
  const group = h('select', { class: 'select select-sm', 'aria-label': 'Agrupar por' }, ...[['day', 'Agrupar por dia'], ['category', 'Por categoria'], ['block', 'Por bloco'], ['source', 'Por fonte'], ['none', 'Sem agrupamento']].map(([v, l]) => h('option', { value: v }, l)));
  group.value = f.groupBy;
  group.addEventListener('change', () => { f.groupBy = group.value; emitUI('filter'); });
  const sort = h('select', { class: 'select select-sm', 'aria-label': 'Ordenar' }, ...[['date', 'Mais recentes'], ['amount', 'Maior valor'], ['description', 'Descrição A–Z']].map(([v, l]) => h('option', { value: v }, l)));
  sort.value = f.sort;
  sort.addEventListener('change', () => { f.sort = sort.value; emitUI('filter'); });

  const active = ['type', 'status', 'categoryId', 'blockId', 'sourceId', 'query'].filter((k) => f[k]);
  const filters = h('div', { class: 'filters' },
    h('div', { class: 'search-wrap' }, icon('search', 'icon-sm'), search),
    h('div', { class: 'filter-row' },
      f.scope === 'month' ? null : null, scope, type, status,
      selectFilter('Categoria', 'categoryId', categoryOptions('expense').concat(categoryOptions('income')), 'Toda categoria'),
      selectFilter('Bloco', 'blockId', blockOptions(), 'Todo bloco'),
      selectFilter('Fonte', 'sourceId', accountOptions(), 'Toda fonte'),
      group, sort,
      active.length ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { resetEntriesFilter(); emitUI('filter'); } }, icon('x', 'icon-sm'), 'Limpar filtros') : null),
  );

  const vo = entryViewOptions();
  const rerender = () => renderEntries(root);
  const head = pageHead('Lançamentos', { sub: f.scope === 'month' ? 'Movimentações do mês selecionado' : 'Histórico completo de todos os meses', controls: f.scope === 'month' ? monthNav() : null,
    actions: h('button', { class: 'btn btn-sm', type: 'button', title: 'Lista ou tabela, informações e colunas', onclick: () => openViewOptions(rerender) }, icon('sliders', 'icon-sm'), 'Exibição') });

  const summary = h('div', { class: 'list-summary small' },
    h('span', null, `${items.length} ${items.length === 1 ? 'lançamento' : 'lançamentos'}`),
    t.income ? h('span', { class: 'pos num' }, `Receitas ${formatMoney(t.income)}`) : null,
    t.expense ? h('span', { class: 'num' }, `Despesas ${formatMoney(t.expense)}`) : null);

  const list = h('div', { class: 'tx-list', role: 'list' });
  const visible = items.slice(0, shown);
  const groupKey = {
    day: (it) => it.date,
    category: (it) => it.categoryId || NONE,
    block: (it) => it.blockId || NONE,
    source: (it) => it.sourceId || NONE,
  }[f.groupBy];
  const groupLabel = {
    day: (k) => formatDayHeading(k, today()),
    category: (k) => categoryName(k === NONE ? null : k),
    block: (k) => blockName(k === NONE ? null : k),
    source: (k) => accountName(k === NONE ? null : k),
  }[f.groupBy];
  if (vo.view === 'table') {
    list.className = '';
    list.removeAttribute('role');
    list.append(entriesTable(visible, vo.columns));
  } else if (groupKey) {
    const groups = new Map();
    for (const it of visible) {
      const k = groupKey(it);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    let entries = [...groups.entries()];
    if (f.groupBy !== 'day') entries.sort((a, b) => totals(b[1]).expense - totals(a[1]).expense);
    for (const [k, rows] of entries) {
      const tt = totals(rows);
      const parts = [];
      if (tt.income) parts.push(`+ ${formatMoney(tt.income)}`);
      if (tt.expense) parts.push(`− ${formatMoney(tt.expense)}`);
      list.append(h('div', { class: 'tx-day' }, h('span', null, capitalize(groupLabel(k))),
        parts.length ? h('span', { class: 'tx-day-total', title: f.groupBy === 'day' ? 'Total do dia' : 'Total do grupo' }, parts.join('  ·  ')) : null));
      for (const it of rows) list.append(txRow(it, { onOpen: openItem, onMenu: itemMenu, onToggle: toggleStatus, showDate: f.groupBy !== 'day', fields: vo.fields }));
    }
  } else {
    for (const it of visible) list.append(txRow(it, { onOpen: openItem, onMenu: itemMenu, onToggle: toggleStatus, showDate: true, fields: vo.fields }));
  }

  if (f.type === 'invest') {
    const evs = repo.list('investmentEvents').filter((e) => e.type !== 'balance' && (f.scope === 'all' || e.date.slice(0, 7) === ui.month)).sort((a, b) => (a.date < b.date ? 1 : -1));
    put(root, head, filters, h('section', { class: 'panel' }, evs.length ? h('div', { class: 'tx-list', role: 'list' }, ...evs.map((e) => investRow(e)))
      : emptyState('Nenhum aporte ou resgate', 'Aportes são registrados em Investimentos e não contam como despesa de consumo.', h('a', { class: 'btn', href: '#/investimentos' }, 'Ir para Investimentos'))));
    return;
  }
  const content = items.length ? [summary, list,
    items.length > shown ? h('button', { class: 'btn btn-block load-more', type: 'button', onclick: () => { shown += PAGE * 2; emitUI('filter'); } }, `Mostrar mais (${items.length - shown} restantes)`) : null]
    : [emptyState(active.length ? 'Nada encontrado com estes filtros' : 'Nenhum lançamento', active.length ? null : f.scope === 'month' ? `Não há movimentações em ${formatMonth(ui.month)}.` : 'Registre o primeiro lançamento.',
      active.length ? h('button', { class: 'btn', type: 'button', onclick: () => { resetEntriesFilter(); emitUI('filter'); } }, 'Limpar filtros') : h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openEntryForm() }, icon('plus'), 'Novo lançamento'))];

  const hadFocus = document.activeElement?.id === 'entries-search';
  const caret = hadFocus ? document.activeElement.selectionStart : null;
  const loadingNote = f.scope === 'all' && !repo.isFullyLoaded() ? h('p', { class: 'note' }, icon('clock', 'icon-sm'), 'Carregando o histórico completo…') : null;
  put(root, head, filters, h('section', { class: 'panel' }, loadingNote, ...content));
  if (hadFocus) { const s = document.getElementById('entries-search'); s.focus(); try { s.setSelectionRange(caret, caret); } catch { /* type=search */ } }
}
