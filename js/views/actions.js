import { h, put, icon, uid } from '../utils/dom.js';
import { openMenu } from '../components/menu.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { toast, toastError } from '../components/toast.js';
import { openEntryForm } from '../components/entry-form.js';
import { field, moneyInput, segmented } from '../components/fields.js';
import { repeatFields } from '../components/repeat-fields.js';
import * as repo from '../database/repository.js';
import { today, formatDate, isISODate, addDays, addMonths, monthOf, formatMonth, formatMonthShort, dateInMonth, currentMonth, firstDay, lastDay } from '../utils/dates.js';
import { formatMoney } from '../utils/money.js';
import { ruleMode, describeFrequency, MONTHLY_MODES, parseDays } from '../services/recurrence.js';
import { isCard } from '../services/cards.js';
import { categoryOptions, blockOptions, accountOptions, capitalize, rowActions } from './common.js';
import { ui } from '../state.js';

const keyOf = (item) => item.occurrenceKey || item.occurrenceDate || null;
const paidWord = (item) => (item.type === 'income' ? 'recebido' : 'pago');

export function openItem(item) {
  if (item.forecast) { openEntryForm({ defaults: { type: 'expense', forecastId: item.recurrenceId, categoryId: item.categoryId, blockId: item.blockId, sourceId: item.sourceId, description: item.description, status: 'done', date: today() } }); return; }
  if (item.virtual) openEntryForm({ occurrence: { ruleId: item.recurrenceId, key: keyOf(item), date: item.date, period: item.period }, defaults: item });
  else openEntryForm({ tx: repo.get('transactions', item.id) });
}

/**
 * Botão de situação (círculo): conclui na hora com os dados previstos. Sem
 * data definida, abre a confirmação (data, valor e fonte). "Confirmar
 * pagamento…" no menu permite ajustar tudo. Pago → volta a previsto.
 */
const inFlight = new Map(); // item → instante da última operação (clique duplo não paga e desfaz)
export async function toggleStatus(item) {
  if (item.forecast) { openItem(item); return; }
  if (item.status !== 'done' && !item.date) { openPayDialog(item); return; }
  const key = item.virtual ? `${item.recurrenceId}:${keyOf(item)}` : item.id;
  if (inFlight.has(key) && Date.now() - inFlight.get(key) < 700) return;
  inFlight.set(key, Date.now());
  try {
    await doToggle(item);
  } finally {
    setTimeout(() => inFlight.delete(key), 700);
  }
}

async function doToggle(item) {
  try {
    if (item.virtual) {
      await repo.payItem(item, { date: item.date, amount: item.amount, sourceId: item.sourceId });
      toast(`“${item.description}” marcado como ${paidWord(item)}`, { tone: 'success', action: { label: 'Desfazer', fn: () => repo.unpayItem(`${item.recurrenceId}:${keyOf(item)}`).catch(toastError) } });
      return;
    }
    const tx = repo.get('transactions', item.id);
    if (!tx) return;
    if (tx.status === 'done') {
      await repo.unpayItem(tx.id);
      toast('Voltou para previsto', { action: { label: 'Desfazer', fn: () => repo.payItem(repo.get('transactions', tx.id), { date: tx.date, amount: tx.amount, sourceId: tx.sourceId }).catch(toastError) } });
    } else {
      await repo.payItem(tx, { date: tx.date, amount: tx.amount, sourceId: tx.sourceId });
      toast(`Marcado como ${paidWord(tx)}`, { tone: 'success', action: { label: 'Desfazer', fn: () => repo.unpayItem(tx.id).catch(toastError) } });
    }
  } catch (err) { toastError(err); }
}

/** Confirmação de pagamento: data efetiva, valor pago e fonte; pagamento parcial opcional. */
export function openPayDialog(item) {
  const t = today();
  const date = h('input', { class: 'input', type: 'date', name: 'payDate', value: item.date && item.date <= t ? item.date : t });
  const amount = moneyInput({ value: item.amount, name: 'payAmount' });
  const src = h('select', { class: 'select', name: 'paySource' }, h('option', { value: '' }, 'Sem fonte'), ...accountOptions({ keep: item.sourceId }).map((o) => h('option', { value: o.value }, o.label)));
  src.value = item.sourceId || '';
  const keep = h('input', { type: 'checkbox', name: 'payKeepRest', checked: true });
  const restRow = h('label', { class: 'check', hidden: true }, keep, h('span', null, ''));
  const cardNote = h('p', { class: 'note', hidden: true }, icon('card', 'icon-sm'), 'Compra no cartão: fica registrada agora e o dinheiro sai quando a fatura for paga (sem contar duas vezes).');
  const sync = () => {
    const v = amount.getValue();
    const diff = item.amount - (v || 0);
    restRow.hidden = !(v && diff > 0);
    restRow.querySelector('span').textContent = `Pagamento parcial: manter ${formatMoney(Math.max(0, diff))} como restante previsto`;
    cardNote.hidden = !(item.type === 'expense' && isCard(repo.get('accounts', src.value)));
  };
  amount.input.addEventListener('input', sync);
  src.addEventListener('change', sync);
  const fAmount = field(item.type === 'income' ? 'Valor recebido' : 'Valor pago', amount);
  const fDate = field(item.type === 'income' ? 'Data do recebimento' : 'Data do pagamento', date);
  const go = h('button', { class: 'btn btn-primary', type: 'submit', form: 'pay-form' }, item.type === 'income' ? 'Confirmar recebimento' : 'Confirmar pagamento');
  const form = h('form', { class: 'stack', id: 'pay-form', novalidate: true },
    h('p', { class: 'muted small' }, `${item.description} · previsto ${formatMoney(item.amount)}${item.date ? ` em ${formatDate(item.date)}` : ' · data a definir'}`),
    h('div', { class: 'form-grid' }, fDate, fAmount, field(item.type === 'income' ? 'Recebido em' : 'Pago com', src)), restRow, cardNote);
  let busy = false;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (busy) return;
    const v = amount.getValue();
    fAmount.setError(v > 0 ? '' : 'Informe um valor');
    fDate.setError(isISODate(date.value) ? '' : 'Data inválida');
    if (!(v > 0) || !isISODate(date.value)) return;
    busy = true; go.classList.add('is-busy');
    try {
      const tx = await repo.payItem(item, { date: date.value, amount: v, sourceId: src.value || null, keepRemainder: !restRow.hidden && keep.checked });
      m.close();
      toast(`“${item.description}” ${paidWord(item)}${v !== item.amount ? ` (${formatMoney(v)})` : ''}`, { tone: 'success', action: { label: 'Desfazer', fn: () => repo.unpayItem(tx.id).catch(toastError) } });
    } catch (err) { toastError(err); } finally { busy = false; go.classList.remove('is-busy'); }
  });
  const m = openModal({ title: item.type === 'income' ? 'Confirmar recebimento' : 'Confirmar pagamento', size: 'sm', body: form, className: 'pay-modal',
    footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), go] });
  sync();
  return m;
}

