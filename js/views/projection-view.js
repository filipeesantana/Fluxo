import { h, icon, put } from '../utils/dom.js';
import { formatMoney } from '../utils/money.js';
import { currentMonth, addMonths, formatMonth, formatMonthShort, isMonth } from '../utils/dates.js';
import * as repo from '../database/repository.js';
import { baselineRows, applyScenario, compareRows, endingCommitments } from '../services/scenarios.js';
import { surplusBars, lineChart } from '../components/charts.js';
import { field, moneyInput, segmented, readInt } from '../components/fields.js';
import { toast, toastError } from '../components/toast.js';
import { readPref, writePref } from '../state.js';
import { panel, capitalize, categoryOptions, blockOptions, kv } from './common.js';

const HORIZONS = [3, 6, 12, 24, 60];
const label = (m) => capitalize(formatMonthShort(m));

function horizonPref() {
  const n = Number(readPref('horizon', '12'));
  return Number.isInteger(n) && n >= 1 && n <= 120 ? n : 12;
}

function horizonControl(onChange) {
  const n = horizonPref();
  const custom = h('input', { class: 'input input-sm', type: 'number', min: 1, max: 120, step: 1, value: HORIZONS.includes(n) ? '' : n, placeholder: 'meses', 'aria-label': 'Período personalizado em meses' });
  const seg = segmented({
    label: 'Horizonte', size: 'segmented-sm', value: HORIZONS.includes(n) ? String(n) : '',
    options: HORIZONS.map((x) => ({ value: String(x), label: x < 12 ? `${x} meses` : x === 12 ? '1 ano' : `${x / 12} anos` })),
    onChange: (v) => { writePref('horizon', v); custom.value = ''; onChange(); },
  });
  custom.addEventListener('change', () => { const v = readInt(custom, { min: 1, max: 120 }); if (v) { writePref('horizon', String(v)); onChange(); } else toast('Informe de 1 a 120 meses', { tone: 'error' }); });
  return h('div', { class: 'horizon' }, seg, h('span', { class: 'faint small' }, 'ou'), custom, h('span', { class: 'faint small' }, 'meses'));
}

function goalsMonthly() {
  return repo.list('goals').filter((g) => !g.archived && g.monthly > 0).reduce((t, g) => t + g.monthly, 0);
}

function stat(value, text, cls = '') {
  return h('div', { class: 'cal-stat' }, h('b', { class: cls }, value), h('span', null, text));
}

