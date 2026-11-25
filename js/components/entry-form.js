import { h, icon, put } from '../utils/dom.js';
import { openModal, confirmDialog } from './modal.js';
import { toast, toastError } from './toast.js';
import { field, moneyInput, selectWithCreate, segmented, suggestInput, checkbox, readInt } from './fields.js';
import * as repo from '../database/repository.js';
import { today, monthOf, isISODate, isMonth, formatMonth, formatDate, dateInMonth, parseISO, currentMonth, addMonths } from '../utils/dates.js';
import { formatMoney, splitCents } from '../utils/money.js';
import { isCard, billFor, cardConfigured } from '../services/cards.js';
import { descriptionSuggestions, recentSources } from '../services/suggest.js';
import { summarize } from '../services/finance.js';
import { METHODS } from '../services/validation.js';
import { FREQUENCIES } from '../services/recurrence.js';
import { categoryOptions, blockOptions, accountOptions, createCategory, createBlock, categoryName, blockName, accountName, capitalize, ACCOUNT_KINDS } from '../views/common.js';
import { ui } from '../state.js';

function defaultDate() {
  const t = today();
  if (ui.month === monthOf(t)) return t;
  return dateInMonth(ui.month, parseISO(t).d);
}

async function quickAccount(name, kind) {
  const a = await repo.createNamed('accounts', { name, kind, openingBalance: 0 });
  return { value: a.id, label: a.name, group: kind === 'credit' ? 'Cartões' : kind === 'benefit' ? 'Benefícios' : 'Contas' };
}

/**
 * Abre o formulário de lançamento.
 * opts.tx: movimentação existente (edição) · opts.occurrence: { ruleId, date } (ocorrência projetada)
 * opts.defaults: valores iniciais · opts.refundOf: movimentação original de um reembolso
 */
