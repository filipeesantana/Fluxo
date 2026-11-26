import { h, icon, put } from '../utils/dom.js';
import { formatMoney, formatPercent } from '../utils/money.js';
import { currentMonth, today, formatMonth, formatMonthShort, formatDate, addMonths, isMonth, isISODate, lastDay } from '../utils/dates.js';
import * as repo from '../database/repository.js';
import { summarize } from '../services/finance.js';
import { simulateGoal, projectSeries, monthlyRate, investmentValue, futureValue, monthsToTarget, simulateSchedule, goalRate } from '../services/investments.js';
import { lineChart, progress } from '../components/charts.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { toast, toastError } from '../components/toast.js';
import { field, moneyInput, segmented, readDecimal, checkbox } from '../components/fields.js';
import { openMenu } from '../components/menu.js';
import { pageHead, panel, emptyState, accountOptions, capitalize, kv } from './common.js';
import { readPref, writePref } from '../state.js';

const round = (x) => Math.round(x);

export function durationText(months) {
  if (months === 0) return 'já atingida';
  const y = Math.floor(months / 12), m = months % 12;
  return [y ? `${y} ${y === 1 ? 'ano' : 'anos'}` : null, m ? `${m} ${m === 1 ? 'mês' : 'meses'}` : null].filter(Boolean).join(' e ');
}
const rateText = (g) => (Number(g.annualRate) ? `${String(g.annualRate).replace('.', ',')}% ${g.rateMode === 'monthly' ? 'a.m.' : 'a.a.'}` : 'sem rentabilidade');

function goalStart(g) {
  const cm = currentMonth();
  return g.startMonth && g.startMonth > cm ? g.startMonth : cm;
}

/** Aportes variáveis: disponível para investir projetado de cada mês. */
function surplusContribution(start) {
  const ctx = repo.context();
  const cache = new Map();
  return (n) => {
    if (n > 120) return cache.get(120) ?? 0;
    if (!cache.has(n)) cache.set(n, Math.max(0, summarize(ctx, addMonths(start, n - 1)).availableToInvest));
    return cache.get(n);
  };
}

function simulate(g, current) {
  const start = goalStart(g);
  return simulateGoal({ ...g, initial: current, startMonth: start }, { contributionAt: g.useSurplus ? surplusContribution(start) : null });
}