export function renderProjection(container, rerender) {
  const ctx = repo.context();
  const n = horizonPref();
  const from = currentMonth();
  const prefs = repo.prefs();
  const variable = prefs.variableEstimate || 0;
  const rows = baselineRows(ctx, from, n, { variable, goalsMonthly: goalsMonthly() });
  const total = rows.reduce((t, r) => t + r.surplus, 0);
  const worst = rows.reduce((w, r) => (!w || r.surplus < w.surplus ? r : w), null);
  const negatives = rows.filter((r) => r.surplus < 0).length;

  const varInput = moneyInput({ value: variable || null, allowZero: true, placeholder: '0,00' });
  varInput.input.addEventListener('change', async () => {
    const v = varInput.getValue() ?? 0;
    if (v < 0) return;
    try { await repo.setPrefs({ variableEstimate: v }); toast(v ? 'Estimativa de gastos variáveis aplicada' : 'Estimativa removida'); } catch (err) { toastError(err); }
  });

  const head = panel('Projeção mensal', { hint: `${capitalize(formatMonth(from))} a ${formatMonth(addMonths(from, n - 1))}`, actions: horizonControl(rerender) },
    h('div', { class: 'proj-kpis' },
      stat(formatMoney(total), `sobra acumulada em ${n} ${n === 1 ? 'mês' : 'meses'}`, total < 0 ? 'neg' : 'pos'),
      stat(formatMoney(Math.round(total / n)), 'sobra média por mês'),
      stat(worst ? formatMoney(worst.surplus) : '—', worst ? `menor sobra · ${formatMonthShort(worst.month)}` : 'menor sobra', worst?.surplus < 0 ? 'neg' : ''),
      stat(String(negatives), negatives === 1 ? 'mês no vermelho' : 'meses no vermelho', negatives ? 'neg' : '')),
    surplusBars(rows, { labelOf: label }),
    h('div', { class: 'form-grid', style: { marginTop: '14px', maxWidth: '640px' } },
      field('Gastos variáveis estimados por mês', varInput, { hint: 'Mercado, lazer, transporte… aplicado a partir do próximo mês' })),
    variable ? null : h('p', { class: 'note is-warn' }, icon('alert', 'icon-sm'), 'Esta projeção não inclui despesas variáveis futuras: considera apenas receitas previstas, contas fixas, parcelas, faturas e compras programadas. Informe uma estimativa para uma visão mais realista.'));

  const table = h('div', { class: 'table-wrap' }, h('table', { class: 'table table-compact' },
    h('thead', null, h('tr', null, ...['Mês', 'Receitas', 'Fixas', 'Parcelas', 'Pontuais', 'Variáveis', 'Sobra', 'Aportes plan.', 'Após aportes', 'Acumulado'].map((t, i) => h('th', { class: i ? 'right' : '' }, t)))),
    h('tbody', null, ...rows.map((r) => h('tr', { class: r.month === from ? 'is-current' : 'is-future' },
      h('td', null, label(r.month)),
      h('td', { class: 'right num pos' }, formatMoney(r.income)),
      h('td', { class: 'right num' }, formatMoney(r.fixed)),
      h('td', { class: 'right num' }, formatMoney(r.installments)),
      h('td', { class: 'right num' }, formatMoney(r.oneOff)),
      h('td', { class: 'right num faint' }, formatMoney(r.variable)),
      h('td', { class: `right num strong ${r.surplus < 0 ? 'neg' : ''}` }, formatMoney(r.surplus)),
      h('td', { class: 'right num invest' }, formatMoney(r.contributions)),
      h('td', { class: `right num ${r.afterContributions < 0 ? 'neg' : ''}` }, formatMoney(r.afterContributions)),
      h('td', { class: `right num ${r.cumulative < 0 ? 'neg' : 'faint'}` }, formatMoney(r.cumulative)))))));

  const ending = endingCommitments(ctx, { plans: repo.list('installmentPlans'), recurrences: repo.list('recurrences'), transactions: repo.list('transactions'), fromMonth: from, horizonMonths: Math.max(n, 12) });
  const endPanel = panel('Compromissos que terminam', { hint: 'quanto do orçamento será liberado' },
    ending.length ? h('div', { class: 'ending-list' }, ...ending.map((e) => h('div', { class: 'ending' },
      h('span', { class: 'strong' }, e.description), h('span', { class: 'num pos strong' }, `+${formatMoney(e.monthly)}/mês`),
      h('span', { class: 'faint' }, `${e.kind === 'installment' ? 'Última parcela' : 'Última ocorrência'} em ${formatMonth(e.lastMonth)}. A partir de ${formatMonth(e.freedFrom)}, o orçamento projetado tem ${formatMoney(e.monthly)} a mais por mês, mantidas as demais condições.`))))
      : h('div', { class: 'empty-block' }, 'Nenhum parcelamento ou conta com data final dentro do período.'));

  put(container, head, panel('Detalhamento', { hint: 'a sobra acumulada é orçamentária: não é patrimônio nem saldo bancário' }, table), endPanel);
}

// ——— Simulação de decisões (não altera registros) ———

const SC_KEY = 'gf.scenario';
function readScenario() { try { return JSON.parse(sessionStorage.getItem(SC_KEY)) || []; } catch { return []; } }
function writeScenario(a) { try { sessionStorage.setItem(SC_KEY, JSON.stringify(a)); } catch { /* opcional */ } }

const ADJ_TYPES = {
  cancelRecurrence: { label: 'Cancelar uma conta recorrente', icon: 'x' },
  expense: { label: 'Nova despesa mensal (assinatura, financiamento)', icon: 'out' },
  installment: { label: 'Compra parcelada', icon: 'layers' },
  income: { label: 'Mudança de renda mensal', icon: 'in' },
  reduceGroup: { label: 'Reduzir gastos de uma categoria ou bloco', icon: 'chart' },
  contribution: { label: 'Aumentar aporte mensal', icon: 'trend' },
};

