import { h, icon, put } from '../utils/dom.js';
import { formatMoney, formatCompact } from '../utils/money.js';
import { today, parseISO, toISO, weekday, formatDayHeading, monthOf, firstDay, addDays } from '../utils/dates.js';
import * as repo from '../database/repository.js';
import { calendarMonth } from '../services/calendar.js';
import { openEntryForm } from '../components/entry-form.js';
import { ui } from '../state.js';
import { panel, txRow, investRow, accountName, capitalize } from './common.js';
import { openItem, itemMenu, toggleStatus } from './actions.js';

const WD = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
let selected = null;

const statusCls = (ev) => (ev.status === 'overdue' ? 'is-overdue' : ev.status === 'planned' ? 'is-planned' : '');

function dayCell(dd, date, isToday, isSel, onPick) {
  const d = parseISO(date).d;
  const events = dd?.events || [];
  const dots = events.slice(0, 6).map((ev) => h('i', { class: `cal-dot k-${ev.kind} ${statusCls(ev)}` }));
  const lines = [];
  if (dd?.in || dd?.inPlanned) lines.push(h('span', { class: 'in' }, `+${formatCompact(dd.in + dd.inPlanned)}`));
  if (dd?.out) lines.push(h('span', { class: 'out' }, `−${formatCompact(dd.out)}`));
  if (dd?.outPlanned) lines.push(h('span', { class: 'plan' }, `${formatCompact(dd.outPlanned)} prev.`));
  const label = [`${d}`, events.length ? `${events.length} evento${events.length > 1 ? 's' : ''}` : 'sem eventos', dd?.overdue ? 'com atraso' : null].filter(Boolean).join(', ');
  return h('button', {
    class: `cal-day${isToday ? ' is-today' : ''}${isSel ? ' is-selected' : ''}${dd?.overdue ? ' has-overdue' : ''}`,
    type: 'button', dataset: { date }, 'aria-label': label, 'aria-pressed': String(isSel), onclick: () => onPick(date),
  }, h('span', { class: 'cal-num' }, String(d)), dots.length ? h('span', { class: 'cal-dots', 'aria-hidden': 'true' }, ...dots) : null,
  events.length > 6 ? h('span', { class: 'cal-more' }, `+${events.length - 6}`) : null,
  lines.length ? h('span', { class: 'cal-amounts' }, ...lines) : null);
}

function billRow(ev) {
  const card = repo.get('accounts', ev.cardId);
  const label = { done: 'paga', overdue: 'vencida', planned: ev.paid > 0 ? 'parcial' : 'aberta' }[ev.status];
  return h('div', { class: 'tx-row', role: 'listitem' },
    h('span', { class: 'status-spacer' }),
    h('div', { class: 'tx-main' },
      h('span', { class: `tx-kind ${ev.status === 'done' ? 'k-transfer' : 'k-planned'}` }, icon('card')),
      h('span', { class: 'tx-text' }, h('span', { class: 'tx-desc' }, h('span', { class: 'truncate' }, `Fatura ${card?.name || ''}`), h('span', { class: `pill pill-${ev.status === 'done' ? 'paid' : ev.status === 'overdue' ? 'overdue' : 'open'}` }, label)),
        h('span', { class: 'tx-meta' }, ev.open > 0 ? `${formatMoney(ev.open)} em aberto` : 'quitada')),
      h('span', { class: 'tx-amount num' }, formatMoney(ev.amount))),
    ev.open > 0 ? h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': 'Pagar fatura', title: 'Pagar fatura', onclick: () => openEntryForm({ defaults: { type: 'transfer', toAccountId: ev.cardId, billMonth: monthOf(ev.date), amount: ev.open, date: today(), status: 'done', sourceId: card?.payAccountId || null } }) }, icon('check')) : h('span'));
}

function dayPanel(cal, date) {
  const dd = cal.days.get(date);
  const events = dd?.events || [];
  const groups = [
    ['Atrasados', events.filter((e) => e.status === 'overdue' && e.kind !== 'bill')],
    ['Faturas', events.filter((e) => e.kind === 'bill')],
    ['Previstos', events.filter((e) => e.status === 'planned' && e.kind !== 'bill')],
    ['Realizados', events.filter((e) => e.status === 'done' && !['bill', 'card', 'invest'].includes(e.kind))],
    ['No cartão · entram na fatura', events.filter((e) => e.kind === 'card' && e.status === 'done')],
    ['Aportes e resgates', events.filter((e) => e.kind === 'invest')],
  ].filter(([, list]) => list.length);
  const body = [
    h('div', { class: 'day-totals' },
      h('div', { class: 'cal-stat' }, h('b', { class: 'pos' }, formatMoney((dd?.in || 0) + (dd?.inPlanned || 0))), h('span', null, dd?.inPlanned ? `entradas · ${formatMoney(dd.inPlanned)} previstas` : 'entradas')),
      h('div', { class: 'cal-stat' }, h('b', null, formatMoney((dd?.out || 0) + (dd?.outPlanned || 0))), h('span', null, dd?.outPlanned ? `saídas · ${formatMoney(dd.outPlanned)} previstas` : 'saídas'))),
  ];
  for (const [title, list] of groups) {
    body.push(h('div', { class: 'day-group-title' }, title));
    body.push(h('div', { class: 'tx-list', role: 'list' }, ...list.map((ev) => ev.kind === 'bill' ? billRow(ev) : ev.kind === 'invest' ? investRow(ev.event) : txRow(ev.item, { onOpen: openItem, onMenu: itemMenu, onToggle: toggleStatus }))));
  }
  if (!groups.length) body.push(h('div', { class: 'empty-block' }, 'Nenhum evento financeiro neste dia.'));
  return panel(capitalize(formatDayHeading(date, today())), {
    cls: 'day-panel', id: 'day-panel',
    actions: h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => openEntryForm({ defaults: { date } }) }, icon('plus', 'icon-sm'), 'Lançar neste dia'),
  }, ...body);
}

