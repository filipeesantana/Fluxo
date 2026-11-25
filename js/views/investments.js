import { h, icon, put } from '../utils/dom.js';
import { formatMoney, formatPercent } from '../utils/money.js';
import { currentMonth, today, formatMonth, formatMonthShort, formatDate, addMonths, isMonth, isISODate, monthOf } from '../utils/dates.js';
import * as repo from '../database/repository.js';
import { summarize } from '../services/finance.js';
import { simulateGoal, projectSeries, monthlyRate, investmentValue, futureValue, monthsToTarget } from '../services/investments.js';
import { lineChart, progress } from '../components/charts.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { toast, toastError } from '../components/toast.js';
import { field, moneyInput, segmented, readDecimal } from '../components/fields.js';
import { openMenu } from '../components/menu.js';
import { pageHead, emptyState, accountOptions, capitalize, kv } from './common.js';
import { readPref, writePref } from '../state.js';

const fmtRate = (r) => (r || r === 0 ? `${String(r).replace('.', ',')}% a.a.` : '—');
const round = (x) => Math.round(x);

function durationText(months) {
  if (months === 0) return 'já atingida';
  const y = Math.floor(months / 12), m = months % 12;
  return [y ? `${y} ${y === 1 ? 'ano' : 'anos'}` : null, m ? `${m} ${m === 1 ? 'mês' : 'meses'}` : null].filter(Boolean).join(' e ');
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
  const s = summarize(ctx, cm);

  const head = pageHead('Investimentos', h('span', { class: 'spacer' }),
    h('button', { class: 'btn', type: 'button', onclick: () => openGoalForm() }, icon('target', 'icon-sm'), 'Nova meta'),
    h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openInvestmentForm() }, icon('plus'), 'Novo investimento'));

  const kpis = h('div', { class: 'kpis kpis-4' },
    kpiStatic('Patrimônio informado', formatMoney(totalInformed), 'saldos registrados por você'),
    kpiStatic('Patrimônio estimado hoje', formatMoney(round(totalEstimated)), 'aplica a rentabilidade informada'),
    kpiStatic('Aportado neste mês', formatMoney(s.contributed), s.withdrawn ? `${formatMoney(s.withdrawn)} resgatados` : ' '),
    kpiStatic('Disponível para aportes', formatMoney(s.availableToInvest), `sobra livre de ${formatMonthShort(cm)}`),
  );

  const portfolio = h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', null, 'Patrimônio'), h('span', { class: 'hint' }, 'valores informados são reais; estimativas não alteram nada')),
    invs.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, 'Investimento ou reserva'), h('th', { class: 'right' }, 'Informado'), h('th', null, 'Referência'), h('th', { class: 'right' }, 'Rentab.'), h('th', { class: 'right' }, 'Estimado hoje'), h('th', null, ''))),
      h('tbody', null, ...invs.map((inv) => {
        const v = values.get(inv.id);
        const more = h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': 'Ações' }, icon('more'));
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
          h('td', null, inv.name, inv.kind ? h('span', { class: 'faint' }, ` · ${inv.kind}`) : null),
          h('td', { class: 'right num' }, formatMoney(v.informed)),
          h('td', { class: 'faint num' }, v.refDate ? formatDate(v.refDate) : '—'),
          h('td', { class: 'right num faint' }, fmtRate(inv.annualRate)),
          h('td', { class: 'right num' }, formatMoney(round(v.estimated))),
          h('td', { class: 'right' }, h('div', { class: 'row row-end' },
            h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openEventForm(inv, 'contribution') }, 'Aporte'), more)));
      })))) : emptyState('Nenhum investimento cadastrado', 'Cadastre reservas e aplicações com o saldo atual. Não há integração com corretoras: os valores são informados por você.'));

  const goals = repo.list('goals').filter((g) => !g.archived);
  const goalsSection = h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', null, 'Metas'), h('span', { class: 'hint' }, 'aportes ao fim de cada mês, salvo indicação')),
    goals.length ? h('div', { class: 'goals' }, ...goals.map((g) => goalRow(g, values))) : emptyState('Nenhuma meta', 'Ex.: reserva de emergência, entrada da moto, viagem, certificações ou patrimônio de R$ 100.000,00.', h('button', { class: 'btn', type: 'button', onclick: () => openGoalForm() }, 'Criar meta')));

  put(root, head, kpis, portfolio, goalsSection, simulator(s, totalInformed));
}

