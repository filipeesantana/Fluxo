import { h, icon, put, uid } from '../utils/dom.js';
import { openModal, confirmDialog } from './modal.js';
import { toast, toastError } from './toast.js';
import { field, moneyInput, segmented, suggestInput, checkbox, readInt } from './fields.js';
import { picker } from './picker.js';
import * as repo from '../database/repository.js';
import { today, monthOf, isISODate, isMonth, formatMonth, formatDate, formatDateShort, dateInMonth, parseISO, addMonths, addDays, firstDay } from '../utils/dates.js';
import { formatMoney, splitCents } from '../utils/money.js';
import { isCard, billFor, cardConfigured, competenceOf } from '../services/cards.js';
import { descriptionSuggestions, recentSources, fold } from '../services/suggest.js';
import { summarize } from '../services/finance.js';
import { findSimilar } from '../services/integrity.js';
import { METHODS } from '../services/validation.js';
import { ruleMode, monthlyAmount } from '../services/recurrence.js';
import { repeatFields } from './repeat-fields.js';
import { categoryOptions, blockOptions, accountOptions, createCategory, createBlock, categoryName, blockName, accountName, recentIds, colorOf } from '../views/common.js';
import { ui } from '../state.js';
import { askScope } from '../views/actions.js';

const SOURCE_KINDS = [{ value: 'checking', label: 'Conta' }, { value: 'credit', label: 'Cartão de crédito' }, { value: 'cash', label: 'Dinheiro' }, { value: 'benefit', label: 'Benefício (VA/VR)' }];

function defaultDate() {
  const t = today();
  if (ui.month === monthOf(t)) return t;
  return dateInMonth(ui.month, parseISO(t).d);
}

async function quickAccount(name, kind = 'checking') {
  const a = await repo.createNamed('accounts', { name, kind, openingBalance: 0 });
  return { value: a.id, label: a.name, group: kind === 'credit' ? 'Cartões' : kind === 'benefit' ? 'Benefícios' : 'Contas', sub: kind === 'credit' ? 'cartão' : kind === 'benefit' ? 'benefício' : '' };
}

