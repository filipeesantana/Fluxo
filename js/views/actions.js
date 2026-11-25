import { h, put } from '../utils/dom.js';
import { openMenu } from '../components/menu.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { toast, toastError } from '../components/toast.js';
import { openEntryForm } from '../components/entry-form.js';
import { field, moneyInput, segmented } from '../components/fields.js';
import * as repo from '../database/repository.js';
import { today, formatDate, isISODate } from '../utils/dates.js';
import { formatMoney } from '../utils/money.js';
import { FREQUENCIES } from '../services/recurrence.js';
import { categoryOptions, blockOptions, accountOptions } from './common.js';

export function openItem(item) {
  if (item.virtual) openEntryForm({ occurrence: { ruleId: item.recurrenceId, date: item.occurrenceDate }, defaults: item });
  else openEntryForm({ tx: repo.get('transactions', item.id) });
}

export async function toggleStatus(item) {
  try {
    if (item.virtual) {
      await repo.materializeOccurrence(item.recurrenceId, item.occurrenceDate, { status: 'done' });
      toast(`“${item.description}” marcado como ${item.type === 'income' ? 'recebido' : 'pago'}`, { tone: 'success' });
      return;
    }
    const tx = repo.get('transactions', item.id);
    const next = tx.status === 'done' ? 'planned' : 'done';
    await repo.setStatus(tx.id, next);
    toast(next === 'done' ? 'Marcado como realizado' : 'Marcado como previsto', { action: { label: 'Desfazer', fn: () => repo.setStatus(tx.id, tx.status).catch(toastError) } });
  } catch (err) { toastError(err); }
}

export function itemMenu(item, anchor) {
  if (item.virtual) return occurrenceMenu(item, anchor);
  const tx = repo.get('transactions', item.id);
  const rule = tx.recurrenceId ? repo.get('recurrences', tx.recurrenceId) : null;
  openMenu(anchor, [
    { label: 'Editar', icon: 'edit', onSelect: () => openItem(item) },
    { label: tx.status === 'done' ? 'Marcar como previsto' : 'Marcar como realizado', icon: 'check', onSelect: () => toggleStatus(item) },
    tx.type !== 'transfer' ? { label: 'Duplicar', icon: 'copy', onSelect: () => duplicate(tx) } : null,
    tx.type === 'expense' ? { label: 'Registrar reembolso/estorno', icon: 'refund', onSelect: () => openEntryForm({ refundOf: tx }) } : null,
    rule ? { label: 'Editar série a partir daqui', icon: 'repeat', onSelect: () => editSeries(rule, tx.occurrenceDate) } : null,
    'sep',
    { label: 'Excluir', icon: 'trash', danger: true, onSelect: () => removeTx(tx) },
  ]);
}

function occurrenceMenu(item, anchor) {
  const rule = repo.get('recurrences', item.recurrenceId);
  openMenu(anchor, [
    { label: item.type === 'income' ? 'Marcar como recebido' : 'Marcar como pago', icon: 'check', onSelect: () => toggleStatus(item) },
    { label: 'Editar só esta ocorrência', icon: 'edit', onSelect: () => openItem(item) },
    { label: 'Editar série a partir daqui', icon: 'repeat', onSelect: () => editSeries(rule, item.occurrenceDate) },
    { label: 'Ignorar esta ocorrência', icon: 'x', onSelect: () => skip(item) },
    'sep',
    { label: 'Encerrar série a partir daqui', icon: 'trash', danger: true, onSelect: () => endSeries(rule, item.occurrenceDate) },
  ]);
}

async function duplicate(tx) {
  try {
    const copy = await repo.duplicateTransaction(tx.id, { date: today(), status: 'done' });
    toast('Lançamento duplicado para hoje', { action: { label: 'Editar', fn: () => openEntryForm({ tx: repo.get('transactions', copy.id) }) } });
  } catch (err) { toastError(err); }
}

export async function removeTx(tx) {
  if (tx.planId) {
    const ok = await confirmDialog({ title: 'Excluir parcela?', message: `Apenas a parcela ${tx.installment.index}/${tx.installment.count} será removida. Para cancelar o parcelamento inteiro, use Planejamento → Parcelamentos.`, confirmLabel: 'Excluir parcela', danger: true });
    if (!ok) return;
  }
  try {
    const removed = await repo.deleteTransaction(tx.id);
    toast(`“${removed.description}” excluído`, { action: { label: 'Desfazer', fn: () => repo.restoreTransactions([removed]).catch(toastError) } });
  } catch (err) { toastError(err); }
}

async function skip(item) {
  try {
    await repo.skipOccurrence(item.recurrenceId, item.occurrenceDate);
    toast(`Ocorrência de ${formatDate(item.occurrenceDate)} ignorada`, { action: { label: 'Desfazer', fn: () => repo.unskipOccurrence(item.recurrenceId, item.occurrenceDate).catch(toastError) } });
  } catch (err) { toastError(err); }
}

