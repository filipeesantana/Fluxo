import { h, icon, put } from '../utils/dom.js';
import { formatMoney } from '../utils/money.js';
import { currentMonth, today, formatMonth, formatMonthShort, formatDate, addMonths, monthOf } from '../utils/dates.js';
import * as repo from '../database/repository.js';
import { projection, summarize, isBillSettled } from '../services/finance.js';
import { describeFrequency, nextOccurrence } from '../services/recurrence.js';
import { planProgress } from '../services/installments.js';
import { isCard } from '../services/cards.js';
import { progress } from '../components/charts.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { toast, toastError } from '../components/toast.js';
import { field, moneyInput, segmented } from '../components/fields.js';
import { openEntryForm } from '../components/entry-form.js';
import { openMenu } from '../components/menu.js';
import { ui, setMonth, readPref, writePref } from '../state.js';
import { pageHead, monthNav, categoryName, blockName, accountName, emptyState, categoryOptions, blockOptions, capitalize, txRow } from './common.js';
import { openRecurrenceForm, endSeries, openItem, itemMenu, toggleStatus } from './actions.js';
import { budgetRow } from './overview.js';
import { renderCalendar } from './calendar-view.js';
import { renderProjection, renderScenarios } from './projection-view.js';

const TABS = [
  ['calendario', 'Calendário', 'calendar'],
  ['projecao', 'Projeção', 'chart'],
  ['simulacoes', 'Simulações', 'branch'],
  ['recorrencias', 'Recorrências', 'repeat'],
  ['programadas', 'Programadas', 'clock'],
  ['parcelamentos', 'Parcelamentos', 'layers'],
  ['orcamentos', 'Orçamentos', 'target'],
];
const MONTH_TABS = ['calendario', 'orcamentos'];

export function renderPlanning(root, sub) {
  const legacy = { proximos: 'projecao' };
  const wanted = legacy[sub] || sub;
  const tab = TABS.some(([k]) => k === wanted) ? wanted : readPref('planning.tab', 'calendario');
  writePref('planning.tab', tab);
  const nav = h('nav', { class: 'subnav', 'aria-label': 'Seções do planejamento' },
    ...TABS.map(([k, l, ic]) => h('a', { href: `#/planejamento/${k}`, class: 'subnav-link', 'aria-current': k === tab ? 'page' : null }, icon(ic), l)));
  const planned = () => openEntryForm({ defaults: { status: 'planned', date: addMonthsDate(1) } });
  const actions = {
    calendario: h('button', { class: 'btn', type: 'button', onclick: planned }, icon('plus', 'icon-sm'), 'Compromisso futuro'),
    projecao: h('button', { class: 'btn', type: 'button', onclick: planned }, icon('plus', 'icon-sm'), 'Despesa programada'),
    simulacoes: null,
    recorrencias: h('button', { class: 'btn', type: 'button', onclick: () => openRecurrenceForm() }, icon('plus', 'icon-sm'), 'Nova recorrência'),
    programadas: h('button', { class: 'btn', type: 'button', onclick: planned }, icon('plus', 'icon-sm'), 'Despesa programada'),
    parcelamentos: h('button', { class: 'btn', type: 'button', onclick: () => { openEntryForm(); document.querySelector('[data-toggle="parcel"]')?.click(); } }, icon('plus', 'icon-sm'), 'Novo parcelamento'),
    orcamentos: h('button', { class: 'btn', type: 'button', onclick: () => openBudgetForm() }, icon('plus', 'icon-sm'), 'Novo orçamento'),
  }[tab];
  const subs = { calendario: 'Compromissos e movimentações por dia', projecao: 'Trajetória do orçamento nos próximos meses e anos', simulacoes: 'Teste decisões sem alterar seus registros', recorrencias: 'Contas e receitas que se repetem', programadas: 'Gastos pontuais futuros', parcelamentos: 'Compras parceladas e saldo restante', orcamentos: 'Limites mensais por categoria ou bloco' };
  const body = h('div', { class: 'stack-lg' });
  const rerender = () => renderPlanning(root, tab);
  put(root, pageHead('Planejamento', { sub: subs[tab], controls: MONTH_TABS.includes(tab) ? monthNav() : null, actions }), nav, body);
  if (tab === 'calendario') renderCalendar(body);
  else if (tab === 'projecao') renderProjection(body, rerender);
  else if (tab === 'simulacoes') renderScenarios(body, rerender);
  else put(body, { recorrencias: recurrences, programadas: scheduled, parcelamentos: plans, orcamentos: budgets }[tab]());
}