/** Pode ser replicado (cópias em outros meses) ou passar a se repetir. */
export function canReplicate(item) {
  return Boolean(item) && !item.virtual && !item.forecast && item.type !== 'transfer' && !item.recurrenceId && !item.remainderOf;
}

export function itemMenu(item, anchor) {
  if (item.virtual) return occurrenceMenu(item, anchor);
  const tx = repo.get('transactions', item.id);
  if (!tx) return;
  // Ocorrência prevista de uma série (já com data ou valor ajustados): mesmas ações da projetada.
  if (tx.recurrenceId && tx.status === 'planned' && !tx.remainderOf && keyOf(tx) && repo.get('recurrences', tx.recurrenceId)) return occurrenceMenu(tx, anchor);
  const rule = tx.recurrenceId ? repo.get('recurrences', tx.recurrenceId) : null;
  const occDate = tx.occurrenceDate || tx.date || firstDay(tx.period || tx.month);
  const income = tx.type === 'income';
  openMenu(anchor, [
    tx.status === 'done'
      ? { label: 'Desfazer pagamento', icon: 'undo', onSelect: () => toggleStatus(item) }
      : { label: income ? 'Marcar como recebido' : 'Marcar como pago', icon: 'check', onSelect: () => toggleStatus(item) },
    tx.status !== 'done' && tx.type !== 'transfer' ? { label: income ? 'Confirmar recebimento…' : 'Confirmar pagamento…', icon: 'edit', onSelect: () => openPayDialog(tx) } : null,
    'sep',
    canCopy(tx) ? { label: 'Copiar para o próximo mês', icon: 'arrow-right', onSelect: () => copyToMonth([tx.id], addMonths(monthOfTx(tx), 1)) } : null,
    canCopy(tx) ? { label: 'Copiar para outro mês…', icon: 'calendar', onSelect: () => openReplicateDialog(tx, { when: 'pick' }) } : null,
    canReplicate(tx) && canBecomeSeries(tx) ? { label: 'Repetir mensalmente', icon: 'repeat', onSelect: () => repeatMonthly(tx) } : null,
    tx.type !== 'transfer' ? { label: 'Duplicar neste mês', icon: 'copy', onSelect: () => duplicate(tx, { status: 'planned' }, 'duplicado como previsto') } : null,
    canReplicate(tx) ? { label: 'Mais opções de replicação…', icon: 'layers', onSelect: () => openReplicateDialog(tx) } : null,
    tx.type !== 'transfer' && tx.status === 'done' ? { label: 'Registrar novamente hoje', icon: 'plus', onSelect: () => duplicate(tx, { date: today(), status: 'done' }, 'registrado novamente hoje') } : null,
    { label: 'Editar', icon: 'edit', onSelect: () => openItem(item) },
    'sep',
    tx.type === 'expense' ? { label: 'Registrar reembolso/estorno', icon: 'refund', onSelect: () => openEntryForm({ refundOf: tx }) } : null,
    { label: 'Calcular com este valor', icon: 'calc', onSelect: () => sendToCalculator(tx.amount, tx.description) },
    rule ? 'sep' : null,
    rule ? { label: 'Editar série a partir daqui', icon: 'repeat', onSelect: () => editSeries(rule, occDate) } : null,
    rule ? (repo.isRulePaused(rule) ? { label: 'Retomar série', icon: 'repeat', onSelect: () => resumeSeries(rule) } : { label: 'Pausar série a partir daqui', icon: 'clock', onSelect: () => pauseSeries(rule, addDays(occDate, 1)) }) : null,
    'sep',
    { label: 'Excluir…', icon: 'trash', danger: true, onSelect: () => removeTx(tx) },
  ]);
}

function occurrenceMenu(item, anchor) {
  const rule = repo.get('recurrences', item.recurrenceId);
  if (!rule) return;
  if (item.forecast) {
    openMenu(anchor, [
      { label: 'Registrar gasto nesta previsão', icon: 'plus', onSelect: () => openItem(item) },
      { label: 'Encerrar a previsão deste mês', icon: 'check', onSelect: () => closeForecast(rule, item.month) },
      { label: 'Calcular com este valor', icon: 'calc', onSelect: () => sendToCalculator(item.amount, item.description) },
      'sep',
      { label: 'Editar previsão', icon: 'edit', onSelect: () => openRecurrenceForm({ rule }) },
    ]);
    return;
  }
  const from = item.date || firstDay(item.period || item.month);
  const income = item.type === 'income';
  openMenu(anchor, [
    { label: income ? 'Marcar como recebido' : 'Marcar como pago', icon: 'check', onSelect: () => toggleStatus(item) },
    { label: income ? 'Confirmar recebimento…' : 'Confirmar pagamento…', icon: 'edit', onSelect: () => openPayDialog(item) },
    'sep',
    { label: item.date ? 'Alterar data…' : 'Definir data…', icon: 'calendar', onSelect: () => openOccurrenceDate(item) },
    { label: 'Editar valor…', icon: 'edit', onSelect: () => openOccurrenceAmount(item) },
    { label: 'Ver e editar detalhes', icon: 'list', onSelect: () => openItem(item) },
    { label: 'Calcular com este valor', icon: 'calc', onSelect: () => sendToCalculator(item.amount, item.description) },
    'sep',
    { label: 'Ignorar esta ocorrência', icon: 'x', onSelect: () => skip(item) },
    { label: 'Cancelar esta ocorrência', icon: 'x', onSelect: () => skip(item, 'cancelled') },
    { label: 'Editar esta e as próximas', icon: 'repeat', onSelect: () => editSeries(rule, from) },
    { label: 'Pausar série a partir daqui', icon: 'clock', onSelect: () => pauseSeries(rule, from) },
    { label: 'Encerrar série a partir daqui', icon: 'trash', danger: true, onSelect: () => endSeries(rule, from) },
  ]);
}

