import { parseISO, dateInMonth, addMonths, monthOf, addDays, dayDiff, monthDiff } from '../utils/dates.js';

export const FREQUENCIES = {
  monthly: 'Mensal',
  weekly: 'Semanal',
  yearly: 'Anual',
};

/** Opções do controle "Repetir lançamento" → frequência + intervalo. */
export const REPEAT_PRESETS = {
  none: { label: 'Não repetir' },
  weekly: { label: 'Semanalmente', frequency: 'weekly', interval: 1 },
  biweekly: { label: 'A cada duas semanas', frequency: 'weekly', interval: 2 },
  monthly: { label: 'Mensalmente', frequency: 'monthly', interval: 1 },
  bimonthly: { label: 'A cada dois meses', frequency: 'monthly', interval: 2 },
  quarterly: { label: 'Trimestralmente', frequency: 'monthly', interval: 3 },
  semiannual: { label: 'Semestralmente', frequency: 'monthly', interval: 6 },
  yearly: { label: 'Anualmente', frequency: 'yearly', interval: 1 },
  custom: { label: 'Personalizado…' },
};

export function describeFrequency(rule) {
  const n = rule.interval || 1;
  if (rule.frequency === 'weekly') return n === 1 ? 'Semanal' : n === 2 ? 'Quinzenal (a cada 2 semanas)' : `A cada ${n} semanas`;
  if (rule.frequency === 'yearly') return n === 1 ? 'Anual' : `A cada ${n} anos`;
  return { 1: 'Mensal', 2: 'Bimestral', 3: 'Trimestral', 6: 'Semestral' }[n] || `A cada ${n} meses`;
}

/** Dia de referência das regras mensais/anuais (preserva o dia 31 após meses curtos). */
export const anchorDayOf = (rule) => rule.anchorDay || parseISO(rule.startDate).d;

export function isPaused(rule, date) {
  return (rule.pauses || []).some((p) => date >= p.from && (!p.to || date <= p.to));
}

/** Data final (inclusiva) que produz exatamente `count` ocorrências. */
export function endDateForCount(rule, count) {
  if (!Number.isInteger(count) || count < 1) return null;
  const far = addDays(rule.startDate, 366 * Math.max(1, Math.ceil((count * (rule.interval || 1)) / (rule.frequency === 'yearly' ? 1 : rule.frequency === 'weekly' ? 52 : 12)) + 1));
  const list = occurrences({ ...rule, endDate: null, exceptions: {}, pauses: [] }, rule.startDate, far);
  return list[count - 1] || null;
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
  const anchorDay = anchorDayOf(rule);
  const skip = rule.exceptions || {};
  const paused = Array.isArray(rule.pauses) && rule.pauses.length;
  const push = (d) => { if (d >= start && d <= end && d >= rule.startDate && skip[d] !== 'skipped' && !(paused && isPaused(rule, d))) out.push(d); };

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
    const d = dateInMonth(addMonths(startMonth, k * stepMonths), anchorDay);
    if (d > end) break;
    push(d);
  }
  return out;
}

export function nextOccurrence(rule, fromISO) {
  const far = addDays(fromISO, 800);
  return occurrences(rule, fromISO, far)[0] || null;
}