function addMonthsDate(n) {
  const t = today();
  return `${addMonths(monthOf(t), n)}-${t.slice(8)}`.replace(/-(29|30|31)$/, '-28');
}

function recurrences() {
  const rules = repo.list('recurrences').filter((r) => !r.archived);
  const t = today();
  const active = rules.filter((r) => !r.endDate || r.endDate >= t);
  const ended = rules.filter((r) => r.endDate && r.endDate < t);
  const section = (title, list, type) => {
    const items = list.filter((r) => r.type === type).sort((a, b) => b.amount - a.amount);
    const monthly = items.reduce((s, r) => s + (r.frequency === 'monthly' ? r.amount / (r.interval || 1) : r.frequency === 'weekly' ? (r.amount * 52) / 12 / (r.interval || 1) : r.amount / 12 / (r.interval || 1)), 0);
    return h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, title), items.length ? h('span', { class: 'hint num' }, `≈ ${formatMoney(Math.round(monthly))} por mês`) : null),
      items.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, 'Descrição'), h('th', null, 'Frequência'), h('th', null, 'Próxima'), h('th', null, 'Classificação'), h('th', { class: 'right' }, 'Valor'), h('th', null, ''))),
        h('tbody', null, ...items.map((r) => {
          const next = nextOccurrence(r, t);
          const more = h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': 'Ações' }, icon('more'));
          more.addEventListener('click', (ev) => { ev.stopPropagation(); openMenu(more, [
            { label: 'Editar regra inteira', icon: 'edit', onSelect: () => openRecurrenceForm({ rule: r }) },
            next ? { label: `Alterar a partir de ${formatDate(next)}`, icon: 'repeat', onSelect: () => openRecurrenceForm({ rule: r, fromDate: next }) } : null,
            'sep',
            next ? { label: 'Encerrar a partir da próxima', icon: 'x', onSelect: () => endSeries(r, next) } : null,
            { label: 'Excluir regra', icon: 'trash', danger: true, onSelect: () => removeRule(r) },
          ]); });
          return h('tr', { class: 'is-link', onclick: () => openRecurrenceForm({ rule: r }) },
            h('td', null, r.description),
            h('td', { class: 'faint' }, describeFrequency(r), r.endDate ? ` · até ${formatDate(r.endDate)}` : ''),
            h('td', { class: 'num' }, next ? formatDate(next) : '—'),
            h('td', { class: 'faint truncate' }, [r.categoryId && categoryName(r.categoryId), r.blockId && blockName(r.blockId), r.sourceId && accountName(r.sourceId)].filter(Boolean).join(' · ') || '—'),
            h('td', { class: `right num ${type === 'income' ? 'pos' : ''}` }, formatMoney(r.amount)),
            h('td', { class: 'right' }, more));
        })))) : h('p', { class: 'empty-line' }, type === 'income' ? 'Nenhuma receita recorrente. Cadastre salário, benefícios ou rendas fixas.' : 'Nenhuma conta recorrente. Ex.: internet, plano de saúde, plano móvel.'));
  };
  const out = [section('Despesas recorrentes', active, 'expense'), section('Receitas recorrentes', active, 'income')];
  if (ended.length) out.push(h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Encerradas')),
    h('div', { class: 'kvs' }, ...ended.map((r) => h('div', { class: 'kv' }, h('span', { class: 'kv-label' }, r.description, h('span', { class: 'faint' }, ` até ${formatDate(r.endDate)}`)), h('span', { class: 'kv-value num faint' }, formatMoney(r.amount)))))));
  return h('div', { class: 'stack-lg' }, ...out);
}

async function removeRule(r) {
  const ok = await confirmDialog({ title: 'Excluir recorrência?', message: `A regra “${r.description}” será removida. Ocorrências já pagas permanecem no histórico; as previstas deixam de existir.`, confirmLabel: 'Excluir', danger: true });
  if (!ok) return;
  try { await repo.deleteRecurrence(r.id); toast('Recorrência excluída'); } catch (err) { toastError(err); }
}

function scheduled() {
  const t = today();
  const items = repo.list('transactions').filter((x) => x.status === 'planned' && !x.recurrenceId && !x.planId && x.month >= monthOf(t) && x.type !== 'transfer')
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : a.date < b.date ? -1 : 1));
  if (!items.length) return h('section', { class: 'panel' }, emptyState('Nenhum gasto programado', 'Registre compras planejadas, viagens, manutenções ou cursos para ver o impacto nos meses correspondentes.'));
  const ctx = repo.context();
  const byMonth = new Map();
  for (const it of items) { if (!byMonth.has(it.month)) byMonth.set(it.month, []); byMonth.get(it.month).push(it); }
  return h('div', null, ...[...byMonth.entries()].map(([m, rows]) => {
    const s = summarize(ctx, m);
    return h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, capitalize(formatMonth(m))),
        h('span', { class: 'hint num' }, `programado ${formatMoney(rows.reduce((a, b) => a + (b.type === 'income' ? 0 : b.amount), 0))} · sobra projetada `, h('span', { class: s.projectedSurplus < 0 ? 'neg' : '' }, formatMoney(s.projectedSurplus)))),
      h('div', { class: 'tx-list', role: 'list' }, ...rows.map((it) => txRow(it, { onOpen: openItem, onMenu: itemMenu, onToggle: toggleStatus, showDate: true }))));
  }));
}