/** Datas de uma ocorrência: dentro do mês do compromisso (antecipar ou adiar sem mudar de mês). */
export function openOccurrenceDate(item) {
  const period = item.period || item.month || (item.date ? monthOf(item.date) : currentMonth());
  const input = h('input', { class: 'input', type: 'date', name: 'occDate', value: item.date || '', min: firstDay(period), max: lastDay(period) });
  const f = field('Data', input, { hint: `Dentro de ${formatMonth(period)}. As outras ocorrências não mudam.` });
  const go = h('button', { class: 'btn btn-primary', type: 'submit', form: 'occ-date-form' }, 'Salvar data');
  const form = h('form', { id: 'occ-date-form', class: 'stack', novalidate: true }, h('p', { class: 'muted small' }, `${item.description} · ${formatMoney(item.amount)}`), f,
    item.date ? h('button', { class: 'link-btn small', type: 'button', onclick: () => save(null) }, 'Deixar a data a definir') : null);
  let busy = false;
  async function save(value) {
    if (busy) return;
    if (value && (!isISODate(value) || value < firstDay(period) || value > lastDay(period))) { f.setError(`Escolha uma data em ${formatMonth(period)}`); return; }
    busy = true;
    try {
      const key = keyOf(item);
      await repo.setOccurrenceDate(item.recurrenceId, key, value);
      m.close();
      toast(value ? `Data alterada para ${formatDate(value)}` : 'Data a definir', { tone: 'success', action: { label: 'Desfazer', fn: () => repo.setOccurrenceDate(item.recurrenceId, key, item.date || null).catch(toastError) } });
    } catch (err) { toastError(err); } finally { busy = false; }
  }
  form.addEventListener('submit', (ev) => { ev.preventDefault(); save(input.value || null); });
  const m = openModal({ title: item.date ? 'Alterar data' : 'Definir data', size: 'sm', body: form, className: 'occ-date-modal',
    footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), go] });
  requestAnimationFrame(() => input.focus());
  return m;
}

/** Valor de uma ocorrência: só esta, este mês, esta e as próximas ou a série toda. */
export function openOccurrenceAmount(item) {
  const rule = repo.get('recurrences', item.recurrenceId);
  if (!rule) return null;
  const amount = moneyInput({ value: item.amount, name: 'occAmount' });
  const f = field('Novo valor', amount);
  const go = h('button', { class: 'btn btn-primary', type: 'submit', form: 'occ-amount-form' }, 'Continuar');
  const form = h('form', { id: 'occ-amount-form', class: 'stack', novalidate: true }, h('p', { class: 'muted small' }, `${item.description} · ${item.date ? formatDate(item.date) : 'data a definir'}`), f);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const v = amount.getValue();
    if (!(v > 0)) { f.setError('Informe um valor maior que zero'); return; }
    if (v === item.amount) { m.close(); return; }
    m.close();
    const mode = ruleMode(rule);
    const scope = await askScope({ title: `Aplicar ${formatMoney(v)} a…`, allowMonth: mode === 'days' || mode === 'flex' });
    if (!scope) return;
    const key = keyOf(item);
    const period = item.period || String(key).slice(0, 7);
    try {
      if (scope === 'one') await repo.materializeOccurrence(rule.id, key, { amount: v });
      else if (scope === 'month') await repo.editSeriesPeriod(rule.id, period, { amount: v });
      else if (scope === 'future') { await repo.materializeOccurrence(rule.id, key, { amount: v }); await repo.editSeriesFrom(rule.id, mode === 'fixed' ? addDays(item.date || item.occurrenceDate, 1) : firstDay(addMonths(period, 1)), { amount: v }); }
      else await repo.saveRecurrence({ ...rule, amount: v });
      toast(`Valor alterado para ${formatMoney(v)}`, { tone: 'success' });
    } catch (err) { toastError(err); }
  });
  const m = openModal({ title: 'Editar valor', size: 'sm', body: form, footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), go] });
  requestAnimationFrame(() => amount.input.focus());
  return m;
}

/** Ocorrência extra no mês (ex.: uma terceira consulta), com data opcional. */
export function openExtraOccurrence(rule, month) {
  const opId = uid();
  const date = h('input', { class: 'input', type: 'date', name: 'extraDate', min: firstDay(month), max: lastDay(month) });
  const amount = moneyInput({ value: rule.amount, name: 'extraAmount' });
  const fDate = field(h('span', null, 'Data ', h('span', { class: 'opt' }, 'opcional')), date, { hint: 'Em branco: data a definir' });
  const fAmount = field('Valor', amount);
  const go = h('button', { class: 'btn btn-primary', type: 'submit', form: 'extra-form' }, 'Adicionar');
  const form = h('form', { id: 'extra-form', class: 'stack', novalidate: true }, h('p', { class: 'muted small' }, `${rule.description} · ${formatMonth(month)}. Só este mês muda.`), h('div', { class: 'form-grid' }, fDate, fAmount));
  let busy = false;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (busy) return;
    const v = amount.getValue();
    fAmount.setError(v > 0 ? '' : 'Informe um valor');
    const okDate = !date.value || (isISODate(date.value) && date.value >= firstDay(month) && date.value <= lastDay(month));
    fDate.setError(okDate ? '' : `Escolha uma data em ${formatMonth(month)}`);
    if (!(v > 0) || !okDate) return;
    busy = true; go.classList.add('is-busy');
    try {
      const tx = await repo.addExtraOccurrence(rule.id, month, { date: date.value || null, amount: v, opId });
      m.close();
      toast('Ocorrência extra adicionada', { tone: 'success', action: { label: 'Desfazer', fn: () => repo.deleteTransaction(tx.id).catch(toastError) } });
    } catch (err) { toastError(err); } finally { busy = false; go.classList.remove('is-busy'); }
  });
  const m = openModal({ title: 'Adicionar ocorrência', size: 'sm', body: form, className: 'extra-modal', footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), go] });
  return m;
}

export function sendToCalculator(cents, label) {
  import('../components/calculator.js').then((c) => c.openCalculatorWith?.(cents, label)).catch(toastError);
}

