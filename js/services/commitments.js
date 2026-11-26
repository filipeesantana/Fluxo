import { firstDay, lastDay, monthOf } from '../utils/dates.js';
import { ruleOccurrences, ruleMode, monthlyAmount, describeFrequency } from './recurrence.js';
import { expenseValue } from './finance.js';

/*
 * Compromissos do mês: a visão "lista de tarefas" das recorrências.
 * Cada regra vira um compromisso por período (AAAA-MM) com suas ocorrências,
 * cada uma com estado próprio. Os valores vêm dos mesmos registros que o motor
 * financeiro usa (lançamentos materializados + projeções), então o total pago,
 * o restante e o previsto sempre conferem com a visão geral.
 *
 * Estados de uma ocorrência:
 *   done       paga / recebida
 *   partial    parte paga, restante ainda previsto
 *   overdue    data vencida e não paga (só existe com data definida)
 *   pending    vence neste mês (ou hoje)
 *   planned    prevista para depois
 *   tbd        data a definir (nunca é considerada atrasada)
 *   skipped    ignorada · cancelled: cancelada (nenhum dos dois é pagamento)
 */

export const STATE_LABEL = {
  done: { expense: 'Pago', income: 'Recebido' },
  partial: { expense: 'Parcialmente pago', income: 'Parcialmente recebido' },
  overdue: { expense: 'Atrasado', income: 'Não recebido' },
  pending: { expense: 'Pendente', income: 'A receber' },
  planned: { expense: 'Previsto', income: 'Previsto' },
  tbd: { expense: 'Data a definir', income: 'Data a definir' },
  skipped: { expense: 'Ignorado', income: 'Ignorado' },
  cancelled: { expense: 'Cancelado', income: 'Cancelado' },
};
export const stateLabel = (state, type = 'expense') => (STATE_LABEL[state] || STATE_LABEL.planned)[type === 'income' ? 'income' : 'expense'];

/** Estado de um item previsto ou pago (lançamento ou projeção). */
export function itemState(item, today) {
  if (item.status === 'done') return 'done';
  if (!item.date) return 'tbd';
  if (item.date < today) return 'overdue';
  if (monthOf(item.date) === monthOf(today)) return 'pending';
  return 'planned';
}

const keyOf = (t) => t.occurrenceKey || t.occurrenceDate || null;

function projected(rule, o, month) {
  return {
    id: `rec:${rule.id}:${o.key}`, virtual: true, recurrenceId: rule.id, occurrenceKey: o.key, occurrenceDate: o.date || undefined, period: o.period,
    slot: ruleMode(rule) === 'flex' ? o.index : undefined, type: rule.type, status: 'planned', description: rule.description, amount: rule.amount,
    date: o.date, month, categoryId: rule.categoryId || null, blockId: rule.blockId || null, sourceId: rule.sourceId || null,
    restricted: Boolean(rule.restricted), estimated: rule.estimated ? true : undefined, method: rule.method || null,
  };
}