export function openEntryForm(opts = {}) {
  const existing = opts.tx || null;
  const occ = opts.occurrence || null;
  const refundOf = opts.refundOf || (existing?.refundOf ? repo.get('transactions', existing.refundOf) : null);
  const base = { type: 'expense', status: 'done', date: defaultDate(), ...(opts.defaults || {}), ...(existing || {}) };
  if (refundOf && !existing) Object.assign(base, { type: 'refund', categoryId: refundOf.categoryId, blockId: refundOf.blockId, sourceId: refundOf.sourceId, description: `Reembolso: ${refundOf.description}`, date: today() });
  if (!existing && !occ && !base.sourceId && base.type !== 'transfer') base.sourceId = recentSources(repo.list('transactions'))[0] || null;
  if (!existing && !occ && opts.defaults?.status == null && base.date > today()) base.status = 'planned';
  const isEdit = Boolean(existing || occ);
  const isRefund = base.type === 'refund';
  let type = base.type;
  let statusTouched = isEdit || opts.defaults?.status != null;
  let monthManual = Boolean(base.monthManual);
  let manualMonth = base.month || null;
  let saving = false;
  let dirty = false;

  // ——— Controles ———
  const typeSeg = segmented({
    label: 'Tipo', value: type === 'refund' ? 'expense' : type,
    options: [{ value: 'expense', label: 'Despesa' }, { value: 'income', label: 'Receita' }, { value: 'transfer', label: 'Transferência' }],
    onChange: (v) => { type = v; syncType(); },
  });
  const amount = moneyInput({ value: base.amount ?? null, large: true, name: 'amount', onChange: () => { dirty = true; updatePreview(); } });
  const date = h('input', { class: 'input', type: 'date', value: base.date, required: true, name: 'date' });
  const desc = suggestInput({
    value: base.description || '', placeholder: 'Ex.: Jantar, Mercado, Salário', name: 'description',
    getSuggestions: (q) => (isEdit || type === 'transfer' ? [] : descriptionSuggestions(q, repo.list('transactions'), { type: type === 'income' ? 'income' : 'expense' })),
    renderItem: (s) => h('span', { class: 'sg-row' }, h('span', { class: 'truncate' }, s.description),
      h('span', { class: 'faint xsmall truncate' }, [s.categoryId && categoryName(s.categoryId), s.blockId && blockName(s.blockId), s.sourceId && accountName(s.sourceId)].filter(Boolean).join(' · ')),
      h('span', { class: 'num faint xsmall' }, formatMoney(s.amount))),
    onPick: (s) => {
      if (s.categoryId && repo.get('categories', s.categoryId) && !repo.get('categories', s.categoryId).archived) category.setValue(s.categoryId);
      if (s.blockId && repo.get('blocks', s.blockId) && !repo.get('blocks', s.blockId).archived) block.setValue(s.blockId);
      if (s.sourceId && repo.get('accounts', s.sourceId) && !repo.get('accounts', s.sourceId).archived) { source.setValue(s.sourceId); syncSource(); }
      if (amount.getValue() == null) amount.setValue(s.amount);
      updatePreview();
      amount.input.focus();
    },
  });
  const category = selectWithCreate({
    options: categoryOptions(type, base.categoryId), value: base.categoryId, placeholder: 'Sem categoria', createLabel: 'Nova categoria',
    onCreate: (name) => createCategory(type, name), name: 'category',
  });
  const block = selectWithCreate({
    options: blockOptions(base.blockId), value: base.blockId, placeholder: 'Sem bloco', createLabel: 'Novo bloco',
    onCreate: createBlock, name: 'block',
  });
  const newKind = h('select', { class: 'select select-inline', 'aria-label': 'Tipo da nova fonte' },
    ...['checking', 'credit', 'cash', 'benefit', 'savings'].map((k) => h('option', { value: k }, ACCOUNT_KINDS[k])));
  const source = selectWithCreate({
    options: accountOptions({ keep: base.sourceId }), value: base.sourceId, placeholder: 'Sem fonte', createLabel: 'Nova conta ou cartão',
    onCreate: (name) => quickAccount(name, newKind.value), onChange: () => syncSource(), name: 'source',
  });
  source.querySelector('input').after(newKind);
  newKind.hidden = true;
  const srcObserver = new MutationObserver(() => { newKind.hidden = source.querySelector('input').hidden; });
  srcObserver.observe(source.querySelector('input'), { attributes: true, attributeFilter: ['hidden'] });

  const toAcc = selectWithCreate({
    options: accountOptions({ keep: base.toAccountId }), value: base.toAccountId, placeholder: 'Escolha o destino', createLabel: 'Nova conta ou cartão',
    onCreate: (name) => quickAccount(name, 'checking'), onChange: () => syncTransfer(), name: 'to',
  });
  const billMonth = h('input', { class: 'input', type: 'month', value: base.billMonth || monthOf(base.date) });
  const status = segmented({
    label: 'Situação', value: base.status,
    options: [{ value: 'done', label: 'Realizado' }, { value: 'planned', label: 'Previsto' }],
    onChange: () => { statusTouched = true; },
  });
  const restricted = checkbox('Benefício de uso restrito', { checked: Boolean(base.restricted), hint: 'VA/VR não conta como dinheiro livre' });
  const method = h('select', { class: 'select', name: 'method' }, h('option', { value: '' }, 'Não informado'), ...Object.entries(METHODS).map(([v, l]) => h('option', { value: v }, l)));
  method.value = base.method || '';
  const note = h('textarea', { class: 'input', rows: 2, maxlength: 500, placeholder: 'Opcional' }, base.note || '');

  // Competência (cartão)
  const billInfo = h('div', { class: 'bill-info small' });
  const monthInput = h('input', { class: 'input input-sm', type: 'month', value: manualMonth || monthOf(base.date), 'aria-label': 'Mês de cobrança' });

  // Parcelamento e repetição (somente na criação)
  const parcelOn = checkbox('Parcelar', { onChange: () => { if (parcelOn.input.checked) repeatOn.input.checked = false; syncExtras(); } });
  const parcelCount = h('input', { class: 'input', type: 'number', min: 2, max: 120, step: 1, value: 2, inputmode: 'numeric' });
  const parcelFirst = h('input', { class: 'input', type: 'month', value: monthOf(base.date) });
  const parcelPreview = h('div', { class: 'faint small' });
  const repeatOn = checkbox('Repetir', { onChange: () => { if (repeatOn.input.checked) parcelOn.input.checked = false; syncExtras(); } });
  const freq = h('select', { class: 'select' }, ...Object.entries(FREQUENCIES).map(([v, l]) => h('option', { value: v }, l)), h('option', { value: 'monthly:2' }, 'A cada 2 meses'), h('option', { value: 'monthly:3' }, 'A cada 3 meses'), h('option', { value: 'monthly:6' }, 'A cada 6 meses'));
  const repeatEnd = h('input', { class: 'input', type: 'date' });

  const fType = h('div', { class: 'form-row' }, typeSeg);
  const fAmount = field(isRefund ? 'Valor devolvido' : 'Valor', amount, { className: 'f-amount' });
  const fDate = field('Data', date, { className: 'f-date' });
  const fDesc = field('Descrição', desc);
  const fCategory = field('Categoria', category);
  const fBlock = field('Bloco', block, { hint: 'Contexto: pessoal, casa, moto…' });
  const fSource = field('Pago com', source);
  const fTo = field('Para', toAcc);
  const fBill = field('Fatura (competência)', billMonth, { hint: 'Mês da fatura que este pagamento liquida' });
  const fStatus = field('Situação', status);
  const fMethod = field('Método', method, { hint: 'Ex.: Pix a partir da conta escolhida' });
  const fNote = field('Observação', note);
  const billUse = h('button', { class: 'link-btn small', type: 'button', hidden: true });
  fBill.append(billUse);

  const parcelBox = h('div', { class: 'extra-box', hidden: true }, h('div', { class: 'form-grid' },
    field('Parcelas', parcelCount), field('Primeira competência', parcelFirst)), parcelPreview);
  const repeatBox = h('div', { class: 'extra-box', hidden: true }, h('div', { class: 'form-grid' },
    field('Frequência', freq), field('Termina em', repeatEnd, { hint: 'Opcional' })),
    h('p', { class: 'faint small' }, 'As próximas ocorrências serão projetadas automaticamente como previstas.'));
  const extras = h('div', { class: 'extras', hidden: isEdit }, h('div', { class: 'row extras-toggles' }, parcelOn, repeatOn), parcelBox, repeatBox);

  const more = h('details', { class: 'more-options', open: Boolean(base.note || base.method) },
    h('summary', null, icon('chev-right', 'icon-sm'), 'Mais opções'),
    h('div', { class: 'form-grid' }, fMethod, fNote));

  const refundBanner = refundOf ? h('div', { class: 'banner' }, icon('refund', 'icon-sm'), h('span', null, 'Reduz a despesa original: ', h('strong', null, refundOf.description), ` (${formatMoney(refundOf.amount)})`)) : null;
  const occBanner = occ ? h('div', { class: 'banner' }, icon('repeat', 'icon-sm'), h('span', null, `Ocorrência de ${formatDate(occ.date)}. As alterações valem só para esta data.`)) : null;
  const planBanner = existing?.planId ? h('div', { class: 'banner' }, icon('layers', 'icon-sm'), h('span', null, `Parcela ${existing.installment.index} de ${existing.installment.count}. Alterações aqui valem só para esta parcela.`)) : null;

  const form = h('form', { class: 'entry-form', novalidate: true },
    refundBanner, occBanner, planBanner,
    isRefund ? null : fType,
    h('div', { class: 'form-grid form-grid-amount' }, fAmount, fDate),
    fDesc,
    h('div', { class: 'form-grid' }, fCategory, fBlock, fSource, fTo, fStatus, fBill, h('div', { class: 'field f-restricted' }, restricted)),
    billInfo,
    extras,
    more,
  );

  // ——— Sincronização visual ———
  function syncType() {
    const t = type;
    fCategory.hidden = t === 'transfer';
    fBlock.hidden = t === 'transfer' || t === 'income';
    fTo.hidden = t !== 'transfer';
    fSource.querySelector('.field-label').textContent = t === 'income' ? 'Recebido em' : t === 'transfer' ? 'De' : 'Pago com';
    restricted.parentElement.hidden = t !== 'income';
    parcelOn.hidden = t !== 'expense';
    if (t !== 'expense') parcelOn.input.checked = false;
    repeatOn.hidden = t === 'transfer';
    if (t === 'transfer') repeatOn.input.checked = false;
    fMethod.hidden = t === 'income';
    category.setOptions(categoryOptions(t, category.getValue()));
    if (category.getValue() && repo.get('categories', category.getValue())?.type !== (t === 'income' ? 'income' : 'expense')) category.setValue(null);
    syncSource();
    syncTransfer();
    syncExtras();
  }
  function syncSource() {
    const acc = repo.get('accounts', source.getValue());
    if (type === 'income' && acc?.kind === 'benefit') restricted.input.checked = true;
    const card = isCard(acc) && (type === 'expense' || type === 'refund') && !parcelOn.input.checked;
    billInfo.hidden = !card;
    if (card) renderBillInfo(acc);
    fMethod.hidden = type === 'income' || isCard(acc);
    updatePreview();
  }
  function renderBillInfo(acc) {
    const d = isISODate(date.value) ? date.value : today();
    const rule = billFor(d, acc);
    const m = monthManual ? manualMonth : rule.month;
    const parts = [icon('card', 'icon-sm')];
    if (!rule.configured) parts.push(h('span', null, 'Cartão sem fechamento e vencimento configurados: a compra conta no mês da data. '));
    else parts.push(h('span', null, `Entra na fatura de ${formatMonth(m)}`, monthManual ? ' (ajustado manualmente)' : `, vence ${formatDate(rule.dueDate)}. `));
    if (monthManual) {
      parts.push(monthInput, h('button', { class: 'link-btn', type: 'button', onclick: () => { monthManual = false; renderBillInfo(acc); } }, 'Usar a regra do cartão'));
    } else {
      parts.push(h('button', { class: 'link-btn', type: 'button', onclick: () => { monthManual = true; manualMonth = m; monthInput.value = m; renderBillInfo(acc); monthInput.focus(); } }, 'Alterar mês'));
    }
    put(billInfo, ...parts);
  }
  monthInput.addEventListener('change', () => { if (isMonth(monthInput.value)) manualMonth = monthInput.value; });

  function syncTransfer() {
    const to = repo.get('accounts', toAcc.getValue());
    const isBill = type === 'transfer' && isCard(to);
    fBill.hidden = !isBill;
    fBill.querySelector('.field-label').textContent = isBill ? `Fatura de ${to.name}` : 'Fatura';
    if (isBill) {
      if (!existing?.billMonth && !billMonth.dataset.touched) billMonth.value = suggestBillMonth(to, isISODate(date.value) ? date.value : today());
      updateBillUse(to);
    }
  }
  function updateBillUse(card) {
    if (!isMonth(billMonth.value)) { billUse.hidden = true; return; }
    const bill = summarize(repo.context(), billMonth.value).cardBills.find((b) => b.cardId === card.id);
    const open = bill ? bill.total - bill.paid : 0;
    billUse.hidden = open <= 0;
    billUse.textContent = `Usar valor em aberto (${formatMoney(open)})`;
    billUse.onclick = () => { amount.setValue(open); amount.input.focus(); };
  }
  billMonth.addEventListener('change', () => { billMonth.dataset.touched = '1'; const to = repo.get('accounts', toAcc.getValue()); if (to) updateBillUse(to); });

  function syncExtras() {
    parcelBox.hidden = !parcelOn.input.checked;
    repeatBox.hidden = !repeatOn.input.checked;
    fAmount.querySelector('.field-label').textContent = parcelOn.input.checked ? 'Valor total' : isRefund ? 'Valor devolvido' : 'Valor';
    const acc = repo.get('accounts', source.getValue());
    if (parcelOn.input.checked && !parcelFirst.dataset.touched) parcelFirst.value = isCard(acc) && isISODate(date.value) ? billFor(date.value, acc).month : monthOf(date.value || today());
    billInfo.hidden = !(isCard(acc) && (type === 'expense' || type === 'refund') && !parcelOn.input.checked);
    updatePreview();
  }
  parcelFirst.addEventListener('change', () => { parcelFirst.dataset.touched = '1'; });
  function updatePreview() {
    if (!parcelOn.input.checked) return;
    const total = amount.getValue();
    const n = readInt(parcelCount, { min: 2, max: 120 });
    if (!total || !n) { parcelPreview.textContent = 'Informe o valor total e o número de parcelas.'; return; }
    const parts = splitCents(total, n);
    const same = parts.every((p) => p === parts[0]);
    parcelPreview.textContent = same
      ? `${n}× de ${formatMoney(parts[0])} · total ${formatMoney(total)}`
      : `1ª de ${formatMoney(parts[0])} e ${n - 1}× de ${formatMoney(parts[n - 1])} · total exato ${formatMoney(total)}`;
  }
  parcelCount.addEventListener('input', updatePreview);
  date.addEventListener('change', () => {
    dirty = true;
    if (!statusTouched && isISODate(date.value)) status.setValue(date.value > today() ? 'planned' : 'done');
    syncSource(); syncTransfer(); syncExtras();
  });
  form.addEventListener('input', () => { dirty = true; });

  // ——— Salvamento ———
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'submit', form: 'entry-form' }, isEdit ? 'Salvar' : 'Salvar');
  const saveNewBtn = isEdit ? null : h('button', { class: 'btn', type: 'button', title: 'Shift+Enter', onclick: () => submit(true) }, 'Salvar e novo');
  const delBtn = existing ? h('button', { class: 'btn btn-ghost btn-danger', type: 'button', onclick: () => remove() }, icon('trash', 'icon-sm'), 'Excluir') : null;
  form.id = 'entry-form';
  form.addEventListener('submit', (ev) => { ev.preventDefault(); submit(false); });
  form.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.shiftKey && !isEdit && ev.target.tagName !== 'TEXTAREA') { ev.preventDefault(); submit(true); }
  });

  function collect() {
    const errors = [];
    const cents = amount.getValue();
    if (cents == null || cents <= 0) { fAmount.setError('Informe um valor maior que zero'); errors.push(amount.input); } else fAmount.setError('');
    if (!isISODate(date.value)) { fDate.setError('Data inválida'); errors.push(date); } else fDate.setError('');
    if (type === 'transfer') {
      const from = source.getValue(), to = toAcc.getValue();
      if (!from) { fSource.setError('Escolha a origem'); errors.push(source.select); } else fSource.setError('');
      if (!to || to === from) { fTo.setError(to === from && to ? 'Origem e destino iguais' : 'Escolha o destino'); errors.push(toAcc.select); } else fTo.setError('');
    } else { fSource.setError(''); fTo.setError(''); }
    let count = null;
    if (parcelOn.input.checked) {
      count = readInt(parcelCount, { min: 2, max: 120 });
      if (!count) { errors.push(parcelCount); toast('Parcelas: informe de 2 a 120', { tone: 'error' }); }
      if (!isMonth(parcelFirst.value)) errors.push(parcelFirst);
    }
    if (repeatOn.input.checked && repeatEnd.value && repeatEnd.value < date.value) { errors.push(repeatEnd); toast('A data final da repetição é anterior ao início', { tone: 'error' }); }
    if (errors.length) { errors[0].focus(); return null; }
    const acc = repo.get('accounts', source.getValue());
    const data = {
      type: type === 'expense' && isRefund ? 'refund' : type,
      status: status.getValue(),
      amount: cents,
      date: date.value,
      description: desc.input.value.trim(),
      categoryId: type === 'transfer' ? null : category.getValue(),
      blockId: type === 'expense' || type === 'refund' || isRefund ? block.getValue() : null,
      sourceId: source.getValue(),
      toAccountId: type === 'transfer' ? toAcc.getValue() : undefined,
      billMonth: type === 'transfer' && isCard(repo.get('accounts', toAcc.getValue())) ? billMonth.value : undefined,
      restricted: type === 'income' ? restricted.input.checked : undefined,
      method: method.value || null,
      note: note.value.trim() || null,
    };
    if (isRefund) data.type = 'refund';
    if (refundOf) data.refundOf = refundOf.id;
    const card = isCard(acc) && (data.type === 'expense' || data.type === 'refund');
    if (existing?.planId) { data.monthManual = true; data.month = monthManual && manualMonth ? manualMonth : existing.month; }
    else if (card && monthManual && isMonth(manualMonth)) { data.monthManual = true; data.month = manualMonth; }
    else data.monthManual = false;
    return { data, count, freqValue: freq.value };
  }

  async function submit(again) {
    if (saving) return;
    const c = collect();
    if (!c) return;
    saving = true;
    saveBtn.classList.add('is-busy');
    try {
      const { data } = c;
      let saved = null;
      let undo = null;
      if (existing) {
        saved = await repo.saveTransaction({ ...existing, ...data, id: existing.id });
      } else if (occ) {
        saved = await repo.materializeOccurrence(occ.ruleId, occ.date, data);
      } else if (parcelOn.input.checked) {
        const plan = await repo.createInstallmentPlan({ ...data, total: data.amount, count: c.count, purchaseDate: data.date, firstMonth: parcelFirst.value });
        undo = () => repo.deletePlan(plan.id);
      } else if (repeatOn.input.checked) {
        const [frequency, interval] = c.freqValue.split(':');
        const rule = await repo.saveRecurrence({
          type: data.type, description: data.description || categoryName(data.categoryId), amount: data.amount, startDate: data.date, endDate: repeatEnd.value || null,
          frequency, interval: Number(interval) || 1, categoryId: data.categoryId, blockId: data.blockId, sourceId: data.sourceId, restricted: data.restricted,
        });
        if (data.status === 'done') await repo.materializeOccurrence(rule.id, data.date, { ...data, status: 'done' });
        undo = () => repo.deleteRecurrence(rule.id);
      } else {
        saved = await repo.saveTransaction(data);
        undo = () => repo.deleteTransaction(saved.id);
      }
      dirty = false;
      modal.close();
      toast(isEdit ? 'Alterações salvas' : parcelOn.input.checked ? `Parcelamento criado em ${c.count} parcelas` : repeatOn.input.checked ? 'Recorrência criada' : 'Lançamento salvo', {
        tone: 'success', action: undo ? { label: 'Desfazer', fn: () => undo().catch(toastError) } : null,
      });
      if (again) openEntryForm({ defaults: { type: data.type === 'refund' ? 'expense' : data.type, date: data.date, sourceId: data.sourceId, status: data.status } });
    } catch (err) {
      toastError(err);
    } finally {
      saving = false;
      saveBtn.classList.remove('is-busy');
    }
  }

  async function remove() {
    const ok = await confirmDialog({ title: 'Excluir lançamento?', message: `“${existing.description}” (${formatMoney(existing.amount)}) será removido. Você poderá desfazer logo em seguida.`, confirmLabel: 'Excluir', danger: true });
    if (!ok) return;
    try {
      const removed = await repo.deleteTransaction(existing.id);
      dirty = false;
      modal.close();
      toast('Lançamento excluído', { action: { label: 'Desfazer', fn: () => repo.restoreTransactions([removed]).catch(toastError) } });
    } catch (err) { toastError(err); }
  }

  const title = existing ? (isRefund ? 'Editar reembolso' : 'Editar lançamento') : occ ? 'Editar ocorrência' : refundOf ? 'Registrar reembolso ou estorno' : 'Novo lançamento';
  const modal = openModal({
    title, body: form, size: 'md', className: 'entry-modal',
    footer: [delBtn, h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancelar'), saveNewBtn, saveBtn],
    onClose: () => srcObserver.disconnect(),
  });
  modal.beforeClose = () => {
    if (!dirty || saving) return true;
    // Fechamento acidental não descarta dados sem confirmação.
    confirmDialog({ title: 'Descartar alterações?', message: 'Os dados preenchidos neste lançamento serão perdidos.', confirmLabel: 'Descartar', danger: true })
      .then((ok) => { if (ok) { dirty = false; modal.close(); } });
    return false;
  };
  syncType();
  requestAnimationFrame(() => (isEdit ? desc.input : amount.input).focus());
  return modal;
}

function suggestBillMonth(card, dateISO) {
  if (!cardConfigured(card)) return monthOf(dateISO);
  // Fatura com vencimento mais próximo ainda em aberto a partir do mês da data.
  const ctx = repo.context();
  const m0 = monthOf(dateISO);
  for (const m of [addMonths(m0, -1), m0, addMonths(m0, 1)]) {
    const bill = summarize(ctx, m).cardBills.find((b) => b.cardId === card.id);
    if (bill && bill.total - bill.paid > 0) return m;
  }
  return dateISO <= dateInMonth(m0, card.dueDay) ? m0 : addMonths(m0, 1);
}

export { capitalize, currentMonth };