/** Pergunta o escopo de uma alteração em ocorrência recorrente. */
export function askScope({ title, allowAll = true, allowMonth = false, fixedMonthly = false }) {
  return new Promise((resolve) => {
    let choice = null;
    const opt = (value, label, desc) => h('button', { class: 'scope-opt', type: 'button', dataset: { scope: value }, onclick: () => { choice = value; m.close(); } }, h('strong', null, label), h('span', { class: 'faint small' }, desc));
    const m = openModal({ title, size: 'sm', body: h('div', { class: 'scope-list' },
      opt('one', fixedMonthly ? 'Somente este mês' : 'Apenas esta ocorrência', fixedMonthly ? 'Os outros meses continuam como estão.' : 'As demais continuam como estão.'),
      allowMonth ? opt('month', 'Somente este mês', 'Todas as ocorrências previstas deste mês; os outros meses não mudam.') : null,
      opt('future', fixedMonthly ? 'Este mês e os próximos' : 'Esta e as próximas', 'Meses anteriores e o que já foi pago não mudam.'),
      allowAll ? opt('all', 'Toda a série', 'Inclui as futuras; lançamentos já realizados são preservados.') : null),
    footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar')], onClose: () => resolve(choice) });
  });
}

async function pauseSeries(rule, fromDate) {
  try {
    await repo.pauseRecurrence(rule.id, fromDate);
    toast(`“${rule.description}” pausada a partir de ${formatDate(fromDate)}`, { tone: 'success', action: { label: 'Retomar', fn: () => resumeSeries(repo.get('recurrences', rule.id)) } });
  } catch (err) { toastError(err); }
}

async function resumeSeries(rule) {
  try { await repo.resumeRecurrence(rule.id, today()); toast(`“${rule.description}” retomada a partir de hoje`, { tone: 'success' }); } catch (err) { toastError(err); }
}

export async function closeForecast(rule, month, closed = true) {
  try {
    await repo.setForecastClosed(rule.id, month, closed);
    toast(closed ? `Previsão de ${formatMonth(month)} encerrada. O valor não usado não vira despesa.` : 'Previsão reaberta', { tone: 'success', action: { label: 'Desfazer', fn: () => repo.setForecastClosed(rule.id, month, !closed).catch(toastError) } });
  } catch (err) { toastError(err); }
}

/**
 * Replicar: um único painel para "copiar para outros meses" e "repetir todo mês".
 * - Próximo mês / 3 / 6 / 12 / meses escolhidos → cópias avulsas previstas (ids por operação: o clique repetido não duplica);
 * - Todos os meses → série recorrente; o próprio lançamento vira a 1ª ocorrência (sem cópia);
 * - datas: mesmo dia, outro dia, vários dias ou a definir (nunca inventadas).
 * Já vem com "Próximo mês" escolhido: Replicar → Replicar conclui; Replicar → Todos os meses → Repetir todo mês.
 */
const WHEN = [['1', 'Próximo mês'], ['3', 'Próximos 3 meses'], ['6', 'Próximos 6 meses'], ['12', 'Próximos 12 meses'], ['all', 'Todos os meses'], ['pick', 'Escolher meses']];

export function openReplicateDialog(tx, { when: initialWhen = '1' } = {}) {
  tx = repo.get('transactions', tx.id) || tx;
  const base = tx.date ? monthOf(tx.date) : tx.period || tx.month;
  const srcDay = tx.date ? Number(tx.date.slice(8, 10)) : null;
  const opId = uid();
  const seriesBlock = tx.recurrenceId || tx.forecastId ? 'Este lançamento já faz parte de uma série.' : tx.planId ? 'Parcelas seguem o parcelamento; use cópias avulsas.' : tx.type === 'refund' ? 'Reembolsos não se repetem; use cópias avulsas.' : null;
  let when = initialWhen === 'all' && seriesBlock ? '1' : initialWhen;
  let dateMode = srcDay ? 'same' : 'flex';
  const chosen = new Set();

  const whenBtns = WHEN.map(([v, label]) => {
    const disabled = v === 'all' && Boolean(seriesBlock);
    return h('button', { class: 'chip', type: 'button', role: 'radio', 'aria-checked': String(v === when), disabled, title: disabled ? seriesBlock : null, dataset: { when: v }, onclick: () => { when = v; sync(); } }, label);
  });
  const whenGroup = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Para quando' }, ...whenBtns);

  const startMonth = h('input', { class: 'input input-sm', type: 'month', name: 'repStart', value: addMonths(base, 1), 'aria-label': 'A partir de' });
  const endMonth = h('input', { class: 'input input-sm', type: 'month', name: 'repEnd', 'aria-label': 'Até' });
  const monthsBox = h('div', { class: 'month-picks', role: 'group', 'aria-label': 'Meses' });
  const drawMonths = () => {
    const from = /^\d{4}-\d{2}$/.test(startMonth.value) ? startMonth.value : addMonths(base, 1);
    const horizon = Array.from({ length: 24 }, (_, i) => addMonths(from, i));
    for (const m of [...chosen]) if (!horizon.includes(m)) horizon.push(m);
    horizon.sort();
    put(monthsBox, ...horizon.map((m) => {
      const on = chosen.has(m);
      return h('button', { class: `month-pick${on ? ' is-on' : ''}`, type: 'button', 'aria-pressed': String(on), dataset: { month: m }, onclick: () => { if (chosen.has(m)) chosen.delete(m); else chosen.add(m); drawMonths(); updateSummary(); } }, capitalize(formatMonthShort(m)));
    }));
  };

  const day = h('input', { class: 'input input-num', type: 'number', min: 1, max: 31, name: 'repDay', value: srcDay || 10, 'aria-label': 'Dia do mês' });
  const days = h('input', { class: 'input', name: 'repDays', placeholder: 'Ex.: 5, 20', inputmode: 'numeric', 'aria-label': 'Dias do mês', value: srcDay ? String(srcDay) : '' });
  const dm = segmented({ label: 'Datas', value: dateMode, size: 'segmented-sm', options: [
    srcDay ? { value: 'same', label: `Mesmo dia (${srcDay})` } : null, { value: 'day', label: 'Outro dia' }, { value: 'days', label: 'Vários dias' }, { value: 'flex', label: 'A definir' }].filter(Boolean),
  onChange: (v) => { dateMode = v; sync(); } });
  const startRow = h('label', { class: 'inline-field' }, h('span', { class: 'small faint' }, 'A partir de'), startMonth);
  const endRow = h('label', { class: 'inline-field' }, h('span', { class: 'small faint' }, 'Até'), endMonth, h('span', { class: 'faint xsmall' }, 'opcional'));
  const summary = h('div', { class: 'replicate-summary', 'aria-live': 'polite' });
  const go = h('button', { class: 'btn btn-primary', type: 'button', name: 'repGo' }, 'Replicar');

  /** Meses das cópias avulsas. */
  function months() {
    if (when === 'pick') return [...chosen].sort();
    if (when === 'all') return [];
    const from = /^\d{4}-\d{2}$/.test(startMonth.value) ? startMonth.value : addMonths(base, 1);
    return Array.from({ length: Number(when) }, (_, i) => addMonths(from, i));
  }
  const readDay = () => { const n = Number(day.value); return Number.isInteger(n) && n >= 1 && n <= 31 ? n : null; };
  const dayList = () => parseDays(days.value);
  function datesOf(m) {
    if (dateMode === 'flex') return [null];
    if (dateMode === 'days') return dayList().map((d) => dateInMonth(m, d));
    return [dateInMonth(m, dateMode === 'day' ? readDay() || 1 : srcDay)];
  }
  function problem() {
    if (dateMode === 'day' && !readDay()) return 'Dia do mês: de 1 a 31.';
    if (dateMode === 'days' && !dayList().length) return 'Informe os dias do mês (ex.: 5, 20).';
    if (when === 'all') {
      if (seriesBlock) return seriesBlock;
      if (endMonth.value && /^\d{4}-\d{2}$/.test(startMonth.value) && endMonth.value < startMonth.value) return 'O mês final é anterior ao inicial.';
      return null;
    }
    if (!months().length) return 'Escolha pelo menos um mês.';
    if (months().length > 60) return 'Escolha no máximo 60 meses de uma vez.';
    return null;
  }
  /** Série: começa no próprio lançamento (vira a 1ª ocorrência) ou num mês posterior (o original fica avulso). */
  function seriesPlan() {
    const start = /^\d{4}-\d{2}$/.test(startMonth.value) ? startMonth.value : base;
    const linkOriginal = start <= base;
    const mode = dateMode === 'flex' ? 'flex' : dateMode === 'days' ? 'days' : 'fixed';
    const anchorDay = dateMode === 'day' ? readDay() : srcDay;
    const desc = mode === 'flex' ? 'todo mês, data a definir' : mode === 'days' ? `todo mês nos dias ${dayList().join(', ')}` : `todo mês no dia ${anchorDay}`;
    return { start: linkOriginal ? base : start, linkOriginal, mode, anchorDay, desc, endDate: /^\d{4}-\d{2}$/.test(endMonth.value) ? lastDay(endMonth.value) : null };
  }

  function updateSummary() {
    const err = problem();
    go.disabled = Boolean(err);
    if (when === 'all') {
      go.textContent = 'Repetir todo mês';
      if (err) { put(summary, h('p', { class: 'note is-warn' }, icon('alert', 'icon-sm'), err)); return; }
      const p = seriesPlan();
      const perMonth = p.mode === 'days' ? tx.amount * dayList().length : tx.amount;
      put(summary,
        h('strong', { class: 'small' }, `Repete ${p.desc}, a partir de ${formatMonth(p.start)}${p.endDate ? ` até ${formatMonth(monthOf(p.endDate))}` : ', sem data de término'} · ${formatMoney(perMonth)} por mês`),
        h('p', { class: 'faint small' }, p.linkOriginal ? `Este lançamento passa a ser a 1ª ocorrência: nada é duplicado. Os próximos meses entram como previstos${tx.status === 'done' ? ' (o pagamento não é copiado)' : ''}.` : 'Este lançamento continua avulso; a série começa no mês escolhido.'));
      return;
    }
    go.textContent = 'Replicar';
    if (err) { put(summary, h('p', { class: 'faint small' }, err)); return; }
    const ms = months();
    const rows = ms.flatMap((m) => datesOf(m).map((d) => ({ m, d })));
    const similar = ms.filter((m) => repo.list('transactions').some((x) => x.id !== tx.id && x.month === m && x.description === tx.description && x.amount === tx.amount));
    put(summary,
      h('strong', { class: 'small' }, `${rows.length} ${rows.length === 1 ? 'lançamento previsto será criado' : 'lançamentos previstos serão criados'} · ${formatMoney(tx.amount * rows.length)} no total`),
      h('ul', { class: 'replicate-list' }, ...rows.slice(0, 8).map(({ m, d }) => h('li', null, `${capitalize(formatMonth(m))} — ${d ? formatDate(d) : 'data a definir'} — ${formatMoney(tx.amount)}`)), rows.length > 8 ? h('li', { class: 'faint' }, `… e mais ${rows.length - 8}`) : null),
      similar.length ? h('p', { class: 'note is-warn' }, icon('alert', 'icon-sm'), `Já existe um lançamento igual em ${similar.map((m) => formatMonthShort(m)).join(', ')}. Confira para não duplicar.`) : null,
      tx.status === 'done' ? h('p', { class: 'faint small' }, 'As cópias começam como previstas: o pagamento não é copiado.') : null);
  }

  function sync() {
    whenBtns.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.when === when)));
    monthsBox.hidden = when !== 'pick';
    if (when === 'all' && !startMonth.dataset.touched) startMonth.value = base < currentMonth() ? currentMonth() : base; // lançamento antigo: a série começa agora, sem meses atrasados
    else if (when !== 'all' && !startMonth.dataset.touched) startMonth.value = addMonths(base, 1);
    endRow.hidden = when !== 'all';
    day.hidden = dateMode !== 'day';
    days.hidden = dateMode !== 'days';
    if (when === 'pick') drawMonths();
    updateSummary();
  }
  for (const el of [day, days, endMonth]) el.addEventListener('input', updateSummary);
  startMonth.addEventListener('change', () => { startMonth.dataset.touched = '1'; if (when === 'pick') drawMonths(); updateSummary(); });

  let busy = false;
  go.addEventListener('click', async () => {
    if (busy || problem()) return;
    busy = true; go.classList.add('is-busy'); go.disabled = true;
    try {
      if (when === 'all') {
        const p = seriesPlan();
        let rule;
        if (p.linkOriginal) {
          rule = await repo.convertToRecurring(tx.id, { frequency: 'monthly', interval: 1, mode: p.mode, anchorDay: p.anchorDay, days: p.mode === 'days' ? dayList() : null, perPeriod: 1, endDate: p.endDate });
        } else {
          const startDate = p.mode === 'fixed' ? dateInMonth(p.start, p.anchorDay) : firstDay(p.start);
          rule = await repo.createRecurrence({ id: opId, type: tx.type, description: tx.description, amount: tx.amount, startDate, endDate: p.endDate, frequency: 'monthly', interval: 1,
            mode: p.mode === 'fixed' ? undefined : p.mode, anchorDay: p.mode === 'fixed' ? p.anchorDay : undefined, days: p.mode === 'days' ? dayList() : undefined, perPeriod: p.mode === 'flex' ? 1 : undefined,
            categoryId: tx.categoryId, blockId: tx.blockId, sourceId: tx.sourceId, method: tx.method || null, restricted: tx.restricted });
        }
        m.close();
        toast(`“${tx.description}” agora se repete ${p.desc}`, { tone: 'success', action: { label: 'Desfazer', fn: () => (p.linkOriginal ? repo.undoConversion(rule.id, tx) : repo.deleteRecurrence(rule.id)).catch(toastError) } });
        return;
      }
      const created = await repo.replicateTransaction(tx.id, { months: months(), dateMode, day: readDay(), days: dayList(), opId });
      m.close();
      const ms = [...new Set(created.map((c) => c.period || c.month))];
      toast(`${created.length} ${created.length === 1 ? 'cópia prevista criada' : 'cópias previstas criadas'}${ms.length ? ` (${ms.slice(0, 3).map(formatMonthShort).join(', ')}${ms.length > 3 ? '…' : ''})` : ''}`, { tone: 'success', action: created.length ? { label: 'Desfazer', fn: () => repo.deleteTransactions(created.map((c) => c.id)).catch(toastError) } : null });
    } catch (err) { toastError(err); } finally { busy = false; go.classList.remove('is-busy'); if (document.body.contains(go)) go.disabled = Boolean(problem()); }
  });

  const m = openModal({ title: 'Replicar', size: 'md', className: 'replicate-modal', body: h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, `${tx.description} · ${formatMoney(tx.amount)}${tx.date ? ` · ${formatDate(tx.date)}` : ' · data a definir'}${tx.status === 'done' ? ' · realizado' : ''}`),
    h('div', { class: 'stack-sm' }, h('span', { class: 'field-label' }, 'Para quando'), whenGroup, monthsBox),
    h('div', { class: 'stack-sm' }, h('span', { class: 'field-label' }, 'Datas'), h('div', { class: 'row wrap gap-sm' }, dm, day, days)),
    h('div', { class: 'row wrap gap-sm' }, startRow, endRow),
    summary),
  footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), go] });
  sync();
  return m;
}