function kpiStatic(label, value, sub) {
  return h('div', { class: 'kpi' }, h('span', { class: 'kpi-label' }, label), h('span', { class: 'kpi-value num' }, value), h('span', { class: 'kpi-sub' }, sub));
}

function goalCurrent(g, values) {
  if (g.investmentId && values.has(g.investmentId)) return values.get(g.investmentId).informed;
  return g.initial || 0;
}

function goalRow(g, values) {
  const current = goalCurrent(g, values);
  const sim = simulateGoal({ ...g, initial: current, startMonth: goalStart(g) });
  const ratio = g.target ? current / g.target : 0;
  const more = h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': 'Ações' }, icon('more'));
  more.addEventListener('click', (ev) => { ev.stopPropagation(); openMenu(more, [
    { label: 'Editar meta', icon: 'edit', onSelect: () => openGoalForm(g) },
    'sep',
    { label: 'Excluir meta', icon: 'trash', danger: true, onSelect: () => removeGoal(g) },
  ]); });
  let status;
  if (sim.reached) status = h('span', { class: 'pos' }, 'Meta atingida');
  else if (!sim.reachable) status = h('span', { class: 'warn' }, 'Inalcançável com estes parâmetros');
  else status = h('span', null, `Conclusão em ${formatMonth(sim.completionMonth)} · ${durationText(sim.months)}`);
  const detail = h('div', { class: 'goal-detail', hidden: true });
  const toggle = h('button', { class: 'goal-head', type: 'button', 'aria-expanded': 'false', onclick: () => {
    const open = detail.hidden;
    detail.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open && !detail.childElementCount) detail.append(goalDetail(g, current, sim));
  } },
  h('span', { class: 'goal-name truncate' }, g.name),
  h('span', { class: 'goal-amounts num' }, formatMoney(current), h('span', { class: 'faint' }, ` de ${formatMoney(g.target)}`)),
  h('span', { class: 'goal-status small' }, status),
  icon('chev-down', 'icon-sm goal-chev'));
  return h('article', { class: 'goal' }, h('div', { class: 'goal-row' }, toggle, more), progress(ratio, { tone: ratio >= 1 ? 'ok' : 'accent' }), detail);
}

function goalStart(g) {
  const cm = currentMonth();
  return g.startMonth && g.startMonth > cm ? g.startMonth : cm;
}

function goalDetail(g, current, sim) {
  const months = sim.reachable ? Math.max(sim.months, 1) : Math.min(sim.horizon, 120);
  const series = projectSeries(current, g.monthly || 0, sim.i, months, sim.timing);
  const start = goalStart(g);
  const labels = series.map((p) => formatMonthShort(addMonths(start, p.n)));
  const stats = h('div', { class: 'kvs kvs-grid' },
    kv('Tempo necessário', sim.reached ? 'já atingida' : sim.reachable ? durationText(sim.months) : '—'),
    kv('Data estimada', sim.completionMonth && !sim.reached ? capitalize(formatMonth(sim.completionMonth)) : '—'),
    kv('Patrimônio projetado', sim.reachable ? formatMoney(round(sim.projected)) : `${formatMoney(round(sim.projected))} em 30 anos`),
    kv('Total aportado', formatMoney(round(sim.contributed))),
    kv('Rendimentos estimados', formatMoney(round(sim.earnings))),
    kv('Valor restante', formatMoney(round(sim.remaining))),
    kv('Taxa mensal equivalente', formatPercent(sim.i * 100, 4)),
    g.deadline ? kv(`Aporte necessário até ${formatMonthShort(g.deadline)}`, Number.isFinite(sim.requiredMonthly) ? `${formatMoney(Math.ceil(sim.requiredMonthly))}/mês` : 'prazo já passou', { cls: sim.onTrack ? 'pos' : 'warn' }) : null,
  );
  return h('div', { class: 'stack' }, stats, lineChart([
    { label: 'Patrimônio projetado', values: series.map((p) => p.value), cls: 's-total', area: true },
    { label: 'Total aportado', values: series.map((p) => p.contributed), cls: 's-contrib' },
  ], labels, { target: g.target }));
}

