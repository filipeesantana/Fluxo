import { h, icon } from '../utils/dom.js';
import { field, readInt, segmented } from './fields.js';
import { parseDays, describeFrequency, monthlyAmount, ruleMode } from '../services/recurrence.js';
import { formatDate, isISODate, monthOf, formatMonth, dateInMonth, addMonths } from '../utils/dates.js';
import { formatMoney } from '../utils/money.js';

/*
 * Repetição dentro do próprio formulário (3.2).
 *
 *   Repetição [ Mensalmente ▾ ]  Dia [ 5 ]
 *
 * Uma seleção basta: Mensalmente já usa o dia da data (editável ao lado).
 * O restante fica numa expansão discreta ("Mais opções de repetição"):
 *   vezes por mês e datas (dia fixo, dias fixos, a definir), valor variável
 *   (previsão de gasto), início, término e quantidade.
 * Personalizar: a cada N dias, semanas, meses ou anos.
 */
export const REPEAT_OPTIONS = [
  ['none', 'Não repetir'], ['weekly', 'Semanalmente'], ['biweekly', 'A cada 14 dias'],
  ['monthly', 'Mensalmente'], ['yearly', 'Anualmente'], ['custom', 'Personalizar…'],
];
const FIXED = { weekly: ['weekly', 1], biweekly: ['weekly', 2], yearly: ['yearly', 1], monthly: ['monthly', 1] };

/** Estado inicial a partir de um preset, de um modo e/ou de uma regra existente. */
function initialState(preset, mode, rule) {
  const s = { kind: 'none', times: 1, dates: 'day', forecast: false, n: 1, unit: 'monthly' };
  const m = rule ? ruleMode(rule) : mode || 'fixed';
  if (rule) {
    if (m === 'fixed') {
      const hit = Object.entries(FIXED).find(([, [f, i]]) => f === rule.frequency && i === (rule.interval || 1));
      if (hit) s.kind = hit[0]; else { s.kind = 'custom'; s.n = rule.interval || 1; s.unit = rule.frequency; }
      if (s.kind !== 'monthly') return s;
    } else s.kind = 'monthly';
  } else if (preset && preset !== 'none') s.kind = REPEAT_OPTIONS.some(([v]) => v === preset) ? preset : 'monthly';
  else return s;
  if (m === 'forecast') s.forecast = true;
  else if (m === 'days') { s.times = rule?.days?.length || 2; s.dates = 'day'; }
  else if (m === 'flex') { s.times = rule?.perPeriod || 2; s.dates = 'tbd'; }
  return s;
}