/** Duplicar: abre um novo lançamento já preenchido (nada é gravado antes de Salvar). */
export function openDuplicate(tx) {
  const { id, rev, recurrenceId, occurrenceDate, occurrenceKey, period, remainderOf, plannedAmount, planId, installment, createdAt, updatedAt, replicaOf, refundOf, forecastId, monthManual, month, ...rest } = tx;
  const date = tx.date || today();
  openEntryForm({ duplicate: true, defaults: { ...rest, date, status: date > today() ? 'planned' : tx.status === 'planned' ? 'planned' : 'done' } });
}

/** Mês "de referência" do lançamento na lista (competência; para "a definir", o período). */
export const monthOfTx = (tx) => tx.period && !tx.date ? tx.period : tx.month || monthOf(tx.date);
/** Pode ser copiado para outro mês como lançamento avulso (parcelas e transferências não). */
export function canCopy(item) {
  // Itens de uma recorrência já aparecem sozinhos nos próximos meses: copiar só duplicaria.
  return Boolean(item) && !item.virtual && !item.forecast && item.type !== 'transfer' && !item.planId && !item.remainderOf && !item.recurrenceId;
}
const canBecomeSeries = (tx) => !tx.recurrenceId && !tx.forecastId && !tx.planId && (tx.type === 'expense' || tx.type === 'income');

