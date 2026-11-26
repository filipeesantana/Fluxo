import { h, icon } from '../utils/dom.js';
import { field, readInt, segmented } from './fields.js';
import { parseDays, describeFrequency, monthlyAmount, ruleMode } from '../services/recurrence.js';
import { formatDate, isISODate, monthOf, formatMonth, dateInMonth, addMonths } from '../utils/dates.js';
import { formatMoney } from '../utils/money.js';

/*
 * Controle "Repetir", compacto e progressivo.
 *
 *   Repetir  [ Não repetir | Mensal | Personalizar ]
 *
 * "Mensal" já vem pronto: todo mês, no mesmo dia da data, sem término.
 * Os outros modelos saem de duas perguntas simples, sem jargão:
 *   Vezes por mês: 1   · Datas: dia fixo | a definir   → dia específico ou data a combinar
 *   Vezes por mês: 2+  · Datas: dias fixos | a definir → vários dias (5 e 20) ou datas flexíveis
 *   "Valor variável"                                  → previsão de gasto do mês (combustível)
 * "Personalizar" cobre semanal, a cada 14 dias, anual e intervalos livres.
 * Início, término e quantidade ficam recolhidos e são opcionais.
 */
const QUICK = {
  weekly: { label: 'Toda semana', frequency: 'weekly', interval: 1 },
  biweekly: { label: 'A cada 14 dias', frequency: 'weekly', interval: 2 },
  yearly: { label: 'Todo ano', frequency: 'yearly', interval: 1 },
  other: { label: 'Outro intervalo' },
};
const LEGACY_PRESET = { weekly: 'weekly', biweekly: 'biweekly', yearly: 'yearly' };

/** Estado inicial a partir de um preset antigo, de um modo e/ou de uma regra existente. */
function initialState(preset, mode, rule) {
  const s = { kind: 'none', times: 1, dates: 'day', forecast: false, quick: 'weekly', n: 1, unit: 'monthly' };
  const m = rule ? ruleMode(rule) : mode || 'fixed';
  if (rule) {
    if (m === 'fixed' && !(rule.frequency === 'monthly' && (rule.interval || 1) === 1)) {
      s.kind = 'custom';
      const q = Object.entries(QUICK).find(([, v]) => v.frequency === rule.frequency && v.interval === (rule.interval || 1));
      if (q) s.quick = q[0]; else { s.quick = 'other'; s.n = rule.interval || 1; s.unit = rule.frequency; }
      return s;
    }
    s.kind = 'monthly';
  } else if (preset === 'monthly') s.kind = 'monthly';
  else if (LEGACY_PRESET[preset]) { s.kind = 'custom'; s.quick = LEGACY_PRESET[preset]; return s; }
  else if (preset === 'custom') { s.kind = 'custom'; return s; }
  else return s;
  if (m === 'forecast') s.forecast = true;
  else if (m === 'days') { s.times = rule?.days?.length || 2; s.dates = 'day'; }
  else if (m === 'flex') { s.times = rule?.perPeriod || 2; s.dates = 'tbd'; }
  return s;
}

