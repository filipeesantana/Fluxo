import { h, icon, put } from '../utils/dom.js';
import { formatMoney, formatPercent } from '../utils/money.js';
import { currentMonth, today, parseISO, formatDateShort, monthDiff, formatMonthShort, formatMonth, addMonths, dayDiff, monthOf } from '../utils/dates.js';
import * as repo from '../database/repository.js';
import { summarize, cashPosition, NONE, expenseValue } from '../services/finance.js';
import { monthInsights, surplusTrend } from '../services/insights.js';
import { upcoming } from '../services/calendar.js';
import { investmentValue, simulateGoal } from '../services/investments.js';
import { barList, dailyChart, lineChart, incomeExpenseChart, progress, autoWidth } from '../components/charts.js';
import { openModal } from '../components/modal.js';
import { segmented } from '../components/fields.js';
import { openEntryForm } from '../components/entry-form.js';
import { ui, setMonth, setEntriesFilter, resetEntriesFilter, readPref, writePref } from '../state.js';
import { monthNav, pageHead, panel, txRow, investRow, categoryName, blockName, accountName, colorOf, emptyState, kv, capitalize } from './common.js';
import { openItem, itemMenu, toggleStatus } from './actions.js';

const lastKpi = new Map();
const MONTHS_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function kpi(id, { label, value, sub, tone, iconName, hero = false, meta, valueCls = '', title }) {
  const changed = lastKpi.has(id) && lastKpi.get(id) !== value;
  lastKpi.set(id, value);
  return h('div', { class: `kpi kpi-${tone}${hero ? ' is-hero' : ''}${changed ? ' is-updated' : ''}`, dataset: { kpi: id }, title },
    h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-icon' }, icon(iconName)), h('span', { class: 'kpi-label' }, label)),
    h('span', { class: `kpi-value num ${valueCls}` }, formatMoney(value)),
    sub ? h('span', { class: 'kpi-sub' }, sub) : null,
    meta || null);
}

const signedPct = (r) => `${r > 0 ? '+' : ''}${formatPercent(r * 100, Math.abs(r) < 0.1 ? 1 : 0)}`;
const signedMoney = (c) => `${c > 0 ? '+' : c < 0 ? '−' : ''}${formatMoney(Math.abs(c))}`;

function insightsStrip(ctx, m, goalsInfo) {
  const ins = monthInsights(ctx, m);
  const prevLabel = formatMonthShort(ins.prevMonth);
  const items = [];
  const item = (value, label, detail, tone = '') => h('div', { class: 'insight' }, h('span', { class: `insight-value ${tone}` }, value), h('span', { class: 'insight-label' }, label), detail ? h('span', { class: 'insight-detail' }, detail) : null);
  if (ins.incomeCommitted) items.push(item(formatPercent(ins.incomeCommitted.ratio * 100, 0), 'da renda comprometida', `${formatMoney(ins.incomeCommitted.expense)} de ${formatMoney(ins.incomeCommitted.income)}`, ins.incomeCommitted.ratio > 1 ? 'neg' : ins.incomeCommitted.ratio > 0.85 ? 'warn' : ''));
  if (ins.commitmentsPaid) items.push(item(formatPercent(ins.commitmentsPaid.ratio * 100, 0), 'das despesas já pagas', ins.commitmentsPaid.pending > 0 ? `faltam ${formatMoney(ins.commitmentsPaid.pending)}` : 'nada pendente'));
  if (ins.expenseVsPrev) items.push(item(signedPct(ins.expenseVsPrev.ratio), `despesas vs. ${prevLabel}`, `${signedMoney(ins.expenseVsPrev.diff)} · ${formatMoney(ins.expenseVsPrev.prev)} em ${prevLabel}`, ins.expenseVsPrev.diff > 0 ? 'neg' : 'pos'));
  if (ins.surplusVsPrev) items.push(item(signedMoney(ins.surplusVsPrev.diff), `sobra vs. ${prevLabel}`, `${formatMoney(ins.surplusVsPrev.prev)} em ${prevLabel}`, ins.surplusVsPrev.diff < 0 ? 'neg' : 'pos'));
  if (ins.categoryChange) items.push(item(`${categoryName(ins.categoryChange.key)} ${signedPct(ins.categoryChange.ratio)}`, `maior variação de categoria`, `${signedMoney(ins.categoryChange.diff)} vs. ${prevLabel}`, ins.categoryChange.diff > 0 ? 'neg' : 'pos'));
  if (goalsInfo) items.push(item(formatPercent(goalsInfo.ratio * 100, 0), `meta “${goalsInfo.name}”`, goalsInfo.remaining > 0 ? `faltam ${formatMoney(goalsInfo.remaining)}` : 'atingida', 'invest'));
  if (!items.length) return h('div', { class: 'insights-empty' }, 'As comparações e leituras aparecem quando houver renda, despesas ou dados do mês anterior. Nada é estimado sem base real.');
  return h('div', { class: 'insights', role: 'list', 'aria-label': 'Leituras do mês' }, ...items);
}