/**
 * Copiar para um mês (1 ação): cópia prevista, sem formulário. Se já existir algo igual
 * no destino, não cria: avisa e oferece ver o existente ou copiar mesmo assim.
 */
export async function copyToMonth(ids, month, { force = false, opId = uid() } = {}) {
  try {
    const res = await repo.copyTransactionsTo(ids, month, { opId, force });
    const n = res.created.length;
    const where = formatMonth(month);
    const parts = [];
    if (n) parts.push(n === 1 ? `“${res.created[0].description}” copiado para ${where} como previsto` : `${n} lançamentos copiados para ${where} como previstos`);
    if (res.conflicts.length) parts.push(res.conflicts.length === 1 ? `“${res.conflicts[0].tx.description}” já está previsto para ${where}` : `${res.conflicts.length} já existiam em ${where} e não foram copiados`);
    if (res.skipped.length) parts.push(`${res.skipped.length} ignorado(s) (parcelas e transferências seguem o próprio fluxo)`);
    const actions = [];
    if (n) actions.push({ label: 'Desfazer', fn: () => repo.deleteTransactions(res.created.map((c) => c.id)).catch(toastError) });
    if (res.conflicts.length) {
      actions.push({ label: 'Ver', fn: () => { import('../state.js').then((st) => { st.setMonth(month); location.hash = '#/lancamentos'; }); } });
      actions.push({ label: 'Copiar mesmo assim', fn: () => copyToMonth(res.conflicts.map((c) => c.tx.id), month, { force: true }) });
    }
    toast(parts.join(' · ') || 'Nada para copiar', { tone: n ? 'success' : 'default', actions, timeout: res.conflicts.length ? 8000 : 4000 });
    return res;
  } catch (err) { toastError(err); return null; }
}

/** "Repetir mensalmente" direto: o lançamento vira a 1ª ocorrência de uma série mensal no mesmo dia. */
export async function repeatMonthly(tx) {
  try {
    const rule = await repo.convertToRecurring(tx.id, { frequency: 'monthly', interval: 1, mode: tx.date ? 'fixed' : 'flex', perPeriod: 1 });
    toast(`“${tx.description}” agora se repete: ${describeFrequency(rule).toLowerCase()}`, { tone: 'success', action: { label: 'Desfazer', fn: () => repo.undoConversion(rule.id, tx).catch(toastError) } });
  } catch (err) { toastError(err); }
}

