import { h, icon, put, prefersReducedMotion } from '../utils/dom.js';
import { formatMoney } from '../utils/money.js';
import { formatMonth, formatDateShort } from '../utils/dates.js';
import * as repo from '../database/repository.js';
import { summarize, expenseValue } from '../services/finance.js';
import { isCard } from '../services/cards.js';
import { openModal } from '../components/modal.js';
import { readPref, writePref } from '../state.js';
import { txRow, capitalize, accountName } from './common.js';
import { openItem, toggleStatus } from './actions.js';

/*
 * Detalhamento dos indicadores. TODOS os números vêm de summarize() — a mesma
 * função que alimenta os cartões, gráficos e o calendário. Cada painel mostra
 * a conta que leva ao valor exibido e confere que a soma bate.
 */

function line(label, value, { sign = '', strong = false, hint, onOpen, cls = '' } = {}) {
  const content = [h('span', { class: 'kv-label' }, label, hint ? h('span', { class: 'faint' }, ` · ${hint}`) : null), h('span', { class: 'kv-value num' }, `${sign}${formatMoney(value)}`, onOpen ? icon('chev-right', 'icon-sm faint') : null)];
  return onOpen ? h('button', { class: `kv kv-link ${strong ? 'kv-strong' : ''} ${cls}`, type: 'button', onclick: onOpen }, ...content) : h('div', { class: `kv ${strong ? 'kv-strong' : ''} ${cls}` }, ...content);
}

function check(ok) {
  return h('p', { class: `note ${ok ? '' : 'is-warn'}` }, icon(ok ? 'check' : 'alert', 'icon-sm'), ok ? 'A soma dos componentes confere com o valor do indicador.' : 'A soma não confere — verifique Configurações → Integridade.');
}