export function repeatFields({ preset = 'none', mode = 'fixed', getDate, getAmount, getType = () => 'expense', onChange = () => {}, onDayChange = () => {}, showStart = false, allowNone = true, rule = null }) {
  const st = initialState(preset, mode, rule);
  if (!allowNone && st.kind === 'none') st.kind = 'monthly';
  const emit = () => { sync(); onChange(); };

  // ——— Primeiro nível: uma seleção ———
  const sel = h('select', { class: 'select', name: 'repeat', 'aria-label': 'Repetição' },
    ...REPEAT_OPTIONS.filter(([v]) => allowNone || v !== 'none').map(([v, l]) => h('option', { value: v }, l)));
  sel.value = st.kind;
  sel.addEventListener('change', () => { st.kind = sel.value; emit(); });
  // Dia do mês ao lado (mensal de dia fixo). Começa no dia da data; mudar aqui é opcional.
  let dayTouched = Boolean(rule?.anchorDay && ruleMode(rule) === 'fixed');
  const day = h('input', { class: 'input input-num', type: 'number', min: 1, max: 31, step: 1, inputmode: 'numeric', name: 'repeatDay', 'aria-label': 'Dia do mês', value: dayTouched ? rule.anchorDay : '' });
  const dayWrap = h('label', { class: 'inline-field repeat-day' }, h('span', { class: 'small faint' }, 'Dia'), day);
  day.addEventListener('input', () => { const d = readInt(day, { min: 1, max: 31 }); if (d) { dayTouched = true; onDayChange(d); } updateSummary(); });
  const control = h('div', { class: 'repeat-control' }, sel, dayWrap);

  // ——— Mais opções (mensal) ———
  const times = h('input', { class: 'input input-num', type: 'number', min: 1, max: 31, step: 1, inputmode: 'numeric', name: 'repeatTimes', value: st.times, 'aria-label': 'Vezes por mês' });
  const stepBtn = (d, label) => h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': label, onclick: () => { const v = Math.min(31, Math.max(1, (readInt(times, { min: 1, max: 31 }) || 1) + d)); times.value = v; st.times = v; emit(); } }, icon(d > 0 ? 'plus' : 'minus', 'icon-sm'));
  const stepper = h('div', { class: 'stepper' }, stepBtn(-1, 'Menos uma vez por mês'), times, stepBtn(1, 'Mais uma vez por mês'));
  times.addEventListener('input', () => { const v = readInt(times, { min: 1, max: 31 }); if (v) { st.times = v; emit(); } });
  const datesSeg = segmented({ label: 'Datas', value: st.dates, size: 'segmented-sm', options: [{ value: 'day', label: 'Dia fixo' }, { value: 'tbd', label: 'A definir' }], onChange: (v) => { st.dates = v; emit(); } });
  const days = h('input', { class: 'input', name: 'repeatDays', placeholder: 'Ex.: 5, 20', inputmode: 'numeric', value: rule?.days ? rule.days.join(', ') : '', 'aria-label': 'Dias do mês' });
  const forecast = h('input', { type: 'checkbox', name: 'repeatForecast', checked: st.forecast });
  forecast.addEventListener('change', () => { st.forecast = forecast.checked; emit(); });
  const forecastRow = h('label', { class: 'check check-sm' }, forecast, h('span', null, 'Valor variável: previsão de gasto do mês ', h('span', { class: 'faint' }, '(ex.: combustível)')));
  const forecastNote = h('p', { class: 'note' }, icon('info', 'icon-sm'), 'O valor é o máximo previsto no mês. Gastos registrados nesta previsão consomem esse valor; o que sobrar não vira despesa.');
  const fTimes = field('Vezes por mês', stepper, { className: 'f-times' });
  const fDates = field('Datas', h('div', { class: 'row wrap gap-sm' }, datesSeg, days), { className: 'f-dates' });
  const monthlyBox = h('div', { class: 'stack-sm' }, h('div', { class: 'repeat-grid' }, fTimes, fDates), forecastRow, forecastNote);

  // ——— Personalizar ———
  const customN = h('input', { class: 'input input-num', type: 'number', min: 1, max: 366, step: 1, value: st.n, inputmode: 'numeric', 'aria-label': 'Intervalo', name: 'repeatEvery' });
  const customUnit = h('select', { class: 'select', 'aria-label': 'Unidade', name: 'repeatUnit' }, h('option', { value: 'daily' }, 'dia(s)'), h('option', { value: 'weekly' }, 'semana(s)'), h('option', { value: 'monthly' }, 'mês(es)'), h('option', { value: 'yearly' }, 'ano(s)'));
  customUnit.value = st.unit;
  const customBox = h('div', { class: 'row gap-sm' }, h('span', { class: 'small' }, 'A cada'), customN, customUnit);

  // ——— Início, término, quantidade ———
  const start = h('input', { class: 'input', type: 'date', name: 'repeatStart', value: '' });
  const end = h('input', { class: 'input', type: 'date', name: 'repeatEnd', value: rule?.endDate || '' });
  const count = h('input', { class: 'input', type: 'number', min: 1, max: 600, step: 1, placeholder: 'Sem limite', inputmode: 'numeric', name: 'repeatCount' });
  const estimated = h('input', { type: 'checkbox', name: 'repeatEstimated', checked: Boolean(rule?.estimated) });
  const fCount = field('Quantidade', count);
  const optional = h('details', { class: 'advanced repeat-options', open: Boolean(rule?.mode && rule.mode !== 'fixed') || st.times > 1 || st.forecast || null },
    h('summary', null, icon('chev-right', 'icon-sm'), 'Mais opções de repetição', h('span', { class: 'opt' }, ' · vezes por mês, datas flexíveis, término')),
    h('div', { class: 'advanced-body stack-sm' },
      monthlyBox,
      h('div', { class: 'form-grid' },
        showStart ? field('Começa em', start, { hint: 'Padrão: a data do lançamento' }) : null,
        field(h('span', null, 'Termina em ', h('span', { class: 'opt' }, 'inclusive')), end),
        fCount),
      h('label', { class: 'check' }, estimated, h('span', null, 'Valor a confirmar (estimado)'))));
  const summary = h('p', { class: 'repeat-summary', 'aria-live': 'polite' });
  const box = h('div', { class: 'repeat-box', hidden: true }, customBox, summary, optional);

  const isExpense = () => getType() !== 'income';
  /** Modo efetivo da regra (fixed · days · flex · forecast) ou null. */
  function currentMode() {
    if (st.kind === 'none') return null;
    if (st.kind !== 'monthly') return 'fixed';
    if (st.forecast && isExpense()) return 'forecast';
    if (st.times === 1) return st.dates === 'tbd' ? 'flex' : 'fixed';
    return st.dates === 'tbd' ? 'flex' : 'days';
  }
  const baseDate = () => (isISODate(start.value) ? start.value : getDate());
  const baseDay = () => { const d = baseDate(); return isISODate(d) ? Number(d.slice(8, 10)) : null; };

  function sync() {
    sel.value = st.kind;
    box.hidden = st.kind === 'none';
    customBox.hidden = st.kind !== 'custom';
    monthlyBox.hidden = st.kind !== 'monthly';
    const m = currentMode();
    const fc = m === 'forecast';
    forecastRow.hidden = !isExpense();
    forecastNote.hidden = !fc;
    fTimes.hidden = fc;
    fDates.hidden = fc;
    datesSeg.querySelector('[data-value="day"]').lastChild.textContent = st.times > 1 ? 'Dias fixos' : 'Dia fixo';
    dayWrap.hidden = !(st.kind === 'monthly' && m === 'fixed');
    days.hidden = m !== 'days';
    if (!dayTouched) day.value = baseDay() || '';
    fCount.querySelector('.field-label').textContent = m === 'flex' || m === 'forecast' ? 'Quantidade de meses' : 'Quantidade de vezes';
    updateSummary();
  }

  /**
   * Lê a configuração como campos de regra (sem id, descrição e valor). null = não repetir.
   * No mensal de dia fixo, monthStart é o dia escolhido no mês da data (a ocorrência
   * que o próprio lançamento representa) e startDate a primeira data da série futura.
   */
  function read() {
    const m = currentMode();
    if (!m) return null;
    let [frequency, interval] = FIXED[st.kind] || [customUnit.value, Math.max(1, Math.min(customUnit.value === 'daily' ? 366 : 60, readInt(customN, { min: 1, max: 366 }) || 1))];
    if (st.kind === 'monthly') [frequency, interval] = ['monthly', 1];
    const date = baseDate();
    const out = { frequency, interval, mode: m === 'fixed' ? undefined : m, startDate: date };
    if (m === 'fixed' && frequency === 'monthly' && interval === 1 && isISODate(date)) {
      const d = readInt(day, { min: 1, max: 31 }) || Number(date.slice(8, 10));
      out.anchorDay = d;
      out.monthStart = dateInMonth(monthOf(date), d);
      out.startDate = out.monthStart < date ? dateInMonth(addMonths(monthOf(date), 1), d) : out.monthStart;
    }
    if (m === 'days') out.days = parseDays(days.value);
    if (m === 'flex') out.perPeriod = st.times;
    if (m !== 'fixed' && isISODate(out.startDate)) out.startDate = `${monthOf(out.startDate)}-01`;
    const n = readInt(count, { min: 1, max: 600 });
    out.count = n || undefined;
    out.endDate = n ? null : end.value || null;
    out.estimated = estimated.checked || undefined;
    return out;
  }

  /** Mensagem de erro (ou null). */
  function validate() {
    const m = currentMode();
    if (!m) return null;
    const date = baseDate();
    if (!isISODate(date) && m !== 'flex' && m !== 'forecast') return 'Informe a data do lançamento: a repetição começa nela.';
    if (end.value && isISODate(date) && end.value < date) return 'A data de término é anterior ao início.';
    if (count.value && !readInt(count, { min: 1, max: 600 })) return 'Quantidade: de 1 a 600.';
    if (st.kind === 'custom' && !readInt(customN, { min: 1, max: customUnit.value === 'daily' ? 366 : 60 })) return customUnit.value === 'daily' ? 'O intervalo precisa ser de 1 a 366 dias.' : 'O intervalo precisa ser de 1 a 60.';
    if (st.kind === 'monthly' && m !== 'forecast' && !readInt(times, { min: 1, max: 31 })) return 'Vezes por mês: de 1 a 31.';
    if (m === 'fixed' && day.value && !readInt(day, { min: 1, max: 31 })) return 'Dia do mês: de 1 a 31.';
    if (m === 'days' && parseDays(days.value).length !== st.times) return `Informe ${st.times} dias do mês, separados por vírgula (ex.: 5, 20).`;
    return null;
  }

  function describe() {
    const r = read();
    if (!r) return '';
    const amount = getAmount();
    const m = r.mode || 'fixed';
    const parts = [describeFrequency({ ...r })];
    if (amount) {
      if (m === 'days' || m === 'flex') parts.push(`${formatMoney(amount)} cada · ${formatMoney(monthlyAmount({ ...r, amount }))} por mês`);
      else if (m === 'forecast') parts.push(`até ${formatMoney(amount)} por mês`);
    }
    if (isISODate(r.startDate)) parts.push(m === 'fixed' ? `a partir de ${formatDate(r.monthStart || r.startDate)}` : `a partir de ${formatMonth(monthOf(r.startDate))}`);
    if (r.count) parts.push(`${r.count} ${m === 'flex' || m === 'forecast' ? (r.count === 1 ? 'mês' : 'meses') : (r.count === 1 ? 'vez' : 'vezes')}`);
    else if (r.endDate) parts.push(`até ${formatDate(r.endDate)}`);
    else parts.push('sem data de término');
    if (r.estimated) parts.push('valor a confirmar');
    return `${parts.join(' · ')}.${m === 'flex' ? ' As datas podem ser definidas depois, mês a mês.' : ''}`;
  }
  function updateSummary() { summary.textContent = describe(); }

  for (const el of [days, customN, customUnit, start, end, count, estimated]) el.addEventListener('input', () => { if (el === customN || el === customUnit || el === start) sync(); else updateSummary(); });
  customUnit.addEventListener('change', sync);
  sync();
  return {
    select: sel, control, box, read, validate, update: sync, describe,
    get active() { return st.kind !== 'none'; },
    get mode() { return currentMode(); },
    get kind() { return st.kind; },
    /** Define a repetição (none · weekly · biweekly · monthly · yearly · custom) e, opcionalmente, o modo mensal. */
    set(kind, m) {
      st.kind = REPEAT_OPTIONS.some(([v]) => v === kind) ? kind : 'monthly';
      if (m === 'forecast') { st.forecast = true; forecast.checked = true; }
      else if (m === 'flex') { st.forecast = false; forecast.checked = false; st.dates = 'tbd'; datesSeg.setValue('tbd'); }
      else if (m === 'days') { st.forecast = false; forecast.checked = false; st.dates = 'day'; datesSeg.setValue('day'); if (st.times < 2) { st.times = 2; times.value = 2; } }
      else if (m === 'fixed') { st.forecast = false; forecast.checked = false; st.dates = 'day'; datesSeg.setValue('day'); st.times = 1; times.value = 1; }
      sync();
    },
  };
}