function simulator(s, totalInformed) {
  const saved = (() => { try { return JSON.parse(readPref('sim', '{}')); } catch { return {}; } })();
  const initial = moneyInput({ value: saved.initial ?? totalInformed, allowZero: true });
  const monthly = moneyInput({ value: saved.monthly ?? (s.availableToInvest || null), allowZero: true });
  const rate = h('input', { class: 'input', inputmode: 'decimal', value: saved.rate ?? '10', 'aria-label': 'Rentabilidade anual' });
  const target = moneyInput({ value: saved.target ?? 10000000, allowZero: true });
  const years = h('input', { class: 'input', type: 'number', min: 1, max: 60, step: 1, value: saved.years ?? 10 });
  let timing = saved.timing || 'end';
  const timingSeg = segmented({ label: 'Momento do aporte', value: timing, options: [{ value: 'end', label: 'Fim do mês' }, { value: 'start', label: 'Início do mês' }], onChange: (v) => { timing = v; update(); } });
  const chips = h('div', { class: 'chips' });
  const out = h('div', { class: 'sim-out' });
  const base = s.availableToInvest || s.projectedSurplus;
  if (base > 0) {
    for (const [label, v] of [['Sobra do mês', base], ['2/3 da sobra', Math.round((base * 2) / 3)], ['Metade', Math.round(base / 2)]]) {
      chips.append(h('button', { class: 'chip', type: 'button', onclick: () => { monthly.setValue(v); update(); } }, `${label} · ${formatMoney(v)}`));
    }
  }
  function update() {
    const p = { initial: initial.getValue() ?? 0, monthly: monthly.getValue() ?? 0, rate: readDecimal(rate.value), target: target.getValue() ?? 0, years: Math.max(1, Math.min(60, Number(years.value) || 10)), timing };
    writePref('sim', JSON.stringify({ ...p, rate: rate.value }));
    if (!Number.isFinite(p.rate) || p.rate <= -100) { put(out, h('p', { class: 'warn small' }, 'Rentabilidade inválida.')); return; }
    const i = monthlyRate(p.rate);
    const n = p.years * 12;
    const series = projectSeries(p.initial, p.monthly, i, n, timing);
    const final = series[n];
    const toTarget = p.target > 0 ? monthsToTarget(p.target, p.initial, p.monthly, i, timing) : null;
    const scenarios = [p.monthly, Math.round(p.monthly * 0.66), Math.round(p.monthly * 1.5)].filter((v, k, a) => v > 0 && a.indexOf(v) === k);
    const start = currentMonth();
    const stepY = n > 24 ? 12 : 1;
    const pts = series.filter((x) => x.n % stepY === 0 || x.n === n);
    put(out, 
      h('div', { class: 'kvs kvs-grid' },
        kv(`Patrimônio em ${p.years} ${p.years === 1 ? 'ano' : 'anos'}`, formatMoney(round(final.value)), { cls: 'kv-strong' }),
        kv('Total aportado', formatMoney(round(final.contributed))),
        kv('Rendimentos estimados', formatMoney(round(final.value - final.contributed))),
        kv('Taxa mensal equivalente', formatPercent(i * 100, 4)),
        p.target > 0 ? kv('Tempo até a meta', toTarget === null ? 'inalcançável' : toTarget === 0 ? 'já atingida' : `${durationText(toTarget)} · ${formatMonthShort(addMonths(start, toTarget))}`) : null),
      lineChart([
        { label: 'Patrimônio', values: pts.map((x) => x.value), cls: 's-total', area: true },
        { label: 'Aportado', values: pts.map((x) => x.contributed), cls: 's-contrib' },
      ], pts.map((x) => (stepY === 12 ? `${Math.round(x.n / 12)}a` : formatMonthShort(addMonths(start, x.n)))), { target: p.target > 0 ? p.target : null }),
      scenarios.length > 1 ? h('div', { class: 'table-wrap' }, h('table', { class: 'table table-compact' },
        h('thead', null, h('tr', null, h('th', null, 'Aporte mensal'), h('th', { class: 'right' }, `Em ${p.years} anos`), h('th', { class: 'right' }, 'Rendimentos'), p.target > 0 ? h('th', { class: 'right' }, 'Tempo até a meta') : null)),
        h('tbody', null, ...scenarios.map((v) => {
          const fv = futureValue(p.initial, v, i, n, timing);
          const mt = p.target > 0 ? monthsToTarget(p.target, p.initial, v, i, timing) : null;
          return h('tr', { class: v === p.monthly ? 'is-current' : '' }, h('td', { class: 'num' }, formatMoney(v)), h('td', { class: 'right num' }, formatMoney(round(fv))), h('td', { class: 'right num faint' }, formatMoney(round(fv - p.initial - v * n))),
            p.target > 0 ? h('td', { class: 'right' }, mt === null ? 'inalcançável' : mt === 0 ? 'já atingida' : durationText(mt)) : null);
        })))) : null,
    );
  }
  for (const el of [initial.input, monthly.input, rate, target.input, years]) el.addEventListener('input', update);
  update();
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', null, 'Simulador de aportes'), h('span', { class: 'hint' }, 'compare cenários sem alterar o patrimônio')),
    h('div', { class: 'sim' },
      h('div', { class: 'sim-in' },
        h('div', { class: 'form-grid' }, field('Patrimônio inicial', initial), field('Aporte mensal', monthly), field('Rentabilidade anual (%)', rate, { hint: 'Taxa efetiva; convertida para mensal' }), field('Meta (opcional)', target), field('Horizonte (anos)', years), field('Aporte no', timingSeg)),
        chips.childElementCount ? h('div', { class: 'stack' }, h('span', { class: 'faint small' }, 'Usar como referência a sobra projetada:'), chips) : null),
      out));
}

