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
import { ruleMode, describeFrequency, MONTHLY_MODES } from '../services/recurrence.js';
import { isCard } from '../services/cards.js';
import { categoryOptions, blockOptions, accountOptions, capitalize } from './common.js';
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

export function itemMenu(item, anchor) {
  if (item.virtual) return occurrenceMenu(item, anchor);
  const tx = repo.get('transactions', item.id);
  if (!tx) return;
  const rule = tx.recurrenceId ? repo.get('recurrences', tx.recurrenceId) : null;
  const canRepeat = !tx.recurrenceId && !tx.forecastId && !tx.planId && (tx.type === 'expense' || tx.type === 'income') && tx.date;
  const occDate = tx.occurrenceDate || tx.date || firstDay(tx.period || tx.month);
  openMenu(anchor, [
    { label: 'Editar', icon: 'edit', onSelect: () => openItem(item) },
    tx.status === 'done'
      ? { label: 'Desfazer pagamento', icon: 'undo', onSelect: () => toggleStatus(item) }
      : { label: tx.type === 'income' ? 'Confirmar recebimento…' : 'Confirmar pagamento…', icon: 'check', onSelect: () => openPayDialog(tx) },
    'sep',
    tx.type !== 'transfer' ? { label: 'Registrar novamente hoje', icon: 'plus', onSelect: () => duplicate(tx, { date: today(), status: 'done' }, 'registrado novamente hoje') } : null,
    tx.type !== 'transfer' ? { label: 'Duplicar (mesma data)', icon: 'copy', onSelect: () => duplicate(tx, {}, 'duplicado') } : null,
    tx.type !== 'transfer' ? { label: 'Copiar para outro mês…', icon: 'calendar', onSelect: () => openReplicateDialog(tx, { single: true }) } : null,
    tx.type !== 'transfer' ? { label: 'Replicar para outros meses…', icon: 'layers', onSelect: () => openReplicateDialog(tx) } : null,
    canRepeat ? { label: 'Transformar em recorrente…', icon: 'repeat', onSelect: () => openConvertToRecurring(tx) } : null,
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
  openMenu(anchor, [
    { label: item.type === 'income' ? 'Marcar como recebido' : 'Marcar como pago', icon: 'check', onSelect: () => toggleStatus(item) },
    { label: item.type === 'income' ? 'Confirmar recebimento…' : 'Confirmar pagamento…', icon: 'check', onSelect: () => openPayDialog(item) },
    { label: item.date ? 'Editar só esta ocorrência' : 'Definir data e editar', icon: 'edit', onSelect: () => openItem(item) },
    { label: 'Editar esta e as próximas', icon: 'repeat', onSelect: () => editSeries(rule, from) },
    { label: 'Calcular com este valor', icon: 'calc', onSelect: () => sendToCalculator(item.amount, item.description) },
    'sep',
    { label: 'Ignorar esta ocorrência', icon: 'x', onSelect: () => skip(item) },
    { label: 'Pausar série a partir daqui', icon: 'clock', onSelect: () => pauseSeries(rule, from) },
    { label: 'Encerrar série a partir daqui', icon: 'trash', danger: true, onSelect: () => endSeries(rule, from) },
  ]);
}

export function sendToCalculator(cents, label) {
  import('../components/calculator.js').then((c) => c.openCalculatorWith?.(cents, label)).catch(toastError);
}

/** Pergunta o escopo de uma alteração em ocorrência recorrente. */
export function askScope({ title, allowAll = true, allowMonth = false }) {
  return new Promise((resolve) => {
    let choice = null;
    const opt = (value, label, desc) => h('button', { class: 'scope-opt', type: 'button', dataset: { scope: value }, onclick: () => { choice = value; m.close(); } }, h('strong', null, label), h('span', { class: 'faint small' }, desc));
    const m = openModal({ title, size: 'sm', body: h('div', { class: 'scope-list' },
      opt('one', 'Apenas esta ocorrência', 'As demais continuam como estão.'),
      allowMonth ? opt('month', 'Somente este mês', 'Todas as ocorrências previstas deste mês; os outros meses não mudam.') : null,
      opt('future', 'Esta e as próximas', 'Ocorrências anteriores e já pagas não mudam.'),
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
 * Replicar para outros meses: escolha rápida (próximo, 3, 6, 12) ou meses
 * específicos; datas iguais, um dia escolhido ou datas a definir. Mostra o
 * resumo antes de confirmar. As cópias começam como previstas.
 */
export function openReplicateDialog(tx, { single = false } = {}) {
  const base = tx.date ? monthOf(tx.date) : tx.month;
  const horizon = Array.from({ length: 24 }, (_, i) => addMonths(base, i + 1));
  const chosen = new Set(single ? [horizon[0]] : []);
  const opId = uid();
  const quick = single ? null : h('div', { class: 'chips' }, ...[[1, 'Próximo mês'], [3, 'Próximos 3'], [6, 'Próximos 6'], [12, 'Próximos 12']].map(([n, l]) =>
    h('button', { class: 'chip', type: 'button', onclick: () => { chosen.clear(); horizon.slice(0, n).forEach((m) => chosen.add(m)); drawMonths(); } }, l)));
  const monthsBox = h('div', { class: 'month-picks', role: 'group', 'aria-label': 'Meses' });
  const drawMonths = () => {
    put(monthsBox, ...horizon.map((m) => {
      const on = chosen.has(m);
      return h('button', { class: `month-pick${on ? ' is-on' : ''}`, type: 'button', 'aria-pressed': String(on), dataset: { month: m }, onclick: () => { if (single) chosen.clear(); if (chosen.has(m)) chosen.delete(m); else chosen.add(m); drawMonths(); } }, capitalize(formatMonthShort(m)));
    }));
    updateSummary();
  };
  const rangeFrom = h('input', { class: 'input', type: 'month', 'aria-label': 'De' });
  const rangeTo = h('input', { class: 'input', type: 'month', 'aria-label': 'Até' });
  const applyRange = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => {
    if (!rangeFrom.value || !rangeTo.value || rangeTo.value < rangeFrom.value) { toast('Escolha um intervalo válido', { tone: 'error' }); return; }
    chosen.clear();
    for (let m = rangeFrom.value, i = 0; m <= rangeTo.value && i < 60; m = addMonths(m, 1), i++) chosen.add(m);
    for (const m of chosen) if (!horizon.includes(m)) horizon.push(m);
    horizon.sort();
    drawMonths();
  } }, 'Usar intervalo');
  let dateMode = tx.date ? 'same' : 'flex';
  const day = h('input', { class: 'input', type: 'number', min: 1, max: 31, value: tx.date ? Number(tx.date.slice(8, 10)) : 10, 'aria-label': 'Dia' });
  const dm = segmented({ label: 'Datas', value: dateMode, size: 'segmented-sm', options: [{ value: 'same', label: 'Mesmo dia' }, { value: 'day', label: 'Outro dia' }, { value: 'flex', label: 'A definir' }], onChange: (v) => { dateMode = v; day.hidden = v !== 'day'; updateSummary(); } });
  day.hidden = dateMode !== 'day';
  const summary = h('div', { class: 'replicate-summary', 'aria-live': 'polite' });
  const updateSummary = () => {
    const ms = [...chosen].sort();
    if (!ms.length) { put(summary, h('p', { class: 'faint small' }, 'Escolha os meses.')); return; }
    const d = (m) => (dateMode === 'flex' ? 'data a definir' : formatDate(dateInMonth(m, dateMode === 'day' ? Number(day.value) || 1 : Number((tx.date || '0000-00-01').slice(8, 10)))));
    const similar = ms.filter((m) => repo.list('transactions').some((x) => x.id !== tx.id && (x.month === m) && x.description === tx.description && x.amount === tx.amount));
    put(summary,
      h('strong', { class: 'small' }, `${ms.length} ${ms.length === 1 ? 'lançamento previsto será criado' : 'lançamentos previstos serão criados'} · ${formatMoney(tx.amount * ms.length)} no total`),
      h('ul', { class: 'replicate-list' }, ...ms.slice(0, 12).map((m) => h('li', null, `${capitalize(formatMonth(m))} — ${d(m)} — ${formatMoney(tx.amount)}`)), ms.length > 12 ? h('li', { class: 'faint' }, `… e mais ${ms.length - 12}`) : null),
      similar.length ? h('p', { class: 'note is-warn' }, icon('alert', 'icon-sm'), `Já existe um lançamento igual em ${similar.map((m) => formatMonthShort(m)).join(', ')}. Confira para não duplicar.`) : null,
      tx.status === 'done' ? h('p', { class: 'faint small' }, 'As cópias começam como previstas: o pagamento não é copiado.') : null);
  };
  day.addEventListener('input', updateSummary);
  const go = h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
    if (!chosen.size) { toast('Escolha pelo menos um mês', { tone: 'error' }); return; }
    go.classList.add('is-busy'); go.disabled = true;
    try {
      const created = await repo.replicateTransaction(tx.id, { months: [...chosen], dateMode, day: Number(day.value) || null, opId });
      m.close();
      toast(`${created.length} ${created.length === 1 ? 'cópia criada' : 'cópias criadas'} como previstas`, { tone: 'success', action: created.length ? { label: 'Desfazer', fn: () => Promise.all(created.map((c) => repo.deleteTransaction(c.id))).catch(toastError) } : null });
    } catch (err) { toastError(err); go.disabled = false; } finally { go.classList.remove('is-busy'); }
  } }, single ? 'Copiar' : 'Replicar');
  const m = openModal({ title: single ? 'Copiar para outro mês' : 'Replicar para outros meses', size: 'md', className: 'replicate-modal', body: h('div', { class: 'stack-lg' },
    h('p', { class: 'muted small' }, `${tx.description} · ${formatMoney(tx.amount)}${tx.date ? ` · ${formatDate(tx.date)}` : ''}`),
    quick, monthsBox,
    single ? null : h('div', { class: 'row wrap' }, h('span', { class: 'small faint' }, 'Intervalo:'), rangeFrom, rangeTo, applyRange),
    h('div', { class: 'row wrap' }, h('span', { class: 'small' }, 'Datas das cópias:'), dm, day),
    summary),
  footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), go] });
  drawMonths();
  return m;
}

export function openConvertToRecurring(tx) {
  const rep = repeatFields({ preset: 'monthly', mode: 'fixed', getDate: () => tx.date, getAmount: () => tx.amount, getType: () => tx.type, idPrefix: 'cv' });
  const go = h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
    const err = rep.validate();
    if (err) { toast(err, { tone: 'error' }); return; }
    const r = rep.read();
    if (!r) { toast('Escolha como repetir', { tone: 'error' }); return; }
    go.classList.add('is-busy');
    try {
      await repo.convertToRecurring(tx.id, { frequency: r.frequency, interval: r.interval, endDate: r.endDate, count: r.count, mode: r.mode || 'fixed', days: r.days, perPeriod: r.perPeriod });
      m.close();
      toast(r.mode === 'forecast' ? `“${tx.description}” agora consome uma previsão mensal de ${formatMoney(tx.amount)}.` : `“${tx.description}” agora é recorrente. Este lançamento é a primeira ocorrência.`, { tone: 'success' });
    } catch (e) { toastError(e); } finally { go.classList.remove('is-busy'); }
  } }, 'Transformar');
  rep.box.hidden = false;
  const m = openModal({ title: 'Transformar em recorrente', size: 'md', body: h('div', { class: 'stack-lg' },
    h('p', { class: 'muted small' }, `“${tx.description}” (${formatMoney(tx.amount)}, ${formatDate(tx.date)}) passa a fazer parte da série. Nenhuma cópia é criada.`),
    field('Repetir', rep.select), rep.box),
  footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), go] });
}

async function duplicate(tx, overrides = {}, verb = 'duplicado') {
  try {
    const copy = await repo.duplicateTransaction(tx.id, overrides);
    toast(`Lançamento ${verb}`, { tone: 'success', action: { label: 'Editar', fn: () => openEntryForm({ tx: repo.get('transactions', copy.id) }) } });
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

export async function skip(item) {
  const key = keyOf(item);
  try {
    await repo.skipOccurrence(item.recurrenceId, key);
    toast(item.date ? `Ocorrência de ${formatDate(item.date)} ignorada` : 'Ocorrência ignorada', { action: { label: 'Desfazer', fn: () => repo.unskipOccurrence(item.recurrenceId, key).catch(toastError) } });
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
  const rep = repeatFields({ preset: presetOf(r), mode: ruleMode(r), getDate: () => startD.value, getAmount: () => amount.getValue(), getType: () => typeV, rule: { ...r, startDate: undefined }, onChange: () => syncLabels() });
  // Na regra, "Não repetir" não faz sentido.
  rep.select.querySelector('option[value="none"]')?.remove();
  rep.update();
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
export { MONTHLY_MODES, describeFrequency, currentMonth, lastDay, ui };
