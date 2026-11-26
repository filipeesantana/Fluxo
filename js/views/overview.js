import { h, icon, put } from '../utils/dom.js';
import { formatMoney, formatPercent } from '../utils/money.js';
import { currentMonth, today, parseISO, formatDateShort, monthDiff, formatMonthShort, formatMonth, addMonths, dayDiff, monthOf, byDateDesc } from '../utils/dates.js';
import * as repo from '../database/repository.js';
import { summarize, cashPosition, NONE, expenseValue } from '../services/finance.js';
import { monthInsights, surplusTrend } from '../services/insights.js';
import { upcoming } from '../services/calendar.js';
import { investmentValue, simulateGoal } from '../services/investments.js';
import { barList, dailyChart, lineChart, incomeExpenseChart, progress, autoWidth, donutChart, columnsChart, groupTable } from '../components/charts.js';
import { widgetGrid, isEditing, setEditing } from '../components/layout.js';
import { openKpiDetail } from './drilldown.js';
import { kpiFormat, commitmentsWidget, signalsWidget, highlightsWidget, topSummary } from './widgets-extra.js';
import { budgetLevel } from '../services/signals.js';
import { backupReminder } from './backup-ui.js';
import { openModal } from '../components/modal.js';
import { segmented } from '../components/fields.js';
import { openEntryForm } from '../components/entry-form.js';
import { ui, setMonth, setEntriesFilter, resetEntriesFilter, readChoice } from '../state.js';
import { monthNav, pageHead, panel, txRow, investRow, categoryName, blockName, accountName, colorOf, emptyState, kv, capitalize } from './common.js';
import { openItem, itemMenu, toggleStatus } from './actions.js';