// ——— Formulários ———

function openInvestmentForm(inv = null) {
  const name = h('input', { class: 'input', value: inv?.name || '', maxlength: 80, placeholder: 'Ex.: Reserva de emergência, Tesouro Selic' });
  const kind = h('input', { class: 'input', value: inv?.kind || '', maxlength: 40, placeholder: 'Opcional: CDB, ações, poupança…' });
  const balance = moneyInput({ value: inv ? null : 0, allowZero: true });
  const ref = h('input', { class: 'input', type: 'date', value: today() });
  const rate = h('input', { class: 'input', inputmode: 'decimal', value: inv?.annualRate != null ? String(inv.annualRate).replace('.', ',') : '', placeholder: 'Ex.: 10,5' });
  const fName = field('Nome', name);
  const save = h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
    const r = rate.value.trim() ? readDecimal(rate.value) : null;
    fName.setError(name.value.trim() ? '' : 'Informe um nome');
    if (!name.value.trim()) return;
    if (r !== null && (!Number.isFinite(r) || r <= -100 || r >= 1000)) { toast('Rentabilidade inválida', { tone: 'error' }); return; }
    try {
      await repo.saveInvestment({ ...(inv || {}), name: name.value, kind: kind.value.trim() || null, annualRate: r, ...(inv ? {} : { initialBalance: balance.getValue() ?? 0, refDate: isISODate(ref.value) ? ref.value : today() }) });
      m.close(); toast(inv ? 'Investimento atualizado' : 'Investimento cadastrado', { tone: 'success' });
    } catch (err) { toastError(err); }
  } }, 'Salvar');
  const m = openModal({ title: inv ? 'Editar investimento' : 'Novo investimento', size: 'sm',
    body: h('div', { class: 'stack' }, fName, field('Tipo', kind), inv ? null : h('div', { class: 'form-grid' }, field('Valor atual', balance), field('Data de referência', ref)), field('Rentabilidade informada (% a.a.)', rate, { hint: 'Usada apenas para estimativas' })),
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
    fAmount.setError(cents != null && (type === 'balance' ? cents >= 0 : cents > 0) ? '' : 'Informe um valor válido');
    if (cents == null || (type !== 'balance' && cents <= 0) || cents < 0 || !isISODate(date.value)) return;
    try {
      await repo.addInvestmentEvent({ investmentId: inv.id, type, amount: cents, date: date.value, accountId: type === 'balance' ? null : account.value || null });
      m.close(); toast(type === 'contribution' ? 'Aporte registrado' : type === 'withdrawal' ? 'Resgate registrado' : 'Saldo atualizado', { tone: 'success' });
    } catch (err) { toastError(err); }
  } }, 'Salvar');
  const m = openModal({ title: `${titles[type]} · ${inv.name}`, size: 'sm',
    body: h('div', { class: 'stack' }, h('div', { class: 'form-grid' }, fAmount, field('Data', date)),
      type !== 'balance' ? field(type === 'contribution' ? 'Saiu da conta' : 'Entrou na conta', account, { hint: 'Atualiza o saldo da conta. Aportes não contam como despesa.' }) : h('p', { class: 'faint small' }, 'O saldo informado substitui a base de cálculo a partir desta data. Aportes e resgates posteriores são somados a ele.')),
    footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), save] });
}

