import { h, icon } from '../utils/dom.js';
import { formatMoney } from '../utils/money.js';
import { formatMonth, formatDateShort, currentMonth, monthDiff, formatMonthShort, today } from '../utils/dates.js';
import * as repo from '../database/repository.js';
import { NONE } from '../services/finance.js';
import { isCard, dueDateOf } from '../services/cards.js';
import { ui, shiftMonth, goToday, setMonth } from '../state.js';

export const ACCOUNT_KINDS = {
  checking: 'Conta corrente', savings: 'Poupança', cash: 'Dinheiro', credit: 'Cartão de crédito', benefit: 'Benefício (VA/VR)', other: 'Outra',
};

export function nameOf(store, id, fallback = '—') {
  if (!id || id === NONE) return fallback;
  const row = repo.get(store, id);
  if (!row) return fallback;
  return row.archived ? `${row.name} (arquivado)` : row.name;
}
export const categoryName = (id) => nameOf('categories', id, 'Sem categoria');
export const blockName = (id) => nameOf('blocks', id, 'Sem bloco');
export const accountName = (id) => nameOf('accounts', id, 'Sem fonte');

export function categoryOptions(type, keep) {
  return repo.list('categories')
    .filter((c) => c.type === (type === 'income' ? 'income' : 'expense') && (!c.archived || c.id === keep))
    .sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.name.localeCompare(b.name, 'pt-BR'))
    .map((c) => ({ value: c.id, label: c.archived ? `${c.name} (arquivada)` : c.name }));
}
export function blockOptions(keep) {
  return repo.list('blocks').filter((b) => !b.archived || b.id === keep).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')).map((b) => ({ value: b.id, label: b.name }));
}
export function accountOptions({ keep, filter = () => true } = {}) {
  const groups = { checking: 'Contas', savings: 'Contas', cash: 'Contas', other: 'Contas', benefit: 'Benefícios', credit: 'Cartões' };
  const order = ['Contas', 'Cartões', 'Benefícios'];
  return repo.list('accounts')
    .filter((a) => (!a.archived || a.id === keep) && filter(a))
    .map((a) => ({ value: a.id, label: a.name, group: groups[a.kind] || 'Contas' }))
    .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.label.localeCompare(b.label, 'pt-BR'));
}

export async function createCategory(type, name) {
  const c = await repo.createNamed('categories', { name, type: type === 'income' ? 'income' : 'expense' });
  return { value: c.id, label: c.name };
}
export async function createBlock(name) {
  const b = await repo.createNamed('blocks', { name });
  return { value: b.id, label: b.name };
}

export function monthNav() {
  const m = ui.month;
  const cm = currentMonth();
  const diff = monthDiff(cm, m);
  const input = h('input', { type: 'month', class: 'sr-only', value: m, tabindex: '-1', 'aria-hidden': 'true', onchange: (ev) => setMonth(ev.target.value) });
  const label = h('button', { class: 'month-label', type: 'button', title: 'Escolher mês', onclick: () => { try { input.showPicker(); } catch { input.focus(); } } }, capitalize(formatMonth(m)));
  return h('div', { class: 'month-nav', role: 'group', 'aria-label': 'Navegação mensal' },
    h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': 'Mês anterior', title: 'Mês anterior (←)', onclick: () => shiftMonth(-1) }, icon('chev-left')),
    label, input,
    h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': 'Próximo mês', title: 'Próximo mês (→)', onclick: () => shiftMonth(1) }, icon('chev-right')),
    diff !== 0 ? h('button', { class: 'btn btn-sm', type: 'button', onclick: goToday, title: 'Voltar ao mês atual (T)' }, 'Mês atual') : null,
    diff > 0 ? h('span', { class: 'month-flag is-future' }, 'Projeção') : diff < 0 ? h('span', { class: 'month-flag' }, 'Histórico') : null,
  );
}

export function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

export function pageHead(title, ...extra) {
  return h('header', { class: 'page-head' }, h('h1', null, title), ...extra);
}

const TYPE_SIGN = { expense: -1, refund: 1, income: 1, transfer: 0 };

export function amountText(item) {
  const sign = TYPE_SIGN[item.type];
  if (sign === 0) return formatMoney(item.amount);
  return formatMoney(sign * item.amount, { signed: true });
}