export function renderInvestments(root) {
  const ctx = repo.context();
  const t = today();
  const cm = currentMonth();
  const invs = repo.list('investments').filter((i) => !i.archived).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const events = repo.list('investmentEvents');
  const values = new Map(invs.map((i) => [i.id, investmentValue(i, events, t)]));
  const totalInformed = [...values.values()].reduce((s, v) => s + v.informed, 0);
  const totalEstimated = [...values.values()].reduce((s, v) => s + v.estimated, 0);
  const anyRate = invs.some((i) => Number(i.annualRate));
  const s = summarize(ctx, cm);

  const head = pageHead('Investimentos', {
    sub: 'Patrimônio, metas e simulações. Rentabilidade é sempre opcional.',
    actions: [h('button', { class: 'btn', type: 'button', onclick: () => openInvestmentForm() }, icon('plus', 'icon-sm'), 'Investimento ou reserva'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openGoalForm() }, icon('target', 'icon-sm'), 'Nova meta')],
  });

  const kpis = h('div', { class: 'kpi-grid' },
    kpiBox('Patrimônio informado', totalInformed, 'invest', 'wallet', 'saldos registrados por você'),
    anyRate ? kpiBox('Estimado hoje', round(totalEstimated), 'plan', 'trend', 'aplica a rentabilidade informada (estimativa)') : kpiBox('Investimentos', invs.length, 'plan', 'layers', 'reservas e aplicações cadastradas', true),
    kpiBox('Aportado neste mês', s.contributed, 'neutral', 'in', s.withdrawn ? `${formatMoney(s.withdrawn)} resgatados` : 'aportes não são despesa'),
    kpiBox('Disponível para aportes', s.availableToInvest, 'accent', 'chart', `sobra livre de ${formatMonthShort(cm)}`));

  const goals = repo.list('goals').filter((g) => !g.archived);
  const linkCount = new Map();
  for (const g of goals) if (g.investmentId) linkCount.set(g.investmentId, (linkCount.get(g.investmentId) || 0) + 1);
  const goalsPanel = panel('Metas', { hint: 'sem rentabilidade, o cálculo considera só o que você guarda' },
    goals.length ? h('div', { class: 'goals-grid' }, ...goals.map((g) => goalCard(g, values, linkCount)))
      : h('div', { class: 'empty-block' }, 'Crie uma meta informando quanto quer juntar, quanto já tem e quanto consegue guardar por mês. Nada mais é obrigatório.',
        h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openGoalForm() }, icon('target', 'icon-sm'), 'Criar primeira meta')));

  const portfolio = panel('Patrimônio', { hint: 'valores informados são reais; estimativas não alteram nada' },
    invs.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, 'Investimento ou reserva'), h('th', { class: 'right' }, 'Informado'), h('th', null, 'Referência'), h('th', { class: 'right' }, 'Rentab.'), anyRate ? h('th', { class: 'right' }, 'Estimado hoje') : null, h('th', null, ''))),
      h('tbody', null, ...invs.map((inv) => {
        const v = values.get(inv.id);
        const more = h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': `Ações de ${inv.name}` }, icon('more'));
        more.addEventListener('click', () => openMenu(more, [
          { label: 'Registrar aporte', icon: 'plus', onSelect: () => openEventForm(inv, 'contribution') },
          { label: 'Registrar resgate', icon: 'arrow-right', onSelect: () => openEventForm(inv, 'withdrawal') },
          { label: 'Atualizar saldo informado', icon: 'edit', onSelect: () => openEventForm(inv, 'balance') },
          { label: 'Histórico', icon: 'list', onSelect: () => openHistory(inv) },
          { label: 'Editar', icon: 'settings', onSelect: () => openInvestmentForm(inv) },
          'sep',
          { label: 'Excluir', icon: 'trash', danger: true, onSelect: () => removeInvestment(inv) },
        ]));
        return h('tr', null,
          h('td', null, h('span', { class: 'strong' }, inv.name), inv.kind ? h('span', { class: 'faint' }, ` · ${inv.kind}`) : null),
          h('td', { class: 'right num strong' }, formatMoney(v.informed)),
          h('td', { class: 'faint num' }, v.refDate ? formatDate(v.refDate) : '—'),
          h('td', { class: 'right num faint' }, inv.annualRate ? `${String(inv.annualRate).replace('.', ',')}% a.a.` : '—'),
          anyRate ? h('td', { class: 'right num' }, formatMoney(round(v.estimated))) : null,
          h('td', { class: 'right' }, h('div', { class: 'row row-end' }, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openEventForm(inv, 'contribution') }, icon('plus', 'icon-sm'), 'Aporte'), more)));
      })))) : h('div', { class: 'empty-block' }, 'Cadastre reservas e aplicações com o saldo atual. Não há integração com bancos ou corretoras.',
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openInvestmentForm() }, icon('plus', 'icon-sm'), 'Cadastrar investimento')),
    invs.length ? patrimonyChart(invs, events) : null);

  put(root, head, kpis, goalsPanel, simulator(s, totalInformed), portfolio);
}

function kpiBox(label, value, tone, iconName, sub, plain = false) {
  return h('div', { class: `kpi kpi-${tone}` },
    h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-icon' }, icon(iconName)), h('span', { class: 'kpi-label' }, label)),
    h('span', { class: 'kpi-value num' }, plain ? String(value) : formatMoney(value)),
    h('span', { class: 'kpi-sub' }, sub));
}

/** Evolução do patrimônio informado nos últimos 12 meses (saldo no fim de cada mês). */
function patrimonyChart(invs, events) {
  const cm = currentMonth();
  const months = Array.from({ length: 12 }, (_, i) => addMonths(cm, i - 11));
  const vals = months.map((m) => {
    const end = lastDay(m);
    const evs = events.filter((e) => e.date <= end);
    return invs.reduce((sum, inv) => sum + investmentValue(inv, evs, end).informed, 0);
  });
  if (!vals.some((v) => v)) return null;
  return h('div', { style: { marginTop: '16px' } }, h('div', { class: 'faint small', style: { marginBottom: '6px' } }, 'Patrimônio informado no fim de cada mês'),
    lineChart([{ label: 'Patrimônio', values: vals, cls: 's-invest', area: true }], months.map((m) => capitalize(formatMonthShort(m))), { height: 180 }));
}

function goalCurrent(g, values) {
  if (g.investmentId && values.has(g.investmentId)) return values.get(g.investmentId).informed;
  return g.initial || 0;
}

