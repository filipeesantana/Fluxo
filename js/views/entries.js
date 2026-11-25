import { h, icon, debounce, put } from '../utils/dom.js';
import { formatMoney } from '../utils/money.js';
import { formatDayHeading, today, formatMonth } from '../utils/dates.js';
import * as repo from '../database/repository.js';
import { monthItems, expenseValue, NONE } from '../services/finance.js';
import { matches } from '../services/suggest.js';
import { openEntryForm } from '../components/entry-form.js';
import { ui, emitUI, resetEntriesFilter } from '../state.js';
import { monthNav, pageHead, txRow, categoryName, blockName, accountName, emptyState, categoryOptions, blockOptions, accountOptions, capitalize } from './common.js';
import { openItem, itemMenu, toggleStatus } from './actions.js';

const PAGE = 150;
let shown = PAGE;
let lastKey = '';

function filterItems() {
  const f = ui.entries;
  const ctx = repo.context();
  let items = f.scope === 'month' ? monthItems(ctx, ui.month) : repo.list('transactions');
  const q = f.query.trim();
  const nums = q.replace(/[^\d,.]/g, '');
  items = items.filter((t) => {
    if (f.type === 'expenses' && !(t.type === 'expense' || t.type === 'refund')) return false;
    if (f.type && f.type !== 'expenses' && t.type !== f.type) return false;
    if (f.status && t.status !== f.status) return false;
    if (f.categoryId && (f.categoryId === NONE ? t.categoryId : t.categoryId !== f.categoryId)) return false;
    if (f.blockId && (f.blockId === NONE ? t.blockId : t.blockId !== f.blockId)) return false;
    if (f.sourceId && (f.sourceId === NONE ? t.sourceId : t.sourceId !== f.sourceId)) return false;
    if (q) {
      const amountMatch = nums && formatMoney(t.amount).includes(nums);
      if (!amountMatch && !matches(q, t.description, categoryName(t.categoryId), blockName(t.blockId), accountName(t.sourceId), t.note)) return false;
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
    ...[['', 'Todos os tipos'], ['expenses', 'Despesas e reembolsos'], ['expense', 'Somente despesas'], ['income', 'Receitas'], ['transfer', 'Transferências'], ['refund', 'Reembolsos']].map(([v, l]) => h('option', { value: v }, l)));
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

  const head = pageHead('Lançamentos', f.scope === 'month' ? monthNav() : h('span', { class: 'faint' }, 'Histórico completo'), h('span', { class: 'spacer' }),
    h('button', { class: 'btn btn-primary btn-new-entry', type: 'button', onclick: () => openEntryForm() }, icon('plus'), 'Novo lançamento'));

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
  if (groupKey) {
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
      list.append(h('div', { class: 'tx-day' }, h('span', null, f.groupBy === 'day' && f.scope === 'all' ? capitalize(groupLabel(k)) : capitalize(groupLabel(k))),
        h('span', { class: 'num faint' }, tt.expense ? `− ${formatMoney(tt.expense)}` : tt.income ? `+ ${formatMoney(tt.income)}` : '')));
      for (const it of rows) list.append(txRow(it, { onOpen: openItem, onMenu: itemMenu, onToggle: toggleStatus, showDate: f.groupBy !== 'day' }));
    }
  } else {
    for (const it of visible) list.append(txRow(it, { onOpen: openItem, onMenu: itemMenu, onToggle: toggleStatus, showDate: true }));
  }

  const content = items.length ? [summary, list,
    items.length > shown ? h('button', { class: 'btn btn-block load-more', type: 'button', onclick: () => { shown += PAGE * 2; emitUI('filter'); } }, `Mostrar mais (${items.length - shown} restantes)`) : null]
    : [emptyState(active.length ? 'Nada encontrado com estes filtros' : 'Nenhum lançamento', active.length ? null : f.scope === 'month' ? `Não há movimentações em ${formatMonth(ui.month)}.` : 'Registre o primeiro lançamento.',
      active.length ? h('button', { class: 'btn', type: 'button', onclick: () => { resetEntriesFilter(); emitUI('filter'); } }, 'Limpar filtros') : h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openEntryForm() }, icon('plus'), 'Novo lançamento'))];

  const hadFocus = document.activeElement?.id === 'entries-search';
  const caret = hadFocus ? document.activeElement.selectionStart : null;
  put(root, head, filters, ...content);
  if (hadFocus) { const s = document.getElementById('entries-search'); s.focus(); try { s.setSelectionRange(caret, caret); } catch { /* type=search */ } }
}