function openHistory(inv) {
  const label = { balance: 'Saldo informado', contribution: 'Aporte', withdrawal: 'Resgate' };
  const evs = repo.list('investmentEvents').filter((e) => e.investmentId === inv.id).sort((a, b) => (a.date < b.date ? 1 : -1));
  const body = evs.length ? h('div', { class: 'kvs' }, ...evs.map((e) => h('div', { class: 'kv' },
    h('span', { class: 'kv-label' }, `${formatDate(e.date)} · ${label[e.type]}`),
    h('span', { class: 'kv-value num' }, formatMoney(e.amount),
      h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': 'Excluir evento', onclick: async () => {
        if (!(await confirmDialog({ title: 'Excluir registro?', message: `${label[e.type]} de ${formatMoney(e.amount)} em ${formatDate(e.date)}.`, confirmLabel: 'Excluir', danger: true }))) return;
        try { await repo.deleteInvestmentEvent(e.id); m.close(); toast('Registro excluído'); } catch (err) { toastError(err); }
      } }, icon('trash', 'icon-sm')))))) : h('p', { class: 'muted' }, 'Sem registros.');
  const m = openModal({ title: `Histórico · ${inv.name}`, body, size: 'sm' });
}

async function removeInvestment(inv) {
  if (!(await confirmDialog({ title: 'Excluir investimento?', message: `“${inv.name}” e todo o seu histórico de saldos, aportes e resgates serão removidos.`, confirmLabel: 'Excluir', danger: true }))) return;
  try { await repo.deleteInvestment(inv.id); toast('Investimento excluído'); } catch (err) { toastError(err); }
}

function openGoalForm(g = null) {
  const invs = repo.list('investments').filter((i) => !i.archived);
  const name = h('input', { class: 'input', value: g?.name || '', maxlength: 80, placeholder: 'Ex.: Reserva de emergência' });
  const target = moneyInput({ value: g?.target ?? null });
  const initial = moneyInput({ value: g?.initial ?? 0, allowZero: true });
  const monthly = moneyInput({ value: g?.monthly ?? null, allowZero: true });
  const rate = h('input', { class: 'input', inputmode: 'decimal', value: g?.annualRate != null ? String(g.annualRate).replace('.', ',') : '10' });
  const start = h('input', { class: 'input', type: 'month', value: g?.startMonth || currentMonth() });
  const deadline = h('input', { class: 'input', type: 'month', value: g?.deadline || '' });
  const link = h('select', { class: 'select' }, h('option', { value: '' }, 'Não vincular'), ...invs.map((i) => h('option', { value: i.id }, i.name)));
  link.value = g?.investmentId || '';
  let timing = g?.timing || 'end';
  const timingSeg = segmented({ label: 'Aporte no', value: timing, options: [{ value: 'end', label: 'Fim do mês' }, { value: 'start', label: 'Início do mês' }], onChange: (v) => { timing = v; } });
  const fName = field('Nome', name), fTarget = field('Valor desejado', target);
  const save = h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
    const r = readDecimal(rate.value);
    fName.setError(name.value.trim() ? '' : 'Informe um nome');
    fTarget.setError(target.getValue() ? '' : 'Informe o valor desejado');
    if (!name.value.trim() || !target.getValue()) return;
    if (!Number.isFinite(r) || r <= -100 || r >= 1000) { toast('Rentabilidade inválida', { tone: 'error' }); return; }
    if (!isMonth(start.value)) { toast('Mês inicial inválido', { tone: 'error' }); return; }
    try {
      await repo.saveGoal({ ...(g || {}), name: name.value, target: target.getValue(), initial: initial.getValue() ?? 0, monthly: monthly.getValue() ?? 0, annualRate: r, startMonth: start.value, deadline: isMonth(deadline.value) ? deadline.value : null, timing, investmentId: link.value || null });
      m.close(); toast(g ? 'Meta atualizada' : 'Meta criada', { tone: 'success' });
    } catch (err) { toastError(err); }
  } }, 'Salvar');
  const m = openModal({ title: g ? 'Editar meta' : 'Nova meta',
    body: h('div', { class: 'stack' }, fName, h('div', { class: 'form-grid' }, fTarget, field('Patrimônio inicial', initial), field('Aporte mensal', monthly), field('Rentabilidade estimada (% a.a.)', rate), field('Data inicial', start), field('Prazo desejado', deadline, { hint: 'Opcional' }), field('Vincular a investimento', link, { hint: 'Usa o saldo informado como patrimônio atual' }), field('Aporte no', timingSeg))),
    footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), save] });
}

async function removeGoal(g) {
  if (!(await confirmDialog({ title: 'Excluir meta?', message: `A meta “${g.name}” será removida. Nenhum investimento é alterado.`, confirmLabel: 'Excluir', danger: true }))) return;
  try { await repo.deleteGoal(g.id); toast('Meta excluída'); } catch (err) { toastError(err); }
}

export { monthOf };