function goalCard(g, values, linkCount) {
  const current = goalCurrent(g, values);
  const sim = simulate(g, current);
  const ratio = g.target ? current / g.target : 0;
  const remaining = Math.max(0, g.target - current);
  const more = h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': `Ações da meta ${g.name}` }, icon('more'));
  more.addEventListener('click', () => openMenu(more, [
    { label: 'Editar meta', icon: 'edit', onSelect: () => openGoalForm(g) },
    'sep',
    { label: 'Excluir meta', icon: 'trash', danger: true, onSelect: () => removeGoal(g) },
  ]));
  let forecast;
  if (sim.reached || remaining === 0) forecast = h('span', { class: 'pos strong' }, 'Meta atingida');
  else if (!sim.reachable) forecast = h('span', { class: 'warn' }, g.monthly || g.useSurplus ? 'Inalcançável com estes valores em 100 anos' : 'Informe quanto consegue guardar por mês para prever a conclusão');
  else forecast = h('span', null, 'Conclusão em ', h('strong', null, formatMonth(sim.completionMonth)), ` · ${durationText(sim.months)}`, sim.i ? h('span', { class: 'faint' }, ' (estimativa com rentabilidade)') : null);
  const overlap = g.investmentId && linkCount.get(g.investmentId) > 1;
  const detail = h('div', { class: 'goal-detail', hidden: true });
  const toggle = h('button', { class: 'link-btn small', type: 'button', 'aria-expanded': 'false', onclick: () => {
    const open = detail.hidden;
    detail.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'Ocultar evolução' : 'Ver evolução projetada';
    if (open && !detail.childElementCount) detail.append(goalDetail(g, current, sim));
  } }, 'Ver evolução projetada');
  const monthlyLabel = g.useSurplus ? 'sobra de cada mês' : formatMoney(g.monthly || 0);
  return h('article', { class: 'goal-card' },
    h('div', { class: 'goal-card-top' }, h('div', { class: 'grow' }, h('div', { class: 'goal-name truncate' }, g.name), h('div', { class: 'faint xsmall' }, rateText(g), g.deadline ? ` · prazo ${formatMonthShort(g.deadline)}` : '')), more),
    h('div', { class: 'goal-amounts' }, h('span', { class: 'now' }, formatMoney(current)), h('span', { class: 'of' }, `de ${formatMoney(g.target)}`)),
    progress(ratio, { tone: ratio >= 1 ? 'ok' : 'invest', label: `${g.name}: ${formatPercent(Math.min(1, ratio) * 100, 0)} concluído` }),
    h('div', { class: 'goal-stats' },
      h('div', { class: 'goal-stat' }, h('b', null, formatPercent(Math.min(1, ratio) * 100, 0)), h('span', null, 'concluído')),
      h('div', { class: 'goal-stat' }, h('b', null, formatMoney(remaining)), h('span', null, 'falta')),
      h('div', { class: 'goal-stat' }, h('b', null, monthlyLabel), h('span', null, 'por mês'))),
    h('div', { class: 'goal-forecast' }, icon('target', 'icon-sm'), forecast),
    g.deadline && Number.isFinite(sim.requiredMonthly) && !sim.reached ? h('div', { class: `small ${sim.onTrack ? 'pos' : 'warn'}` }, sim.onTrack ? 'No ritmo para o prazo.' : `Para chegar em ${formatMonthShort(g.deadline)}: ${formatMoney(Math.ceil(sim.requiredMonthly))}/mês.`) : null,
    overlap ? h('div', { class: 'note is-warn' }, icon('alert', 'icon-sm'), 'O mesmo investimento está vinculado a outra meta: o saldo está sendo contado nas duas.') : null,
    toggle, detail);
}

function goalDetail(g, current, sim) {
  const start = goalStart(g);
  const months = sim.reachable ? Math.max(sim.months, 1) : Math.min(sim.horizon || 120, 120);
  const series = sim.series ? sim.series.slice(0, months + 1) : projectSeries(current, g.monthly || 0, sim.i, months, sim.timing);
  const labels = series.map((p) => capitalize(formatMonthShort(addMonths(start, p.n))));
  return h('div', { class: 'stack' },
    lineChart([
      { label: 'Patrimônio da meta', values: series.map((p) => p.value), cls: 's-invest', area: true },
      { label: 'Total guardado', values: series.map((p) => p.contributed), cls: 's-contrib' },
    ], labels, { target: g.target, height: 180, frac: window.innerWidth > 1240 ? 0.31 : window.innerWidth > 760 ? 0.48 : 1 }),
    h('div', { class: 'kvs' },
      kv('Total guardado até a conclusão', formatMoney(round(sim.contributed))),
      sim.i ? kv('Rendimentos estimados', formatMoney(round(sim.earnings)), { cls: 'invest' }) : null,
      sim.i ? kv('Taxa mensal equivalente', formatPercent(sim.i * 100, 4)) : null,
      kv('Aporte no', sim.timing === 'start' ? 'início do mês' : 'fim do mês')));
}