/** Gaveta com navegação em pilha (Voltar sem perder o estado anterior). */
function drillDrawer(title) {
  const body = h('div', { class: 'drill' });
  const back = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', hidden: true, onclick: () => pop() }, icon('chev-left', 'icon-sm'), 'Voltar');
  const stack = [];
  const m = openModal({ title, body: h('div', { class: 'stack' }, back, body), drawer: true, footer: [h('span', { class: 'grow' }), h('button', { class: 'btn btn-primary', type: 'button', onclick: () => m.close() }, 'Fechar')] });
  const show = (view, dir) => {
    put(body, view.content);
    m.setTitle(view.title);
    back.hidden = stack.length <= 1;
    if (!prefersReducedMotion()) body.animate([{ opacity: 0, transform: `translateX(${dir * 16}px)` }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
  };
  const push = (t, content) => { stack.push({ title: t, content }); show(stack[stack.length - 1], 1); };
  const pop = () => { if (stack.length > 1) { stack.pop(); show(stack[stack.length - 1], -1); } };
  return { push, modal: m };
}

function itemsList(items, empty = 'Nada neste período.') {
  if (!items.length) return h('div', { class: 'empty-block' }, empty);
  return h('div', { class: 'tx-list', role: 'list' }, ...items.sort((a, b) => (a.date < b.date ? 1 : -1)).map((it) => txRow(it, { onOpen: openItem, onToggle: toggleStatus, showDate: true })));
}

function billRows(bills, which) {
  return bills.filter((b) => (which === 'paid' ? b.paid > 0 : b.open > 0)).map((b) => line(`Fatura ${accountName(b.cardId)}`, which === 'paid' ? Math.min(b.paid, Math.max(0, b.total)) : b.open, { hint: b.dueDate ? `vence ${formatDateShort(b.dueDate)}` : 'cartão' }));
}

export function parts(s, ctx) {
  const card = (it) => isCard(ctx.accounts.get(it.sourceId));
  return {
    incomeReceived: s.items.filter((it) => it.type === 'income' && it.status === 'done'),
    incomeExpected: s.items.filter((it) => it.type === 'income' && it.status !== 'done'),
    expenseDone: s.items.filter((it) => (it.type === 'expense' || it.type === 'refund') && it.status === 'done' && !card(it)),
    expensePending: s.items.filter((it) => (it.type === 'expense' || it.type === 'refund') && it.status !== 'done' && !card(it)),
    cardItems: s.items.filter((it) => (it.type === 'expense' || it.type === 'refund') && card(it)),
  };
}

export function openKpiDetail(kind, month) {
  const ctx = repo.context();
  const s = summarize(ctx, month);
  const p = parts(s, ctx);
  const label = capitalize(formatMonth(month));
  const sumIncome = (list) => list.reduce((t, x) => t + x.amount, 0);
  const sumExp = (list) => list.reduce((t, x) => t + expenseValue(x), 0);
  const d = drillDrawer('');
  const listView = (title, items, extra = []) => () => d.push(title, h('div', { class: 'stack-lg' }, ...extra, itemsList(items)));
  const bills = s.cardBills;
  const billsPaid = bills.reduce((t, b) => t + (b.total > 0 ? Math.min(b.paid, b.total) : b.total), 0);
  const billsOpen = bills.reduce((t, b) => t + b.open, 0);

  const views = {
    surplus: () => {
      const total = s.incomeReceived + s.incomeExpected - s.expenseDone - s.expensePending;
      d.push(`Sobra projetada · ${label}`, h('div', { class: 'stack-lg' },
        h('div', { class: 'kvs' },
          line('Receitas recebidas', s.incomeReceived, { sign: '+ ', onOpen: listView('Receitas recebidas', p.incomeReceived) }),
          line('Receitas previstas', s.incomeExpected, { sign: '+ ', onOpen: listView('Receitas previstas', p.incomeExpected) }),
          line('Despesas realizadas', s.expenseDone, { sign: '− ', onOpen: () => views.expenseDone(true) }),
          line('Compromissos pendentes', s.expensePending, { sign: '− ', onOpen: () => views.expensePending(true) }),
          line('Sobra projetada', s.projectedSurplus, { strong: true, cls: s.projectedSurplus < 0 ? 'neg' : '' })),
        check(total === s.projectedSurplus),
        h('h3', { class: 'small faint' }, 'Despesas do mês por tipo'),
        h('div', { class: 'kvs' },
          line('Contas fixas (recorrentes)', s.expFixed, { onOpen: listView('Contas fixas', s.items.filter((it) => it.recurrenceId && it.type !== 'income' && it.type !== 'transfer')) }),
          line('Parcelas', s.expInstallments, { onOpen: listView('Parcelas', s.items.filter((it) => it.planId)) }),
          line('Gastos pontuais', s.expOneOff, { onOpen: listView('Gastos pontuais', s.items.filter((it) => !it.planId && !it.recurrenceId && (it.type === 'expense' || it.type === 'refund'))) }),
          line('Total de despesas', s.expenseTotal, { strong: true })),
        check(s.expFixed + s.expInstallments + s.expOneOff === s.expenseTotal),
        h('p', { class: 'faint small' }, 'Transferências entre contas, pagamentos de fatura e aportes não entram como despesa: só movem dinheiro.')));
    },
    invest: () => {
      const overflow = Math.max(0, s.restrictedExpense - s.restrictedIncome);
      const free = s.projectedSurplus - s.restrictedIncome + s.restrictedExpense - overflow;
      const goTo = (hash) => { d.modal.close(); location.hash = hash; };
      d.push(`Disponível para investir · ${label}`, h('div', { class: 'stack-lg' },
        h('div', { class: 'kvs' },
          line('Sobra projetada', s.projectedSurplus, { onOpen: views.surplus }),
          s.restrictedIncome ? line('Receitas de uso restrito (VA/VR)', s.restrictedIncome, { sign: '− ', hint: 'não viram dinheiro livre' }) : null,
          s.restrictedExpense ? line('Despesas pagas com benefícios', s.restrictedExpense, { sign: '+ ', hint: 'já cobertas pelo benefício' }) : null,
          overflow ? line('Benefício excedido, pago com dinheiro livre', overflow, { sign: '− ' }) : null,
          line('Sobra livre', s.freeSurplus, { strong: true }),
          s.safetyMargin ? line('Margem de segurança', s.safetyMargin, { sign: '− ', hint: 'Configurações' }) : null,
          line('Potencial para aportes', s.investable, { hint: s.freeSurplus - s.safetyMargin < 0 ? 'nunca negativo' : null }),
          line('Aportes já realizados no mês', s.contributed, { sign: '− ' }),
          line('Disponível para investir', s.availableToInvest, { strong: true, cls: 'invest' }),
          s.goalsPlanned ? line('Planejado para metas', s.goalsPlanned, { hint: s.availableToInvest >= s.goalsPlanned ? 'coberto pelo disponível' : 'acima do disponível', cls: s.availableToInvest >= s.goalsPlanned ? '' : 'warn' }) : null),
        check(free === s.freeSurplus && Math.max(0, Math.max(0, s.freeSurplus - s.safetyMargin) - s.contributed) === s.availableToInvest),
        h('p', { class: 'faint small' }, 'Nada é investido automaticamente. As ações abaixo abrem simulações e planos; nenhum lançamento é criado.'),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => { let prev = {}; try { prev = JSON.parse(readPref('sim2', '{}')) || {}; } catch { /* preferência inválida */ } writePref('sim2', JSON.stringify({ ...prev, monthly: s.availableToInvest, useSurplus: false })); goTo('#/investimentos'); } }, icon('trend', 'icon-sm'), 'Simular aporte'),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => { d.modal.close(); const m = await import('./investments.js'); m.openGoalForm(null, { monthly: s.availableToInvest }); } }, icon('target', 'icon-sm'), 'Criar meta'),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => goTo('#/investimentos') }, icon('wallet', 'icon-sm'), 'Planejar investimento'),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => goTo('#/planejamento/projecao') }, icon('chart', 'icon-sm'), 'Ver projeção'))));
    },
    incomeReceived: () => d.push(`Receitas recebidas · ${label}`, h('div', { class: 'stack-lg' }, h('div', { class: 'kvs' }, line('Total recebido', s.incomeReceived, { strong: true }), s.restrictedIncome ? line('Inclui benefícios de uso restrito', s.restrictedIncome) : null), check(sumIncome(p.incomeReceived) === s.incomeReceived), itemsList(p.incomeReceived))),
    incomeExpected: () => d.push(`Receitas previstas · ${label}`, h('div', { class: 'stack-lg' }, h('div', { class: 'kvs' }, line('Total a receber', s.incomeExpected, { strong: true })), check(sumIncome(p.incomeExpected) === s.incomeExpected), h('p', { class: 'faint small' }, 'Receitas previstas não contam como dinheiro já recebido.'), itemsList(p.incomeExpected))),
    expenseDone: () => d.push(`Despesas realizadas · ${label}`, h('div', { class: 'stack-lg' },
      h('div', { class: 'kvs' }, line('Pagas em conta ou dinheiro', sumExp(p.expenseDone)), ...billRows(bills, 'paid'), line('Despesas realizadas', s.expenseDone, { strong: true })),
      check(sumExp(p.expenseDone) + billsPaid === s.expenseDone),
      bills.length ? h('p', { class: 'faint small' }, 'Compras no cartão só contam como pagas quando a fatura é paga (pagar a fatura não gera uma segunda despesa).') : null,
      itemsList(p.expenseDone))),
    expensePending: () => d.push(`Compromissos pendentes · ${label}`, h('div', { class: 'stack-lg' },
      h('div', { class: 'kvs' }, line('Despesas previstas', sumExp(p.expensePending)), ...billRows(bills, 'open'), s.overdue ? line('Dos quais atrasados', s.overdue, { cls: 'warn' }) : null, line('Compromissos pendentes', s.expensePending, { strong: true })),
      check(sumExp(p.expensePending) + billsOpen === s.expensePending),
      h('div', { class: 'row' }, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { d.modal.close(); location.hash = '#/planejamento/calendario'; } }, icon('calendar', 'icon-sm'), 'Ver no calendário')),
      itemsList([...p.expensePending, ...p.cardItems.filter((it) => bills.some((b) => b.cardId === it.sourceId && b.open > 0))]))),
  };
  views[kind]?.();
  return d;
}