/** Linha da lista de movimentações (sem innerHTML; texto do usuário sempre seguro). */
export function txRow(item, { onOpen, onMenu, onToggle, showDate = false } = {}) {
  const acc = repo.get('accounts', item.sourceId);
  const meta = [];
  if (item.type === 'transfer') {
    meta.push(`${accountName(item.sourceId)} → ${accountName(item.toAccountId)}`);
    const to = repo.get('accounts', item.toAccountId);
    if (isCard(to) && item.billMonth) meta.push(`fatura ${formatMonthShort(item.billMonth)}`);
  } else {
    meta.push(item.categoryId ? categoryName(item.categoryId) : item.type === 'income' ? 'Receita' : 'Sem categoria');
    if (item.blockId) meta.push(blockName(item.blockId));
    if (item.sourceId) meta.push(accountName(item.sourceId));
  }
  const tags = [];
  if (item.installment) tags.push(h('span', { class: 'tag' }, `${item.installment.index}/${item.installment.count}`));
  if (item.recurrenceId) tags.push(h('span', { class: 'tag tag-icon', title: 'Recorrente' }, icon('repeat', 'icon-sm')));
  if (item.type === 'refund') tags.push(h('span', { class: 'tag' }, 'Reembolso'));
  if (item.restricted) tags.push(h('span', { class: 'tag' }, 'Benefício'));
  if (isCard(acc) && (item.type === 'expense' || item.type === 'refund') && item.month !== item.date.slice(0, 7)) {
    tags.push(h('span', { class: 'tag', title: dueDateOf(item.month, acc) ? `Vence em ${formatDateShort(dueDateOf(item.month, acc))}` : 'Competência ajustada' }, `fatura ${formatMonthShort(item.month)}`));
  }
  const planned = item.status === 'planned';
  const overdue = planned && item.date < today() && item.type !== 'income';
  const toggle = onToggle ? h('button', {
    class: `status-btn${planned ? '' : ' is-done'}${overdue ? ' is-overdue' : ''}`, type: 'button',
    'aria-label': planned ? 'Marcar como realizado' : 'Marcar como previsto',
    title: planned ? (overdue ? 'Atrasado · marcar como realizado' : 'Previsto · marcar como realizado') : 'Realizado · voltar para previsto',
    onclick: (ev) => { ev.stopPropagation(); onToggle(item); },
  }, icon('check', 'icon-sm')) : h('span', { class: 'status-spacer' });

  const row = h('div', { class: `tx-row${planned ? ' is-planned' : ''}${item.virtual ? ' is-virtual' : ''}`, role: 'listitem', dataset: { id: item.id } },
    toggle,
    h('button', { class: 'tx-main', type: 'button', onclick: () => onOpen?.(item) },
      showDate ? h('span', { class: 'tx-date num faint' }, formatDateShort(item.date)) : null,
      h('span', { class: 'tx-text' },
        h('span', { class: 'tx-desc truncate' }, item.description || '—', ...tags),
        h('span', { class: 'tx-meta truncate' }, meta.join(' · '), planned ? h('span', { class: overdue ? 'warn' : 'faint' }, overdue ? ' · atrasado' : ' · previsto') : null),
      ),
      h('span', { class: `tx-amount num ${item.type === 'income' ? 'pos' : item.type === 'refund' ? 'pos-soft' : item.type === 'transfer' ? 'faint' : ''}` }, amountText(item)),
    ),
    onMenu ? h('button', { class: 'btn btn-ghost btn-icon btn-sm tx-more', type: 'button', 'aria-label': 'Ações', 'aria-haspopup': 'menu', onclick: (ev) => { ev.stopPropagation(); onMenu(item, ev.currentTarget); } }, icon('more')) : null,
  );
  return row;
}

export function emptyState(title, text, action) {
  return h('div', { class: 'empty' }, h('p', { class: 'empty-title' }, title), text ? h('p', { class: 'muted small' }, text) : null, action || null);
}

export function kv(label, value, { cls = '', hint } = {}) {
  return h('div', { class: `kv ${cls}` }, h('span', { class: 'kv-label' }, label, hint ? h('span', { class: 'faint' }, ` ${hint}`) : null), h('span', { class: 'kv-value num' }, value));
}