// ——— Simulador ———

function simulator(s, totalInformed) {
  const saved = (() => { try { return JSON.parse(readPref('sim2', '{}')); } catch { return {}; } })();
  const initial = moneyInput({ value: saved.initial ?? totalInformed, allowZero: true });
  const monthly = moneyInput({ value: saved.monthly ?? (s.availableToInvest || null), allowZero: true });
  const target = moneyInput({ value: saved.target ?? null, allowZero: true, placeholder: 'opcional' });
  const years = h('input', { class: 'input', type: 'number', min: 1, max: 60, step: 1, value: saved.years ?? 5 });
  const rate = h('input', { class: 'input', inputmode: 'decimal', value: saved.rate ?? '', placeholder: '0' });
  let rateMode = saved.rateMode || 'annual';
  let timing = saved.timing || 'end';
  let useSurplus = Boolean(saved.useSurplus);
  const rateModeSeg = segmented({ label: 'Tipo de taxa', size: 'segmented-sm', value: rateMode, options: [{ value: 'annual', label: '% ao ano' }, { value: 'monthly', label: '% ao mês' }], onChange: (v) => { rateMode = v; update(); } });
  const timingSeg = segmented({ label: 'Momento do aporte', size: 'segmented-sm', value: timing, options: [{ value: 'end', label: 'Fim do mês' }, { value: 'start', label: 'Início do mês' }], onChange: (v) => { timing = v; update(); } });
  const surplusCheck = checkbox('Usar a sobra projetada de cada mês', { checked: useSurplus, hint: 'aportes variáveis', onChange: (v) => { useSurplus = v; monthly.input.disabled = v; update(); } });
  monthly.input.disabled = useSurplus;
  const chips = h('div', { class: 'chips' });
  const base = s.availableToInvest;
  if (base > 0) {
    for (const [label, v] of [['Usar sobra mensal', base], ['2/3 da sobra', Math.round((base * 2) / 3)], ['Metade', Math.round(base / 2)]]) {
      chips.append(h('button', { class: 'chip', type: 'button', onclick: () => { useSurplus = false; surplusCheck.input.checked = false; monthly.input.disabled = false; monthly.setValue(v); update(); } }, `${label} · ${formatMoney(v)}`));
    }
  }
  const out = h('div', { class: 'sim-out' });
  function update() {
    const p = { initial: initial.getValue() ?? 0, monthly: monthly.getValue() ?? 0, target: target.getValue() ?? 0, years: Math.max(1, Math.min(60, Number(years.value) || 5)), rate: rate.value.trim() ? readDecimal(rate.value) : 0 };
    writePref('sim2', JSON.stringify({ ...p, rate: rate.value, rateMode, timing, useSurplus }));
    if (!Number.isFinite(p.rate) || p.rate <= -100) { put(out, h('p', { class: 'warn small' }, 'Rentabilidade inválida.')); return; }
    const i = rateMode === 'monthly' ? p.rate / 100 : monthlyRate(p.rate);
    const n = p.years * 12;
    const start = currentMonth();
    const contrib = useSurplus ? surplusContribution(start) : () => p.monthly;
    const run = simulateSchedule({ initial: p.initial, target: Infinity, i, timing, contribution: contrib, maxMonths: n });
    const series = run.series;
    const final = series[series.length - 1];
    const toTarget = p.target > 0 ? simulateSchedule({ initial: p.initial, target: p.target, i, timing, contribution: contrib }).months : null;
    const stepY = n > 36 ? 12 : n > 12 ? 3 : 1;
    const pts = series.filter((x) => x.n % stepY === 0 || x.n === n);
    const scenarios = useSurplus ? [] : [p.monthly, Math.round(p.monthly * 0.66), Math.round(p.monthly * 1.5)].filter((v, k, a) => v > 0 && a.indexOf(v) === k);
    put(out,
      h('div', { class: 'kvs kvs-grid' },
        kv(`Em ${p.years} ${p.years === 1 ? 'ano' : 'anos'}`, formatMoney(round(final.value)), { cls: 'kv-strong invest' }),
        kv('Total guardado', formatMoney(round(final.contributed))),
        i ? kv('Rendimentos estimados', formatMoney(round(final.value - final.contributed))) : kv('Rendimentos', 'não considerados (0%)'),
        i ? kv('Taxa mensal equivalente', formatPercent(i * 100, 4)) : null,
        p.target > 0 ? kv('Tempo até a meta', toTarget === null ? 'inalcançável' : toTarget === 0 ? 'já atingida' : `${durationText(toTarget)} · ${formatMonthShort(addMonths(start, toTarget))}`) : null),
      lineChart([
        { label: 'Patrimônio simulado', values: pts.map((x) => x.value), cls: 's-invest', area: true },
        { label: 'Total guardado', values: pts.map((x) => x.contributed), cls: 's-contrib' },
      ], pts.map((x) => (stepY === 12 ? `${Math.round(x.n / 12)}a` : capitalize(formatMonthShort(addMonths(start, x.n))))), { target: p.target > 0 ? p.target : null, height: 200, frac: window.innerWidth > 1240 ? 0.66 : 1 }),
      scenarios.length > 1 ? h('div', { class: 'table-wrap' }, h('table', { class: 'table table-compact' },
        h('thead', null, h('tr', null, h('th', null, 'Aporte mensal'), h('th', { class: 'right' }, `Em ${p.years} anos`), p.target > 0 ? h('th', { class: 'right' }, 'Tempo até a meta') : null)),
        h('tbody', null, ...scenarios.map((v) => {
          const fv = futureValue(p.initial, v, i, n, timing);
          const mt = p.target > 0 ? monthsToTarget(p.target, p.initial, v, i, timing) : null;
          return h('tr', { class: v === p.monthly ? 'is-current' : '' }, h('td', { class: 'num' }, formatMoney(v)), h('td', { class: 'right num' }, formatMoney(round(fv))),
            p.target > 0 ? h('td', { class: 'right' }, mt === null ? 'inalcançável' : mt === 0 ? 'já atingida' : durationText(mt)) : null);
        })))) : null,
      h('p', { class: 'note' }, icon('info', 'icon-sm'), 'Simulação: nenhum investimento é registrado e o patrimônio real não muda.'));
  }
  for (const el of [initial.input, monthly.input, target.input, years, rate]) el.addEventListener('input', update);
  update();
  const advanced = h('details', { class: 'advanced', open: Boolean(saved.rate) },
    h('summary', null, icon('chev-right', 'icon-sm'), 'Rentabilidade e opções avançadas'),
    h('div', { class: 'advanced-body' },
      h('div', { class: 'form-grid' }, field(h('span', null, 'Rentabilidade ', h('span', { class: 'opt' }, 'opcional')), rate, { hint: 'Em branco = 0%' }), field('Tipo', rateModeSeg)),
      field('Aporte no', timingSeg), surplusCheck));
  return panel('Simulador de aportes', { hint: 'compare cenários sem alterar o patrimônio' },
    h('div', { class: 'sim' },
      h('div', { class: 'sim-in' },
        h('div', { class: 'form-grid' }, field('Já tenho', initial), field('Guardo por mês', monthly), field('Meta', target), field('Horizonte (anos)', years)),
        chips.childElementCount ? h('div', { class: 'stack' }, h('span', { class: 'faint small' }, 'Referência: o Fluxo calculou a sobra livre deste mês.'), chips) : null,
        advanced),
      out));
}