const lastKpi = new Map();
const MONTHS_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function kpi(id, { label, value, sub, tone, iconName, hero = false, meta, valueCls = '', onOpen, cfg = {}, extra = null }) {
  const changed = lastKpi.has(id) && lastKpi.get(id) !== value;
  lastKpi.set(id, value);
  // O indicador inteiro é um botão: abre o detalhamento do cálculo (drill-down).
  return h('button', { class: `kpi kpi-${tone}${hero ? ' is-hero' : ''}${changed ? ' is-updated' : ''}${cfg.size === 's' ? ' is-compact' : ''}`, type: 'button', dataset: { kpi: id }, onclick: onOpen, 'aria-label': `${label}: ${formatMoney(value)}. Ver como foi calculado.` },
    h('span', { class: 'kpi-top' }, h('span', { class: 'kpi-icon' }, icon(iconName)), h('span', { class: 'kpi-label' }, label), h('span', { class: 'kpi-more', 'aria-hidden': 'true' }, icon('chev-right', 'icon-sm'))),
    h('span', { class: `kpi-value num ${valueCls}` }, value < 0 ? `− ${formatMoney(-value)}` : formatMoney(value)),
    sub && !extra ? h('span', { class: 'kpi-sub' }, sub) : null,
    extra || meta || null);
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
    .sort(byDateDesc);
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

function evolutionPanel(s, m, ctx, isCurrent, cfg = {}, api) {
  const mode = ['day', 'cum', 'ie'].includes(cfg.chart) ? cfg.chart : 'day';
  const span = { l: 0.5, xl: 0.68, f: 1 }[cfg.size] || 0.68;
  const frac = window.innerWidth > 1100 ? span : 1;
  const body = h('div');
  const todayIdx = isCurrent ? parseISO(today()).d - 1 : null;
  const draw = (md) => {
    if (md !== mode || cfg.chart !== md) api?.update({ chart: md });
    cfg.chart = md;
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
  const hint = mode === 'ie' ? 'últimos meses, realizado e previsto' : `${formatMoney(s.expenseTotal)} em despesas · ${capitalize(formatMonthShort(m))}`;
  return panel('Evolução', { hint, actions: seg }, body);
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

// ——— Componentes da Visão geral ———
// Cada componente é independente: falha de um não derruba os outros (ver layout.js).

function distWidget(title, hint, groups, field, labelOf, emptyText, emptyAction) {
  return (cfg) => {
    const hasNeg = groups.some((g) => g.total < 0);
    // Rosca não representa valores negativos: cai para barras e avisa.
    const chart = cfg.chart === 'donut' && hasNeg ? 'bars' : cfg.chart;
    const onSelect = (k) => openGroupPanel(field, k);
    const total = groups.reduce((t, g) => t + g.total, 0);
    const opts = { id: field, labelOf, colorOf, onSelect, total };
    let body;
    if (!groups.length) body = h('div', { class: 'empty-block' }, emptyText, emptyAction || null);
    else if (chart === 'donut') body = donutChart(groups, { ...opts, centerLabel: 'em despesas' });
    else if (chart === 'columns') body = columnsChart(groups, { ...opts, frac: cfg.size === 'f' ? 1 : cfg.size === 'xl' ? 0.66 : cfg.size === 'l' ? 0.5 : 0.33 });
    else if (chart === 'table') body = groupTable(groups, opts);
    else if (chart === 'top') body = topSummary(groups, labelOf, onSelect);
    else body = barList(groups, { ...opts, empty: emptyText, emptyAction });
    return panel(title, { hint: groups.length ? `${formatMoney(total)} · ${hint}` : hint },
      body, cfg.chart === 'donut' && hasNeg ? h('p', { class: 'faint xsmall' }, 'Há valores negativos (estornos maiores que os gastos); a rosca foi trocada por barras.') : null);
  };
}

function movementsWidget(s, m, isFuture) {
  return () => {
    const items = [...s.items].sort(byDateDesc);
    const invEvents = repo.list('investmentEvents').filter((e) => e.type !== 'balance' && monthOf(e.date) === m);
    const LIMIT = 14;
    const list = h('div', { class: 'tx-list', role: 'list' });
    let lastDate;
    const merged = [...items.map((it) => ({ date: it.date, createdAt: it.createdAt, it })), ...invEvents.map((e) => ({ date: e.date, ev: e }))].sort(byDateDesc).slice(0, LIMIT);
    for (const row of merged) {
      if (row.date !== lastDate) {
        lastDate = row.date;
        const dayTotal = items.filter((x) => x.date === row.date).reduce((t, x) => t + expenseValue(x), 0);
        list.append(h('div', { class: 'tx-day', dataset: { day: row.date || '' } }, h('span', null, row.date ? formatDateShort(row.date) : 'Data a definir'), dayTotal ? h('span', { class: 'tx-day-total' }, `− ${formatMoney(dayTotal)}`) : null));
      }
      list.append(row.ev ? investRow(row.ev) : txRow(row.it, { onOpen: openItem, onMenu: itemMenu, onToggle: toggleStatus }));
    }
    const total = items.length + invEvents.length;
    return panel('Movimentações', { hint: `${total} no mês`, actions: h('a', { class: 'btn btn-sm', href: '#/lancamentos', onclick: () => { resetEntriesFilter(); ui.entries.scope = 'month'; } }, 'Ver todas', icon('arrow-right', 'icon-sm')) },
      total ? list : h('div', { class: 'empty-block' }, isFuture ? 'Nenhum compromisso registrado para este mês.' : 'Nenhuma movimentação neste mês.',
        h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => openEntryForm() }, icon('plus', 'icon-sm'), 'Novo lançamento')),
      total > LIMIT ? h('a', { class: 'link-btn small more-link', href: '#/lancamentos' }, `Ver os outros ${total - LIMIT} em Lançamentos`) : null);
  };
}

function goalsProgress() {
  const events = repo.list('investmentEvents');
  const t = today();
  return repo.list('goals').filter((g) => !g.archived).map((g) => {
    const inv = g.investmentId ? repo.get('investments', g.investmentId) : null;
    return { id: g.id, name: g.name, target: g.target, current: inv ? investmentValue(inv, events, t).informed : g.initial || 0 };
  });
}

function goalsWidget(cfg = {}) {
  const goals = repo.list('goals').filter((g) => !g.archived);
  if (cfg.chart === 'percent' && goals.length) {
    return panel('Metas', { actions: h('a', { class: 'btn btn-ghost btn-sm', href: '#/investimentos' }, 'Abrir') }, h('div', { class: 'goal-pcts' }, ...goalsProgress().slice(0, 4).map((g) => {
      const r = g.target ? g.current / g.target : 0;
      return h('div', { class: 'goal-pct' }, h('strong', { class: `num ${r >= 1 ? 'pos' : 'invest'}` }, formatPercent(Math.min(1, r) * 100, 0)), h('span', { class: 'small truncate' }, g.name), h('span', { class: 'faint xsmall num' }, r >= 1 ? 'concluída' : `faltam ${formatMoney(g.target - g.current)}`));
    })));
  }
  if (!goals.length) return h('div', { class: 'empty-block' }, 'Nenhuma meta ativa.', h('a', { class: 'btn btn-sm', href: '#/investimentos' }, 'Criar meta'));
  const events = repo.list('investmentEvents');
  const t = today();
  return panel('Metas', { actions: h('a', { class: 'btn btn-ghost btn-sm', href: '#/investimentos' }, 'Abrir') }, h('div', { class: 'budgets' }, ...goals.slice(0, 5).map((g) => {
    const inv = g.investmentId ? repo.get('investments', g.investmentId) : null;
    const current = inv ? investmentValue(inv, events, t).informed : g.initial || 0;
    const ratio = g.target ? current / g.target : 0;
    return h('div', { class: 'budget' }, h('div', { class: 'budget-top' }, h('span', { class: 'truncate' }, g.name), h('span', { class: 'num small faint' }, formatPercent(Math.min(1, ratio) * 100, 0))),
      progress(ratio, { tone: 'invest', label: `${g.name}: ${formatPercent(ratio * 100, 0)}` }),
      h('div', { class: 'faint xsmall num' }, `${formatMoney(current)} de ${formatMoney(g.target)}`));
  })));
}

export function overviewRegistry({ ctx, s, m, isCurrent, isFuture, cash, empty }) {
  const billsOpen = s.cardBills.reduce((t, b) => t + b.open, 0);
  const pendingSub = [billsOpen ? `${formatMoney(billsOpen)} em faturas` : null, s.overdue ? `${formatMoney(s.overdue)} atrasados` : null].filter(Boolean).join(' · ') || 'previstos e faturas em aberto';
  const receivedRatio = s.incomeTotal > 0 ? s.incomeReceived / s.incomeTotal : null;
  const paidRatio = s.expenseTotal > 0 ? s.expenseDone / s.expenseTotal : null;
  const ratioBar = (r, color) => r == null ? null : h('span', { class: 'kpi-bar', style: { color } }, h('span', { style: { width: `${Math.round(Math.min(1, r) * 100)}%` } }));
  const accounts = repo.list('accounts').filter((a) => !a.archived && a.kind !== 'credit');
  const firstAction = empty ? h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => openEntryForm() }, icon('plus', 'icon-sm'), 'Registrar o primeiro gasto') : null;
  const DIST = { charts: ['bars', 'columns', 'donut', 'table', 'top'], chart: 'bars', sizes: ['m', 'l', 'xl', 'f'], color: false };
  const KPI = { sizes: ['s', 'm', 'l'], color: true, locked: false, charts: ['value', 'detail', 'trend', 'compare'], chart: 'value' };
  const kpiOpen = (kind) => () => openKpiDetail(kind, m);
  const fx = (kind, cfg, detail) => kpiFormat(kind, cfg.chart, ctx, m, detail);
  const prefs = repo.prefs();

  return {
    'kpi-surplus': { ...KPI, title: 'Sobra projetada', description: 'Receitas do mês menos todas as despesas.', size: 'l',
      render: (cfg) => kpi('surplus', { label: 'Sobra projetada', value: s.projectedSurplus, tone: s.projectedSurplus < 0 ? 'neg' : 'accent', iconName: 'chart', hero: true, valueCls: s.projectedSurplus < 0 ? 'neg-value' : '', onOpen: kpiOpen('surplus'),
        sub: s.projectedSurplus < 0 ? 'Déficit: as despesas do mês superam as receitas.' : 'Receitas do mês menos todas as despesas, pagas e previstas.',
        meta: h('span', { class: 'kpi-meta' }, h('span', null, 'Até agora: ', h('strong', { class: 'num' }, formatMoney(s.currentSurplus))), s.safetyMargin ? h('span', null, `Margem: ${formatMoney(s.safetyMargin)}`) : null), cfg,
        extra: fx('surplus', cfg, [['Receitas do mês', formatMoney(s.incomeTotal), 'pos'], ['Despesas do mês', `− ${formatMoney(s.expenseTotal)}`], s.forecastLeft ? ['das quais previsões restantes', formatMoney(s.forecastLeft), 'faint'] : null]) }) },
    'kpi-invest': { ...KPI, title: 'Disponível para investir', description: 'Sobra livre após margem e aportes do mês.', size: 'l',
      render: (cfg) => kpi('invest', { label: 'Disponível para investir', value: s.availableToInvest, tone: 'invest', iconName: 'trend', hero: true, onOpen: kpiOpen('invest'),
        sub: 'Sobra livre (sem benefícios restritos), após margem e aportes já feitos. Nada é investido automaticamente.',
        meta: h('span', { class: 'kpi-meta' }, h('span', null, 'Aportado no mês: ', h('strong', { class: 'num' }, formatMoney(s.contributed)))), cfg,
        extra: fx('invest', cfg, [['Sobra livre', formatMoney(s.freeSurplus)], s.safetyMargin ? ['Margem de segurança', `− ${formatMoney(s.safetyMargin)}`] : null, ['Aportes no mês', `− ${formatMoney(s.contributed)}`]]) }) },
    'kpi-income-received': { ...KPI, title: 'Receitas recebidas', size: 's',
      render: (cfg) => kpi('inRec', { label: 'Receitas recebidas', value: s.incomeReceived, tone: 'pos', iconName: 'in', onOpen: kpiOpen('incomeReceived'), sub: s.incomeTotal ? `de ${formatMoney(s.incomeTotal)} no mês${s.restrictedIncome ? ` · ${formatMoney(s.restrictedIncome)} em benefícios` : ''}` : 'nenhuma receita no mês', meta: ratioBar(receivedRatio, 'var(--pos)'), cfg, extra: fx('inRec', cfg, [['Total do mês', formatMoney(s.incomeTotal)], ['Ainda a receber', formatMoney(s.incomeExpected)]]) }) },
    'kpi-income-expected': { ...KPI, title: 'Receitas previstas', size: 's',
      render: (cfg) => kpi('inExp', { label: 'Receitas previstas', value: s.incomeExpected, tone: 'plan', iconName: 'clock', onOpen: kpiOpen('incomeExpected'), sub: s.incomeExpected ? 'a receber neste mês' : 'nada a receber', cfg, extra: fx('inExp', cfg, [['Já recebido', formatMoney(s.incomeReceived)], ['Total do mês', formatMoney(s.incomeTotal)]]) }) },
    'kpi-expense-done': { ...KPI, title: 'Despesas realizadas', size: 's',
      render: (cfg) => kpi('exDone', { label: 'Despesas realizadas', value: s.expenseDone, tone: 'neg', iconName: 'out', onOpen: kpiOpen('expenseDone'), sub: paidRatio != null ? `${formatPercent(paidRatio * 100, 0)} das despesas do mês` : 'nenhuma despesa paga', meta: ratioBar(paidRatio, 'var(--neg)'), cfg, extra: fx('exDone', cfg, [['Contas fixas', formatMoney(s.expFixed)], ['Parcelas', formatMoney(s.expInstallments)], ['Pontuais e previsões', formatMoney(s.expOneOff + s.expForecast)]]) }) },
    'kpi-expense-pending': { ...KPI, title: 'Compromissos pendentes', size: 's',
      render: (cfg) => kpi('exPend', { label: 'Compromissos pendentes', value: s.expensePending, tone: 'warn', iconName: 'alert', onOpen: kpiOpen('expensePending'), sub: pendingSub, cfg, extra: fx('exPend', cfg, [['Faturas em aberto', formatMoney(billsOpen)], ['Atrasados', formatMoney(s.overdue), s.overdue ? 'neg' : ''], ['Demais previstos', formatMoney(Math.max(0, s.expensePending - billsOpen))]]) }) },
    commitments: { title: 'Compromissos do mês', description: 'Pendente, próximo vencimento, contas restantes e quanto já foi pago.', size: 'm', sizes: ['m', 'l', 'xl', 'f'], charts: ['summary', 'list', 'progress'], chart: 'summary', color: true, render: (cfg) => commitmentsWidget(ctx, m, cfg) },
    signals: { title: 'Atenção', description: 'Avisos discretos: orçamentos, atrasos, vencimentos próximos, déficit e margem.', size: 'm', sizes: ['m', 'l', 'xl', 'f'], render: () => signalsWidget(ctx, m, prefs, goalsProgress()) },
    highlights: { title: 'Destaques', description: 'Alterna entre sobra, economia em relação ao mês anterior e disponível para investir.', size: 'm', sizes: ['s', 'm', 'l'], charts: ['manual', 'auto'], chart: 'manual', hidden: true, color: true, render: (cfg) => highlightsWidget(ctx, m, cfg) },
    insights: { title: 'Leituras do mês', description: 'Comparações com o mês anterior e metas.', size: 'f', sizes: ['l', 'xl', 'f'], render: () => insightsStrip(ctx, m, topGoal()) },
    'dist-category': { ...DIST, title: 'Por categoria', description: 'Natureza do gasto.', size: 'm', render: distWidget('Por categoria', 'natureza do gasto', s.byCategory, 'categoryId', categoryName, 'Sem gastos neste mês.', firstAction) },
    'dist-block': { ...DIST, title: 'Por bloco', description: 'Contexto: pessoal, casa, moto…', size: 'm', render: distWidget('Por bloco', 'contexto', s.byBlock, 'blockId', blockName, 'Sem gastos neste mês. Blocos agrupam por contexto: pessoal, casa, moto…') },
    'dist-source': { ...DIST, title: 'Por fonte', description: 'Conta ou cartão usado.', size: 'm', render: distWidget('Por fonte', 'conta ou cartão', s.bySource, 'sourceId', accountName, 'Sem gastos neste mês.') },
    evolution: { title: 'Evolução', description: 'Gastos por dia, acumulado ou receitas × despesas.', size: 'xl', sizes: ['l', 'xl', 'f'], charts: ['day', 'cum', 'ie'], chart: readChoice('evo', ['day', 'cum', 'ie'], 'day'),
      render: (cfg, api) => evolutionPanel(s, m, ctx, isCurrent, cfg, api) },
    upcoming: { title: 'Próximos vencimentos', description: 'O que vence nos próximos 30 dias.', size: 'm', sizes: ['m', 'l', 'xl', 'f'], when: () => isCurrent || isFuture, render: () => (isCurrent || isFuture ? upcomingPanel(ctx) : h('div', { class: 'empty-block' }, 'Disponível no mês atual e nos próximos.')) },
    movements: { title: 'Movimentações', description: 'Lançamentos e aportes do mês.', size: 'xl', sizes: ['l', 'xl', 'f'], render: movementsWidget(s, m, isFuture) },
    'surplus-detail': { title: 'Sobra em detalhe', description: 'Da sobra orçamentária ao disponível para aportes.', size: 'm', sizes: ['m', 'l', 'xl'],
      render: () => panel('Sobra em detalhe', { actions: h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: kpiOpen('invest') }, 'Ver cálculo') }, h('div', { class: 'kvs' },
        kv('Sobra orçamentária do mês', formatMoney(s.projectedSurplus), { cls: s.projectedSurplus < 0 ? 'neg' : 'kv-strong' }),
        kv('Sobra até agora', formatMoney(s.currentSurplus), { hint: 'recebido − pago' }),
        isCurrent ? kv('Saldo em contas hoje', ctx.complete ? formatMoney(cash.free) : 'carregando…', { hint: 'caixa real' }) : null,
        isCurrent ? kv('Caixa após compromissos', ctx.complete ? formatMoney(cash.free + s.incomeExpected - s.expensePending) : 'carregando…', { hint: 'fim do mês' }) : null,
        s.restrictedIncome || s.restrictedExpense ? kv('Benefícios livres', formatMoney(s.restrictedLeft), { hint: 'não entram em aportes' }) : null,
        s.safetyMargin ? kv('Margem de segurança', `− ${formatMoney(s.safetyMargin)}`) : null,
        kv('Aportes realizados', formatMoney(s.contributed), { cls: s.contributed ? 'invest' : '' }),
        kv('Disponível para aportes', formatMoney(s.availableToInvest), { cls: 'invest' }),
        s.goalsPlanned ? kv('Planejado para metas', formatMoney(s.goalsPlanned), { hint: s.availableToInvest >= s.goalsPlanned ? 'coberto' : 'acima do disponível', cls: s.availableToInvest >= s.goalsPlanned ? '' : 'warn' }) : null)) },
    balances: { title: 'Saldos', description: 'Saldo realizado por conta (mês atual).', size: 'm', sizes: ['m', 'l', 'xl'], when: () => accounts.length > 0 && isCurrent && ctx.complete,
      render: () => (accounts.length && isCurrent ? panel('Saldos', { hint: 'somente realizados' }, h('div', { class: 'kvs' }, ...accounts.map((a) => kv(a.name, ctx.complete ? formatMoney(cash.balances.get(a.id) || 0) : '…', { cls: (cash.balances.get(a.id) || 0) < 0 ? 'neg' : '' })))) : h('div', { class: 'empty-block' }, 'Os saldos aparecem no mês atual, quando houver contas.')) },
    bills: { title: 'Faturas', description: 'Faturas de cartão do mês.', size: 'm', sizes: ['m', 'l', 'xl'], when: () => s.cardBills.length > 0, render: () => billsPanel(s, m) },
    budgets: { title: 'Orçamentos', description: 'Uso dos limites do mês.', size: 'm', sizes: ['m', 'l', 'xl'], when: () => s.budgets.length > 0,
      render: () => panel('Orçamentos', { actions: h('a', { class: 'btn btn-ghost btn-sm', href: '#/planejamento/orcamentos' }, 'Gerenciar') },
        s.budgets.length ? h('div', { class: 'budgets' }, ...[...s.budgets].sort((a, b) => b.ratio - a.ratio).slice(0, 5).map((b) => budgetRow(b))) : h('div', { class: 'empty-block' }, 'Nenhum orçamento definido.')) },
    goals: { title: 'Metas', description: 'Progresso das metas ativas.', size: 'm', sizes: ['m', 'l', 'xl'], hidden: true, charts: ['list', 'percent'], chart: 'list', render: (cfg) => goalsWidget(cfg) },
  };
}