export async function endSeries(rule, fromDate) {
  const ok = await confirmDialog({
    title: 'Encerrar recorrência?',
    message: `“${rule.description}” deixará de ser projetada a partir de ${formatDate(fromDate)}. Ocorrências já pagas são preservadas.`,
    confirmLabel: 'Encerrar série', danger: true,
  });
  if (!ok) return;
  try { await repo.endSeries(rule.id, fromDate); toast('Recorrência encerrada'); } catch (err) { toastError(err); }
}

/** Formulário de regra recorrente (nova, edição completa ou edição a partir de uma data). */
export function openRecurrenceForm({ rule = null, fromDate = null, defaults = {} } = {}) {
  const r = { type: 'expense', frequency: 'monthly', interval: 1, startDate: today(), ...defaults, ...(rule || {}) };
  const type = segmented({ label: 'Tipo', value: r.type, options: [{ value: 'expense', label: 'Despesa' }, { value: 'income', label: 'Receita' }], onChange: (v) => { put(category, ...opts(categoryOptions(v, r.categoryId), 'Sem categoria')); fBlock.hidden = v === 'income'; } });
  const desc = h('input', { class: 'input', value: r.description || '', maxlength: 200, placeholder: 'Ex.: Internet, Plano de saúde, Salário' });
  const amount = moneyInput({ value: r.amount ?? null });
  const freq = h('select', { class: 'select' }, ...Object.entries(FREQUENCIES).map(([v, l]) => h('option', { value: v }, l)));
  freq.value = r.frequency;
  const interval = h('input', { class: 'input', type: 'number', min: 1, max: 60, step: 1, value: r.interval || 1 });
  const start = h('input', { class: 'input', type: 'date', value: fromDate || r.startDate });
  const end = h('input', { class: 'input', type: 'date', value: r.endDate || '' });
  const opts = (list, empty) => [h('option', { value: '' }, empty), ...list.map((o) => h('option', { value: o.value }, o.label))];
  const category = h('select', { class: 'select' }, ...opts(categoryOptions(r.type, r.categoryId), 'Sem categoria'));
  category.value = r.categoryId || '';
  const block = h('select', { class: 'select' }, ...opts(blockOptions(r.blockId), 'Sem bloco'));
  block.value = r.blockId || '';
  const source = h('select', { class: 'select' }, ...opts(accountOptions({ keep: r.sourceId }), 'Sem fonte'));
  source.value = r.sourceId || '';
  const fBlock = field('Bloco', block);
  fBlock.hidden = r.type === 'income';
  const fAmount = field('Valor', amount);
  const fDesc = field('Descrição', desc);
  const fStart = field(fromDate ? 'Vale a partir de' : 'Primeira ocorrência', start);
  const body = h('form', { class: 'entry-form', novalidate: true },
    fromDate ? h('div', { class: 'banner' }, `As alterações valem a partir de ${formatDate(fromDate)}. Ocorrências anteriores permanecem como estão.`) : null,
    rule ? null : h('div', { class: 'form-row' }, type),
    h('div', { class: 'form-grid' }, fDesc, fAmount, field('Frequência', freq), field('Intervalo', interval, { hint: 'Ex.: 2 = a cada duas vezes a frequência' }), fStart, field('Termina em', end, { hint: 'Opcional' }), field('Categoria', category), fBlock, field('Fonte', source)),
  );
  const save = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Salvar');
  body.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const cents = amount.getValue();
    fAmount.setError(cents ? '' : 'Informe um valor');
    fDesc.setError(desc.value.trim() ? '' : 'Informe uma descrição');
    fStart.setError(isISODate(start.value) ? '' : 'Data inválida');
    if (!cents || !desc.value.trim() || !isISODate(start.value)) return;
    if (end.value && end.value < start.value) { toast('A data final é anterior ao início', { tone: 'error' }); return; }
    const changes = {
      type: rule ? r.type : type.getValue(), description: desc.value.trim(), amount: cents, frequency: freq.value,
      interval: Math.max(1, Math.min(60, Number(interval.value) || 1)), endDate: end.value || null,
      categoryId: category.value || null, blockId: (rule ? r.type : type.getValue()) === 'income' ? null : block.value || null, sourceId: source.value || null,
    };
    save.classList.add('is-busy');
    try {
      if (rule && fromDate) await repo.editSeriesFrom(rule.id, fromDate, { ...changes, startDate: start.value });
      else await repo.saveRecurrence({ ...(rule || {}), ...changes, startDate: start.value });
      m.close();
      toast(rule ? 'Recorrência atualizada' : 'Recorrência criada', { tone: 'success' });
    } catch (err) { toastError(err); } finally { save.classList.remove('is-busy'); }
  });
  save.setAttribute('form', 'rec-form');
  body.id = 'rec-form';
  const m = openModal({ title: rule ? (fromDate ? 'Editar série' : 'Editar recorrência') : 'Nova recorrência', body, footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), save] });
  return m;
}

export function editSeries(rule, fromDate) {
  if (!rule) return;
  openRecurrenceForm({ rule, fromDate: fromDate && fromDate > rule.startDate ? fromDate : null });
}

export function formatAmountShort(c) { return formatMoney(c); }