// ——— Formulários ———

function openInvestmentForm(inv = null) {
  const name = h('input', { class: 'input', value: inv?.name || '', maxlength: 80, placeholder: 'Ex.: Reserva de emergência, Tesouro Selic' });
  const kind = h('input', { class: 'input', value: inv?.kind || '', maxlength: 40, placeholder: 'Ex.: CDB, poupança' });
  const balance = moneyInput({ value: inv ? null : 0, allowZero: true });
  const ref = h('input', { class: 'input', type: 'date', value: today() });
  const rate = h('input', { class: 'input', inputmode: 'decimal', value: inv?.annualRate != null ? String(inv.annualRate).replace('.', ',') : '', placeholder: 'Em branco = sem estimativa' });
  const fName = field('Nome', name);
  const save = h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
    const r = rate.value.trim() ? readDecimal(rate.value) : null;
    fName.setError(name.value.trim() ? '' : 'Informe um nome');
    if (!name.value.trim()) return;
    if (r !== null && (!Number.isFinite(r) || r <= -100 || r >= 1000)) { toast('Rentabilidade inválida', { tone: 'error' }); return; }
    save.classList.add('is-busy');
    try {
      await repo.saveInvestment({ ...(inv || {}), name: name.value, kind: kind.value.trim() || null, annualRate: r || null, ...(inv ? {} : { initialBalance: balance.getValue() ?? 0, refDate: isISODate(ref.value) ? ref.value : today() }) });
      m.close(); toast(inv ? 'Investimento atualizado' : 'Investimento cadastrado', { tone: 'success' });
    } catch (err) { toastError(err); } finally { save.classList.remove('is-busy'); }
  } }, 'Salvar');
  const m = openModal({ title: inv ? 'Editar investimento' : 'Novo investimento ou reserva', size: 'sm',
    body: h('div', { class: 'stack-lg' }, fName, inv ? null : h('div', { class: 'form-grid' }, field('Valor atual', balance), field('Data de referência', ref)),
      h('details', { class: 'advanced', open: Boolean(inv?.annualRate || inv?.kind) }, h('summary', null, icon('chev-right', 'icon-sm'), 'Opções avançadas'),
        h('div', { class: 'advanced-body' }, field('Tipo', kind), field(h('span', null, 'Rentabilidade (% a.a.) ', h('span', { class: 'opt' }, 'opcional')), rate, { hint: 'Usada apenas para estimativas; não altera o valor informado' })))),
    footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), save] });
}