function describeAdj(a) {
  const fromTxt = a.from ? ` a partir de ${formatMonthShort(a.from)}` : '';
  const dur = a.months ? ` por ${a.months} ${a.months === 1 ? 'mês' : 'meses'}` : '';
  switch (a.type) {
    case 'cancelRecurrence': return `Cancelar “${repo.get('recurrences', a.ruleId)?.description || 'recorrência'}”${fromTxt}`;
    case 'expense': return `${a.name || 'Nova despesa'}: ${formatMoney(a.amount)}/mês${fromTxt}${dur}`;
    case 'installment': return `${a.name || 'Compra'}: ${formatMoney(a.total)} em ${a.count}×${fromTxt}`;
    case 'income': return `Renda ${a.amount >= 0 ? '+' : '−'}${formatMoney(Math.abs(a.amount))}/mês${fromTxt}${dur}`;
    case 'reduceGroup': return `Reduzir ${a.refName} em ${a.percent}%${fromTxt}`;
    case 'contribution': return `Aporte +${formatMoney(a.amount)}/mês${fromTxt}`;
    default: return '';
  }
}

function builder(onAdd) {
  const from = currentMonth();
  let type = 'cancelRecurrence';
  const typeSel = h('select', { class: 'select', 'aria-label': 'Tipo de decisão' }, ...Object.entries(ADJ_TYPES).map(([v, d]) => h('option', { value: v }, d.label)));
  const fields = h('div', { class: 'form-grid' });
  const start = h('input', { class: 'input', type: 'month', value: addMonths(from, 1) });
  const nameIn = h('input', { class: 'input', maxlength: 60, placeholder: 'Ex.: Financiamento da moto' });
  const money = moneyInput({});
  const months = h('input', { class: 'input', type: 'number', min: 1, max: 120, step: 1, placeholder: 'Sem prazo' });
  const count = h('input', { class: 'input', type: 'number', min: 2, max: 120, step: 1, value: 10 });
  const percent = h('input', { class: 'input', type: 'number', min: 1, max: 100, step: 1, value: 20 });
  const sign = segmented({ label: 'Direção', value: '+', options: [{ value: '+', label: 'Aumentar' }, { value: '-', label: 'Reduzir' }] });
  const rules = repo.list('recurrences').filter((r) => !r.archived && (!r.endDate || r.endDate >= `${from}-01`));
  const ruleSel = h('select', { class: 'select' }, ...rules.map((r) => h('option', { value: r.id }, `${r.description} · ${formatMoney(r.amount)}${r.type === 'income' ? ' (receita)' : ''}`)));
  const groupSel = h('select', { class: 'select' },
    h('optgroup', { label: 'Categorias' }, ...categoryOptions('expense').map((o) => h('option', { value: `category:${o.value}` }, o.label))),
    h('optgroup', { label: 'Blocos' }, ...blockOptions().map((o) => h('option', { value: `block:${o.value}` }, o.label))));
  const draw = () => {
    const f = [];
    if (type === 'cancelRecurrence') f.push(rules.length ? field('Conta recorrente', ruleSel) : h('p', { class: 'faint small span-2' }, 'Nenhuma recorrência ativa cadastrada.'));
    if (type === 'expense' || type === 'installment') f.push(field('Descrição', nameIn));
    if (type === 'expense' || type === 'income' || type === 'contribution') f.push(field(type === 'income' ? 'Valor mensal' : 'Valor por mês', money));
    if (type === 'installment') f.push(field('Valor total', money), field('Parcelas', count));
    if (type === 'income') f.push(field('Mudança', sign));
    if (type === 'reduceGroup') f.push(field('Categoria ou bloco', groupSel), field('Redução (%)', percent));
    f.push(field('A partir de', start));
    if (type === 'expense' || type === 'income') f.push(field('Duração (meses)', months, { hint: 'Em branco = sem prazo' }));
    put(fields, ...f);
  };
  typeSel.addEventListener('change', () => { type = typeSel.value; draw(); });
  draw();
  const add = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => {
    if (!isMonth(start.value)) { toast('Mês inicial inválido', { tone: 'error' }); return; }
    const a = { type, from: start.value };
    if (type === 'cancelRecurrence') { if (!ruleSel.value) return; a.ruleId = ruleSel.value; }
    if (type === 'expense' || type === 'income' || type === 'contribution') { const v = money.getValue(); if (!v) { toast('Informe um valor', { tone: 'error' }); return; } a.amount = type === 'income' && sign.getValue() === '-' ? -v : v; }
    if (type === 'installment') { const v = money.getValue(); const c = readInt(count, { min: 2, max: 120 }); if (!v || !c) { toast('Informe valor total e parcelas (2 a 120)', { tone: 'error' }); return; } a.total = v; a.count = c; }
    if (type === 'expense' || type === 'installment') a.name = nameIn.value.trim();
    if (type === 'expense' || type === 'income') { const mm = readInt(months, { min: 1, max: 120 }); a.months = Number.isNaN(mm) ? null : mm; }
    if (type === 'reduceGroup') { const [scope, refId] = groupSel.value.split(':'); const p = readInt(percent, { min: 1, max: 100 }); if (!refId || !p) { toast('Escolha o grupo e o percentual (1 a 100)', { tone: 'error' }); return; } Object.assign(a, { scope, refId, percent: p, refName: groupSel.selectedOptions[0].textContent }); }
    onAdd(a);
  } }, icon('plus', 'icon-sm'), 'Adicionar ao cenário');
  return h('div', { class: 'adj-builder' }, field('Decisão', typeSel), fields, h('div', { class: 'row' }, add));
}

