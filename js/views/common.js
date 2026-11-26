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
export const ACCOUNT_ICON = { checking: 'wallet', savings: 'wallet', cash: 'wallet', credit: 'card', benefit: 'tag', other: 'wallet' };

export function nameOf(store, id, fallback = '—') {
  if (!id || id === NONE) return fallback;
  const row = repo.get(store, id);
  if (!row) return fallback;
  return row.archived ? `${row.name} (arquivado)` : row.name;
}
export const categoryName = (id) => nameOf('categories', id, 'Sem categoria');
export const blockName = (id) => nameOf('blocks', id, 'Sem bloco');
export const accountName = (id) => nameOf('accounts', id, 'Sem fonte');

/** Cor estável por item (mesma categoria → mesma cor em qualquer gráfico). */
export function colorOf(key) {
  if (!key || key === NONE) return 'var(--c-none)';
  let hsh = 0;
  for (let i = 0; i < key.length; i++) hsh = (hsh * 31 + key.charCodeAt(i)) >>> 0;
  return `var(--c${(hsh % 8) + 1})`;
}

export function categoryOptions(type, keep) {
  return repo.list('categories')
    .filter((c) => c.type === (type === 'income' ? 'income' : 'expense') && (!c.archived || c.id === keep))
    .sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.name.localeCompare(b.name, 'pt-BR'))
    .map((c) => ({ value: c.id, label: c.archived ? `${c.name} (arquivada)` : c.name, color: colorOf(c.id) }));
}
export function blockOptions(keep) {
  return repo.list('blocks').filter((b) => !b.archived || b.id === keep).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')).map((b) => ({ value: b.id, label: b.name, color: colorOf(b.id) }));
}
export function accountOptions({ keep, filter = () => true } = {}) {
  const groups = { checking: 'Contas', savings: 'Contas', cash: 'Contas', other: 'Contas', benefit: 'Benefícios', credit: 'Cartões' };
  const order = ['Contas', 'Cartões', 'Benefícios'];
  return repo.list('accounts')
    .filter((a) => (!a.archived || a.id === keep) && filter(a))
    .map((a) => ({ value: a.id, label: a.name, group: groups[a.kind] || 'Contas', sub: a.kind === 'credit' ? 'cartão' : a.kind === 'benefit' ? 'benefício' : '' }))
    .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.label.localeCompare(b.label, 'pt-BR'));
}

