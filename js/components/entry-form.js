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
import { summarize, monthItems } from '../services/finance.js';
import { findSimilar } from '../services/integrity.js';
import { METHODS } from '../services/validation.js';
import { ruleMode, monthlyAmount, describeFrequency } from '../services/recurrence.js';
import { repeatFields } from './repeat-fields.js';
import { categoryOptions, blockOptions, accountOptions, createCategory, createBlock, categoryName, blockName, accountName, recentIds, colorOf, blockSource } from '../views/common.js';
import { ui } from '../state.js';
import { askScope, editSeries } from '../views/actions.js';

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
  // 3.2: a fonte não é mais "chutada" pela mais recente; vem do bloco, do histórico da descrição ou da escolha do usuário.
  if (!existing && !occ && opts.defaults?.status == null && base.date > today()) base.status = 'planned';
  const isEdit = Boolean(existing || occ);
  const isRefund = base.type === 'refund';
  // Um lançamento avulso já salvo também pode passar a se repetir (vira a 1ª ocorrência, sem cópia).
  const canRepeatExisting = Boolean(existing) && !existing.recurrenceId && !existing.forecastId && !existing.planId && !existing.remainderOf && (existing.type === 'expense' || existing.type === 'income');
  const seriesRule = (existing?.recurrenceId || occ?.ruleId) ? repo.get('recurrences', existing?.recurrenceId || occ?.ruleId) : null;
  const draftId = existing?.id || uid(); // idempotência: o mesmo formulário nunca cria dois registros
  let type = base.type;
  let statusTouched = isEdit || opts.defaults?.status != null;
  let monthManual = Boolean(base.monthManual);
  let manualMonth = base.month || null;
  let saving = false;
  let dirty = false;
  let dateTouched = Boolean(existing || occ || (opts.defaults?.date && !opts.kept));
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
    onCreate: (name) => createCategory(type, name), onChange: () => { touched.add('category'); dirty = true; hideSimilar(); updateFormSummary(); },
  });
  const block = picker({
    name: 'block', options: blockOptions(base.blockId), value: base.blockId, emptyLabel: 'Sem bloco', ariaLabel: 'Bloco',
    recent: recentIds('blockId'), createLabel: 'Criar bloco',
    // Bloco novo criado aqui herda a fonte já escolhida pelo usuário (ou a de mesmo nome).
    onCreate: (name) => createBlock(name, { sourceId: touched.has('source') ? source.getValue() : null }),
    onChange: () => { touched.add('block'); dirty = true; applyBlockSource(); updateFormSummary(); },
  });
  const source = picker({
    name: 'source', options: accountOptions({ keep: base.sourceId }), value: base.sourceId, emptyLabel: 'Sem fonte', ariaLabel: 'Fonte',
    createLabel: 'Criar', createKinds: SOURCE_KINDS, onCreate: (name, kind) => quickAccount(name, kind),
    onChange: () => { touched.add('source'); sourceAuto = null; dirty = true; syncSource(); hideSimilar(); },
  });
  // Fonte derivada do bloco (Fatura Nubank → Cartão Nubank): preenchida sem perguntar de novo.
  let sourceAuto = null;
  const sourceHint = h('p', { class: 'field-hint source-hint', hidden: true });
  function applyBlockSource() {
    if (type === 'transfer') return;
    const bs = blockSource(block.getValue());
    if (!bs || touched.has('source')) { if (sourceAuto && !bs) { sourceAuto = null; sourceHint.hidden = true; } return; }
    if (source.getValue() !== bs.account.id) source.setValue(bs.account.id);
    sourceAuto = bs;
    put(sourceHint, icon('sparkle', 'icon-sm'), ` ${bs.account.name} — preenchida pelo bloco${bs.how === 'history' ? ' (histórico)' : ''}`);
    sourceHint.hidden = false;
    syncSource();
  }
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
  // Repetição: "Não repetir | Mensal | Personalizar"; o restante aparece só quando necessário.
  const rep = repeatFields({ preset: opts.defaults?.repeat || 'none', mode: opts.defaults?.repeatMode || 'fixed', getDate: () => (tbd.checked ? `${tbdMonth.value}-01` : date.value), getAmount: () => amount.getValue(), getType: () => type,
    onChange: () => { mode.repeat = rep.active; if (mode.repeat) mode.parcel = false; dirty = true; syncExtras(); },
    // "Dia 5" com a data ainda no padrão: a 1ª ocorrência passa a ser o dia 5 deste mês.
    onDayChange: (d) => {
      if (dateTouched || isEdit || !isISODate(date.value)) return;
      date.value = dateInMonth(monthOf(date.value), d);
      if (!statusTouched) status.setValue(date.value > today() ? 'planned' : 'done');
      syncSource(); syncTransfer(); syncExtras();
    } });
  const repeatSel = rep.control;
  // Previsões mensais ativas às quais um gasto pode ser vinculado (consome o valor previsto).
  const forecastSel = h('select', { class: 'select', name: 'forecast', 'aria-label': 'Conta na previsão mensal' });
  let forecastTouched = Boolean(base.forecastId);
  const mode = { parcel: false, repeat: rep.active, details: Boolean(base.note || base.method), tpl: false };
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
  const saveTplChip = isEdit ? null : chip('tpl', 'Salvar como modelo', 'sparkle');

  const fAmount = field(isRefund ? 'Valor devolvido' : 'Valor', amount, { className: 'f-amount' });
  const fDate = field('Data', date, { className: 'f-date' });
  fDate.append(tbdRow);
  const fDesc = field('Descrição', desc);
  const fCategory = field('Categoria', category);
  const fBlock = field('Bloco', block, { id: block.button.id });
  const fSource = field('Fonte', source, { id: source.button.id });
  fSource.append(sourceHint);
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
  const fRepeat = field('Repetição', repeatSel, { className: 'f-repeat' });
  // Ocorrência de uma série: mostra a regra e o atalho para editá-la (em vez de "Repetir").
  const seriesLine = seriesRule ? h('div', { class: 'repeat-line is-series' }, h('span', { class: 'field-label' }, 'Repete'),
    h('span', { class: 'small' }, icon('repeat', 'icon-sm'), ` ${describeFrequency(seriesRule)}`),
    h('button', { class: 'link-btn small', type: 'button', onclick: () => { dirty = false; modal.close(); editSeries(seriesRule, existing?.occurrenceDate || occ?.date || existing?.date || null); } }, 'Editar série')) : null;
  const repeatBox = rep.box;
  const detailsBox = h('div', { class: 'extra-box', hidden: true }, h('div', { class: 'form-grid' }, fMethod, fNote));
  const toggles = h('div', { class: 'more-toggles' }, isEdit ? null : parcelChip, detailsChip, saveTplChip);

  const similarBox = h('div', { class: 'banner banner-warn', hidden: true, role: 'status' });
  // Recorrência já existente com a mesma descrição: usar a ocorrência em vez de criar outra despesa.
  const ruleNote = h('div', { class: 'banner banner-soft', hidden: true, role: 'status' });
  const formSummary = h('p', { class: 'form-summary', 'aria-live': 'polite' });
  // Cadastro em sequência: o que foi mantido do lançamento anterior fica explícito.
  const keptNote = opts.kept?.length ? h('div', { class: 'kept-note small' }, icon('check', 'icon-sm'),
    h('span', { class: 'grow' }, 'Mantidos: ', h('strong', null, opts.kept.join(' · '))),
    h('button', { class: 'link-btn small', type: 'button', onclick: () => { block.setValue(null); category.setValue(null); touched.delete('block'); touched.delete('category'); keptNote.remove(); } }, 'Limpar')) : null;
  // Modelos salvos e lançamentos frequentes: um toque preenche o formulário (nada é gravado).
  const templatesRow = !isEdit && !refundOf ? templateChips() : null;

  const banners = [];
  if (refundOf) banners.push(h('div', { class: 'banner' }, icon('refund', 'icon-sm'), h('span', null, 'Reduz a despesa original: ', h('strong', null, refundOf.description), ` (${formatMoney(refundOf.amount)})`)));
  if (occ) banners.push(h('div', { class: 'banner' }, icon('repeat', 'icon-sm'), h('span', null, occ.date ? `Ocorrência de ${formatDate(occ.date)} de uma série.` : 'Ocorrência de uma série com data a definir.', ' Ao salvar, você escolhe se a alteração vale só para ela ou também para as próximas.')));
  if (existing?.planId) banners.push(h('div', { class: 'banner' }, icon('layers', 'icon-sm'), h('span', null, `Parcela ${existing.installment.index} de ${existing.installment.count}. Alterações aqui valem só para esta parcela.`)));

  // Ordem: tipo · descrição e valor · data e repetição · bloco e categoria · fonte e situação.
  const form = h('form', { class: 'entry-form', novalidate: true, id: 'entry-form' },
    ...banners,
    isRefund ? null : h('div', { class: 'form-row' }, typeSeg),
    templatesRow, keptNote,
    h('div', { class: 'form-grid form-grid-desc' }, fDesc, fAmount),
    suggestNote, ruleNote,
    h('div', { class: 'form-grid form-grid-when' }, fDate, isEdit && !canRepeatExisting ? seriesLine : fRepeat),
    repeatBox,
    h('div', { class: 'form-grid' }, fBlock, fCategory),
    h('div', { class: 'form-grid' }, fSource, fTo, fStatus, fForecast, fBill, h('div', { class: 'field f-restricted' }, restricted)),
    billInfo,
    toggles, parcelBox, detailsBox,
    similarBox,
    formSummary,
  );

  // ——— Sugestões do histórico (nunca sobrescrevem escolhas manuais) ———
  function applySuggestion(s, explicit) {
    const applied = [];
    const prev = { category: category.getValue(), block: block.getValue(), source: source.getValue() };
    if (s.categoryId && !touched.has('category') && repo.get('categories', s.categoryId) && !repo.get('categories', s.categoryId).archived && repo.get('categories', s.categoryId).type === (type === 'income' ? 'income' : 'expense')) { category.setValue(s.categoryId); applied.push(categoryName(s.categoryId)); }
    if (type !== 'income' && s.blockId && !touched.has('block') && repo.get('blocks', s.blockId) && !repo.get('blocks', s.blockId).archived) { block.setValue(s.blockId); applied.push(blockName(s.blockId)); }
    if (s.sourceId && !touched.has('source') && repo.get('accounts', s.sourceId) && !repo.get('accounts', s.sourceId).archived) { source.setValue(s.sourceId); applied.push(accountName(s.sourceId)); syncSource(); }
    // Valor habitual: só preenche um campo vazio (nunca troca um valor digitado).
    const amountWasEmpty = amount.getValue() == null;
    if (amountWasEmpty && s.amount) { amount.setValue(s.amount); applied.push(`valor habitual ${formatMoney(s.amount)}`); }
    if (!touched.has('source') && !s.sourceId) applyBlockSource();
    // Aparece em 2 ou mais meses e ainda não se repete: oferece "Repetir mensalmente" (não ativa sozinho).
    const months = new Set(repo.list('transactions').filter((t) => fold(t.description) === fold(s.description)).map((t) => t.period || t.month));
    const offerRepeat = !isEdit && !mode.repeat && !mode.parcel && months.size >= 2 && !ruleFor(s.description);
    if (applied.length || offerRepeat) {
      put(suggestNote, icon('sparkle', 'icon-sm'), h('span', { class: 'grow' }, applied.length ? `Do histórico: ${applied.join(' · ')}` : `“${s.description}” aparece em ${months.size} meses.`),
        offerRepeat ? h('button', { class: 'link-btn', type: 'button', onclick: (ev) => { rep.set('monthly'); mode.repeat = true; syncExtras(); ev.currentTarget.remove(); } }, 'Repetir mensalmente') : null,
        applied.length ? h('button', { class: 'link-btn', type: 'button', onclick: () => { category.setValue(prev.category); block.setValue(prev.block); source.setValue(prev.source); if (amountWasEmpty) amount.setValue(null); syncSource(); suggestNote.hidden = true; } }, 'Desfazer') : null);
      suggestNote.hidden = false;
    }
    updateFormSummary();
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
    checkRule();
  };
  desc.input.addEventListener('input', () => { clearTimeout(exactT); exactT = setTimeout(exactMatch, 350); });

  /** Regra recorrente ativa com a mesma descrição (despesa ou receita), se houver. */
  function ruleFor(text) {
    const q = fold(text);
    if (!q) return null;
    const t = type === 'income' ? 'income' : 'expense';
    return repo.list('recurrences').find((r) => !r.archived && r.type === t && ruleMode(r) !== 'forecast' && fold(r.description) === q) || null;
  }
  /** "Spotify já se repete": oferece usar a ocorrência prevista em vez de criar outra despesa. */
  function checkRule() {
    ruleNote.hidden = true;
    if (isEdit || type === 'transfer') return;
    const r = ruleFor(desc.input.value);
    if (!r) return;
    const m = tbd.checked ? tbdMonth.value : isISODate(date.value) ? monthOf(date.value) : ui.month;
    const occ0 = monthItems(repo.context(), m).find((i) => i.recurrenceId === r.id && i.status === 'planned' && !i.forecast && !i.remainderOf);
    put(ruleNote, icon('repeat', 'icon-sm'), h('span', { class: 'grow small' }, h('strong', null, `“${r.description}” já se repete`), ` (${describeFrequency(r).toLowerCase()}).`,
      occ0 ? ` Prevista ${occ0.date ? `para ${formatDate(occ0.date)}` : 'neste mês'}: ${formatMoney(occ0.amount)}.` : ' Nada pendente neste mês.', ' Salvar aqui cria outra despesa.'),
      occ0 ? h('button', { class: 'btn btn-sm btn-soft', type: 'button', onclick: () => payExisting(occ0) }, type === 'income' ? 'Marcar como recebida' : 'Marcar como paga') : null,
      h('button', { class: 'link-btn small', type: 'button', onclick: () => { dirty = false; modal.close(); editSeries(r, null); } }, 'Ver série'));
    ruleNote.hidden = false;
  }
  async function payExisting(item) {
    try {
      const v = amount.getValue() || item.amount;
      const when = item.date && item.date <= today() ? item.date : today();
      const tx = await repo.payItem(item, { date: when, amount: v, sourceId: touched.has('source') ? source.getValue() : item.sourceId });
      dirty = false; modal.close();
      toast(`“${item.description}” marcada como ${type === 'income' ? 'recebida' : 'paga'}`, { tone: 'success', action: { label: 'Desfazer', fn: () => repo.unpayItem(tx.id).catch(toastError) } });
    } catch (err) { toastError(err); }
  }
  /** Resumo discreto antes de salvar (não é uma etapa). */
  function updateFormSummary() {
    const v = amount.getValue();
    const d = desc.input.value.trim();
    if (!v && !d) { formSummary.textContent = ''; return; }
    const parts = [d || (type === 'transfer' ? 'Transferência' : 'Sem descrição'), v ? formatMoney(v) : 'sem valor'];
    const r = mode.repeat ? rep.read() : null;
    parts.push(r ? describeFrequency(r) : tbd.checked && !tbdRow.hidden ? 'data a definir' : isISODate(date.value) ? formatDate(date.value) : 'sem data');
    if (type !== 'transfer' && block.getValue()) parts.push(blockName(block.getValue()));
    if (type !== 'transfer' && category.getValue()) parts.push(categoryName(category.getValue()));
    if (source.getValue()) parts.push(accountName(source.getValue()));
    const st = tbd.checked && !tbdRow.hidden ? 'planned' : status.getValue();
    if (rep.mode !== 'forecast') parts.push(st === 'done' ? (type === 'income' ? 'recebido' : 'pago') : 'previsto');
    formSummary.textContent = parts.join(' · ');
  }
  /** Linha de modelos e frequentes: um toque preenche (nada é gravado até Salvar). */
  function templateChips() {
    const saved = repo.listTemplates();
    const seen = new Set(saved.map((t) => `${t.type}|${fold(t.description)}`));
    const since = addMonths(monthOf(today()), -6);
    const freq = new Map();
    for (const t of repo.list('transactions')) {
      if ((t.type !== 'expense' && t.type !== 'income') || !t.description || (t.period || t.month) < since || t.planId || t.remainderOf) continue;
      const k = `${t.type}|${fold(t.description)}`;
      if (seen.has(k)) continue;
      const g = freq.get(k) || { n: 0, last: null };
      g.n++;
      if (!g.last || `${t.date}|${t.createdAt}` > `${g.last.date}|${g.last.createdAt}`) g.last = t;
      freq.set(k, g);
    }
    const frequent = [...freq.values()].filter((g) => g.n >= 2).sort((a, b) => b.n - a.n).slice(0, Math.max(0, 8 - saved.length))
      .map((g) => ({ type: g.last.type, description: g.last.description, amount: g.last.amount, categoryId: g.last.categoryId, blockId: g.last.blockId, sourceId: g.last.sourceId }));
    const items = [...saved.map((t) => ({ ...t, saved: true })), ...frequent];
    if (!items.length) return null;
    const row = h('div', { class: 'tpl-row', role: 'group', 'aria-label': 'Modelos e lançamentos frequentes' }, h('span', { class: 'small faint' }, 'Rápido'));
    for (const t of items) {
      const chipEl = h('span', { class: `tpl-chip${t.saved ? ' is-saved' : ''}` },
        h('button', { class: 'tpl-use', type: 'button', title: t.saved ? 'Modelo salvo: preencher o formulário' : 'Frequente: preencher o formulário', onclick: () => applyTemplate(t) },
          t.saved ? icon('sparkle', 'icon-sm') : null, t.description, t.amount ? h('span', { class: 'faint num' }, formatMoney(t.amount)) : null),
        t.saved ? h('button', { class: 'tpl-del', type: 'button', 'aria-label': `Remover o modelo ${t.description}`, onclick: async () => { try { await repo.deleteTemplate(t.id); chipEl.remove(); } catch (err) { toastError(err); } } }, icon('x', 'icon-sm')) : null);
      row.append(chipEl);
    }
    return row;
  }
  function applyTemplate(t) {
    if (t.type !== type && !isRefund) { type = t.type; typeSeg.setValue(t.type); syncType(); }
    desc.input.value = t.description;
    if (t.amount) amount.setValue(t.amount);
    const ok = (store, id) => id && repo.get(store, id) && !repo.get(store, id).archived;
    if (ok('categories', t.categoryId)) { category.setValue(t.categoryId); touched.add('category'); }
    if (type !== 'income' && ok('blocks', t.blockId)) { block.setValue(t.blockId); touched.add('block'); }
    if (ok('accounts', t.sourceId)) { source.setValue(t.sourceId); touched.add('source'); sourceHint.hidden = true; } else applyBlockSource();
    if (t.repeat && t.repeat !== 'none') { rep.set(t.repeat); mode.repeat = true; }
    if (t.note) { note.value = t.note; mode.details = true; }
    dirty = true;
    syncSource(); syncExtras(); checkRule();
    amount.input.focus(); amount.input.select();
  }

  // ——— Sincronização visual ———
  function syncType() {
    const t = type;
    fCategory.hidden = t === 'transfer';
    fBlock.hidden = t === 'transfer' || t === 'income';
    fTo.hidden = t !== 'transfer';
    fSource.querySelector('.field-label').textContent = t === 'income' ? 'Recebido em' : t === 'transfer' ? 'De' : 'Fonte';
    if (t === 'transfer') sourceHint.hidden = true;
    restricted.parentElement.hidden = t !== 'income';
    parcelChip.hidden = t !== 'expense';
    if (t !== 'expense') mode.parcel = false;
    fRepeat.hidden = t === 'transfer' || isRefund || (isEdit && !canRepeatExisting);
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
    const flexRepeat = mode.repeat && rmode === 'flex';
    tbdRow.hidden = !((!mode.repeat || flexRepeat) && !mode.parcel && type !== 'transfer' && (status.getValue() === 'planned' || tbd.checked || flexRepeat) && !(existing && existing.status === 'done'));
    if (tbdRow.hidden) tbd.checked = false;
    date.disabled = tbd.checked;
    tbdMonth.hidden = !tbd.checked;
    syncForecast();
    detailsBox.hidden = !mode.details;
    parcelChip.setAttribute('aria-pressed', String(mode.parcel));
    detailsChip.setAttribute('aria-pressed', String(mode.details));
    saveTplChip?.setAttribute('aria-pressed', String(mode.tpl));
    fAmount.querySelector('.field-label').textContent = mode.parcel ? 'Valor total' : isRefund ? 'Valor devolvido' : rmode === 'forecast' ? 'Valor previsto no mês' : rmode === 'flex' || rmode === 'days' ? 'Valor de cada ocorrência' : 'Valor';
    const acc = repo.get('accounts', source.getValue());
    if (mode.parcel && !parcelFirst.dataset.touched) parcelFirst.value = isCard(acc) && isISODate(date.value) ? billFor(date.value, acc).month : monthOf(date.value || today());
    billInfo.hidden = !(isCard(acc) && (type === 'expense' || type === 'refund') && !mode.parcel);
    updatePreview();
    updateFormSummary();
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
    dateTouched = true;
    hideSimilar();
    if (!statusTouched && isISODate(date.value)) status.setValue(date.value > today() ? 'planned' : 'done');
    syncSource(); syncTransfer(); syncExtras();
  });
  form.addEventListener('input', () => { dirty = true; updateFormSummary(); });

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
  const saveNewBtn = isEdit ? null : h('button', { class: 'btn', type: 'button', title: 'Shift+Enter', onclick: () => submit(true) }, 'Salvar e adicionar outro');
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
    // Cópia pedida explicitamente (Duplicar): o aviso de semelhança seria só um clique a mais.
    if (!isEdit && !similarAck && !opts.duplicate && !mode.parcel && data.type !== 'transfer' && data.date) {
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
        scope = await askScope({ title: 'Aplicar a alteração a…', allowMonth: rmode === 'days' || rmode === 'flex', fixedMonthly: rmode === 'fixed' && rule.frequency === 'monthly' && (rule.interval || 1) === 1 });
        if (!scope) return;
        saving = true;
        saveBtn.classList.add('is-busy');
      }
      const occKey = existing?.occurrenceKey || existing?.occurrenceDate || occ?.key || occ?.date;
      const period = existing?.period || occ?.period || (occKey ? String(occKey).slice(0, 7) : null);
      const seriesChanges = Object.fromEntries(changed.map((k) => [k, data[k] ?? null]));
      if (existing && mode.repeat && c.repeat && canRepeatExisting) {
        // Edição + repetição numa única transação: o lançamento vira a 1ª ocorrência.
        const r = c.repeat;
        const rule = await repo.convertToRecurring(existing.id, { frequency: r.frequency, interval: r.interval, endDate: r.endDate, count: r.count, mode: r.mode || 'fixed', days: r.days, perPeriod: r.perPeriod, anchorDay: r.anchorDay, estimated: r.estimated }, { ...data, rev: existing.rev });
        dirty = false;
        modal.close();
        toast(r.mode === 'forecast' ? `“${data.description}” agora consome uma previsão mensal de ${formatMoney(data.amount)}` : `“${data.description}” agora se repete: ${describeFrequency(rule).toLowerCase()}`, { tone: 'success', action: { label: 'Desfazer', fn: () => repo.undoConversion(rule.id, existing).catch(toastError) } });
        return;
      } else if (existing) {
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
        // A ocorrência deste mês é o próprio lançamento (pago, com outra data ou já com data definida).
        // Nunca cria uma segunda ocorrência; o "pago" não é copiado para os meses seguintes.
        let first = null;
        let firstKey = null;
        let startDate = r.startDate;
        const done = data.status === 'done';
        if (m === 'flex') first = data.date ? { ...data, period: undefined, month: undefined } : null;
        else if (m === 'days') {
          const d = Number(data.date.slice(8, 10));
          if (done || !r.days.includes(d)) { first = { ...data }; firstKey = repo.firstKeyFor({ mode: 'days', days: r.days, frequency: 'monthly' }, data.date); }
        } else if (m === 'fixed' && r.monthStart) {
          // Mensal de dia fixo: a ocorrência deste mês é este lançamento, mesmo em outro dia.
          if (done || data.date !== r.monthStart) { startDate = r.monthStart; first = { ...data }; firstKey = r.monthStart; }
          else startDate = r.monthStart;
        } else if (m === 'fixed') first = done && r.startDate === data.date ? { ...data } : null;
        if (first && !done) first.status = 'planned';
        const created = await repo.createRecurrence({
          id: draftId, type: data.type, description: data.description || categoryName(data.categoryId), amount: data.amount,
          startDate, endDate: r.endDate || null, count: r.count, anchorDay: r.anchorDay, mode: r.mode, days: r.days, perPeriod: r.perPeriod,
          frequency: r.frequency, interval: r.interval, categoryId: data.categoryId, blockId: data.blockId, sourceId: data.sourceId, method: data.method,
          restricted: data.restricted, estimated: r.estimated,
        }, first, firstKey);
        undo = () => repo.deleteRecurrence(created.id);
      } else {
        const saved = await repo.saveTransaction({ ...data, id: draftId });
        undo = () => repo.deleteTransaction(saved.id);
      }
      if (mode.tpl && !isEdit) await repo.saveTemplate({ ...data, repeat: mode.repeat ? rep.kind : 'none' }).catch(toastError);
      dirty = false;
      if (again) modal.closeInstant(); else modal.close();
      const repMsg = c.repeat ? (c.repeat.mode === 'forecast' ? 'Previsão mensal criada' : c.repeat.mode === 'flex' ? 'Compromisso mensal criado: defina as datas em Planejamento → Compromissos' : 'Lançamento recorrente criado') : null;
      toast(isEdit ? 'Alterações salvas' : mode.parcel ? `Parcelamento criado em ${c.count} parcelas` : mode.repeat ? repMsg : data.date ? 'Lançamento salvo' : `Compromisso previsto para ${formatMonth(data.period)} (data a definir)`, {
        tone: 'success', action: undo ? { label: 'Desfazer', fn: () => undo().catch(toastError) } : null,
      });
      if (again) {
        // Cadastro em sequência: mantém o contexto (bloco, categoria, fonte, data e situação),
        // limpa descrição e valor e volta o foco para a descrição. Repetição não é herdada.
        const t2 = data.type === 'refund' ? 'expense' : data.type;
        const keep = { type: t2, date: data.date || defaultDate(), status: data.status };
        const kept = [];
        if (t2 !== 'transfer' && data.blockId) { keep.blockId = data.blockId; kept.push(blockName(data.blockId)); }
        if (t2 !== 'transfer' && data.categoryId) { keep.categoryId = data.categoryId; kept.push(categoryName(data.categoryId)); }
        if (data.sourceId) { keep.sourceId = data.sourceId; kept.push(accountName(data.sourceId)); }
        if (data.date) kept.push(formatDate(data.date));
        openEntryForm({ instant: true, kept, defaults: keep });
      }
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
    title, body: form, size: 'md', className: 'entry-modal', instant: Boolean(opts.instant),
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
  if (!isEdit && block.getValue()) applyBlockSource();
  updateFormSummary();
  requestAnimationFrame(() => desc.input.focus());
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