export function renderScenarios(container, rerender) {
  const ctx = repo.context();
  const n = horizonPref();
  const from = currentMonth();
  const variable = repo.prefs().variableEstimate || 0;
  const base = baselineRows(ctx, from, n, { variable, goalsMonthly: goalsMonthly() });
  let adjs = readScenario();
  const sim = applyScenario(base, adjs);
  const cmp = compareRows(base, sim);
  const set = (next) => { writeScenario(next); rerender(); };

  const list = adjs.length ? h('div', { class: 'scenario-adjs' }, ...adjs.map((a, i) => h('div', { class: 'adj' },
    h('span', { class: 'tx-kind k-transfer' }, icon(ADJ_TYPES[a.type].icon)),
    h('span', null, describeAdj(a)),
    h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': 'Remover ajuste', onclick: () => set(adjs.filter((_, j) => j !== i)) }, icon('x'))))) : h('div', { class: 'empty-block' }, 'Adicione decisões hipotéticas para comparar com a trajetória atual. Exemplos: cancelar uma assinatura, financiar uma moto, aumentar o aporte.');

  const left = panel('Cenário', {
    hint: 'nada aqui altera seus registros',
    actions: adjs.length ? h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => { set([]); toast('Simulação descartada. Nenhum registro foi alterado.'); } }, 'Descartar simulação') : null,
  }, h('div', { class: 'stack-lg' }, list, builder((a) => set([...adjs, a]))));

  const diffCls = cmp.diff > 0 ? 'diff-pos' : cmp.diff < 0 ? 'diff-neg' : '';
  const result = panel('Comparação', { actions: horizonControl(rerender) },
    h('div', { class: 'proj-kpis' },
      stat(formatMoney(cmp.surplusBase), `sobra atual em ${n} meses`),
      stat(formatMoney(cmp.surplusSim), 'sobra no cenário', cmp.surplusSim < 0 ? 'neg' : ''),
      stat(`${cmp.diff > 0 ? '+' : ''}${formatMoney(cmp.diff)}`, 'diferença no período', diffCls),
      stat(`${cmp.monthlyAvgDiff > 0 ? '+' : ''}${formatMoney(cmp.monthlyAvgDiff)}`, 'diferença média por mês', diffCls)),
    adjs.length && cmp.negativeMonths ? h('p', { class: 'note is-warn' }, icon('alert', 'icon-sm'), `No cenário, ${cmp.negativeMonths} ${cmp.negativeMonths === 1 ? 'mês fica' : 'meses ficam'} com sobra negativa (pior: ${formatMonthShort(cmp.worstSim.month)}, ${formatMoney(cmp.worstSim.surplus)}).`) : null,
    surplusBars(base, { labelOf: label, compare: adjs.length ? sim : null, frac: window.innerWidth > 1100 ? 0.66 : 1 }),
    lineChart([
      { label: 'Acumulado atual', values: base.map((r) => r.cumulative), cls: 's-prev' },
      { label: 'Acumulado no cenário', values: sim.map((r) => r.cumulative), cls: 's-sim' },
    ], base.map((r) => label(r.month)), { height: 200, frac: window.innerWidth > 1100 ? 0.66 : 1 }),
    h('p', { class: 'note' }, icon('info', 'icon-sm'), `Considera receitas previstas, contas fixas, parcelas, faturas e compras programadas${variable ? ` e ${formatMoney(variable)}/mês de gastos variáveis` : ''}.`),
    variable ? null : h('p', { class: 'note is-warn' }, icon('alert', 'icon-sm'), 'Não considera gastos variáveis futuros. Informe uma estimativa na aba Projeção.'));

  put(container, h('div', { class: 'grid grid-scenario' }, left, result));
}
