import { parseISO, dateInMonth, addMonths, monthOf, addDays, dayDiff, monthDiff } from '../utils/dates.js';

export const FREQUENCIES = {
  monthly: 'Mensal',
  weekly: 'Semanal',
  yearly: 'Anual',
};

export function describeFrequency(rule) {
  const n = rule.interval || 1;
  if (rule.frequency === 'weekly') return n === 1 ? 'Semanal' : `A cada ${n} semanas`;
  if (rule.frequency === 'yearly') return n === 1 ? 'Anual' : `A cada ${n} anos`;
  return n === 1 ? 'Mensal' : `A cada ${n} meses`;
}

/**
 * Datas das ocorrências de uma regra no intervalo [from, to] (inclusivo).
 * As ocorrências são ancoradas na data inicial: uma conta no dia 31 cai no
 * último dia dos meses mais curtos e volta ao dia 31 nos meses seguintes;
 * uma regra anual em 29/02 cai em 28/02 nos anos não bissextos.
 * Ocorrências ignoradas (exceptions[data] === 'skipped') são excluídas.
 */
export function occurrences(rule, from, to) {
  const out = [];
  if (!rule || !rule.startDate) return out;
  const end = rule.endDate && rule.endDate < to ? rule.endDate : to;
  const start = rule.startDate > from ? rule.startDate : from;
  if (start > end) return out;
  const n = Math.max(1, rule.interval || 1);
  const anchor = parseISO(rule.startDate);
  const skip = rule.exceptions || {};
  const push = (d) => { if (d >= start && d <= end && d >= rule.startDate && skip[d] !== 'skipped') out.push(d); };

  if (rule.frequency === 'weekly') {
    const step = 7 * n;
    let k = Math.max(0, Math.floor(dayDiff(rule.startDate, start) / step));
    for (let d = addDays(rule.startDate, k * step); d <= end; k++, d = addDays(rule.startDate, k * step)) push(d);
    return out;
  }

  const stepMonths = rule.frequency === 'yearly' ? 12 * n : n;
  const startMonth = monthOf(rule.startDate);
  let k = Math.max(0, Math.floor(monthDiff(startMonth, monthOf(start)) / stepMonths) - 1);
  for (let guard = 0; guard < 2400; guard++, k++) {
    const d = dateInMonth(addMonths(startMonth, k * stepMonths), anchor.d);
    if (d > end) break;
    push(d);
  }
  return out;
}

export function nextOccurrence(rule, fromISO) {
  const far = addDays(fromISO, 800);
  return occurrences(rule, fromISO, far)[0] || null;
}
