import { h, icon, tweenNumber, put } from '../utils/dom.js';
import { formatMoney } from '../utils/money.js';
import { currentMonth, today, parseISO, formatDateShort, monthDiff, formatMonthShort, dateInMonth } from '../utils/dates.js';
import * as repo from '../database/repository.js';
import { summarize, cashPosition, NONE } from '../services/finance.js';
import { barList, dailyChart, progress } from '../components/charts.js';
import { openEntryForm } from '../components/entry-form.js';
import { ui, setEntriesFilter, resetEntriesFilter } from '../state.js';
import { monthNav, pageHead, txRow, categoryName, blockName, accountName, emptyState, kv } from './common.js';
import { openItem, itemMenu, toggleStatus } from './actions.js';

const lastKpi = new Map();

function kpi(id, label, value, sub, { tone = '', title } = {}) {
  const v = h('span', { class: `kpi-value num ${tone}` });
  const from = lastKpi.get(id);
  lastKpi.set(id, value);
  tweenNumber(from ?? value, value, (x) => { v.textContent = formatMoney(x); });
  return h('div', { class: 'kpi', title }, h('span', { class: 'kpi-label' }, label), v, h('span', { class: 'kpi-sub' }, sub || ' '));
}

function openGroup(field, key) {
  resetEntriesFilter();
  setEntriesFilter({ [field]: key === NONE ? NONE : key, scope: 'month', type: 'expenses' }, { navigate: true });
}