function openEventForm(inv, type) {
  const titles = { contribution: 'Registrar aporte', withdrawal: 'Registrar resgate', balance: 'Atualizar saldo informado' };
  const amount = moneyInput({ allowZero: type === 'balance' });
  const date = h('input', { class: 'input', type: 'date', value: today() });
  const account = h('select', { class: 'select' }, h('option', { value: '' }, 'Não movimentar conta'), ...accountOptions({ filter: (a) => a.kind !== 'credit' && a.kind !== 'benefit' }).map((o) => h('option', { value: o.value }, o.label)));
  const fAmount = field(type === 'balance' ? 'Saldo atual informado' : 'Valor', amount);
  const save = h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
    const cents = amount.getValue();
    const ok = cents != null && (type === 'balance' ? cents >= 0 : cents > 0) && isISODate(date.value);
    fAmount.setError(ok ? '' : 'Informe um valor válido');
    if (!ok || save.classList.contains('is-busy')) return;
    save.classList.add('is-busy');
    try {
      await repo.addInvestmentEvent({ investmentId: inv.id, type, amount: cents, date: date.value, accountId: type === 'balance' ? null : account.value || null });
      m.close(); toast(type === 'contribution' ? 'Aporte registrado' : type === 'withdrawal' ? 'Resgate registrado' : 'Saldo atualizado', { tone: 'success' });
    } catch (err) { toastError(err); } finally { save.classList.remove('is-busy'); }
  } }, 'Salvar');
  const m = openModal({ title: `${titles[type]} · ${inv.name}`, size: 'sm',
    body: h('div', { class: 'stack-lg' }, h('div', { class: 'form-grid' }, fAmount, field('Data', date)),
      type !== 'balance' ? field(type === 'contribution' ? 'Saiu da conta' : 'Entrou na conta', account, { hint: 'Atualiza o saldo da conta. Aportes não contam como despesa.' }) : h('p', { class: 'faint small' }, 'O saldo informado substitui a base a partir desta data. Aportes e resgates posteriores são somados a ele.')),
    footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), save] });
}

function openHistory(inv) {
  const label = { balance: 'Saldo informado', contribution: 'Aporte', withdrawal: 'Resgate' };
  const evs = repo.list('investmentEvents').filter((e) => e.investmentId === inv.id).sort((a, b) => (a.date < b.date ? 1 : -1));
  const body = evs.length ? h('div', { class: 'kvs' }, ...evs.map((e) => h('div', { class: 'kv' },
    h('span', { class: 'kv-label' }, `${formatDate(e.date)} · ${label[e.type]}`),
    h('span', { class: 'kv-value num' }, formatMoney(e.amount),
      h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': 'Excluir registro', onclick: async () => {
        if (!(await confirmDialog({ title: 'Excluir registro?', message: `${label[e.type]} de ${formatMoney(e.amount)} em ${formatDate(e.date)}.`, confirmLabel: 'Excluir', danger: true }))) return;
        try { await repo.deleteInvestmentEvent(e.id); m.close(); toast('Registro excluído'); } catch (err) { toastError(err); }
      } }, icon('trash', 'icon-sm')))))) : h('p', { class: 'muted' }, 'Sem registros.');
  const m = openModal({ title: `Histórico · ${inv.name}`, body, size: 'sm', drawer: true });
}