export function repeatFields({ preset = 'none', mode = 'fixed', getDate, getAmount, getType = () => 'expense', onChange = () => {}, showStart = false, allowNone = true, rule = null }) {
  const st = initialState(preset, mode, rule);
  if (!allowNone && st.kind === 'none') st.kind = 'monthly';
  const emit = () => { sync(); onChange(); };

  // ——— Primeiro nível ———
  const seg = segmented({
    label: 'Repetir', value: st.kind, size: 'repeat-seg',
    options: [allowNone ? { value: 'none', label: 'Não repetir' } : null, { value: 'monthly', label: 'Mensal' }, { value: 'custom', label: 'Personalizar' }].filter(Boolean),
    onChange: (v) => { st.kind = v; emit(); },
  });

  // ——— Mensal ———
  const times = h('input', { class: 'input input-num', type: 'number', min: 1, max: 31, step: 1, inputmode: 'numeric', name: 'repeatTimes', value: st.times, 'aria-label': 'Vezes por mês' });
  const stepBtn = (d, label) => h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': label, onclick: () => { const v = Math.min(31, Math.max(1, (readInt(times, { min: 1, max: 31 }) || 1) + d)); times.value = v; st.times = v; emit(); } }, icon(d > 0 ? 'plus' : 'minus', 'icon-sm'));
  const stepper = h('div', { class: 'stepper' }, stepBtn(-1, 'Menos uma vez por mês'), times, stepBtn(1, 'Mais uma vez por mês'));
  times.addEventListener('input', () => { const v = readInt(times, { min: 1, max: 31 }); if (v) { st.times = v; emit(); } });
  const datesSeg = segmented({ label: 'Datas', value: st.dates, size: 'segmented-sm', options: [{ value: 'day', label: 'Dia fixo' }, { value: 'tbd', label: 'A definir' }], onChange: (v) => { st.dates = v; emit(); } });
  const day = h('input', { class: 'input input-num', type: 'number', min: 1, max: 31, step: 1, inputmode: 'numeric', name: 'repeatDay', value: rule?.anchorDay && ruleMode(rule) === 'fixed' ? rule.anchorDay : '', 'aria-label': 'Dia do mês' });
  const days = h('input', { class: 'input', name: 'repeatDays', placeholder: 'Ex.: 5, 20', inputmode: 'numeric', value: rule?.days ? rule.days.join(', ') : '', 'aria-label': 'Dias do mês' });
  const dayWrap = h('label', { class: 'inline-field' }, h('span', { class: 'small faint' }, 'dia'), day);
  const forecast = h('input', { type: 'checkbox', name: 'repeatForecast', checked: st.forecast });
  forecast.addEventListener('change', () => { st.forecast = forecast.checked; emit(); });
  const forecastRow = h('label', { class: 'check check-sm' }, forecast, h('span', null, 'Valor variável: usar como previsão de gasto do mês ', h('span', { class: 'faint' }, '(ex.: combustível)')));
  const forecastNote = h('p', { class: 'note' }, icon('info', 'icon-sm'), 'O valor é o máximo previsto no mês. Cada gasto registrado nesta previsão consome esse valor; o que sobrar não vira despesa.');
  const fTimes = field('Vezes por mês', stepper, { className: 'f-times' });
  const fDates = field('Datas', h('div', { class: 'row wrap gap-sm' }, datesSeg, dayWrap, days), { className: 'f-dates' });
  const monthlyBox = h('div', { class: 'stack-sm' }, h('div', { class: 'repeat-grid' }, fTimes, fDates), forecastRow, forecastNote);

  // ——— Personalizar ———
  const quickSeg = segmented({ label: 'Frequência', value: st.quick, size: 'segmented-sm', options: Object.entries(QUICK).map(([value, q]) => ({ value, label: q.label })), onChange: (v) => { st.quick = v; emit(); } });
  const customN = h('input', { class: 'input input-num', type: 'number', min: 1, max: 366, step: 1, value: st.n, inputmode: 'numeric', 'aria-label': 'Intervalo', name: 'repeatEvery' });
  const customUnit = h('select', { class: 'select', 'aria-label': 'Unidade', name: 'repeatUnit' }, h('option', { value: 'daily' }, 'dia(s)'), h('option', { value: 'weekly' }, 'semana(s)'), h('option', { value: 'monthly' }, 'mês(es)'), h('option', { value: 'yearly' }, 'ano(s)'));
  customUnit.value = st.unit;
  const otherRow = h('div', { class: 'row gap-sm' }, h('span', { class: 'small' }, 'A cada'), customN, customUnit);
  const customBox = h('div', { class: 'stack-sm' }, quickSeg, otherRow);

  // ——— Opcionais ———
  const start = h('input', { class: 'input', type: 'date', name: 'repeatStart', value: '' });
  const end = h('input', { class: 'input', type: 'date', name: 'repeatEnd', value: rule?.endDate || '' });
  const count = h('input', { class: 'input', type: 'number', min: 1, max: 600, step: 1, placeholder: 'Sem limite', inputmode: 'numeric', name: 'repeatCount' });
  const estimated = h('input', { type: 'checkbox', name: 'repeatEstimated', checked: Boolean(rule?.estimated) });
  const fCount = field('Quantidade', count);
  const optional = h('details', { class: 'advanced repeat-options' },
    h('summary', null, icon('chev-right', 'icon-sm'), 'Início e término', h('span', { class: 'opt' }, ' · opcionais')),
    h('div', { class: 'advanced-body' },
      h('div', { class: 'form-grid' },
        showStart ? field('Começa em', start, { hint: 'Padrão: a data do lançamento' }) : null,
        field(h('span', null, 'Termina em ', h('span', { class: 'opt' }, 'inclusive')), end),
        fCount),
      h('label', { class: 'check' }, estimated, h('span', null, 'Valor a confirmar (estimado)'))));
  const summary = h('p', { class: 'repeat-summary', 'aria-live': 'polite' });
  const box = h('div', { class: 'repeat-box', hidden: true }, monthlyBox, customBox, optional, summary);

  const isExpense = () => getType() !== 'income';
  /** Modo efetivo da regra (fixed · days · flex · forecast) ou null. */
  function currentMode() {
    if (st.kind === 'none') return null;
    if (st.kind === 'custom') return 'fixed';
    if (st.forecast && isExpense()) return 'forecast';
    if (st.times === 1) return st.dates === 'tbd' ? 'flex' : 'fixed';
    return st.dates === 'tbd' ? 'flex' : 'days';
  }
  const baseDay = () => { const d = isISODate(start.value) ? start.value : getDate(); return isISODate(d) ? Number(d.slice(8, 10)) : null; };

  function sync() {
    seg.setValue(st.kind);
    box.hidden = st.kind === 'none';
    monthlyBox.hidden = st.kind !== 'monthly';
    customBox.hidden = st.kind !== 'custom';
    otherRow.hidden = st.quick !== 'other';
    const m = currentMode();
    const fc = m === 'forecast';
    forecastRow.hidden = !isExpense();
    forecastNote.hidden = !fc;
    fTimes.hidden = fc;
    fDates.hidden = fc;
    datesSeg.querySelector('[data-value="day"]').lastChild.textContent = st.times > 1 ? 'Dias fixos' : 'Dia fixo';
    dayWrap.hidden = m !== 'fixed' || st.kind !== 'monthly';
    days.hidden = m !== 'days';
    const bd = baseDay();
    day.placeholder = bd ? String(bd) : 'dia';
    fCount.querySelector('.field-label').textContent = m === 'flex' || m === 'forecast' ? 'Quantidade de meses' : 'Quantidade de vezes';
    updateSummary();
  }

  /**
   * Lê a configuração como campos de regra (sem id, descrição e valor). null = não repetir.
   * startDate: primeira data da série; no mensal de dia fixo, se o dia escolhido já
   * passou no mês da data, a série começa no mês seguinte (monthStart guarda o dia
   * equivalente no próprio mês, para quem registra a ocorrência deste mês).
   */
  function read() {
    const m = currentMode();
    if (!m) return null;
    let frequency = 'monthly';
    let interval = 1;
    if (st.kind === 'custom') {
      const q = QUICK[st.quick];
      frequency = q.frequency || customUnit.value;
      interval = q.frequency ? q.interval : Math.max(1, Math.min(frequency === 'daily' ? 366 : 60, readInt(customN, { min: 1, max: 366 }) || 1));
    }
    const date = isISODate(start.value) ? start.value : getDate();
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
    const date = isISODate(start.value) ? start.value : getDate();
    if (!isISODate(date) && m !== 'flex' && m !== 'forecast') return 'Informe a data do lançamento: a repetição começa nela.';
    if (end.value && isISODate(date) && end.value < date) return 'A data de término é anterior ao início.';
    if (count.value && !readInt(count, { min: 1, max: 600 })) return 'Quantidade: de 1 a 600.';
    if (st.kind === 'custom' && st.quick === 'other' && !readInt(customN, { min: 1, max: customUnit.value === 'daily' ? 366 : 60 })) return customUnit.value === 'daily' ? 'O intervalo precisa ser de 1 a 366 dias.' : 'O intervalo precisa ser de 1 a 60.';
    if (st.kind === 'monthly' && m !== 'forecast' && !readInt(times, { min: 1, max: 31 })) return 'Vezes por mês: de 1 a 31.';
    if (m === 'fixed' && day.value && !readInt(day, { min: 1, max: 31 })) return 'Dia do mês: de 1 a 31.';
    if (m === 'days') {
      const list = parseDays(days.value);
      if (list.length !== st.times) return `Informe ${st.times} dias do mês, separados por vírgula (ex.: 5, 20).`;
    }
    return null;
  }

  function updateSummary() {
    const r = read();
    if (!r) { summary.textContent = ''; return; }
    const amount = getAmount();
    const m = r.mode || 'fixed';
    const parts = [describeFrequency({ ...r })];
    if (amount) {
      if (m === 'days' || m === 'flex') parts.push(`${formatMoney(amount)} cada · ${formatMoney(monthlyAmount({ ...r, amount }))} por mês`);
      else if (m === 'forecast') parts.push(`até ${formatMoney(amount)} por mês`);
    }
    if (isISODate(r.startDate)) parts.push(m === 'fixed' ? `a partir de ${formatDate(r.startDate)}` : `a partir de ${formatMonth(monthOf(r.startDate))}`);
    if (r.count) parts.push(`${r.count} ${m === 'flex' || m === 'forecast' ? (r.count === 1 ? 'mês' : 'meses') : (r.count === 1 ? 'vez' : 'vezes')}`);
    else if (r.endDate) parts.push(`até ${formatDate(r.endDate)}`);
    else parts.push('sem data de término');
    if (r.estimated) parts.push('valor a confirmar');
    summary.textContent = `${parts.join(' · ')}.${m === 'flex' ? ' As datas podem ser definidas depois, mês a mês.' : ''}`;
  }

  for (const el of [day, days, customN, customUnit, start, end, count, estimated]) el.addEventListener('input', () => { if (el === customN || el === customUnit) sync(); else updateSummary(); });
  customUnit.addEventListener('change', sync);
  sync();
  return {
    select: seg, control: seg, box, read, validate, update: sync,
    get active() { return st.kind !== 'none'; },
    get mode() { return currentMode(); },
    /** Define o tipo de repetição (none · monthly · custom, ou um preset antigo) e, opcionalmente, o modo mensal. */
    set(kind, m) {
      if (LEGACY_PRESET[kind]) { st.kind = 'custom'; st.quick = LEGACY_PRESET[kind]; } else st.kind = kind;
      if (m === 'forecast') { st.forecast = true; forecast.checked = true; }
      else if (m === 'flex') { st.forecast = false; forecast.checked = false; st.dates = 'tbd'; datesSeg.setValue('tbd'); }
      else if (m === 'days') { st.forecast = false; forecast.checked = false; st.dates = 'day'; datesSeg.setValue('day'); if (st.times < 2) { st.times = 2; times.value = 2; } }
      else if (m === 'fixed') { st.forecast = false; forecast.checked = false; st.dates = 'day'; datesSeg.setValue('day'); st.times = 1; times.value = 1; }
      sync();
    },
  };
}