function billsPanel(s, m) {
  if (!s.cardBills.length) return h('div', { class: 'empty-block' }, 'Nenhuma fatura neste mês.');
  const label = { paid: 'paga', open: 'aberta', partial: 'parcial', overdue: 'vencida' };
  return panel(`Faturas de ${formatMonthShort(m)}`, null, h('div', { class: 'kvs' }, ...s.cardBills.map((b) => {
    const card = repo.get('accounts', b.cardId);
    const row = h('div', { class: 'kv' },
      h('span', { class: 'kv-label' }, card?.name || 'Cartão', h('span', { class: 'faint' }, b.dueDate ? ` · vence ${formatDateShort(b.dueDate)}` : ' · sem vencimento configurado')),
      h('span', { class: 'kv-value num' }, formatMoney(b.total), h('span', { class: `pill pill-${b.status}` }, label[b.status])));
    if (b.open > 0 && card) row.append(h('div', { class: 'kv-action' }, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openEntryForm({ defaults: { type: 'transfer', toAccountId: card.id, billMonth: m, amount: b.open, date: today(), status: 'done', sourceId: card.payAccountId || null } }) }, icon('check', 'icon-sm'), `Pagar ${formatMoney(b.open)}`)));
    return row;
  })));
}

export function customizeButton(section, rerender) {
  const on = isEditing(section);
  return h('button', { class: `btn${on ? ' btn-primary' : ''}`, type: 'button', 'aria-pressed': on ? 'true' : 'false', title: 'Reorganizar, redimensionar e escolher componentes desta tela',
    onclick: () => { setEditing(section, !on); rerender(); } }, icon('sliders', 'icon-sm'), on ? 'Concluir' : 'Personalizar');
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
  const rerender = () => renderOverview(root);
  const head = pageHead('Visão geral', { sub: isFuture ? 'Projeção com base nos compromissos cadastrados' : isCurrent ? `Resumo de ${formatMonth(m)}` : `Histórico de ${formatMonth(m)}`, controls: monthNav(), actions: customizeButton('overview', rerender) });
  const registry = overviewRegistry({ ctx, s, m, isCurrent, isFuture, cash, empty });
  put(root, head, backupReminder(), widgetGrid({ section: 'overview', registry, rerender }));
}