function plans() {
  const list = repo.list('installmentPlans').sort((a, b) => (a.purchaseDate < b.purchaseDate ? 1 : -1));
  if (!list.length) return h('section', { class: 'panel' }, emptyState('Nenhum parcelamento', 'Use “Parcelar” no formulário de lançamento: as parcelas são geradas automaticamente com centavos distribuídos corretamente.'));
  const ctx = repo.context();
  const all = repo.list('transactions');
  return h('section', { class: 'panel' }, h('div', { class: 'plans' }, ...list.map((p) => {
    const parcels = all.filter((t) => t.planId === p.id).sort((a, b) => a.installment.index - b.installment.index);
    const acc = repo.get('accounts', p.sourceId);
    const settled = (t) => (isCard(acc) ? isBillSettled(ctx, acc.id, t.month) : t.status === 'done');
    const pr = planProgress(parcels, settled);
    const next = parcels.find((t) => !settled(t));
    const more = h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': 'Ações' }, icon('more'));
    more.addEventListener('click', () => openMenu(more, [
      { label: 'Editar descrição e classificação', icon: 'edit', onSelect: () => openPlanForm(p) },
      !p.cancelledAt ? { label: 'Cancelar parcelas restantes', icon: 'x', onSelect: () => cancel(p, settled) } : null,
      'sep',
      { label: 'Excluir parcelamento inteiro', icon: 'trash', danger: true, onSelect: () => removePlan(p) },
    ]));
    const details = h('details', { class: 'plan-details' }, h('summary', { class: 'link-btn small' }, `Ver ${parcels.length} parcelas`),
      h('div', { class: 'tx-list', role: 'list' }, ...parcels.map((t) => txRow(t, { onOpen: openItem, onMenu: itemMenu, onToggle: isCard(acc) ? null : toggleStatus, showDate: false }))));
    return h('article', { class: 'plan' },
      h('div', { class: 'plan-top' },
        h('div', { class: 'grow' }, h('div', { class: 'plan-title truncate' }, p.description, p.cancelledAt ? h('span', { class: 'pill pill-overdue' }, 'cancelado') : null),
          h('div', { class: 'faint small truncate' }, [formatDate(p.purchaseDate), accountName(p.sourceId), p.categoryId && categoryName(p.categoryId), p.blockId && blockName(p.blockId)].filter(Boolean).join(' · '))),
        h('div', { class: 'right' }, h('div', { class: 'num' }, formatMoney(p.total)), h('div', { class: 'faint small' }, `${p.count}× · desde ${formatMonthShort(p.firstMonth)}`)),
        more),
      progress(pr.total ? pr.paid / pr.total : 0, { tone: 'ok' }),
      h('div', { class: 'plan-stats small' },
        h('span', null, `${pr.paidCount} de ${pr.count} pagas`),
        h('span', { class: 'num' }, `Pago ${formatMoney(pr.paid)}`),
        h('span', { class: 'num' }, `Restante ${formatMoney(pr.pending)}`),
        next ? h('span', { class: 'faint' }, `Próxima: ${formatMonthShort(next.month)} · ${formatMoney(next.amount)}`) : h('span', { class: 'pos' }, 'Quitado')),
      details);
  })));
}

function openPlanForm(p) {
  const desc = h('input', { class: 'input', value: p.description, maxlength: 200 });
  const cat = h('select', { class: 'select' }, h('option', { value: '' }, 'Sem categoria'), ...categoryOptions('expense', p.categoryId).map((o) => h('option', { value: o.value }, o.label)));
  cat.value = p.categoryId || '';
  const blk = h('select', { class: 'select' }, h('option', { value: '' }, 'Sem bloco'), ...blockOptions(p.blockId).map((o) => h('option', { value: o.value }, o.label)));
  blk.value = p.blockId || '';
  const save = h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
    try { await repo.updatePlan(p.id, { description: desc.value, categoryId: cat.value || null, blockId: blk.value || null }); m.close(); toast('Parcelamento atualizado'); } catch (err) { toastError(err); }
  } }, 'Salvar');
  const m = openModal({ title: 'Editar parcelamento', size: 'sm', body: h('div', { class: 'stack' }, field('Descrição', desc), field('Categoria', cat), field('Bloco', blk), h('p', { class: 'faint small' }, 'Valores e datas das parcelas não são alterados. Para mudar uma parcela específica, edite-a individualmente.')), footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), save] });
}