/**
 * Formulário de lançamento.
 * opts.tx: movimentação existente · opts.occurrence: { ruleId, key, date } · opts.defaults · opts.refundOf
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
  const draftId = existing?.id || uid(); // idempotência: o mesmo formulário nunca cria dois registros
  let type = base.type;
  let statusTouched = isEdit || opts.defaults?.status != null;
  let monthManual = Boolean(base.monthManual);
  let manualMonth = base.month || null;
  let saving = false;
  let dirty = false;
  let similarAck = false;
  const touched = new Set(isEdit ? ['category', 'block', 'source'] : Object.keys(opts.defaults || {}).map((k) => ({ categoryId: 'category', blockId: 'block', sourceId: 'source' }[k])).filter(Boolean));

  // ——— Controles ———
  const typeSeg = segmented({
    label: 'Tipo', value: type === 'refund' ? 'expense' : type,
    options: [{ value: 'expense', label: 'Despesa', icon: 'out' }, { value: 'income', label: 'Receita', icon: 'in' }, { value: 'transfer', label: 'Transferência', icon: 'swap' }],
    onChange: (v) => { type = v; dirty = true; syncType(); },
  });
  const amount = moneyInput({ value: base.amount ?? null, large: true, name: 'amount', onChange: () => { dirty = true; updatePreview(); hideSimilar(); } });
  const date = h('input', { class: 'input', type: 'date', value: base.date || '', required: true, name: 'date' });
  // Data a definir: só para compromissos previstos (consulta em dezembro, dia ainda não marcado).
  const tbd = h('input', { type: 'checkbox', name: 'dateTBD', checked: !base.date && base.status !== 'done' });
  const tbdMonth = h('input', { class: 'input input-sm', type: 'month', name: 'tbdMonth', value: base.period || base.month || ui.month, 'aria-label': 'Mês previsto' });
  const tbdRow = h('div', { class: 'tbd-row' }, h('label', { class: 'check check-sm' }, tbd, h('span', null, 'Data a definir')), tbdMonth);
  const desc = suggestInput({
    value: base.description || '', placeholder: 'Ex.: Mercado, Internet, Salário', name: 'description',
    getSuggestions: (q) => (isEdit || type === 'transfer' ? [] : descriptionSuggestions(q, repo.list('transactions'), { type: type === 'income' ? 'income' : 'expense' })),
    renderItem: (s) => h('span', { class: 'sg-row' }, h('span', { class: 'truncate' }, s.description),
      h('span', { class: 'faint xsmall truncate' }, [s.categoryId && categoryName(s.categoryId), s.blockId && blockName(s.blockId), s.sourceId && accountName(s.sourceId)].filter(Boolean).join(' · ')),
      h('span', { class: 'num faint xsmall' }, formatMoney(s.amount))),
    onPick: (s) => applySuggestion(s, true),
  });
  const category = picker({
    name: 'category', options: categoryOptions(type, base.categoryId), value: base.categoryId, emptyLabel: 'Sem categoria', ariaLabel: 'Categoria',
    recent: recentIds('categoryId', { type: type === 'income' ? 'income' : 'expense' }), createLabel: 'Criar categoria',
    onCreate: (name) => createCategory(type, name), onChange: () => { touched.add('category'); dirty = true; hideSimilar(); },
  });
  const block = picker({
    name: 'block', options: blockOptions(base.blockId), value: base.blockId, emptyLabel: 'Sem bloco', ariaLabel: 'Bloco',
    recent: recentIds('blockId'), createLabel: 'Criar bloco', onCreate: createBlock, onChange: () => { touched.add('block'); dirty = true; },
  });
  const source = picker({
    name: 'source', options: accountOptions({ keep: base.sourceId }), value: base.sourceId, emptyLabel: 'Sem fonte', ariaLabel: 'Fonte',
    createLabel: 'Criar', createKinds: SOURCE_KINDS, onCreate: (name, kind) => quickAccount(name, kind),
    onChange: () => { touched.add('source'); dirty = true; syncSource(); hideSimilar(); },
  });
  const toAcc = picker({
    name: 'to', options: accountOptions({ keep: base.toAccountId }), value: base.toAccountId, emptyLabel: 'Escolha o destino', ariaLabel: 'Destino',
    createLabel: 'Criar', createKinds: SOURCE_KINDS, onCreate: (name, kind) => quickAccount(name, kind), onChange: () => { dirty = true; syncTransfer(); },
  });
  const billMonth = h('input', { class: 'input', type: 'month', value: base.billMonth || monthOf(base.date) });
  const status = segmented({
    label: 'Situação', value: base.status,
    options: [{ value: 'done', label: 'Realizado' }, { value: 'planned', label: 'Previsto' }],
    onChange: () => { statusTouched = true; dirty = true; if (typeof syncExtras === 'function') syncExtras(); },
  });
  const restricted = checkbox('Benefício de uso restrito', { checked: Boolean(base.restricted), hint: 'VA/VR não conta como dinheiro livre' });
  const method = h('select', { class: 'select', name: 'method' }, h('option', { value: '' }, 'Não informado'), ...Object.entries(METHODS).map(([v, l]) => h('option', { value: v }, l)));
  method.value = base.method || '';
  const note = h('textarea', { class: 'input', rows: 2, maxlength: 500, placeholder: 'Opcional' }, base.note || '');
  const billInfo = h('div', { class: 'bill-info' });
  const monthInput = h('input', { class: 'input input-sm', type: 'month', value: manualMonth || monthOf(base.date), 'aria-label': 'Mês de cobrança' });
  const suggestNote = h('div', { class: 'suggest-note', hidden: true });

  // Parcelamento e repetição (somente na criação)
  const parcelCount = h('input', { class: 'input', type: 'number', min: 2, max: 120, step: 1, value: 2, inputmode: 'numeric' });
  const parcelFirst = h('input', { class: 'input', type: 'month', value: monthOf(base.date) });
  const parcelPreview = h('div', { class: 'faint small' });
  // Repetição: um único seletor visível; o restante aparece só quando necessário.
  const rep = repeatFields({ preset: opts.defaults?.repeat || 'none', mode: opts.defaults?.repeatMode || 'fixed', getDate: () => date.value, getAmount: () => amount.getValue(), getType: () => type, onChange: () => { mode.repeat = rep.active; if (mode.repeat) mode.parcel = false; syncExtras(); } });
  const repeatSel = rep.select;
  // Previsões mensais ativas às quais um gasto pode ser vinculado (consome o valor previsto).
  const forecastSel = h('select', { class: 'select', name: 'forecast', 'aria-label': 'Conta na previsão mensal' });
  let forecastTouched = Boolean(base.forecastId);
  const mode = { parcel: false, repeat: rep.active, details: Boolean(base.note || base.method) };
  const chip = (key, label, ic) => {
    const b = h('button', { class: 'chip-toggle', type: 'button', 'aria-pressed': String(mode[key]), dataset: { toggle: key } }, icon(ic), label);
    b.addEventListener('click', () => {
      mode[key] = !mode[key];
      if (key === 'parcel' && mode.parcel) { mode.repeat = false; rep.set('none'); }
      syncExtras();
    });
    return b;
  };
  const parcelChip = chip('parcel', 'Parcelar', 'layers');
  const detailsChip = chip('details', 'Observação e método', 'edit');

  const fAmount = field(isRefund ? 'Valor devolvido' : 'Valor', amount, { className: 'f-amount' });
  const fDate = field('Data', date, { className: 'f-date' });
  fDate.append(tbdRow);
  const fDesc = field('Descrição', desc);
  const fCategory = field('Categoria', category);
  const fBlock = field(h('span', null, 'Bloco ', h('span', { class: 'opt' }, 'opcional')), block, { id: block.button.id });
  const fSource = field('Pago com', source, { id: source.button.id });
  const fForecast = field('Conta na previsão', forecastSel, { hint: 'O gasto consome o valor previsto para o mês' });
  const fTo = field('Para', toAcc, { id: toAcc.button.id });
  const fBill = field('Fatura (competência)', billMonth, { hint: 'Mês da fatura que este pagamento liquida' });
  const fStatus = field('Situação', status);
  const fMethod = field('Método', method, { hint: 'Ex.: Pix a partir da conta escolhida' });
  const fNote = field('Observação', note);
  category.button.id && fCategory.querySelector('label').setAttribute('for', category.button.id);
  const billUse = h('button', { class: 'link-btn small', type: 'button', hidden: true });
  fBill.append(billUse);

  const parcelBox = h('div', { class: 'extra-box', hidden: true }, h('div', { class: 'form-grid' }, field('Parcelas', parcelCount), field('Primeira competência', parcelFirst)), parcelPreview);
  const fRepeat = field('Repetir', repeatSel);
  const repeatBox = rep.box;
  const detailsBox = h('div', { class: 'extra-box', hidden: true }, h('div', { class: 'form-grid' }, fMethod, fNote));
  const toggles = h('div', { class: 'more-toggles' }, isEdit ? null : parcelChip, detailsChip);

  const similarBox = h('div', { class: 'banner banner-warn', hidden: true, role: 'status' });
  const banners = [];
  if (refundOf) banners.push(h('div', { class: 'banner' }, icon('refund', 'icon-sm'), h('span', null, 'Reduz a despesa original: ', h('strong', null, refundOf.description), ` (${formatMoney(refundOf.amount)})`)));
  if (occ) banners.push(h('div', { class: 'banner' }, icon('repeat', 'icon-sm'), h('span', null, occ.date ? `Ocorrência de ${formatDate(occ.date)} de uma série.` : 'Ocorrência de uma série com data a definir.', ' Ao salvar, você escolhe se a alteração vale só para ela ou também para as próximas.')));
  if (existing?.planId) banners.push(h('div', { class: 'banner' }, icon('layers', 'icon-sm'), h('span', null, `Parcela ${existing.installment.index} de ${existing.installment.count}. Alterações aqui valem só para esta parcela.`)));

  const form = h('form', { class: 'entry-form', novalidate: true, id: 'entry-form' },
    ...banners,
    isRefund ? null : h('div', { class: 'form-row' }, typeSeg),
    h('div', { class: 'form-grid form-grid-amount' }, fAmount, fDate),
    fDesc,
    h('div', { class: 'form-grid' }, fCategory, fSource, fTo, fBlock, fStatus, isEdit ? null : fRepeat, fForecast, fBill, h('div', { class: 'field f-restricted' }, restricted)),
    suggestNote,
    billInfo,
    toggles, parcelBox, repeatBox, detailsBox,
    similarBox,
  );

  // ——— Sugestões do histórico (nunca sobrescrevem escolhas manuais) ———
  function applySuggestion(s, explicit) {
    const applied = [];
    const prev = { category: category.getValue(), block: block.getValue(), source: source.getValue() };
    if (s.categoryId && !touched.has('category') && repo.get('categories', s.categoryId) && !repo.get('categories', s.categoryId).archived && repo.get('categories', s.categoryId).type === (type === 'income' ? 'income' : 'expense')) { category.setValue(s.categoryId); applied.push(categoryName(s.categoryId)); }
    if (type !== 'income' && s.blockId && !touched.has('block') && repo.get('blocks', s.blockId) && !repo.get('blocks', s.blockId).archived) { block.setValue(s.blockId); applied.push(blockName(s.blockId)); }
    if (s.sourceId && !touched.has('source') && repo.get('accounts', s.sourceId) && !repo.get('accounts', s.sourceId).archived) { source.setValue(s.sourceId); applied.push(accountName(s.sourceId)); syncSource(); }
    if (explicit && amount.getValue() == null) amount.setValue(s.amount);
    if (applied.length) {
      put(suggestNote, icon('sparkle', 'icon-sm'), h('span', null, `Sugerido pelo histórico: ${applied.join(' · ')}`),
        h('button', { class: 'link-btn', type: 'button', onclick: () => { category.setValue(prev.category); block.setValue(prev.block); source.setValue(prev.source); syncSource(); suggestNote.hidden = true; } }, 'Desfazer'));
      suggestNote.hidden = false;
    }
    updatePreview();
    if (explicit) amount.input.focus();
  }
  // Descrição idêntica a uma anterior: aplica a classificação durante a digitação
  // (não no blur, para não deslocar o layout no momento do clique em Salvar).
  let exactT;
  const exactMatch = () => {
    if (isEdit || type === 'transfer' || !desc.input.value.trim()) return;
    const q = fold(desc.input.value);
    const s = descriptionSuggestions(desc.input.value, repo.list('transactions'), { type: type === 'income' ? 'income' : 'expense', limit: 3 }).find((x) => fold(x.description) === q);
    if (s) applySuggestion(s, false);
  };
  desc.input.addEventListener('input', () => { clearTimeout(exactT); exactT = setTimeout(exactMatch, 350); });

  // ——— Sincronização visual ———
  function syncType() {
    const t = type;
    fCategory.hidden = t === 'transfer';
    fBlock.hidden = t === 'transfer' || t === 'income';
    fTo.hidden = t !== 'transfer';
    fSource.querySelector('.field-label').textContent = t === 'income' ? 'Recebido em' : t === 'transfer' ? 'De' : 'Pago com';
    restricted.parentElement.hidden = t !== 'income';
    parcelChip.hidden = t !== 'expense';
    if (t !== 'expense') mode.parcel = false;
    fRepeat.hidden = t === 'transfer' || isEdit || isRefund;
    if (t === 'transfer') { mode.repeat = false; rep.set('none'); }
    rep.update();
    category.setOptions(categoryOptions(t, category.getValue()));
    category.setRecent(recentIds('categoryId', { type: t === 'income' ? 'income' : 'expense' }));
    syncSource(); syncTransfer(); syncExtras();
  }
  function syncSource() {
    const acc = repo.get('accounts', source.getValue());
    if (type === 'income' && acc?.kind === 'benefit') restricted.input.checked = true;
    const card = isCard(acc) && (type === 'expense' || type === 'refund') && !mode.parcel;
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
    if (!rule.configured) parts.push(h('span', null, 'Cartão sem fechamento e vencimento configurados: a compra conta no mês da data.'));
    else parts.push(h('span', null, `Entra na fatura de ${formatMonth(m)}`, monthManual ? ' (ajustado manualmente)' : `, vence ${formatDate(rule.dueDate)}.`));
    if (monthManual) parts.push(monthInput, h('button', { class: 'link-btn', type: 'button', onclick: () => { monthManual = false; renderBillInfo(acc); } }, 'Usar a regra do cartão'));
    else parts.push(h('button', { class: 'link-btn', type: 'button', onclick: () => { monthManual = true; manualMonth = m; monthInput.value = m; renderBillInfo(acc); monthInput.focus(); } }, 'Alterar mês'));
    put(billInfo, ...parts);
  }
  monthInput.addEventListener('change', () => { if (isMonth(monthInput.value)) manualMonth = monthInput.value; });

  function syncTransfer() {
    const to = repo.get('accounts', toAcc.getValue());
    const isBill = type === 'transfer' && isCard(to);
    fBill.hidden = !isBill;
    fStatus.hidden = false;
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
    parcelBox.hidden = !mode.parcel;
    repeatBox.hidden = !mode.repeat;
    repeatSel.disabled = mode.parcel;
    const rmode = rep.mode;
    rep.update();
    // Previsão mensal: o valor é o total do mês e não há "pago" na criação.
    fStatus.hidden = rmode === 'forecast';
    tbdRow.hidden = !(!mode.repeat && !mode.parcel && type !== 'transfer' && (status.getValue() === 'planned' || tbd.checked) && !(existing && existing.status === 'done'));
    if (tbdRow.hidden) tbd.checked = false;
    date.disabled = tbd.checked;
    tbdMonth.hidden = !tbd.checked;
    syncForecast();
    detailsBox.hidden = !mode.details;
    parcelChip.setAttribute('aria-pressed', String(mode.parcel));
    detailsChip.setAttribute('aria-pressed', String(mode.details));
    fAmount.querySelector('.field-label').textContent = mode.parcel ? 'Valor total' : isRefund ? 'Valor devolvido' : rmode === 'forecast' ? 'Valor previsto no mês' : rmode === 'flex' || rmode === 'days' ? 'Valor de cada ocorrência' : 'Valor';
    const acc = repo.get('accounts', source.getValue());
    if (mode.parcel && !parcelFirst.dataset.touched) parcelFirst.value = isCard(acc) && isISODate(date.value) ? billFor(date.value, acc).month : monthOf(date.value || today());
    billInfo.hidden = !(isCard(acc) && (type === 'expense' || type === 'refund') && !mode.parcel);
    updatePreview();
  }
  parcelFirst.addEventListener('change', () => { parcelFirst.dataset.touched = '1'; });
  function updatePreview() {
    if (!mode.parcel) return;
    const total = amount.getValue();
    const n = readInt(parcelCount, { min: 2, max: 120 });
    if (!total || !n) { parcelPreview.textContent = 'Informe o valor total e o número de parcelas.'; return; }
    const parts = splitCents(total, n);
    const last = addMonths(parcelFirst.value || monthOf(date.value || today()), n - 1);
    parcelPreview.textContent = (parts.every((p) => p === parts[0])
      ? `${n}× de ${formatMoney(parts[0])}`
      : `1ª de ${formatMoney(parts[0])} e ${n - 1}× de ${formatMoney(parts[n - 1])}`) + ` · total exato ${formatMoney(total)} · última em ${formatMonth(last)}`;
  }
  parcelCount.addEventListener('input', updatePreview);
  function syncForecast() {
    const m = tbd.checked ? tbdMonth.value : isISODate(date.value) ? competenceOf({ type, date: date.value }, repo.get('accounts', source.getValue())) : ui.month;
    const ctx = repo.context();
    const rules = repo.list('recurrences').filter((r) => ruleMode(r) === 'forecast' && !r.archived && r.type === 'expense');
    const show = (type === 'expense') && !mode.repeat && !mode.parcel && rules.length > 0 && !(existing?.recurrenceId);
    fForecast.hidden = !show;
    if (!show) return;
    const cur = forecastSel.value || base.forecastId || '';
    put(forecastSel, h('option', { value: '' }, 'Não vincular'), ...rules.map((r) => {
      const used = ctx.forecastUse.get(`${r.id}|${m}`) || 0;
      const left = r.amount - used;
      return h('option', { value: r.id }, `${r.description} · ${left >= 0 ? `restam ${formatMoney(left)}` : `${formatMoney(-left)} acima`}`);
    }));
    forecastSel.value = rules.some((r) => r.id === cur) ? cur : '';
    // Sugestão: mesma categoria da previsão (nunca sobrescreve uma escolha manual).
    if (!forecastTouched && !forecastSel.value) {
      const match = rules.find((r) => r.categoryId && r.categoryId === category.getValue());
      if (match) forecastSel.value = match.id;
    }
  }
  forecastSel.addEventListener('change', () => { forecastTouched = true; dirty = true; });
  // Ocorrência de série: o mês previsto é o do compromisso, não pode ser trocado aqui.
  if (occ || existing?.recurrenceId) tbdMonth.disabled = true;
  tbd.addEventListener('change', () => { dirty = true; if (tbd.checked) { status.setValue('planned'); statusTouched = true; if (isISODate(date.value)) tbdMonth.value = monthOf(date.value); } syncExtras(); });
  tbdMonth.addEventListener('change', syncForecast);
  date.addEventListener('change', () => {
    dirty = true;
    hideSimilar();
    if (!statusTouched && isISODate(date.value)) status.setValue(date.value > today() ? 'planned' : 'done');
    syncSource(); syncTransfer(); syncExtras();
  });
  form.addEventListener('input', () => { dirty = true; });

  // ——— Duplicidades ———
  function hideSimilar() { similarBox.hidden = true; similarAck = false; }
  function showSimilar(result, data) {
    const rows = result.matches.map((t) => h('div', { class: 'similar-item' },
      h('span', { class: 'truncate' }, `${t.description} · ${formatDateShort(t.date)}${t.sourceId ? ` · ${accountName(t.sourceId)}` : ''}`),
      h('span', { class: 'num strong' }, formatMoney(t.amount))));
    const actions = [h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { hideSimilar(); amount.input.focus(); } }, 'Voltar e revisar')];
    if (result.matches[0]) actions.push(h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { dirty = false; modal.close(); openEntryForm({ tx: result.matches[0] }); } }, 'Abrir existente'));
    if (result.occurrence) actions.push(h('button', { class: 'btn btn-sm btn-soft', type: 'button', onclick: () => payOccurrence(result.occurrence, data) }, `Marcar “${result.occurrence.description}” como paga`));
    actions.push(h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { similarAck = true; submit(pendingAgain); } }, 'Registrar mesmo assim'));
    put(similarBox, icon('alert', 'icon-sm'), h('div', { class: 'banner-body' },
      h('strong', null, result.matches.length ? 'Encontramos um lançamento semelhante.' : 'Este gasto parece ser uma conta recorrente já prevista.'),
      result.occurrence && !result.matches.length ? h('span', { class: 'small' }, `“${result.occurrence.description}” (${formatMoney(result.occurrence.amount)}) está prevista para ${formatDateShort(result.occurrence.date)}. Marcar como paga evita contar o gasto duas vezes.`) : null,
      rows.length ? h('div', { class: 'similar-list' }, ...rows) : null,
      h('div', { class: 'banner-actions' }, ...actions)));
    similarBox.hidden = false;
    similarBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  async function payOccurrence(v, data) {
    try {
      await repo.materializeOccurrence(v.recurrenceId, v.occurrenceKey || v.occurrenceDate, { status: 'done', amount: data.amount, date: data.date, sourceId: data.sourceId || v.sourceId, categoryId: data.categoryId || v.categoryId, blockId: data.blockId || v.blockId });
      dirty = false; modal.close();
      toast(`“${v.description}” marcada como paga`, { tone: 'success' });
    } catch (err) { toastError(err); }
  }

  // ——— Salvamento ———
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'submit', form: 'entry-form' }, 'Salvar');
  const saveNewBtn = isEdit ? null : h('button', { class: 'btn', type: 'button', title: 'Shift+Enter', onclick: () => submit(true) }, 'Salvar e novo');
  const delBtn = existing ? h('button', { class: 'btn btn-ghost btn-danger', type: 'button', onclick: () => remove() }, icon('trash', 'icon-sm'), 'Excluir') : null;
  let pendingAgain = false;
  form.addEventListener('submit', (ev) => { ev.preventDefault(); submit(false); });
  form.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || ev.target.closest('.picker, .suggest-wrap [aria-expanded="true"]')) return;
    if (ev.ctrlKey || ev.metaKey) { ev.preventDefault(); submit(false); }
    else if (ev.shiftKey && !isEdit && ev.target.tagName !== 'TEXTAREA') { ev.preventDefault(); submit(true); }
  });

  function collect() {
    const errors = [];
    const cents = amount.getValue();
    if (cents == null || cents <= 0) { fAmount.setError('Informe um valor maior que zero'); errors.push(amount.input); } else fAmount.setError('');
    const undated = !tbdRow.hidden && tbd.checked;
    if (undated) { if (!isMonth(tbdMonth.value)) { fDate.setError('Escolha o mês previsto'); errors.push(tbdMonth); } else fDate.setError(''); }
    else if (!isISODate(date.value)) { fDate.setError('Data inválida'); errors.push(date); } else fDate.setError('');
    if (type === 'transfer') {
      const from = source.getValue(), to = toAcc.getValue();
      if (!from) { fSource.setError('Escolha de qual conta sai o dinheiro'); errors.push(source.button); } else fSource.setError('');
      if (!to || to === from) { fTo.setError(to && to === from ? 'Origem e destino iguais' : 'Escolha o destino'); errors.push(toAcc.button); } else fTo.setError('');
    } else { fSource.setError(''); fTo.setError(''); }
    let count = null;
    if (mode.parcel) {
      count = readInt(parcelCount, { min: 2, max: 120 });
      if (!count) { errors.push(parcelCount); toast('Parcelas: informe de 2 a 120', { tone: 'error' }); }
      if (!isMonth(parcelFirst.value)) errors.push(parcelFirst);
    }
    const repErr = mode.repeat ? rep.validate() : null;
    if (repErr) { errors.push(repeatSel); toast(repErr, { tone: 'error' }); }
    if (errors.length) { errors[0].focus(); return null; }
    const acc = repo.get('accounts', source.getValue());
    const data = {
      type: isRefund ? 'refund' : type,
      status: undated ? 'planned' : status.getValue(),
      amount: cents,
      date: undated ? null : date.value,
      period: undated ? tbdMonth.value : undefined,
      month: undated ? tbdMonth.value : undefined,
      description: desc.input.value.trim(),
      categoryId: type === 'transfer' ? null : category.getValue(),
      blockId: type === 'expense' || isRefund ? block.getValue() : null,
      sourceId: source.getValue(),
      toAccountId: type === 'transfer' ? toAcc.getValue() : undefined,
      billMonth: type === 'transfer' && isCard(repo.get('accounts', toAcc.getValue())) ? billMonth.value : undefined,
      restricted: type === 'income' ? restricted.input.checked : undefined,
      method: method.value || null,
      note: note.value.trim() || null,
      forecastId: !fForecast.hidden && forecastSel.value ? forecastSel.value : (existing?.forecastId && fForecast.hidden ? existing.forecastId : null),
    };
    if (refundOf) data.refundOf = refundOf.id;
    const card = isCard(acc) && (data.type === 'expense' || data.type === 'refund');
    if (existing?.planId) { data.monthManual = true; data.month = monthManual && manualMonth ? manualMonth : existing.month; }
    else if (card && monthManual && isMonth(manualMonth) && !undated) { data.monthManual = true; data.month = manualMonth; }
    else data.monthManual = false;
    return { data, count, repeat: mode.repeat ? rep.read() : null };
  }

  async function submit(again) {
    if (saving) return;
    const c = collect();
    if (!c) return;
    const { data } = c;
    pendingAgain = again;
    // Aviso de semelhança somente em lançamentos novos e avulsos; nunca bloqueia.
    if (!isEdit && !similarAck && !mode.parcel && data.type !== 'transfer' && data.date) {
      const month = data.monthManual ? data.month : competenceOf({ ...data }, repo.get('accounts', data.sourceId));
      const res = findSimilar({ ...data, id: draftId, month }, repo.context());
      if (res.matches.length || (res.occurrence && !mode.repeat)) { showSimilar(res, data); return; }
    }
    saving = true;
    saveBtn.classList.add('is-busy');
    saveNewBtn?.setAttribute('disabled', '');
    try {
      let undo = null;
      // Ocorrência de série: pergunta o escopo quando muda algo que define a série.
      const ruleId = existing?.recurrenceId || occ?.ruleId;
      const rule = ruleId ? repo.get('recurrences', ruleId) : null;
      const rmode = rule ? ruleMode(rule) : null;
      const seriesKeys = ['amount', 'description', 'categoryId', 'blockId', 'sourceId'];
      const changed = rule ? seriesKeys.filter((k) => (data[k] ?? null) !== (rule[k] ?? null)) : [];
      let scope = 'one';
      if (rule && changed.length && !existing?.remainderOf) {
        saving = false;
        saveBtn.classList.remove('is-busy');
        scope = await askScope({ title: 'Aplicar a alteração a…', allowMonth: rmode === 'days' || rmode === 'flex' });
        if (!scope) return;
        saving = true;
        saveBtn.classList.add('is-busy');
      }
      const occKey = existing?.occurrenceKey || existing?.occurrenceDate || occ?.key || occ?.date;
      const period = existing?.period || occ?.period || (occKey ? String(occKey).slice(0, 7) : null);
      const seriesChanges = Object.fromEntries(changed.map((k) => [k, data[k] ?? null]));
      if (existing) {
        await repo.saveTransaction({ ...existing, ...data, id: existing.id }, { baseRev: existing.rev || 0 });
      } else if (occ) {
        await repo.materializeOccurrence(occ.ruleId, occKey, data);
      }
      if (rule && scope === 'month' && period) await repo.editSeriesPeriod(rule.id, period, seriesChanges);
      else if (rule && scope === 'future') {
        const from = rmode === 'fixed' ? addDays(existing?.occurrenceDate || occ?.date || data.date, 1) : firstDay(addMonths(period, 1));
        await repo.editSeriesFrom(rule.id, from, seriesChanges);
      } else if (rule && scope === 'all') await repo.saveRecurrence({ ...rule, ...seriesChanges });
      if (existing || occ) {
        // já gravado acima
      } else if (mode.parcel) {
        const plan = await repo.createInstallmentPlan({ ...data, id: draftId, total: data.amount, count: c.count, purchaseDate: data.date, firstMonth: parcelFirst.value });
        undo = () => repo.deletePlan(plan.id);
      } else if (mode.repeat && c.repeat) {
        const r = c.repeat;
        const m = r.mode || 'fixed';
        // A ocorrência que deu origem à série: registrada já paga ou com a data escolhida.
        let first = null;
        if (m === 'flex') first = { ...data, period: undefined, month: undefined };
        else if (m === 'days') first = data.status === 'done' && r.days.includes(Number(data.date.slice(8, 10))) ? { ...data } : null;
        else if (m === 'fixed') first = data.status === 'done' && r.startDate === data.date ? { ...data, status: 'done' } : null;
        const created = await repo.createRecurrence({
          id: draftId, type: data.type, description: data.description || categoryName(data.categoryId), amount: data.amount,
          startDate: r.startDate, endDate: r.endDate || null, count: r.count, anchorDay: r.anchorDay, mode: r.mode, days: r.days, perPeriod: r.perPeriod,
          frequency: r.frequency, interval: r.interval, categoryId: data.categoryId, blockId: data.blockId, sourceId: data.sourceId, method: data.method,
          restricted: data.restricted, estimated: r.estimated,
        }, first);
        undo = () => repo.deleteRecurrence(created.id);
      } else {
        const saved = await repo.saveTransaction({ ...data, id: draftId });
        undo = () => repo.deleteTransaction(saved.id);
      }
      dirty = false;
      modal.close();
      const repMsg = c.repeat ? (c.repeat.mode === 'forecast' ? 'Previsão mensal criada' : c.repeat.mode === 'flex' ? 'Compromisso mensal criado: defina as datas em Planejamento → Compromissos' : 'Lançamento recorrente criado') : null;
      toast(isEdit ? 'Alterações salvas' : mode.parcel ? `Parcelamento criado em ${c.count} parcelas` : mode.repeat ? repMsg : data.date ? 'Lançamento salvo' : `Compromisso previsto para ${formatMonth(data.period)} (data a definir)`, {
        tone: 'success', action: undo ? { label: 'Desfazer', fn: () => undo().catch(toastError) } : null,
      });
      if (again) openEntryForm({ defaults: { type: data.type === 'refund' ? 'expense' : data.type, date: data.date || defaultDate(), sourceId: data.sourceId, status: data.status } });
    } catch (err) {
      toastError(err);
    } finally {
      saving = false;
      saveBtn.classList.remove('is-busy');
      saveNewBtn?.removeAttribute('disabled');
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
  const keysHint = h('span', { class: 'hint-keys' }, h('kbd', null, 'Ctrl'), '+', h('kbd', null, 'Enter'), 'salva');
  const modal = openModal({
    title, body: form, size: 'md', className: 'entry-modal',
    footer: [delBtn, keysHint, h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancelar'), saveNewBtn, saveBtn],
  });
  modal.beforeClose = () => {
    if (!dirty || saving) return true;
    confirmDialog({ title: 'Descartar alterações?', message: 'Os dados preenchidos neste lançamento serão perdidos.', confirmLabel: 'Descartar', danger: true })
      .then((ok) => { if (ok) { dirty = false; modal.close(); } });
    return false;
  };
  syncType();
  syncExtras();
  requestAnimationFrame(() => (isEdit ? desc.input : amount.input).focus());
  return modal;
}

function suggestBillMonth(card, dateISO) {
  if (!cardConfigured(card)) return monthOf(dateISO);
  const ctx = repo.context();
  const m0 = monthOf(dateISO);
  for (const m of [addMonths(m0, -1), m0, addMonths(m0, 1)]) {
    const bill = summarize(ctx, m).cardBills.find((b) => b.cardId === card.id);
    if (bill && bill.total - bill.paid > 0) return m;
  }
  return dateISO <= dateInMonth(m0, card.dueDay) ? m0 : addMonths(m0, 1);
}

export { colorOf };