/** Trazer do mês anterior: escolhe o que copiar; recorrências e conflitos já vêm identificados. */
export function openBringFromPrevious(month) {
  const prev = addMonths(month, -1);
  const rows = repo.list('transactions').filter((t) => monthOfTx(t) === prev && t.type !== 'transfer' && !t.remainderOf && !t.forecastId)
    .sort((a, b) => (a.description || '').localeCompare(b.description || '', 'pt-BR'));
  const chosen = new Set();
  const opId = uid();
  const list = h('div', { class: 'bring-list', role: 'group', 'aria-label': `Lançamentos de ${formatMonth(prev)}` });
  const entries = rows.map((t) => {
    const reason = t.planId ? 'parcela: segue o parcelamento' : t.recurrenceId ? 'já se repete todo mês' : repo.conflictIn(t, month) ? `já existe em ${formatMonthShort(month)}` : null;
    if (!reason) chosen.add(t.id);
    const cb = h('input', { type: 'checkbox', checked: !reason, disabled: Boolean(t.planId || t.recurrenceId), dataset: { id: t.id } });
    cb.addEventListener('change', () => { if (cb.checked) chosen.add(t.id); else chosen.delete(t.id); sync(); });
    return h('label', { class: `bring-row${reason ? ' is-off' : ''}` }, cb,
      h('span', { class: 'grow truncate' }, t.description, reason ? h('span', { class: 'faint xsmall' }, ` · ${reason}`) : null),
      h('span', { class: 'num' }, formatMoney(t.plannedAmount || t.amount)));
  });
  put(list, ...entries);
  const go = h('button', { class: 'btn btn-primary', type: 'button' }, 'Trazer');
  const info = h('p', { class: 'small muted' });
  const sync = () => {
    const total = rows.filter((t) => chosen.has(t.id)).reduce((s0, t) => s0 + (t.plannedAmount || t.amount), 0);
    info.textContent = chosen.size ? `${chosen.size} ${chosen.size === 1 ? 'lançamento' : 'lançamentos'} · ${formatMoney(total)} · entram como previstos em ${formatMonth(month)}` : 'Nada selecionado.';
    go.disabled = !chosen.size;
  };
  const all = h('button', { class: 'link-btn small', type: 'button', onclick: () => { list.querySelectorAll('input:not(:disabled)').forEach((cb) => { cb.checked = true; chosen.add(cb.dataset.id); }); sync(); } }, 'Marcar todos');
  const none = h('button', { class: 'link-btn small', type: 'button', onclick: () => { list.querySelectorAll('input').forEach((cb) => { cb.checked = false; }); chosen.clear(); sync(); } }, 'Desmarcar');
  let busy = false;
  go.addEventListener('click', async () => {
    if (busy || !chosen.size) return;
    busy = true; go.classList.add('is-busy');
    const res = await copyToMonth([...chosen], month, { opId });
    busy = false; go.classList.remove('is-busy');
    if (res) m.close();
  });
  const m = openModal({ title: `Trazer de ${formatMonth(prev)}`, size: 'md', className: 'bring-modal',
    body: rows.length ? h('div', { class: 'stack' }, h('div', { class: 'row' }, h('span', { class: 'small faint grow' }, 'Marque o que também vale para este mês.'), all, none), list, info)
      : h('p', { class: 'muted' }, `Nenhum lançamento em ${formatMonth(prev)}.`),
    footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), rows.length ? go : null] });
  sync();
  return m;
}

async function duplicate(tx, overrides = {}, verb = 'duplicado') {
  try {
    const copy = await repo.duplicateTransaction(tx.id, overrides);
    toast(`Lançamento ${verb}`, { tone: 'success', actions: [{ label: 'Editar', fn: () => openEntryForm({ tx: repo.get('transactions', copy.id) }) }, { label: 'Desfazer', fn: () => repo.deleteTransaction(copy.id).catch(toastError) }] });
  } catch (err) { toastError(err); }
}

export async function removeTx(tx) {
  if (tx.planId) {
    const ok = await confirmDialog({ title: 'Excluir parcela?', message: `Apenas a parcela ${tx.installment.index}/${tx.installment.count} será removida. Para cancelar o parcelamento inteiro, use Planejamento → Parcelamentos.`, confirmLabel: 'Excluir parcela', danger: true });
    if (!ok) return;
  }
  const rule = tx.recurrenceId && !tx.remainderOf ? repo.get('recurrences', tx.recurrenceId) : null;
  const key = keyOf(tx);
  if (rule && key) {
    const scope = await askScope({ title: `Excluir “${tx.description}”` });
    if (!scope) return;
    try {
      if (scope === 'one') {
        await repo.skipOccurrence(rule.id, key, { removeDone: true });
        toast('Ocorrência excluída', { tone: 'success', action: { label: 'Desfazer', fn: () => repo.restoreOccurrence(rule.id, tx).catch(toastError) } });
      } else if (scope === 'future') {
        await repo.endSeries(rule.id, tx.occurrenceDate || tx.date || firstDay(tx.period || tx.month), { removeDoneFrom: key });
        toast('Série encerrada a partir desta ocorrência', { tone: 'success' });
      } else {
        await repo.deleteRecurrence(rule.id);
        toast('Série excluída. Lançamentos já realizados de outras datas foram preservados.', { tone: 'success' });
      }
    } catch (err) { toastError(err); }
    return;
  }
  try {
    const removed = await repo.deleteTransaction(tx.id);
    toast(`“${removed.description}” excluído`, { tone: 'success', action: { label: 'Desfazer', fn: () => repo.restoreTransactions([removed]).catch(toastError) } });
  } catch (err) { toastError(err); }
}

export async function skip(item, reason = 'skipped') {
  const key = keyOf(item);
  const word = reason === 'cancelled' ? 'cancelada' : 'ignorada';
  try {
    await repo.skipOccurrence(item.recurrenceId, key, { reason });
    toast(item.date ? `Ocorrência de ${formatDate(item.date)} ${word}` : `Ocorrência ${word}`, { action: { label: 'Desfazer', fn: () => repo.unskipOccurrence(item.recurrenceId, key).catch(toastError) } });
  } catch (err) { toastError(err); }
}