/** Compromisso de UMA regra em UM mês (ou null quando não há nada no período). */
export function commitmentOf(ctx, rule, month) {
  const mode = ruleMode(rule);
  const from = firstDay(month), to = lastDay(month);
  const own = (ctx.byRule.get(rule.id) || []);
  if (mode === 'forecast') {
    const occ = ruleOccurrences(rule, from, to)[0];
    const linked = (ctx.byMonth.get(month) || []).filter((t) => t.forecastId === rule.id);
    if (!occ && !linked.length) return null;
    const planned = occ ? rule.amount : 0;
    const used = linked.reduce((s, t) => s + expenseValue(t), 0);
    const done = linked.filter((t) => t.status === 'done').reduce((s, t) => s + expenseValue(t), 0);
    const closed = Boolean(rule.closed?.[month]);
    const left = closed ? 0 : Math.max(0, planned - used);
    const excess = Math.max(0, used - planned);
    const state = closed ? 'closed' : excess > 0 ? 'over' : used >= planned && planned > 0 ? 'full' : 'open';
    return { rule, mode, month, forecast: true, planned, used, done, left, excess, closed, state, linked: linked.sort(byDate), ratio: planned > 0 ? used / planned : 0, describe: describeFrequency(rule) };
  }
  const occs = ruleOccurrences(rule, from, to);
  const keys = new Set(occs.map((o) => o.key));
  const entries = [];
  for (const o of occs) {
    const tx = own.find((t) => keyOf(t) === o.key && !t.remainderOf);
    const item = tx || projected(rule, o, month);
    const rest = tx ? own.filter((t) => t.remainderOf === tx.id) : [];
    entries.push(entry(item, rest, o.index, ctx.today));
  }
  // Ocorrências materializadas deste período que a regra não projeta mais (regra editada depois).
  for (const t of own) {
    if (t.remainderOf || !keyOf(t) || keys.has(keyOf(t))) continue;
    const period = t.period || String(keyOf(t)).slice(0, 7);
    if (period !== month) continue;
    entries.push(entry(t, own.filter((x) => x.remainderOf === t.id), entries.length + 1, ctx.today));
  }
  // Ignoradas e canceladas aparecem como histórico, mas não somam.
  for (const [k, v] of Object.entries(rule.exceptions || {})) {
    if (String(k).slice(0, 7) !== month || keys.has(k)) continue;
    entries.push({ key: k, item: null, state: v === 'cancelled' ? 'cancelled' : 'skipped', amount: 0, paid: 0, left: 0, date: /^\d{4}-\d{2}-\d{2}$/.test(k) ? k : null, index: entries.length + 1, remainders: [] });
  }
  if (!entries.length) return null;
  entries.sort((a, b) => (a.date || '9999') < (b.date || '9999') ? -1 : (a.date || '9999') > (b.date || '9999') ? 1 : a.index - b.index);
  const live = entries.filter((e) => e.state !== 'skipped' && e.state !== 'cancelled');
  const total = live.reduce((s, e) => s + e.amount, 0);
  const paid = live.reduce((s, e) => s + e.paid, 0);
  const doneCount = live.filter((e) => e.state === 'done').length;
  const state = !live.length ? 'skipped' : doneCount === live.length ? 'done' : live.some((e) => e.state === 'overdue') ? 'overdue' : paid > 0 ? 'partial' : live.some((e) => e.state === 'pending') ? 'pending' : live.every((e) => e.state === 'tbd') ? 'tbd' : 'planned';
  return { rule, mode, month, entries, total, paid, left: total - paid, count: live.length, doneCount, state, ratio: total > 0 ? paid / total : 0, describe: describeFrequency(rule), monthly: monthlyAmount(rule) };
}

function entry(item, remainders, index, today) {
  const pendingRest = remainders.filter((r) => r.status !== 'done');
  const paidRest = remainders.filter((r) => r.status === 'done');
  const paid = (item.status === 'done' ? item.amount : 0) + paidRest.reduce((s, r) => s + r.amount, 0);
  const left = (item.status === 'done' ? 0 : item.amount) + pendingRest.reduce((s, r) => s + r.amount, 0);
  let state = itemState(item, today);
  if (state === 'done' && pendingRest.length) state = 'partial';
  return { key: keyOf(item), item, remainders, state, amount: paid + left, paid, left, date: item.date || null, index };
}

const byDate = (a, b) => ((a.date || '9999') < (b.date || '9999') ? -1 : 1);

/** Todos os compromissos recorrentes de um mês, mais os previstos avulsos. */
export function commitmentsFor(ctx, month) {
  const key = `commit:${month}`;
  if (ctx.cache.has(key)) return ctx.cache.get(key);
  const list = [];
  for (const rule of ctx.recurrences) {
    if (rule.archived && !(ctx.byRule.get(rule.id) || []).some((t) => (t.period || t.month) === month)) continue;
    const c = commitmentOf(ctx, rule, month);
    if (c) list.push(c);
  }
  const order = { overdue: 0, partial: 1, pending: 2, tbd: 3, planned: 4, open: 4, over: 5, full: 6, closed: 7, done: 8, skipped: 9 };
  list.sort((a, b) => (order[a.state] ?? 5) - (order[b.state] ?? 5) || a.rule.description.localeCompare(b.rule.description, 'pt-BR'));
  // Compromissos avulsos previstos (sem recorrência nem parcela) do mês.
  const oneOff = (ctx.byMonth.get(month) || []).filter((t) => t.status === 'planned' && !t.recurrenceId && !t.planId && !t.forecastId && t.type !== 'transfer')
    .map((t) => ({ item: t, state: itemState(t, ctx.today) })).sort((a, b) => byDate(a.item, b.item));
  const recurring = list.filter((c) => !c.forecast);
  const forecasts = list.filter((c) => c.forecast);
  const expenseOnly = recurring.filter((c) => c.rule.type === 'expense');
  const totals = {
    total: expenseOnly.reduce((s, c) => s + c.total, 0),
    paid: expenseOnly.reduce((s, c) => s + c.paid, 0),
    count: expenseOnly.reduce((s, c) => s + c.count, 0),
    doneCount: expenseOnly.reduce((s, c) => s + c.doneCount, 0),
    forecastPlanned: forecasts.reduce((s, c) => s + c.planned, 0),
    forecastUsed: forecasts.reduce((s, c) => s + c.used, 0),
  };
  totals.left = totals.total - totals.paid;
  const res = { month, recurring, forecasts, oneOff, totals };
  ctx.cache.set(key, res);
  return res;
}
