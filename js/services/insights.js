import { addMonths } from '../utils/dates.js';
import { summarize, NONE } from './finance.js';

/*
 * Leituras complementares do mês. Regras:
 * • nunca inventar tendência: uma comparação só existe quando o mês de
 *   referência tem dados para a mesma grandeza;
 * • divisões por zero não geram percentuais;
 * • percentuais arredondados apenas na apresentação.
 */

const hasActivity = (s) => s.incomeTotal !== 0 || s.expenseTotal !== 0;

export function monthInsights(ctx, month) {
  const cur = summarize(ctx, month);
  const prevMonth = addMonths(month, -1);
  const prev = summarize(ctx, prevMonth);
  const out = { month, prevMonth };

  if (cur.incomeTotal > 0) {
    out.incomeCommitted = { ratio: cur.expenseTotal / cur.incomeTotal, expense: cur.expenseTotal, income: cur.incomeTotal };
  }
  if (cur.expenseTotal > 0) {
    out.commitmentsPaid = { ratio: cur.expenseDone / cur.expenseTotal, paid: cur.expenseDone, pending: cur.expensePending };
  }
  if (prev.expenseTotal > 0 && cur.expenseTotal >= 0) {
    const diff = cur.expenseTotal - prev.expenseTotal;
    out.expenseVsPrev = { diff, ratio: diff / prev.expenseTotal, prev: prev.expenseTotal, cur: cur.expenseTotal };
  }
  if (hasActivity(prev) && hasActivity(cur)) {
    out.surplusVsPrev = { diff: cur.projectedSurplus - prev.projectedSurplus, prev: prev.projectedSurplus, cur: cur.projectedSurplus };
  }
  // Maior variação de categoria entre categorias presentes nos dois meses.
  const prevCat = new Map(prev.byCategory.map((g) => [g.key, g.total]));
  let best = null;
  for (const g of cur.byCategory) {
    if (g.key === NONE) continue;
    const p = prevCat.get(g.key);
    if (!p || p <= 0) continue;
    const diff = g.total - p;
    if (!best || Math.abs(diff) > Math.abs(best.diff)) best = { key: g.key, diff, ratio: diff / p, prev: p, cur: g.total };
  }
  if (best && best.diff !== 0) out.categoryChange = best;
  return out;
}

/** Evolução da sobra em uma janela de meses (somente meses com atividade). */
export function surplusTrend(ctx, endMonth, count = 6) {
  const rows = [];
  for (let i = count - 1; i >= 0; i--) {
    const m = addMonths(endMonth, -i);
    const s = summarize(ctx, m);
    rows.push({ month: m, income: s.incomeTotal, expense: s.expenseTotal, surplus: s.projectedSurplus, active: hasActivity(s), received: s.incomeReceived, paid: s.expenseDone });
  }
  return rows;
}
