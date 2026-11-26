import { parseISO, dateInMonth, addMonths, monthOf, addDays, dayDiff, monthDiff, firstDay, lastDay } from '../utils/dates.js';

export const FREQUENCIES = {
  monthly: 'Mensal',
  weekly: 'Semanal',
  yearly: 'Anual',
  daily: 'Diária',
};

/** Opções do controle "Repetir" → frequência + intervalo. */
export const REPEAT_PRESETS = {
  none: { label: 'Não repetir' },
  weekly: { label: 'Semanalmente', frequency: 'weekly', interval: 1 },
  biweekly: { label: 'A cada 14 dias', frequency: 'weekly', interval: 2 },
  monthly: { label: 'Mensalmente', frequency: 'monthly', interval: 1 },
  yearly: { label: 'Anualmente', frequency: 'yearly', interval: 1 },
  custom: { label: 'Personalizar…' },
};

/*
 * Modos de recorrência (todos independentes da fonte de pagamento):
 *   fixed     uma data por período (dia fixo do mês, a cada N dias/semanas, anual)
 *   days      vários dias fixos no mesmo mês (ex.: 5 e 20)            — mensal
 *   flex      N ocorrências por mês, cada uma com data a definir      — mensal
 *   forecast  previsão mensal de consumo (ex.: combustível R$ 400):
 *             gastos reais vinculados consomem o valor planejado       — mensal
 * Cada ocorrência tem uma CHAVE estável, que não depende de a data mudar:
 *   fixed → 'AAAA-MM-DD' (data projetada) · days → 'AAAA-MM@dia'
 *   flex  → 'AAAA-MM#n'                    · forecast → 'AAAA-MM'
 */
export const RULE_MODES = ['fixed', 'days', 'flex', 'forecast'];
export const MONTHLY_MODES = {
  fixed: { label: 'Em um dia específico', hint: 'Ex.: internet todo dia 10' },
  days: { label: 'Em mais de um dia do mês', hint: 'Ex.: dias 5 e 20' },
  flex: { label: 'Com datas flexíveis', hint: 'Ex.: 2 consultas por mês, datas a combinar' },
  forecast: { label: 'Como previsão mensal', hint: 'Ex.: até R$ 400 de combustível no mês' },
};
export const MAX_DAYS = 10;
export const MAX_PER_PERIOD = 31;

export const ruleMode = (rule) => (RULE_MODES.includes(rule?.mode) ? rule.mode : 'fixed');

/** Valor previsto por mês (para resumos e formulários). */
export function monthlyAmount(rule) {
  const m = ruleMode(rule);
  if (m === 'days') return rule.amount * (rule.days?.length || 1);
  if (m === 'flex') return rule.amount * (rule.perPeriod || 1);
  return rule.amount;
}

export function describeFrequency(rule) {
  const n = rule.interval || 1;
  const mode = ruleMode(rule);
  const every = n === 1 ? 'mês' : `${n} meses`;
  if (mode === 'days') return `Nos dias ${listDays(rule.days || [])}${n === 1 ? '' : `, a cada ${every}`}`;
  if (mode === 'flex') return `${rule.perPeriod || 1}× por mês, datas flexíveis${n === 1 ? '' : ` (a cada ${every})`}`;
  if (mode === 'forecast') return 'Previsão mensal';
  if (rule.frequency === 'daily') return n === 1 ? 'Diária' : `A cada ${n} dias`;
  if (rule.frequency === 'weekly') return n === 1 ? 'Semanal' : n === 2 ? 'A cada 14 dias' : `A cada ${n * 7} dias`;
  if (rule.frequency === 'yearly') return n === 1 ? 'Anual' : `A cada ${n} anos`;
  const base = { 1: 'Mensal', 2: 'Bimestral', 3: 'Trimestral', 6: 'Semestral' }[n] || `A cada ${n} meses`;
  return rule.startDate ? `${base}, dia ${anchorDayOf(rule)}` : base;
}

function listDays(days) {
  const s = [...days].sort((a, b) => a - b).map(String);
  return s.length > 1 ? `${s.slice(0, -1).join(', ')} e ${s[s.length - 1]}` : s[0] || '—';
}

/** Normaliza a lista de dias ("5, 20" ou [20, 5, 5]) → [5, 20]. */
export function parseDays(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[^\d]+/);
  const out = [...new Set(raw.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 31))].sort((a, b) => a - b);
  return out.slice(0, MAX_DAYS);
}