function topGoal() {
  const goals = repo.list('goals').filter((g) => !g.archived);
  if (!goals.length) return null;
  const events = repo.list('investmentEvents');
  const t = today();
  const rows = goals.map((g) => {
    const inv = g.investmentId ? repo.get('investments', g.investmentId) : null;
    const current = inv ? investmentValue(inv, events, t).informed : g.initial || 0;
    return { name: g.name, ratio: g.target ? current / g.target : 0, remaining: Math.max(0, g.target - current) };
  });
  return rows.sort((a, b) => b.ratio - a.ratio).find((r) => r.ratio < 1) || rows[0];
}

/** Painel contextual: movimentações de uma categoria, bloco ou fonte no mês. */
export function openGroupPanel(field, key, month = ui.month) {
  const nameFn = { categoryId: categoryName, blockId: blockName, sourceId: accountName }[field];
  const dimension = { categoryId: 'Categoria', blockId: 'Bloco', sourceId: 'Fonte' }[field];
  const s = summarize(repo.context(), month);
  const items = s.items.filter((it) => (it.type === 'expense' || it.type === 'refund') && ((it[field] || NONE) === key))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const total = items.reduce((t, it) => t + expenseValue(it), 0);
  const planned = items.filter((i) => i.status !== 'done').reduce((t, it) => t + expenseValue(it), 0);
  const list = h('div', { class: 'tx-list', role: 'list' }, ...items.map((it) => txRow(it, { onOpen: (x) => { m.close(); openItem(x); }, onToggle: toggleStatus, showDate: true })));
  const body = h('div', { class: 'stack-lg' },
    h('div', { class: 'kvs' },
      kv('Total no mês', formatMoney(total), { cls: 'kv-strong' }),
      kv('Participação nas despesas', s.expenseTotal > 0 ? formatPercent((total / s.expenseTotal) * 100, 1) : '—'),
      planned ? kv('Ainda previsto', formatMoney(planned), { cls: 'warn' }) : null,
      kv('Movimentações', String(items.length))),
    items.length ? list : emptyState('Nada neste mês', null));
  const m = openModal({
    title: `${nameFn(key === NONE ? null : key)} · ${capitalize(formatMonth(month))}`, body, drawer: true,
    footer: [h('span', { class: 'faint small' }, dimension), h('span', { class: 'grow' }),
      h('button', { class: 'btn', type: 'button', onclick: () => { m.close(); resetEntriesFilter(); setEntriesFilter({ [field]: key, scope: 'month', type: 'expenses' }, { navigate: true }); } }, 'Abrir em Lançamentos'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => m.close() }, 'Fechar')],
  });
}