async function removeInvestment(inv) {
  if (!(await confirmDialog({ title: 'Excluir investimento?', message: `“${inv.name}” e todo o seu histórico de saldos, aportes e resgates serão removidos. Metas vinculadas ficam sem vínculo.`, confirmLabel: 'Excluir', danger: true }))) return;
  try { await repo.deleteInvestment(inv.id); toast('Investimento excluído'); } catch (err) { toastError(err); }
}

export function openGoalForm(g = null) {
  const invs = repo.list('investments').filter((i) => !i.archived);
  const s = summarize(repo.context(), currentMonth());
  const name = h('input', { class: 'input', value: g?.name || '', maxlength: 80, placeholder: 'Ex.: Entrada da moto' });
  const target = moneyInput({ value: g?.target ?? null });
  const initial = moneyInput({ value: g?.initial ?? null, allowZero: true, placeholder: '0,00' });
  const monthly = moneyInput({ value: g?.monthly ?? null, allowZero: true });
  const rate = h('input', { class: 'input', inputmode: 'decimal', value: g?.annualRate ? String(g.annualRate).replace('.', ',') : '', placeholder: 'Em branco = 0%' });
  let rateMode = g?.rateMode || 'annual';
  const rateModeSeg = segmented({ label: 'Tipo de taxa', size: 'segmented-sm', value: rateMode, options: [{ value: 'annual', label: '% ao ano' }, { value: 'monthly', label: '% ao mês' }], onChange: (v) => { rateMode = v; preview(); } });
  const start = h('input', { class: 'input', type: 'month', value: g?.startMonth || currentMonth() });
  const deadline = h('input', { class: 'input', type: 'month', value: g?.deadline || '' });
  const link = h('select', { class: 'select' }, h('option', { value: '' }, 'Não vincular'), ...invs.map((i) => h('option', { value: i.id }, i.name)));
  link.value = g?.investmentId || '';
  let timing = g?.timing || 'end';
  const timingSeg = segmented({ label: 'Aporte no', size: 'segmented-sm', value: timing, options: [{ value: 'end', label: 'Fim do mês' }, { value: 'start', label: 'Início do mês' }], onChange: (v) => { timing = v; preview(); } });
  const useSurplus = checkbox('Guardar a sobra projetada de cada mês', { checked: Boolean(g?.useSurplus), hint: 'aportes variáveis', onChange: () => { monthly.input.disabled = useSurplus.input.checked; preview(); } });
  monthly.input.disabled = Boolean(g?.useSurplus);
  let extras = [...(g?.extras || [])];
  const extrasList = h('div', { class: 'stack' });
  const exMonth = h('input', { class: 'input', type: 'month', value: addMonths(currentMonth(), 1) });
  const exAmount = moneyInput({});
  const drawExtras = () => put(extrasList, ...extras.map((e, i) => h('div', { class: 'similar-item' }, h('span', null, `${capitalize(formatMonthShort(e.month))} · ${formatMoney(e.amount)}`),
    h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': 'Remover aporte extra', onclick: () => { extras = extras.filter((_, j) => j !== i); drawExtras(); preview(); } }, icon('x', 'icon-sm')))));
  const addExtra = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { const v = exAmount.getValue(); if (!v || !isMonth(exMonth.value)) { toast('Informe mês e valor do aporte extra', { tone: 'error' }); return; } extras.push({ month: exMonth.value, amount: v }); exAmount.setValue(null); drawExtras(); preview(); } }, icon('plus', 'icon-sm'), 'Adicionar');
  drawExtras();
  const out = h('div', { class: 'banner' });
  const sobra = s.availableToInvest > 0 ? h('button', { class: 'chip', type: 'button', onclick: () => { useSurplus.input.checked = false; monthly.input.disabled = false; monthly.setValue(s.availableToInvest); preview(); } }, `Usar sobra mensal · ${formatMoney(s.availableToInvest)}`) : null;

  function draft() {
    const r = rate.value.trim() ? readDecimal(rate.value) : 0;
    return { name: name.value.trim(), target: target.getValue(), initial: initial.getValue() ?? 0, monthly: monthly.getValue() ?? 0, annualRate: r || null, rateMode, startMonth: isMonth(start.value) ? start.value : currentMonth(), deadline: isMonth(deadline.value) ? deadline.value : null, timing, investmentId: link.value || null, useSurplus: useSurplus.input.checked, extras };
  }
  function preview() {
    const d = draft();
    if (!d.target) { put(out, icon('info', 'icon-sm'), h('span', null, 'Informe o valor desejado para ver quanto falta e quando a meta será atingida.')); return; }
    if (!Number.isFinite(Number(d.annualRate ?? 0))) { put(out, h('span', { class: 'warn' }, 'Rentabilidade inválida.')); return; }
    const current = d.investmentId ? investmentValue(repo.get('investments', d.investmentId), repo.list('investmentEvents'), today()).informed : d.initial;
    const sim = simulate(d, current);
    const remaining = Math.max(0, d.target - current);
    const pct = Math.min(100, (current / d.target) * 100);
    const when = sim.reached || !remaining ? 'Meta já atingida.' : sim.reachable ? `Conclusão em ${formatMonth(sim.completionMonth)} (${durationText(sim.months)}${sim.i ? ', estimativa com rentabilidade' : ' de aportes'}).` : 'Com estes valores a meta não é atingida. Informe quanto consegue guardar por mês.';
    put(out, icon('target', 'icon-sm'), h('span', null, h('strong', null, `Falta ${formatMoney(remaining)} · ${formatPercent(pct, 0)} concluído. `), when));
  }
  for (const el of [target.input, initial.input, monthly.input, rate, start, deadline]) el.addEventListener('input', preview);
  link.addEventListener('change', preview);
  preview();

  const fName = field('Nome da meta', name), fTarget = field('Valor desejado', target);
  const save = h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
    const d = draft();
    fName.setError(d.name ? '' : 'Dê um nome para a meta');
    fTarget.setError(d.target ? '' : 'Informe o valor desejado');
    if (!d.name || !d.target) return;
    if (d.annualRate != null && (!Number.isFinite(d.annualRate) || d.annualRate <= -100 || d.annualRate >= 1000)) { toast('Rentabilidade inválida', { tone: 'error' }); return; }
    save.classList.add('is-busy');
    try { await repo.saveGoal({ ...(g || {}), ...d }); m.close(); toast(g ? 'Meta atualizada' : 'Meta criada', { tone: 'success' }); }
    catch (err) { toastError(err); } finally { save.classList.remove('is-busy'); }
  } }, g ? 'Salvar' : 'Criar meta');
  const m = openModal({ title: g ? 'Editar meta' : 'Nova meta',
    body: h('div', { class: 'stack-lg' },
      fName,
      h('div', { class: 'form-grid' }, fTarget, field('Valor que já tenho', initial), field('Quanto consigo guardar por mês', monthly, { className: 'span-2' })),
      sobra ? h('div', { class: 'chips' }, sobra) : null,
      out,
      h('details', { class: 'advanced', open: Boolean(g?.annualRate || g?.deadline || g?.investmentId || g?.extras?.length || g?.useSurplus) },
        h('summary', null, icon('chev-right', 'icon-sm'), 'Opções avançadas (todas opcionais)'),
        h('div', { class: 'advanced-body' },
          h('div', { class: 'form-grid' }, field('Rentabilidade estimada', rate, { hint: 'Juros compostos; resultado é estimativa' }), field('Tipo de taxa', rateModeSeg),
            field('Data desejada', deadline, { hint: 'Calcula o aporte necessário' }), field('Início dos aportes', start),
            field('Vincular a investimento', link, { hint: 'Usa o saldo informado como valor atual' }), field('Aporte no', timingSeg)),
          useSurplus,
          h('div', { class: 'stack' }, h('span', { class: 'field-label' }, 'Aportes extraordinários'), extrasList, h('div', { class: 'form-grid' }, field('Mês', exMonth), field('Valor', exAmount)), h('div', null, addExtra))))),
    footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), save] });
}

async function removeGoal(g) {
  if (!(await confirmDialog({ title: 'Excluir meta?', message: `A meta “${g.name}” será removida. Nenhum investimento é alterado.`, confirmLabel: 'Excluir', danger: true }))) return;
  try { await repo.deleteGoal(g.id); toast('Meta excluída'); } catch (err) { toastError(err); }
}

export { goalRate };