/** Dia de referência das regras mensais/anuais (preserva o dia 31 após meses curtos). */
export const anchorDayOf = (rule) => rule.anchorDay || parseISO(rule.startDate).d;

export function isPaused(rule, date) {
  return (rule.pauses || []).some((p) => date >= p.from && (!p.to || date <= p.to));
}

/** Data final (inclusiva) que produz exatamente `count` ocorrências. */
export function endDateForCount(rule, count) {
  if (!Number.isInteger(count) || count < 1) return null;
  const mode = ruleMode(rule);
  // Datas flexíveis e previsões: a quantidade conta MESES (um compromisso mensal por vez).
  if (mode === 'flex' || mode === 'forecast') {
    const months = ruleMonths({ ...rule, endDate: null }, monthOf(rule.startDate), addMonths(monthOf(rule.startDate), count * Math.max(1, rule.interval || 1)));
    return months[count - 1] ? lastDay(months[count - 1]) : null;
  }
  if (mode === 'days') {
    const per = Math.max(1, parseDays(rule.days).length);
    const months = Math.ceil(count / per) * Math.max(1, rule.interval || 1) + 2;
    const list = ruleOccurrences({ ...rule, endDate: null, exceptions: {}, pauses: [] }, rule.startDate, lastDay(addMonths(monthOf(rule.startDate), months)));
    return list[count - 1]?.date || null;
  }
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
  const push = (d) => { if (d >= start && d <= end && d >= rule.startDate && skip[d] !== 'skipped' && skip[d] !== 'cancelled' && !(paused && isPaused(rule, d))) out.push(d); };

  if (rule.frequency === 'weekly' || rule.frequency === 'daily') {
    const step = (rule.frequency === 'weekly' ? 7 : 1) * n;
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
  if (ruleMode(rule) !== 'fixed') return ruleOccurrences(rule, fromISO, far).find((o) => o.date)?.date || null;
  return occurrences(rule, fromISO, far)[0] || null;
}

/** Meses do período [fromMonth, toMonth] alinhados ao intervalo da regra (limite de 2.400). */
function ruleMonths(rule, fromMonth, toMonth) {
  const out = [];
  const startMonth = monthOf(rule.startDate);
  const endMonth = rule.endDate ? monthOf(rule.endDate) : null;
  const n = Math.max(1, rule.interval || 1);
  let m = fromMonth > startMonth ? fromMonth : startMonth;
  const off = monthDiff(startMonth, m) % n;
  if (off) m = addMonths(m, n - off);
  for (let guard = 0; guard < 2400 && m <= toMonth && (!endMonth || m <= endMonth); guard++, m = addMonths(m, n)) out.push(m);
  return out;
}

/**
 * Ocorrências de QUALQUER modo no intervalo [from, to], com chave estável.
 * Retorna [{ key, date (ou null quando a data é flexível), period: 'AAAA-MM', index }].
 * Datas flexíveis nunca são inventadas: ficam null até o usuário definir.
 */
export function ruleOccurrences(rule, from, to) {
  if (!rule || !rule.startDate || from > to) return [];
  const mode = ruleMode(rule);
  const skip = rule.exceptions || {};
  const skipped = (key) => skip[key] === 'skipped' || skip[key] === 'cancelled';
  if (mode === 'fixed') return occurrences(rule, from, to).map((d, i) => ({ key: d, date: d, period: monthOf(d), index: i + 1 }));
  const out = [];
  for (const m of ruleMonths(rule, monthOf(from), monthOf(to))) {
    if (Array.isArray(rule.pauses) && rule.pauses.length && isPaused(rule, firstDay(m)) && isPaused(rule, lastDay(m))) continue;
    if (mode === 'days') {
      for (const d of parseDays(rule.days)) {
        const date = dateInMonth(m, d);
        const key = `${m}@${d}`;
        if (date < from || date > to || date < rule.startDate || (rule.endDate && date > rule.endDate) || skipped(key) || isPaused(rule, date)) continue;
        out.push({ key, date, period: m, index: out.filter((o) => o.period === m).length + 1 });
      }
    } else if (mode === 'flex') {
      const k = Math.min(MAX_PER_PERIOD, Math.max(1, rule.perPeriod || 1));
      for (let i = 1; i <= k; i++) {
        const key = `${m}#${i}`;
        if (!skipped(key)) out.push({ key, date: null, period: m, index: i });
      }
    } else if (!skipped(m)) out.push({ key: m, date: null, period: m, index: 1 });
  }
  return out;
}

/** Período (AAAA-MM) de uma chave de ocorrência. */
export const periodOfKey = (key) => String(key).slice(0, 7);