/** Ids usados recentemente em um campo (para "Recentes" nos seletores). */
export function recentIds(field, { type, limit = 4 } = {}) {
  const out = [];
  const rows = repo.list('transactions').filter((t) => t[field] && (!type || t.type === type)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  for (const t of rows) {
    if (!out.includes(t[field])) out.push(t[field]);
    if (out.length >= limit) break;
  }
  return out;
}

export async function createCategory(type, name) {
  const c = await repo.createNamed('categories', { name, type: type === 'income' ? 'income' : 'expense' });
  return { value: c.id, label: c.name, color: colorOf(c.id) };
}
export async function createBlock(name) {
  const b = await repo.createNamed('blocks', { name });
  return { value: b.id, label: b.name, color: colorOf(b.id) };
}

export function monthNav() {
  const m = ui.month;
  const cm = currentMonth();
  const diff = monthDiff(cm, m);
  const input = h('input', { type: 'month', class: 'sr-only', value: m, tabindex: '-1', 'aria-hidden': 'true', onchange: (ev) => setMonth(ev.target.value) });
  const label = h('button', { class: 'month-label', type: 'button', title: 'Escolher mês', onclick: () => { try { input.showPicker(); } catch { input.focus(); } } }, capitalize(formatMonth(m)));
  return h('div', { class: 'row wrap' },
    h('div', { class: 'month-nav', role: 'group', 'aria-label': 'Navegação mensal' },
      h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': 'Mês anterior', title: 'Mês anterior (←)', onclick: () => shiftMonth(-1) }, icon('chev-left')),
      label, input,
      h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': 'Próximo mês', title: 'Próximo mês (→)', onclick: () => shiftMonth(1) }, icon('chev-right'))),
    diff !== 0 ? h('button', { class: 'btn btn-sm', type: 'button', onclick: goToday, title: 'Voltar ao mês atual (T)' }, 'Mês atual') : null,
    diff > 0 ? h('span', { class: 'month-flag is-future' }, 'Projeção') : diff < 0 ? h('span', { class: 'month-flag' }, 'Histórico') : null,
  );
}

export function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/** Cabeçalho de página: título, subtítulo opcional, controles e ações. */
export function pageHead(title, { sub, controls, actions } = {}) {
  return h('header', { class: 'page-head' },
    h('div', { class: 'page-title' }, h('h1', null, title), sub ? h('p', null, sub) : null),
    controls || null,
    h('span', { class: 'spacer' }),
    actions ? h('div', { class: 'page-actions' }, actions) : null);
}

export function panel(title, opts, ...children) {
  const { hint, actions, cls = '', id } = opts || {};
  return h('section', { class: `panel ${cls}`.trim(), id },
    title ? h('div', { class: 'panel-head' }, h('h2', null, title), hint ? h('span', { class: 'hint' }, hint) : null, actions ? h('div', { class: 'actions' }, actions) : null) : null,
    ...children);
}

const TYPE_SIGN = { expense: -1, refund: 1, income: 1, transfer: 0 };

export function amountText(item) {
  const sign = TYPE_SIGN[item.type];
  if (sign === 0 || sign == null) return formatMoney(item.amount);
  return formatMoney(sign * item.amount, { signed: true });
}

/** Ícone e classe que identificam a natureza da movimentação. */
export function kindOf(item) {
  if (item.kind === 'invest') return { cls: 'k-invest', icon: 'trend', label: 'Aporte' };
  if (item.type === 'income') return { cls: 'k-income', icon: 'in', label: 'Receita' };
  if (item.type === 'refund') return { cls: 'k-refund', icon: 'refund', label: 'Reembolso' };
  if (item.type === 'transfer') return { cls: 'k-transfer', icon: 'swap', label: 'Transferência' };
  const acc = repo.get('accounts', item.sourceId);
  if (isCard(acc)) return { cls: 'k-card', icon: 'card', label: 'Cartão' };
  return { cls: 'k-expense', icon: 'out', label: 'Despesa' };
}

/** Linha de movimentação (sem innerHTML; texto do usuário sempre seguro). */
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
  if (item.restricted) tags.push(h('span', { class: 'tag' }, 'Benefício'));
  if (isCard(acc) && (item.type === 'expense' || item.type === 'refund') && item.month !== item.date.slice(0, 7)) {
    tags.push(h('span', { class: 'tag', title: dueDateOf(item.month, acc) ? `Vence em ${formatDateShort(dueDateOf(item.month, acc))}` : 'Competência ajustada' }, `fatura ${formatMonthShort(item.month)}`));
  }
  const planned = item.status === 'planned';
  const overdue = planned && item.date < today() && item.type !== 'income';
  const k = kindOf(item);
  const toggle = onToggle ? h('button', {
    class: `status-btn${planned ? '' : ' is-done'}${overdue ? ' is-overdue' : ''}`, type: 'button',
    'aria-label': planned ? `Marcar “${item.description}” como ${item.type === 'income' ? 'recebido' : 'pago'}` : 'Voltar para previsto',
    title: planned ? (overdue ? 'Atrasado · marcar como realizado' : 'Previsto · marcar como realizado') : 'Realizado · voltar para previsto',
    onclick: (ev) => { ev.stopPropagation(); onToggle(item); },
  }, icon('check', 'icon-sm')) : h('span', { class: 'status-spacer' });

  return h('div', { class: `tx-row${planned ? ' is-planned' : ''}${item.virtual ? ' is-virtual' : ''}`, role: 'listitem', dataset: { id: item.id } },
    toggle,
    h('button', { class: `tx-main${showDate ? ' has-date' : ''}`, type: 'button', onclick: () => onOpen?.(item), 'aria-label': `${k.label}: ${item.description}, ${amountText(item)}` },
      h('span', { class: `tx-kind ${planned ? 'k-planned' : k.cls}`, title: planned ? `${k.label} prevista` : k.label }, icon(planned ? 'clock' : k.icon)),
      showDate ? h('span', { class: 'tx-date num' }, formatDateShort(item.date)) : null,
      h('span', { class: 'tx-text' },
        h('span', { class: 'tx-desc' }, h('span', { class: 'truncate' }, item.description || '—'), ...tags),
        h('span', { class: 'tx-meta truncate' }, meta.join(' · '), planned ? h('span', { class: overdue ? 'warn' : '' }, overdue ? ' · atrasado' : ' · previsto') : null),
      ),
      h('span', { class: `tx-amount num ${item.type === 'income' ? 'is-income' : item.type === 'refund' ? 'is-refund' : item.type === 'transfer' ? 'is-neutral' : ''}` }, amountText(item)),
    ),
    onMenu ? h('button', { class: 'btn btn-ghost btn-icon btn-sm tx-more', type: 'button', 'aria-label': `Ações de ${item.description}`, 'aria-haspopup': 'menu', onclick: (ev) => { ev.stopPropagation(); onMenu(item, ev.currentTarget); } }, icon('more')) : null,
  );
}

/** Linha de aporte/resgate (evento de investimento) para listas mensais. */
export function investRow(ev) {
  const inv = repo.get('investments', ev.investmentId);
  const contribution = ev.type === 'contribution';
  return h('div', { class: 'tx-row', role: 'listitem' },
    h('span', { class: 'status-spacer' }),
    h('a', { class: 'tx-main', href: '#/investimentos' },
      h('span', { class: 'tx-kind k-invest' }, icon('trend')),
      h('span', { class: 'tx-text' },
        h('span', { class: 'tx-desc' }, h('span', { class: 'truncate' }, `${contribution ? 'Aporte' : 'Resgate'} · ${inv?.name || 'Investimento'}`), h('span', { class: 'tag tag-invest' }, contribution ? 'aporte' : 'resgate')),
        h('span', { class: 'tx-meta truncate' }, ev.accountId ? accountName(ev.accountId) : 'não movimentou conta', ' · não é despesa de consumo')),
      h('span', { class: 'tx-amount num is-invest' }, `${contribution ? '' : '+'}${formatMoney(ev.amount)}`)),
    h('span'));
}

export function emptyState(title, text, action) {
  return h('div', { class: 'empty' }, h('p', { class: 'empty-title' }, title), text ? h('p', { class: 'muted small' }, text) : null, action || null);
}

export function kv(label, value, { cls = '', hint } = {}) {
  return h('div', { class: `kv ${cls}` }, h('span', { class: 'kv-label' }, label, hint ? h('span', { class: 'faint' }, ` · ${hint}`) : null), h('span', { class: 'kv-value num' }, value));
}

export { formatMonth };