function evolutionPanel(s, m, ctx, isCurrent) {
  const mode = readPref('evo', 'day');
  const frac = window.innerWidth > 1100 ? 0.68 : 1;
  const body = h('div');
  const todayIdx = isCurrent ? parseISO(today()).d - 1 : null;
  const draw = (md) => {
    writePref('evo', md);
    if (md === 'day') put(body, dailyChart(s.days, { width: autoWidth(frac), todayDay: todayIdx != null ? todayIdx + 1 : null, onSelectDay: (d) => document.querySelector(`[data-day="${m}-${String(d).padStart(2, '0')}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }));
    else if (md === 'cum') {
      const cum = (days) => { let a = 0; return days.map((d) => (a += d.done + d.planned)); };
      const prev = summarize(ctx, addMonths(m, -1));
      const cur = cum(s.days);
      const pv = cum(prev.days);
      const prevAligned = cur.map((_, i) => pv[Math.min(i, pv.length - 1)]);
      const future = monthDiff(currentMonth(), m) > 0;
      const series = [{ label: 'Este mês', values: cur, cls: 's-cum', area: true, projectedFrom: future ? 0 : todayIdx }];
      if (prev.expenseTotal > 0) series.push({ label: `${capitalize(formatMonthShort(prev.month))} (anterior)`, values: prevAligned, cls: 's-prev' });
      put(body, lineChart(series, s.days.map((d) => String(d.day)), { markIndex: todayIdx, frac, empty: 'Nenhum gasto acumulado neste mês ainda.' }));
    } else {
      const rows = surplusTrend(ctx, addMonths(m, 2), 8);
      put(body, incomeExpenseChart(rows, { width: autoWidth(frac), currentIndex: rows.findIndex((r) => r.month === currentMonth()), labelOf: (mm) => capitalize(formatMonthShort(mm)), onSelect: (mm) => setMonth(mm) }));
    }
  };
  const seg = segmented({ label: 'Visualização', value: mode, size: 'segmented-sm', options: [{ value: 'day', label: 'Por dia' }, { value: 'cum', label: 'Acumulado' }, { value: 'ie', label: 'Receitas × despesas' }], onChange: draw });
  draw(mode);
  return panel('Evolução', { hint: `${formatMoney(s.expenseTotal)} em despesas`, actions: seg }, body);
}

function upcomingPanel(ctx) {
  const up = upcoming(ctx, { horizon: 30, limit: 7 });
  const t = today();
  const rows = up.items.map((ev) => {
    const d = parseISO(ev.date);
    const diff = dayDiff(t, ev.date);
    const statusText = ev.status === 'overdue' ? (ev.kind === 'income' ? 'Não recebida' : 'Atrasado') : ev.status === 'done' ? (ev.kind === 'bill' ? 'Paga' : 'Pago') : diff === 0 ? 'Hoje' : diff === 1 ? 'Amanhã' : `Em ${diff} dias`;
    const pill = ev.status === 'overdue' ? 'pill-overdue' : ev.status === 'done' ? 'pill-done' : diff <= 3 ? 'pill-today' : 'pill-planned';
    const card = ev.kind === 'bill' ? repo.get('accounts', ev.cardId) : null;
    const title = ev.kind === 'bill' ? `Fatura ${card?.name || 'do cartão'}` : ev.item.description;
    const kindLabel = ev.kind === 'bill' ? 'fatura' : ev.kind === 'income' ? 'receita' : ev.item.recurrenceId ? 'conta fixa' : ev.item.planId ? `parcela ${ev.item.installment.index}/${ev.item.installment.count}` : 'despesa';
    const value = ev.kind === 'bill' ? ev.open || ev.amount : ev.amount;
    const onclick = () => {
      if (ev.kind === 'bill') {
        if (ev.open > 0) openEntryForm({ defaults: { type: 'transfer', toAccountId: ev.cardId, billMonth: monthOf(ev.date), amount: ev.open, date: t, status: 'done', sourceId: card?.payAccountId || null } });
      } else openItem(ev.item);
    };
    return h('button', { class: `up-row${ev.status === 'overdue' ? ' is-overdue' : diff >= 0 && diff <= 3 && ev.status !== 'done' ? ' is-soon' : ''}`, type: 'button', onclick, 'aria-label': `${title}, ${formatDateShort(ev.date)}, ${formatMoney(value)}, ${statusText}` },
      h('span', { class: 'up-date' }, h('b', null, String(d.d)), h('span', null, MONTHS_PT[d.m - 1])),
      h('span', { class: 'up-text' }, h('span', { class: 'up-title truncate' }, title), h('span', { class: 'up-sub' }, kindLabel)),
      h('span', { class: `up-amount${ev.kind === 'income' ? ' is-income' : ''}` }, formatMoney(value), h('span', { class: `pill ${pill}` }, statusText)));
  });
  return panel('Próximos vencimentos', { hint: up.pending ? `${formatMoney(up.pending)} a pagar` : null, actions: h('a', { class: 'btn btn-ghost btn-sm', href: '#/planejamento/calendario' }, icon('calendar', 'icon-sm'), 'Calendário') },
    rows.length ? h('div', { class: 'upcoming' }, ...rows) : h('div', { class: 'empty-block' }, 'Nada vence nos próximos 30 dias.', h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openEntryForm({ defaults: { status: 'planned' } }) }, icon('plus', 'icon-sm'), 'Programar uma despesa')));
}

export function renderOverview(root) {
  const ctx = repo.context();
  const m = ui.month;
  const s = summarize(ctx, m);
  const cm = currentMonth();
  const isCurrent = m === cm;
  const isFuture = monthDiff(cm, m) > 0;
  const cash = cashPosition(ctx);
  const empty = repo.list('transactions').length === 0 && repo.list('recurrences').length === 0;

  const head = pageHead('Visão geral', { sub: isFuture ? 'Projeção com base nos compromissos cadastrados' : isCurrent ? `Resumo de ${formatMonth(m)}` : `Histórico de ${formatMonth(m)}`, controls: monthNav() });

  const billsOpen = s.cardBills.reduce((t, b) => t + b.open, 0);
  const pendingSub = [billsOpen ? `${formatMoney(billsOpen)} em faturas` : null, s.overdue ? `${formatMoney(s.overdue)} atrasados` : null].filter(Boolean).join(' · ') || 'previstos e faturas em aberto';
  const receivedRatio = s.incomeTotal > 0 ? s.incomeReceived / s.incomeTotal : null;
  const paidRatio = s.expenseTotal > 0 ? s.expenseDone / s.expenseTotal : null;
  const ratioBar = (r, color) => r == null ? null : h('div', { class: 'kpi-bar', style: { color } }, h('span', { style: { width: `${Math.round(Math.min(1, r) * 100)}%` } }));

  const kpis = h('div', { class: 'kpi-grid', role: 'group', 'aria-label': 'Indicadores do mês' },
    kpi('surplus', { label: 'Sobra projetada', value: s.projectedSurplus, tone: s.projectedSurplus < 0 ? 'neg' : 'accent', iconName: 'chart', hero: true, valueCls: s.projectedSurplus < 0 ? 'neg-value' : '',
      sub: 'Receitas do mês menos todas as despesas, pagas e previstas.',
      meta: h('div', { class: 'kpi-meta' }, h('span', null, 'Até agora: ', h('strong', { class: 'num' }, formatMoney(s.currentSurplus))), s.safetyMargin ? h('span', null, `Margem: ${formatMoney(s.safetyMargin)}`) : null) }),
    kpi('invest', { label: 'Disponível para investir', value: s.availableToInvest, tone: 'invest', iconName: 'trend', hero: true,
      sub: 'Sobra livre (sem benefícios restritos), após margem e aportes já feitos. Nada é investido automaticamente.',
      meta: h('div', { class: 'kpi-meta' }, h('span', null, 'Aportado no mês: ', h('strong', { class: 'num' }, formatMoney(s.contributed))), s.availableToInvest > 0 ? h('a', { class: 'link-btn', href: '#/investimentos' }, 'Simular aporte', icon('arrow-right', 'icon-sm')) : null) }),
    kpi('inRec', { label: 'Receitas recebidas', value: s.incomeReceived, tone: 'pos', iconName: 'in', sub: s.incomeTotal ? `de ${formatMoney(s.incomeTotal)} no mês${s.restrictedIncome ? ` · ${formatMoney(s.restrictedIncome)} em benefícios` : ''}` : 'nenhuma receita no mês', meta: ratioBar(receivedRatio, 'var(--pos)') }),
    kpi('inExp', { label: 'Receitas previstas', value: s.incomeExpected, tone: 'plan', iconName: 'clock', sub: s.incomeExpected ? 'a receber neste mês' : 'nada a receber' }),
    kpi('exDone', { label: 'Despesas realizadas', value: s.expenseDone, tone: 'neg', iconName: 'out', sub: paidRatio != null ? `${formatPercent(paidRatio * 100, 0)} das despesas do mês` : 'nenhuma despesa paga', meta: ratioBar(paidRatio, 'var(--neg)') }),
    kpi('exPend', { label: 'Compromissos pendentes', value: s.expensePending, tone: 'warn', iconName: 'alert', sub: pendingSub }),
  );

  const g = topGoal();
  const dist = h('div', { class: 'grid grid-3' },
    panel('Por categoria', { hint: 'natureza do gasto' }, barList(s.byCategory, { id: 'cat', labelOf: categoryName, colorOf, onSelect: (k) => openGroupPanel('categoryId', k), empty: 'Sem gastos neste mês.', emptyAction: empty ? h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => openEntryForm() }, icon('plus', 'icon-sm'), 'Registrar o primeiro gasto') : null })),
    panel('Por bloco', { hint: 'contexto' }, barList(s.byBlock, { id: 'block', labelOf: blockName, colorOf, onSelect: (k) => openGroupPanel('blockId', k), empty: 'Sem gastos neste mês. Blocos agrupam por contexto: pessoal, casa, moto…' })),
    panel('Por fonte', { hint: 'conta ou cartão' }, barList(s.bySource, { id: 'src', labelOf: accountName, colorOf, onSelect: (k) => openGroupPanel('sourceId', k), empty: 'Sem gastos neste mês.' })),
  );

  // Movimentações do mês (inclui aportes/resgates, que não são consumo)
  const items = [...s.items].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0)));
  const invEvents = repo.list('investmentEvents').filter((e) => e.type !== 'balance' && monthOf(e.date) === m);
  const LIMIT = 14;
  const list = h('div', { class: 'tx-list', role: 'list' });
  let lastDate = null;
  const merged = [...items.map((it) => ({ date: it.date, it })), ...invEvents.map((e) => ({ date: e.date, ev: e }))].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, LIMIT);
  for (const row of merged) {
    if (row.date !== lastDate) {
      lastDate = row.date;
      const dayTotal = items.filter((x) => x.date === row.date).reduce((t, x) => t + expenseValue(x), 0);
      list.append(h('div', { class: 'tx-day', dataset: { day: row.date } }, h('span', null, formatDateShort(row.date)), dayTotal ? h('span', { class: 'tx-day-total' }, `− ${formatMoney(dayTotal)}`) : null));
    }
    list.append(row.ev ? investRow(row.ev) : txRow(row.it, { onOpen: openItem, onMenu: itemMenu, onToggle: toggleStatus }));
  }
  const total = items.length + invEvents.length;
  const movements = panel('Movimentações', { hint: `${total} no mês`, actions: h('a', { class: 'btn btn-sm', href: '#/lancamentos', onclick: () => { resetEntriesFilter(); ui.entries.scope = 'month'; } }, 'Ver todas', icon('arrow-right', 'icon-sm')) },
    total ? list : h('div', { class: 'empty-block' }, isFuture ? 'Nenhum compromisso registrado para este mês.' : 'Nenhuma movimentação neste mês.',
      h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => openEntryForm() }, icon('plus', 'icon-sm'), 'Novo lançamento')),
    total > LIMIT ? h('a', { class: 'link-btn small', href: '#/lancamentos', style: { marginTop: '10px' } }, `Ver os outros ${total - LIMIT} em Lançamentos`) : null);

  // Coluna lateral
  const side = h('div', { class: 'col' });
  if (isCurrent || isFuture) side.append(upcomingPanel(ctx));
  side.append(panel('Sobra em detalhe', null, h('div', { class: 'kvs' },
    kv('Sobra orçamentária do mês', formatMoney(s.projectedSurplus), { cls: s.projectedSurplus < 0 ? 'neg' : 'kv-strong' }),
    kv('Sobra até agora', formatMoney(s.currentSurplus), { hint: 'recebido − pago' }),
    isCurrent ? kv('Saldo em contas hoje', ctx.complete ? formatMoney(cash.free) : 'carregando…', { hint: 'caixa real' }) : null,
    isCurrent ? kv('Caixa após compromissos', ctx.complete ? formatMoney(cash.free + s.incomeExpected - s.expensePending) : 'carregando…', { hint: 'fim do mês' }) : null,
    s.restrictedIncome || s.restrictedExpense ? kv('Benefícios livres', formatMoney(s.restrictedLeft), { hint: 'não entram em aportes' }) : null,
    s.safetyMargin ? kv('Margem de segurança', `− ${formatMoney(s.safetyMargin)}`) : null,
    kv('Aportes realizados', formatMoney(s.contributed), { cls: s.contributed ? 'invest' : '' }),
    kv('Disponível para aportes', formatMoney(s.availableToInvest), { cls: 'invest' }),
    s.goalsPlanned ? kv('Planejado para metas', formatMoney(s.goalsPlanned), { hint: s.availableToInvest >= s.goalsPlanned ? 'coberto' : 'acima do disponível', cls: s.availableToInvest >= s.goalsPlanned ? '' : 'warn' }) : null)));

  const accounts = repo.list('accounts').filter((a) => !a.archived && a.kind !== 'credit');
  if (accounts.length && isCurrent && ctx.complete) {
    side.append(panel('Saldos', { hint: 'somente realizados' }, h('div', { class: 'kvs' }, ...accounts.map((a) => kv(a.name, formatMoney(cash.balances.get(a.id) || 0), { cls: (cash.balances.get(a.id) || 0) < 0 ? 'neg' : '' })))));
  }
  if (s.cardBills.length) {
    const label = { paid: 'paga', open: 'aberta', partial: 'parcial', overdue: 'vencida' };
    side.append(panel(`Faturas de ${formatMonthShort(m)}`, null, h('div', { class: 'kvs' }, ...s.cardBills.map((b) => {
      const card = repo.get('accounts', b.cardId);
      const row = h('div', { class: 'kv' },
        h('span', { class: 'kv-label' }, card?.name || 'Cartão', h('span', { class: 'faint' }, b.dueDate ? ` · vence ${formatDateShort(b.dueDate)}` : ' · sem vencimento configurado')),
        h('span', { class: 'kv-value num' }, formatMoney(b.total), h('span', { class: `pill pill-${b.status}` }, label[b.status])));
      if (b.open > 0 && card) row.append(h('div', { class: 'kv-action' }, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openEntryForm({ defaults: { type: 'transfer', toAccountId: card.id, billMonth: m, amount: b.open, date: today(), status: 'done', sourceId: card.payAccountId || null } }) }, icon('check', 'icon-sm'), `Pagar ${formatMoney(b.open)}`)));
      return row;
    }))));
  }
  if (s.budgets.length) {
    side.append(panel('Orçamentos', { actions: h('a', { class: 'btn btn-ghost btn-sm', href: '#/planejamento/orcamentos' }, 'Gerenciar') },
      h('div', { class: 'budgets' }, ...[...s.budgets].sort((a, b) => b.ratio - a.ratio).slice(0, 5).map((b) => budgetRow(b)))));
  }

  put(root, head, kpis, h('div', { style: { marginTop: 'var(--gap)' } }, insightsStrip(ctx, m, g)), dist,
    h('div', { class: 'grid grid-main' }, h('div', { class: 'col' }, evolutionPanel(s, m, ctx, isCurrent), movements), side));
}

export function budgetRow(b) {
  const name = b.scope === 'block' ? blockName(b.refId) : categoryName(b.refId);
  const over = b.remaining < 0;
  return h('div', { class: 'budget' },
    h('div', { class: 'budget-top' }, h('span', { class: 'truncate' }, name),
      h('span', { class: `num small ${over ? 'neg' : b.ratio > 0.85 ? 'warn' : 'faint'}` }, over ? `${formatMoney(-b.remaining)} acima` : `restam ${formatMoney(b.remaining)}`)),
    progress(b.ratio, { label: `${name}: ${formatPercent(b.ratio * 100, 0)} do orçamento` }),
    h('div', { class: 'faint xsmall num' }, `${formatMoney(b.used)} de ${formatMoney(b.amount)}`));
}

export { simulateGoal };
