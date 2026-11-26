import { addMonths, currentMonth } from '../utils/dates.js';
import { splitCents } from '../utils/money.js';
import { summarize } from './finance.js';

/*
 * Projeção de longo prazo e simulação de decisões.
 * As linhas-base vêm do motor financeiro (registros reais + recorrências
 * projetadas). Cenários aplicam ajustes sobre cópias dessas linhas: nada é
 * gravado no banco.
 */

export function baselineRows(ctx, fromMonth, count, { variable = 0, goalsMonthly = 0, today = ctx.today } = {}) {
  const cm = today.slice(0, 7);
  const rows = [];
  let acc = 0;
  for (let i = 0; i < count; i++) {
    const m = addMonths(fromMonth, i);
    const s = summarize(ctx, m);
    const variableCost = m > cm ? Math.max(0, variable) : 0;
    const row = {
      month: m,
      income: s.incomeTotal,
      fixed: s.expFixed,
      installments: s.expInstallments,
      oneOff: s.expOneOff,
      variable: variableCost,
      contributions: m >= cm ? goalsMonthly : 0,
      byRule: new Map(s.byRule),
      incomeByRule: new Map(s.incomeByRule),
      byCategory: new Map(s.byCategory.map((g) => [g.key, g.total])),
      byBlock: new Map(s.byBlock.map((g) => [g.key, g.total])),
      adjustments: 0,
    };
    finish(row);
    acc += row.surplus;
    row.cumulative = acc;
    rows.push(row);
  }
  return rows;
}

function finish(row) {
  row.expense = row.fixed + row.installments + row.oneOff + row.variable + row.adjustments;
  row.surplus = row.income - row.expense;
  row.afterContributions = row.surplus - row.contributions;
}

const active = (adj, m, idx0) => m >= (adj.from || '0000-00') && (adj.months == null || idx0 < adj.months);

/** Aplica ajustes hipotéticos. Devolve novas linhas; as originais não mudam. */
export function applyScenario(rows, adjustments) {
  const out = rows.map((r) => ({ ...r, extra: [] }));
  for (const adj of adjustments) {
    const start = adj.from || rows[0]?.month;
    let k = 0;
    const parcels = adj.type === 'installment' ? splitCents(adj.total, adj.count) : null;
    for (const r of out) {
      if (r.month < start) continue;
      const idx = k++;
      switch (adj.type) {
        case 'cancelRecurrence': {
          const e = r.byRule.get(adj.ruleId) || 0;
          const inc = r.incomeByRule.get(adj.ruleId) || 0;
          r.fixed -= e;
          r.income -= inc;
          break;
        }
        case 'income':
          if (active(adj, r.month, idx)) r.income += adj.amount;
          break;
        case 'expense':
          if (active(adj, r.month, idx)) r.adjustments += adj.amount;
          break;
        case 'installment':
          if (idx < parcels.length) r.adjustments += parcels[idx];
          break;
        case 'reduceGroup': {
          const map = adj.scope === 'block' ? r.byBlock : r.byCategory;
          const base = map.get(adj.refId) || 0;
          r.adjustments -= Math.round((base * adj.percent) / 100);
          break;
        }
        case 'contribution':
          if (active(adj, r.month, idx)) r.contributions += adj.amount;
          break;
        default:
          break;
      }
    }
  }
  let acc = 0;
  for (const r of out) { finish(r); acc += r.surplus; r.cumulative = acc; }
  return out;
}

export function compareRows(base, sim) {
  const sum = (rows, k) => rows.reduce((t, r) => t + r[k], 0);
  return {
    surplusBase: sum(base, 'surplus'),
    surplusSim: sum(sim, 'surplus'),
    diff: sum(sim, 'surplus') - sum(base, 'surplus'),
    monthlyAvgDiff: base.length ? Math.round((sum(sim, 'surplus') - sum(base, 'surplus')) / base.length) : 0,
    worstSim: sim.reduce((w, r) => (w == null || r.surplus < w.surplus ? r : w), null),
    negativeMonths: sim.filter((r) => r.surplus < 0).length,
  };
}

/**
 * Compromissos que terminam: parcelamentos e recorrências com data final.
 * Para cada um: último mês, valor mensal liberado e mês a partir do qual a
 * folga aparece (demais condições constantes).
 */
export function endingCommitments(ctx, { plans, recurrences, transactions, fromMonth = currentMonth(), horizonMonths = 60 }) {
  const until = addMonths(fromMonth, horizonMonths);
  const out = [];
  for (const p of plans) {
    if (p.cancelledAt) continue;
    const parcels = transactions.filter((t) => t.planId === p.id).sort((a, b) => (a.month < b.month ? -1 : 1));
    if (!parcels.length) continue;
    const last = parcels[parcels.length - 1];
    if (last.month < fromMonth || last.month > until) continue;
    out.push({ kind: 'installment', id: p.id, description: p.description, lastMonth: last.month, freedFrom: addMonths(last.month, 1), monthly: last.amount, remaining: parcels.filter((t) => t.month >= fromMonth).reduce((s, t) => s + t.amount, 0) });
  }
  for (const r of recurrences) {
    if (r.archived || !r.endDate || r.type !== 'expense') continue;
    const lastMonth = r.endDate.slice(0, 7);
    if (lastMonth < fromMonth || lastMonth > until) continue;
    const monthly = r.frequency === 'monthly' ? Math.round(r.amount / (r.interval || 1)) : r.frequency === 'weekly' ? Math.round((r.amount * 52) / 12 / (r.interval || 1)) : Math.round(r.amount / 12 / (r.interval || 1));
    out.push({ kind: 'recurrence', id: r.id, description: r.description, lastMonth, freedFrom: addMonths(lastMonth, 1), monthly });
  }
  return out.sort((a, b) => (a.lastMonth < b.lastMonth ? -1 : a.lastMonth > b.lastMonth ? 1 : b.monthly - a.monthly));
}