async function cancel(p, settled) {
  const ok = await confirmDialog({ title: 'Cancelar parcelas restantes?', message: 'Parcelas futuras ainda não pagas serão removidas. Parcelas pagas e meses anteriores permanecem no histórico.', confirmLabel: 'Cancelar parcelas', danger: true });
  if (!ok) return;
  try { const n = await repo.cancelPlan(p.id, settled); toast(`${n} parcela(s) cancelada(s)`); } catch (err) { toastError(err); }
}

async function removePlan(p) {
  const ok = await confirmDialog({ title: 'Excluir parcelamento inteiro?', message: `Todas as ${p.count} parcelas de “${p.description}” serão excluídas, inclusive as já pagas. Para manter o histórico, prefira cancelar as restantes.`, confirmLabel: 'Excluir tudo', danger: true });
  if (!ok) return;
  try { await repo.deletePlan(p.id); toast('Parcelamento excluído'); } catch (err) { toastError(err); }
}

function budgets() {
  const s = summarize(repo.context(), ui.month);
  if (!s.budgets.length) return h('section', { class: 'panel' }, emptyState('Nenhum orçamento definido', 'Orçamentos são opcionais: defina limites mensais por categoria ou bloco e acompanhe o que resta.', h('button', { class: 'btn', type: 'button', onclick: () => openBudgetForm() }, 'Definir orçamento')));
  const rows = [...s.budgets].sort((a, b) => b.ratio - a.ratio);
  const total = rows.reduce((t, b) => t + b.amount, 0), used = rows.reduce((t, b) => t + b.used, 0);
  return h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', null, capitalize(formatMonth(ui.month))), h('span', { class: 'hint num' }, `${formatMoney(used)} de ${formatMoney(total)} orçados`)),
    h('div', { class: 'budgets budgets-wide' }, ...rows.map((b) => {
      const row = budgetRow(b);
      const more = h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': 'Ações' }, icon('more'));
      more.addEventListener('click', () => openMenu(more, [
        { label: 'Editar limite', icon: 'edit', onSelect: () => openBudgetForm(b) },
        { label: 'Remover orçamento', icon: 'trash', danger: true, onSelect: async () => { try { await repo.deleteBudget(b.id); toast('Orçamento removido'); } catch (e) { toastError(e); } } },
      ]));
      row.querySelector('.budget-top').append(more);
      return row;
    })),
    h('p', { class: 'faint small note' }, 'O valor usado inclui despesas realizadas e previstas do mês. Os limites valem para todos os meses.'));
}

function openBudgetForm(b = null) {
  let scope = b?.scope || 'category';
  const ref = h('select', { class: 'select' });
  const fill = () => {
    const opts = scope === 'block' ? blockOptions(b?.refId) : categoryOptions('expense', b?.refId);
    put(ref, ...opts.map((o) => h('option', { value: o.value }, o.label)));
    if (b?.refId) ref.value = b.refId;
  };
  const sc = segmented({ label: 'Escopo', value: scope, options: [{ value: 'category', label: 'Categoria' }, { value: 'block', label: 'Bloco' }], onChange: (v) => { scope = v; fill(); fRef.querySelector('.field-label').textContent = v === 'block' ? 'Bloco' : 'Categoria'; } });
  const amount = moneyInput({ value: b?.amount ?? null });
  const fAmount = field('Limite mensal', amount);
  const fRef = field(scope === 'block' ? 'Bloco' : 'Categoria', ref);
  fill();
  const save = h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
    const cents = amount.getValue();
    fAmount.setError(cents ? '' : 'Informe um limite');
    if (!cents || !ref.value) { if (!ref.value) toast(scope === 'block' ? 'Crie um bloco primeiro' : 'Escolha uma categoria', { tone: 'error' }); return; }
    try { await repo.saveBudget({ id: b?.id, scope, refId: ref.value, amount: cents }); m.close(); toast('Orçamento salvo', { tone: 'success' }); } catch (err) { toastError(err); }
  } }, 'Salvar');
  const m = openModal({ title: b ? 'Editar orçamento' : 'Novo orçamento', size: 'sm', body: h('div', { class: 'stack' }, b ? null : sc, fRef, fAmount), footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), save] });
}
