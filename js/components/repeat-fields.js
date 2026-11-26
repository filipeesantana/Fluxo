import { h, icon, put } from '../utils/dom.js';
import { field, readInt } from './fields.js';
import { REPEAT_PRESETS, MONTHLY_MODES, parseDays, describeFrequency, monthlyAmount } from '../services/recurrence.js';
import { formatDate, isISODate, monthOf, formatMonth, dateInMonth, addMonths } from '../utils/dates.js';
import { formatMoney } from '../utils/money.js';

/*
 * Controle "Repetir" com preenchimento progressivo.
 * Primeiro nível: Não repetir · Semanalmente · A cada 14 dias · Mensalmente · Anualmente · Personalizar.
 * Em "Mensalmente", quatro formas humanas: um dia específico, mais de um dia,
 * datas flexíveis ou previsão mensal. Tudo além disso é opcional.
 */
export function repeatFields({ preset = 'none', mode = 'fixed', getDate, getAmount, getType = () => 'expense', onChange = () => {}, idPrefix = 'rp', showStart = false, rule = null }) {
  const sel = h('select', { class: 'select', name: 'repeat', 'aria-label': 'Repetir' }, ...Object.entries(REPEAT_PRESETS).map(([v, p]) => h('option', { value: v }, p.label)));
  sel.value = REPEAT_PRESETS[preset] ? preset : 'none';
  let monthly = mode;
  const modeBtns = Object.entries(MONTHLY_MODES).map(([k, m]) => {
    const b = h('button', { class: 'mode-opt', type: 'button', role: 'radio', 'aria-checked': String(k === monthly), dataset: { mode: k } }, h('strong', null, m.label), h('span', null, m.hint));
    b.addEventListener('click', () => { monthly = k; sync(); onChange(); });
    return b;
  });
  const modeGroup = h('div', { class: 'mode-opts', role: 'radiogroup', 'aria-label': 'Como repetir todo mês' }, ...modeBtns);
  modeGroup.addEventListener('keydown', (ev) => {
    const i = modeBtns.indexOf(document.activeElement);
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
    if (i < 0 || !d) return;
    ev.preventDefault();
    const n = modeBtns[(i + d + modeBtns.length) % modeBtns.length];
    n.focus(); n.click();
  });

  const day = h('input', { class: 'input', type: 'number', min: 1, max: 31, step: 1, inputmode: 'numeric', name: 'repeatDay', placeholder: 'Dia da data', value: rule?.anchorDay || '' });
  const days = h('input', { class: 'input', name: 'repeatDays', placeholder: 'Ex.: 5, 20', inputmode: 'numeric', value: rule?.days ? rule.days.join(', ') : '' });
  const perMonth = h('input', { class: 'input', type: 'number', min: 1, max: 31, step: 1, inputmode: 'numeric', name: 'repeatPerMonth', value: rule?.perPeriod || 2 });
  const customN = h('input', { class: 'input', type: 'number', min: 1, max: 366, step: 1, value: rule?.interval || 1, inputmode: 'numeric', 'aria-label': 'Intervalo', name: 'repeatEvery' });
  const customUnit = h('select', { class: 'select', 'aria-label': 'Unidade', name: 'repeatUnit' }, h('option', { value: 'daily' }, 'dia(s)'), h('option', { value: 'weekly' }, 'semana(s)'), h('option', { value: 'monthly' }, 'mês(es)'), h('option', { value: 'yearly' }, 'ano(s)'));
  customUnit.value = rule?.frequency || 'monthly';
  const start = h('input', { class: 'input', type: 'date', name: 'repeatStart', value: rule?.startDate || '' });
  const end = h('input', { class: 'input', type: 'date', name: 'repeatEnd', value: rule?.endDate || '' });
  const count = h('input', { class: 'input', type: 'number', min: 1, max: 600, step: 1, placeholder: 'Sem limite', inputmode: 'numeric', name: 'repeatCount' });
  const estimated = h('input', { type: 'checkbox', name: 'repeatEstimated', checked: Boolean(rule?.estimated) });
  const summary = h('p', { class: 'repeat-summary', 'aria-live': 'polite' });

  const fDay = field('Dia do vencimento', day, { hint: 'Opcional: usa o dia da data' });
  const fDays = field('Dias do mês', days, { hint: 'Separe por vírgula. Dias que não existem no mês caem no último dia.' });
  const fPer = field('Quantas vezes por mês', perMonth, { hint: 'Cada uma com o valor informado; as datas você define depois' });
  const fCount = field('Quantidade de repetições', count);
  const customRow = h('div', { class: 'form-grid' }, field('A cada', customN), field('Unidade', customUnit));
  const forecastNote = h('p', { class: 'note' }, icon('info', 'icon-sm'), 'O valor é o total previsto para o mês. Gastos registrados e vinculados a esta previsão consomem esse valor; o que sobrar não vira despesa.');
  const monthlyBox = h('div', { class: 'stack' }, modeGroup, h('div', { class: 'form-grid' }, fDay, fDays, fPer), forecastNote);
  const optional = h('details', { class: 'advanced repeat-options' },
    h('summary', null, icon('chev-right', 'icon-sm'), 'Início, término e outras opções', h('span', { class: 'opt' }, ' · opcionais')),
    h('div', { class: 'advanced-body' },
      h('div', { class: 'form-grid' },
        showStart ? field('Começa em', start, { hint: 'Padrão: a data do lançamento' }) : null,
        field(h('span', null, 'Termina em ', h('span', { class: 'opt' }, 'inclusive')), end),
        fCount),
      h('label', { class: 'check' }, estimated, h('span', null, 'Valor a confirmar (estimado)'))));
  const box = h('div', { class: 'repeat-box', hidden: true }, customRow, monthlyBox, optional, summary);

  function sync() {
    const p = sel.value;
    box.hidden = p === 'none';
    customRow.hidden = p !== 'custom';
    const isMonthly = p === 'monthly' || (p === 'custom' && customUnit.value === 'monthly' && Number(customN.value) === 1);
    monthlyBox.hidden = !isMonthly;
    if (getType() === 'income' && monthly === 'forecast') monthly = 'fixed';
    modeBtns.forEach((b) => { b.setAttribute('aria-checked', String(b.dataset.mode === monthly)); b.hidden = b.dataset.mode === 'forecast' && getType() === 'income'; });
    fDay.hidden = monthly !== 'fixed';
    fDays.hidden = monthly !== 'days';
    fPer.hidden = monthly !== 'flex';
    forecastNote.hidden = monthly !== 'forecast';
    fCount.querySelector('.field-label').textContent = isMonthly && (monthly === 'flex' || monthly === 'forecast') ? 'Quantidade de meses' : 'Quantidade de repetições';
    updateSummary();
  }
  function currentMode() { return monthlyBox.hidden ? 'fixed' : monthly; }

  /** Lê a configuração como campos de regra (sem id/descrição/valor). null = não repetir. */
  function read() {
    const p = sel.value;
    if (p === 'none') return null;
    const preset = REPEAT_PRESETS[p];
    let frequency = preset?.frequency || customUnit.value;
    let interval = preset?.frequency ? preset.interval : Math.max(1, Math.min(frequency === 'daily' ? 366 : 60, Number(customN.value) || 1));
    if (p === 'custom' && frequency === 'weekly' && interval === 2) interval = 2;
    const m = currentMode();
    const date = getDate();
    const out = { frequency, interval, mode: m === 'fixed' ? undefined : m };
    const startDate = isISODate(start.value) ? start.value : date;
    out.startDate = startDate;
    if (m === 'fixed' && frequency === 'monthly') {
      const d = readInt(day, { min: 1, max: 31 });
      if (d && isISODate(startDate)) {
        let s = dateInMonth(monthOf(startDate), d);
        if (s < startDate) s = dateInMonth(addMonths(monthOf(startDate), 1), d);
        out.startDate = s;
        out.anchorDay = d;
      }
    }
    if (m === 'days') out.days = parseDays(days.value);
    if (m === 'flex') out.perPeriod = readInt(perMonth, { min: 1, max: 31 }) || 1;
    if (m !== 'fixed' && isISODate(out.startDate)) out.startDate = `${monthOf(out.startDate)}-01`;
    const n = readInt(count, { min: 1, max: 600 });
    out.count = n || undefined;
    out.endDate = n ? null : end.value || null;
    out.estimated = estimated.checked || undefined;
    return out;
  }

  /** Mensagem de erro (ou null). */
  function validate() {
    if (sel.value === 'none') return null;
    const date = isISODate(start.value) ? start.value : getDate();
    if (!isISODate(date)) return 'Informe a data de início.';
    if (end.value && end.value < date) return 'A data de término é anterior ao início.';
    if (count.value && !readInt(count, { min: 1, max: 600 })) return 'Quantidade: de 1 a 600.';
    if (sel.value === 'custom' && !(Number(customN.value) >= 1)) return 'O intervalo precisa ser de pelo menos 1.';
    const m = currentMode();
    if (m === 'fixed' && day.value && !readInt(day, { min: 1, max: 31 })) return 'Dia do vencimento: de 1 a 31.';
    if (m === 'days' && parseDays(days.value).length < 1) return 'Informe ao menos um dia do mês (ex.: 5, 20).';
    if (m === 'flex' && !readInt(perMonth, { min: 1, max: 31 })) return 'Quantas vezes por mês: de 1 a 31.';
    return null;
  }

  function updateSummary() {
    const r = read();
    if (!r) { summary.textContent = ''; return; }
    const amount = getAmount();
    const parts = [describeFrequency({ ...r, startDate: r.startDate })];
    const m = r.mode || 'fixed';
    if (amount) {
      if (m === 'days' || m === 'flex') parts.push(`${formatMoney(amount)} cada · ${formatMoney(monthlyAmount({ ...r, amount }))} por mês`);
      else if (m === 'forecast') parts.push(`até ${formatMoney(amount)} por mês`);
    }
    if (isISODate(r.startDate)) parts.push(m === 'fixed' ? `a partir de ${formatDate(r.startDate)}` : `a partir de ${formatMonth(monthOf(r.startDate))}`);
    if (r.count) parts.push(`${r.count} ${m === 'flex' || m === 'forecast' ? 'mês(es)' : 'vez(es)'}`);
    else if (r.endDate) parts.push(`até ${formatDate(r.endDate)}`);
    else parts.push('sem data de término');
    if (r.estimated) parts.push('valor a confirmar');
    summary.textContent = `${parts.join(' · ')}.${m === 'flex' ? ' As datas de cada ocorrência podem ser definidas depois, mês a mês.' : ''}`;
  }

  sel.addEventListener('change', () => { if (sel.value === 'custom') optional.open = false; sync(); onChange(); });
  for (const el of [day, days, perMonth, customN, customUnit, start, end, count, estimated]) el.addEventListener('input', () => { if (el === customN || el === customUnit) sync(); else updateSummary(); });
  if (rule?.mode) { monthly = rule.mode; }
  sync();
  return {
    select: sel, box, read, validate, update: sync,
    get active() { return sel.value !== 'none'; },
    get mode() { return sel.value === 'none' ? null : currentMode(); },
    set(presetKey, m) { sel.value = presetKey; if (m) monthly = m; sync(); },
  };
}

export { put };