export function renderCalendar(container) {
  const ctx = repo.context();
  const m = ui.month;
  const cal = calendarMonth(ctx, m);
  const t = today();
  if (!selected || monthOf(selected) !== m) selected = monthOf(t) === m ? t : ([...cal.days.keys()].sort()[0] || firstDay(m));
  const [y, mm] = m.split('-').map(Number);
  const lead = weekday(firstDay(m));
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(h('span', { class: 'cal-day is-out', 'aria-hidden': 'true' }));
  const grid = h('div', { class: 'cal-grid', role: 'grid', 'aria-label': 'Calendário do mês' }, ...WD.map((w) => h('span', { class: 'cal-wd', role: 'columnheader' }, w)));
  const pick = (date) => {
    selected = date;
    grid.querySelectorAll('.cal-day[data-date]').forEach((b) => { const on = b.dataset.date === date; b.classList.toggle('is-selected', on); b.setAttribute('aria-pressed', String(on)); });
    const fresh = dayPanel(cal, date);
    document.getElementById('day-panel')?.replaceWith(fresh);
    if (window.innerWidth <= 1240) fresh.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  for (let d = 1; d <= cal.dayCount; d++) {
    const date = toISO(y, mm, d);
    cells.push(dayCell(cal.days.get(date), date, date === t, date === selected, pick));
  }
  grid.append(...cells);
  grid.addEventListener('keydown', (ev) => {
    const cur = ev.target.closest?.('.cal-day[data-date]');
    if (!cur) return;
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[ev.key];
    if (!delta) return;
    ev.preventDefault(); ev.stopPropagation();
    const next = grid.querySelector(`[data-date="${addDays(cur.dataset.date, delta)}"]`);
    if (next) { next.focus(); pick(next.dataset.date); }
  });
  const tt = cal.totals;
  const balance = tt.in + tt.inPlanned - tt.out - tt.outPlanned;
  const summary = h('div', { class: 'cal-summary' },
    h('div', { class: 'cal-stat' }, h('b', { class: 'pos' }, formatMoney(tt.in)), h('span', null, `entradas recebidas · ${formatMoney(tt.inPlanned)} previstas`)),
    h('div', { class: 'cal-stat' }, h('b', null, formatMoney(tt.out)), h('span', null, 'saídas de caixa pagas')),
    h('div', { class: 'cal-stat' }, h('b', { class: 'warn' }, formatMoney(tt.outPlanned)), h('span', null, tt.overdue ? `a pagar · ${formatMoney(tt.overdue)} atrasados` : 'a pagar no mês')),
    h('div', { class: 'cal-stat' }, h('b', { class: balance < 0 ? 'neg' : '' }, formatMoney(balance)), h('span', null, 'saldo de caixa do mês')));
  const legend = h('div', { class: 'cal-legend' },
    ...[['k-income', 'Receita'], ['k-expense', 'Despesa'], ['k-card', 'Compra no cartão'], ['k-bill', 'Fatura'], ['k-invest', 'Aporte']].map(([k, l]) => h('span', { class: 'legend' }, h('i', { class: `cal-dot ${k}` }), l)),
    h('span', { class: 'legend' }, h('i', { class: 'cal-dot is-planned' }), 'Previsto'),
    h('span', { class: 'legend' }, h('i', { class: 'cal-dot is-overdue' }), 'Atrasado'));
  // Compromissos sem dia definido: aparecem uma vez, à parte, sem inventar uma data.
  const undatedTotal = cal.undated.filter((it) => it.type !== 'income').reduce((s, it) => s + it.amount, 0);
  const undated = cal.undated.length ? h('div', { class: 'cal-undated' },
    h('div', { class: 'day-group-title' }, `Sem data definida · ${formatMoney(undatedTotal)}`, h('span', { class: 'faint' }, ' · contam no mês, fora dos dias')),
    h('div', { class: 'tx-list', role: 'list' }, ...cal.undated.map((it) => txRow(it, { onOpen: openItem, onMenu: itemMenu, onToggle: toggleStatus })))) : null;
  put(container, h('div', { class: 'cal-layout' },
    panel('Calendário financeiro', { hint: 'fluxo de caixa por dia; compras no cartão saem do caixa no vencimento da fatura' }, summary, grid, legend, undated),
    dayPanel(cal, selected)));
  return accountName;
}