export function renderOverview(root) {
  const ctx = repo.context();
  const m = ui.month;
  const s = summarize(ctx, m);
  const cm = currentMonth();
  const isCurrent = m === cm;
  const isFuture = monthDiff(cm, m) > 0;
  const cash = cashPosition(ctx);
  const firstUse = repo.isEmpty() && repo.list('transactions').length === 0;

  const head = pageHead('Visão geral', monthNav(), h('span', { class: 'spacer' }),
    h('button', { class: 'btn btn-primary btn-new-entry', type: 'button', onclick: () => openEntryForm(), title: 'Novo lançamento (N)' }, icon('plus'), 'Novo lançamento'));

  const pendingSub = [
    s.cardBills.some((b) => b.open > 0) ? `${formatMoney(s.cardBills.reduce((t, b) => t + b.open, 0))} em faturas` : null,
    s.overdue > 0 ? `${formatMoney(s.overdue)} atrasados` : null,
  ].filter(Boolean).join(' · ');
  const kpis = h('div', { class: `kpis${isFuture ? ' is-projection' : ''}`, role: 'group', 'aria-label': 'Indicadores do mês' },
    kpi('inRec', 'Receitas recebidas', s.incomeReceived, s.restrictedIncome ? `${formatMoney(s.restrictedIncome)} em benefícios` : 'dinheiro que já entrou', { tone: s.incomeReceived ? 'pos' : '' }),
    kpi('inExp', 'Receitas previstas', s.incomeExpected, `total do mês ${formatMoney(s.incomeTotal)}`),
    kpi('exDone', 'Despesas realizadas', s.expenseDone, 'pagas, incluindo faturas quitadas'),
    kpi('exPend', 'Compromissos pendentes', s.expensePending, pendingSub || 'previstos e faturas em aberto', { tone: s.overdue > 0 ? 'warn' : '' }),
    kpi('surplus', 'Sobra projetada', s.projectedSurplus, `receitas − despesas do mês`, { tone: s.projectedSurplus < 0 ? 'neg' : '' }),
    kpi('invest', 'Disponível para investir', s.availableToInvest, s.contributed ? `${formatMoney(s.contributed)} já aportados` : s.safetyMargin ? `após margem de ${formatMoney(s.safetyMargin)}` : 'sobra livre, sem benefícios', { title: 'Sobra projetada sem benefícios de uso restrito, menos margem de segurança e aportes já feitos no mês. Nada é investido automaticamente.' }),
  );

  if (firstUse) {
    put(root, head, kpis, h('section', { class: 'section' },
      emptyState('Comece registrando um lançamento', 'Categorias padrão já estão prontas. Contas, cartões e blocos podem ser criados dentro do próprio formulário.',
        h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openEntryForm() }, icon('plus'), 'Novo lançamento'),
          h('a', { class: 'btn', href: '#/configuracoes' }, 'Importar backup')))));
    return;
  }

  const dist = h('div', { class: 'cols-3' },
    h('section', { class: 'col-section' }, h('div', { class: 'section-head' }, h('h2', null, 'Por bloco'), h('span', { class: 'hint' }, 'contexto')),
      barList(s.byBlock, { id: 'block', labelOf: blockName, onSelect: (k) => openGroup('blockId', k) })),
    h('section', { class: 'col-section' }, h('div', { class: 'section-head' }, h('h2', null, 'Por categoria'), h('span', { class: 'hint' }, 'natureza')),
      barList(s.byCategory, { id: 'cat', labelOf: categoryName, onSelect: (k) => openGroup('categoryId', k) })),
    h('section', { class: 'col-section' }, h('div', { class: 'section-head' }, h('h2', null, 'Por fonte'), h('span', { class: 'hint' }, 'conta ou cartão')),
      barList(s.bySource, { id: 'src', labelOf: accountName, onSelect: (k) => openGroup('sourceId', k) })),
  );

  const todayDay = isCurrent ? parseISO(today()).d : null;
  const evolution = h('section', { class: 'col-section' },
    h('div', { class: 'section-head' }, h('h2', null, 'Evolução do mês'), h('span', { class: 'hint num' }, `${formatMoney(s.expenseTotal)} em despesas`)),
    dailyChart(s.days, { todayDay, onSelectDay: (d) => document.getElementById(`day-${dateInMonth(m, d)}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }));

  // Lista cronológica do mês
  const items = [...s.items].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0)));
  const list = h('div', { class: 'tx-list', role: 'list' });
  let lastDate = null;
  const LIMIT = 80;
  for (const it of items.slice(0, LIMIT)) {
    if (it.date !== lastDate) {
      lastDate = it.date;
      list.append(h('div', { class: 'tx-day', id: `day-${it.date}` }, h('span', null, formatDateShort(it.date))));
    }
    list.append(txRow(it, { onOpen: openItem, onMenu: itemMenu, onToggle: toggleStatus }));
  }
  const movements = h('section', { class: 'col-section' },
    h('div', { class: 'section-head' }, h('h2', null, 'Movimentações'), h('span', { class: 'hint' }, `${items.length} no mês`),
      h('div', { class: 'actions' }, h('a', { class: 'btn btn-sm', href: '#/lancamentos', onclick: () => { resetEntriesFilter(); ui.entries.scope = 'month'; } }, 'Ver todas'))),
    items.length ? list : emptyState('Nenhuma movimentação neste mês', isFuture ? 'Registre despesas programadas para ver o impacto deste mês.' : null),
    items.length > LIMIT ? h('a', { class: 'link-btn small', href: '#/lancamentos' }, `Ver os outros ${items.length - LIMIT} em Lançamentos`) : null);

  // Coluna lateral: sobra detalhada, contas, faturas, orçamentos
  const side = h('div', { class: 'side' });
  side.append(h('section', { class: 'col-section' },
    h('div', { class: 'section-head' }, h('h2', null, 'Sobra em detalhe')),
    h('div', { class: 'kvs' },
      kv('Sobra orçamentária do mês', formatMoney(s.projectedSurplus), { cls: s.projectedSurplus < 0 ? 'neg' : '' }),
      kv('Sobra até agora', formatMoney(s.currentSurplus), { hint: 'recebido − pago' }),
      isCurrent ? kv('Saldo em contas hoje', formatMoney(cash.free), { hint: 'caixa real' }) : null,
      isCurrent ? kv('Caixa após compromissos', formatMoney(cash.free + s.incomeExpected - s.expensePending), { hint: 'estimado ao fim do mês' }) : null,
      s.restrictedIncome || s.restrictedExpense ? kv('Benefícios restritos livres', formatMoney(s.restrictedLeft), { hint: 'não entram em aportes' }) : null,
      s.safetyMargin ? kv('Margem de segurança', `− ${formatMoney(s.safetyMargin)}`) : null,
      kv('Aportes realizados no mês', formatMoney(s.contributed)),
      kv('Disponível para aportes', formatMoney(s.availableToInvest), { cls: 'kv-strong' }),
      s.goalsPlanned ? kv('Planejado para metas', formatMoney(s.goalsPlanned), { hint: s.availableToInvest >= s.goalsPlanned ? 'coberto' : 'acima do disponível', cls: s.availableToInvest >= s.goalsPlanned ? '' : 'warn' }) : null,
    )));

  const accounts = repo.list('accounts').filter((a) => !a.archived && a.kind !== 'credit');
  if (accounts.length && isCurrent) {
    side.append(h('section', { class: 'col-section' },
      h('div', { class: 'section-head' }, h('h2', null, 'Saldos'), h('span', { class: 'hint' }, 'somente realizados')),
      h('div', { class: 'kvs' }, ...accounts.map((a) => kv(a.name, formatMoney(cash.balances.get(a.id) || 0), { cls: (cash.balances.get(a.id) || 0) < 0 ? 'neg' : '' })))));
  }
  if (s.cardBills.length) {
    const label = { paid: 'paga', open: 'aberta', partial: 'parcial', overdue: 'vencida' };
    side.append(h('section', { class: 'col-section' },
      h('div', { class: 'section-head' }, h('h2', null, `Faturas de ${formatMonthShort(m)}`)),
      h('div', { class: 'kvs' }, ...s.cardBills.map((b) => {
        const card = repo.get('accounts', b.cardId);
        const row = h('div', { class: 'kv' },
          h('span', { class: 'kv-label' }, card?.name || 'Cartão', h('span', { class: `faint` }, b.dueDate ? ` vence ${formatDateShort(b.dueDate)}` : ' sem vencimento configurado')),
          h('span', { class: 'kv-value num' }, formatMoney(b.total), h('span', { class: `pill pill-${b.status}` }, label[b.status])));
        if (b.open > 0 && card) row.append(h('button', { class: 'link-btn small kv-action', type: 'button', onclick: () => openEntryForm({ defaults: { type: 'transfer', toAccountId: card.id, billMonth: m, amount: b.open, date: today(), status: 'done', sourceId: card.payAccountId || null } }) }, 'Pagar fatura'));
        return row;
      }))));
  }
  if (s.budgets.length) {
    side.append(h('section', { class: 'col-section' },
      h('div', { class: 'section-head' }, h('h2', null, 'Orçamentos'), h('div', { class: 'actions' }, h('a', { class: 'link-btn small', href: '#/planejamento/orcamentos' }, 'Gerenciar'))),
      h('div', { class: 'budgets' }, ...s.budgets.sort((a, b) => b.ratio - a.ratio).slice(0, 6).map((b) => budgetRow(b)))));
  }

  put(root, head, kpis, dist, h('div', { class: 'cols-main' }, h('div', { class: 'main-col' }, evolution, movements), side));
}

export function budgetRow(b) {
  const name = b.scope === 'block' ? blockName(b.refId) : categoryName(b.refId);
  const over = b.remaining < 0;
  return h('div', { class: 'budget' },
    h('div', { class: 'budget-top' }, h('span', { class: 'truncate' }, name),
      h('span', { class: `num small ${over ? 'neg' : b.ratio > 0.85 ? 'warn' : 'faint'}` }, over ? `${formatMoney(-b.remaining)} acima` : `restam ${formatMoney(b.remaining)}`)),
    progress(b.ratio),
    h('div', { class: 'budget-bottom faint xsmall num' }, `${formatMoney(b.used)} de ${formatMoney(b.amount)}`));
}