export async function endSeries(rule, fromDate) {
  const ok = await confirmDialog({
    title: 'Encerrar recorrência?',
    message: `“${rule.description}” deixará de ser projetada a partir de ${ruleMode(rule) === 'fixed' ? formatDate(fromDate) : formatMonth(monthOf(fromDate))}. Ocorrências já pagas são preservadas.`,
    confirmLabel: 'Encerrar série', danger: true,
  });
  if (!ok) return;
  try { await repo.endSeries(rule.id, fromDate); toast('Recorrência encerrada'); } catch (err) { toastError(err); }
}

/** Formulário de regra recorrente (nova, edição completa ou edição a partir de uma data). */
export function openRecurrenceForm({ rule = null, fromDate = null, defaults = {} } = {}) {
  const r = { type: 'expense', frequency: 'monthly', interval: 1, startDate: today(), ...defaults, ...(rule || {}) };
  let typeV = r.type;
  const type = segmented({ label: 'Tipo', value: r.type, options: [{ value: 'expense', label: 'Despesa' }, { value: 'income', label: 'Receita' }], onChange: (v) => { typeV = v; put(category, ...opts(categoryOptions(v, r.categoryId), 'Sem categoria')); fBlock.hidden = v === 'income'; rep.update(); } });
  const desc = h('input', { class: 'input', value: r.description || '', maxlength: 200, placeholder: 'Ex.: Internet, Psicóloga, Combustível, Salário', name: 'recDescription' });
  const amount = moneyInput({ value: r.amount ?? null, name: 'recAmount' });
  const startD = h('input', { class: 'input', type: 'date', value: fromDate || r.startDate, name: 'recStart' });
  const presetOf = (x) => (ruleMode(x) !== 'fixed' ? 'monthly' : x.frequency === 'weekly' && x.interval === 1 ? 'weekly' : x.frequency === 'weekly' && x.interval === 2 ? 'biweekly' : x.frequency === 'monthly' && (x.interval || 1) === 1 ? 'monthly' : x.frequency === 'yearly' && (x.interval || 1) === 1 ? 'yearly' : 'custom');
  // Na regra, "Não repetir" não faz sentido.
  const rep = repeatFields({ preset: presetOf(r), mode: ruleMode(r), allowNone: false, getDate: () => startD.value, getAmount: () => amount.getValue(), getType: () => typeV, rule: r, onChange: () => syncLabels() });
  const opts = (list, empty) => [h('option', { value: '' }, empty), ...list.map((o) => h('option', { value: o.value }, o.label))];
  const category = h('select', { class: 'select' }, ...opts(categoryOptions(r.type, r.categoryId), 'Sem categoria'));
  category.value = r.categoryId || '';
  const block = h('select', { class: 'select' }, ...opts(blockOptions(r.blockId), 'Sem bloco'));
  block.value = r.blockId || '';
  const source = h('select', { class: 'select', name: 'recSource' }, ...opts(accountOptions({ keep: r.sourceId }), 'A definir no pagamento'));
  source.value = r.sourceId || '';
  const fBlock = field('Bloco', block);
  fBlock.hidden = r.type === 'income';
  const fAmount = field('Valor', amount);
  const fDesc = field('Descrição', desc);
  const fStart = field(fromDate ? 'Vale a partir de' : 'Começa em', startD);
  const syncLabels = () => { const md = rep.mode; fAmount.querySelector('.field-label').textContent = md === 'forecast' ? 'Valor previsto no mês' : md === 'flex' || md === 'days' ? 'Valor de cada ocorrência' : 'Valor'; };
  const body = h('form', { class: 'entry-form', novalidate: true, id: 'rec-form' },
    fromDate ? h('div', { class: 'banner' }, `As alterações valem a partir de ${formatDate(fromDate)}. Ocorrências anteriores permanecem como estão.`) : null,
    rule ? null : h('div', { class: 'form-row' }, type),
    h('div', { class: 'form-grid' }, fDesc, fAmount, field('Repetir', rep.select), fStart),
    rep.box,
    h('div', { class: 'form-grid' }, field('Categoria', category), fBlock, field('Fonte padrão', source, { hint: 'Pode ficar a definir: você escolhe ao pagar' })));
  rep.box.hidden = false;
  syncLabels();
  const save = h('button', { class: 'btn btn-primary', type: 'submit', form: 'rec-form' }, 'Salvar');
  body.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const cents = amount.getValue();
    fAmount.setError(cents ? '' : 'Informe um valor');
    fDesc.setError(desc.value.trim() ? '' : 'Informe uma descrição');
    fStart.setError(isISODate(startD.value) ? '' : 'Data inválida');
    if (!cents || !desc.value.trim() || !isISODate(startD.value)) return;
    const err = rep.validate();
    if (err) { toast(err, { tone: 'error' }); return; }
    const rr = rep.read();
    const t = rule ? r.type : type.getValue();
    const changes = {
      type: t, description: desc.value.trim(), amount: cents, frequency: rr.frequency, interval: rr.interval, mode: rr.mode || 'fixed',
      days: rr.days, perPeriod: rr.perPeriod, anchorDay: rr.anchorDay, endDate: rr.endDate, count: rr.count, estimated: rr.estimated,
      categoryId: category.value || null, blockId: t === 'income' ? null : block.value || null, sourceId: source.value || null,
    };
    save.classList.add('is-busy');
    try {
      if (rule && fromDate) await repo.editSeriesFrom(rule.id, fromDate, { ...changes, startDate: rr.startDate });
      else await repo.saveRecurrence({ ...(rule || {}), ...changes, startDate: rr.startDate });
      m.close();
      toast(rule ? 'Recorrência atualizada' : 'Recorrência criada', { tone: 'success' });
    } catch (e) { toastError(e); } finally { save.classList.remove('is-busy'); }
  });
  const m = openModal({ title: rule ? (fromDate ? 'Editar série' : 'Editar recorrência') : 'Nova recorrência', body, footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), save] });
  return m;
}

export function editSeries(rule, fromDate) {
  if (!rule) return;
  openRecurrenceForm({ rule, fromDate: fromDate && fromDate > rule.startDate ? fromDate : null });
}

export function formatAmountShort(c) { return formatMoney(c); }
// Ação visível na linha: copiar para o próximo mês (1 clique, sem formulário).
rowActions.replicate = (item) => { const tx = repo.get('transactions', item.id) || item; return copyToMonth([tx.id], addMonths(monthOfTx(tx), 1)); };
rowActions.canReplicate = canCopy;
export { MONTHLY_MODES, describeFrequency, currentMonth, lastDay, ui };