const BUDGET_STATE = { ok: 'Saudável', warn: 'Atenção', full: 'Limite atingido', over: 'Ultrapassado' };
export function budgetRow(b) {
  const name = b.scope === 'block' ? blockName(b.refId) : categoryName(b.refId);
  const warnAt = b.warnAt ?? repo.prefs().budgetWarnAt ?? 80;
  const lvl = budgetLevel(b.ratio, warnAt);
  const tone = lvl === 'over' ? 'neg' : lvl === 'ok' ? 'ok' : 'warn';
  return h('div', { class: `budget b-${lvl}` },
    h('div', { class: 'budget-top' }, h('span', { class: 'truncate' }, name),
      h('span', { class: `budget-state s-${lvl}` }, BUDGET_STATE[lvl]),
      h('span', { class: `num small ${lvl === 'over' ? 'neg' : lvl === 'ok' ? 'faint' : 'warn'}` }, lvl === 'over' ? `${formatMoney(-b.remaining)} acima` : `restam ${formatMoney(b.remaining)}`)),
    progress(b.ratio, { tone, label: `${name}: ${formatPercent(b.ratio * 100, 0)} do orçamento · ${BUDGET_STATE[lvl]}` }),
    h('div', { class: 'faint xsmall num' }, `${formatMoney(b.used)} de ${formatMoney(b.amount)} · ${formatPercent(b.ratio * 100, 0)}`));
}

export { simulateGoal };
