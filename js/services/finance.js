import { addMonths, firstDay, lastDay, monthOf, parseISO, daysInMonth, dateInMonth } from '../utils/dates.js';
import { isCard, billFor, dueDateOf, competenceOf } from './cards.js';
import { occurrences } from './recurrence.js';

/*
 * Modelo financeiro
 * -----------------
 * • Toda movimentação tem uma competência (`month`): o mês cujo orçamento ela afeta.
 *   Compras no cartão têm competência no mês de vencimento da fatura.
 * • Despesa realizada: consumo já pago. Compras no cartão são obrigações
 *   assumidas e só se tornam "realizadas" à medida que a fatura é paga.
 * • Compromissos pendentes: despesas previstas, ocorrências recorrentes ainda
 *   não pagas e faturas de cartão em aberto.
 * • Pagamento de fatura é uma transferência para o cartão: liquida a obrigação
 *   e nunca é contada como uma segunda despesa.
 * • Transferências entre contas e aportes em investimentos não são consumo.
 * • Reembolsos e estornos reduzem a despesa da categoria/bloco/fonte original.
 * • Receitas de benefícios de uso restrito (VA/VR) ficam fora do dinheiro livre.
 */

export const NONE = '__none__';

export function createContext({ transactions = [], recurrences = [], accounts = [], investmentEvents = [], budgets = [], goals = [], prefs = {}, today }) {
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const byMonth = new Map();
  const materialized = new Set();
  const payments = new Map(); // `${cardId}|${billMonth}` → centavos pagos
  for (const tx of transactions) {
    if (!byMonth.has(tx.month)) byMonth.set(tx.month, []);
    byMonth.get(tx.month).push(tx);
    if (tx.recurrenceId && tx.occurrenceDate) materialized.add(`${tx.recurrenceId}|${tx.occurrenceDate}`);
    if (tx.type === 'transfer' && tx.status === 'done' && isCard(accountMap.get(tx.toAccountId))) {
      const key = `${tx.toAccountId}|${tx.billMonth || tx.month}`;
      payments.set(key, (payments.get(key) || 0) + tx.amount);
    }
  }
  return { transactions, recurrences, accounts: accountMap, investmentEvents, budgets, goals, prefs, today, byMonth, materialized, payments, cache: new Map() };
}

/** Ocorrências virtuais (projetadas, não persistidas) de recorrências no mês. */
export function virtualItems(ctx, month) {
  const out = [];
  const from = firstDay(addMonths(month, -2));
  const to = lastDay(month);
  for (const rule of ctx.recurrences) {
    if (rule.archived) continue;
    const acc = ctx.accounts.get(rule.sourceId);
    for (const date of occurrences(rule, from, to)) {
      if (ctx.materialized.has(`${rule.id}|${date}`)) continue;
      const m = competenceOf({ type: rule.type, date }, acc);
      if (m !== month) continue;
      out.push({
        id: `rec:${rule.id}:${date}`,
        virtual: true,
        recurrenceId: rule.id,
        occurrenceDate: date,
        type: rule.type,
        status: 'planned',
        description: rule.description,
        amount: rule.amount,
        date,
        month,
        categoryId: rule.categoryId || null,
        blockId: rule.blockId || null,
        sourceId: rule.sourceId || null,
        restricted: Boolean(rule.restricted),
      });
    }
  }
  return out;
}

export function monthItems(ctx, month) {
  return [...(ctx.byMonth.get(month) || []), ...virtualItems(ctx, month)];
}

export function isRestrictedIncome(item, ctx) {
  return item.type === 'income' && (Boolean(item.restricted) || ctx.accounts.get(item.sourceId)?.kind === 'benefit');
}

/** Valor com sinal de consumo: despesa positiva, reembolso negativo, demais 0. */
export function expenseValue(item) {
  if (item.type === 'expense') return item.amount;
  if (item.type === 'refund') return -item.amount;
  return 0;
}

/** Dia do mês em que o item aparece na evolução diária. */
export function displayDay(item, month, ctx) {
  if (monthOf(item.date) === month) return parseISO(item.date).d;
  const acc = ctx.accounts.get(item.sourceId);
  const due = isCard(acc) ? dueDateOf(month, acc) : null;
  if (due) return parseISO(due).d;
  return item.date < firstDay(month) ? 1 : parseISO(lastDay(month)).d;
}

function bump(map, key, total, planned) {
  const g = map.get(key) || { key, total: 0, planned: 0, count: 0 };
  g.total += total; g.planned += planned; g.count += 1;
  map.set(key, g);
}

function sortedGroups(map, whole) {
  return [...map.values()]
    .filter((g) => g.total !== 0)
    .map((g) => ({ ...g, pct: whole > 0 ? (g.total / whole) * 100 : 0 }))
    .sort((a, b) => b.total - a.total || String(a.key).localeCompare(String(b.key)));
}

export function summarize(ctx, month) {
  if (ctx.cache.has(month)) return ctx.cache.get(month);
  const items = monthItems(ctx, month);
  const r = {
    month,
    incomeReceived: 0, incomeExpected: 0, restrictedIncome: 0,
    expenseDone: 0, expensePending: 0, expenseTotal: 0, restrictedExpense: 0,
    plannedExpense: 0, overdue: 0,
    transfers: 0,
  };
  const byCategory = new Map(), byBlock = new Map(), bySource = new Map(), byIncomeCategory = new Map();
  const bills = new Map();
  const days = Array.from({ length: daysInMonth(...month.split('-').map(Number)) }, (_, i) => ({ day: i + 1, done: 0, planned: 0 }));

  for (const it of items) {
    const acc = ctx.accounts.get(it.sourceId);
    const done = it.status === 'done';
    if (it.type === 'income') {
      if (done) r.incomeReceived += it.amount; else r.incomeExpected += it.amount;
      if (isRestrictedIncome(it, ctx)) r.restrictedIncome += it.amount;
      bump(byIncomeCategory, it.categoryId || NONE, it.amount, done ? 0 : it.amount);
      continue;
    }
    if (it.type === 'transfer') { r.transfers += it.amount; continue; }
    const v = expenseValue(it);
    if (!v) continue;
    r.expenseTotal += v;
    if (!done) r.plannedExpense += v;
    if (!done && it.date < ctx.today && v > 0) r.overdue += v;
    if (acc?.kind === 'benefit') r.restrictedExpense += v;
    bump(byCategory, it.categoryId || NONE, v, done ? 0 : v);
    bump(byBlock, it.blockId || NONE, v, done ? 0 : v);
    bump(bySource, it.sourceId || NONE, v, done ? 0 : v);
    const d = days[displayDay(it, month, ctx) - 1];
    if (done) d.done += v; else d.planned += v;
    if (isCard(acc)) {
      const b = bills.get(acc.id) || { cardId: acc.id, total: 0 };
      b.total += v;
      bills.set(acc.id, b);
    } else if (done) r.expenseDone += v;
    else r.expensePending += v;
  }

  // Faturas: o valor pago liquida a obrigação; o restante é compromisso pendente.
  const cardBills = [];
  for (const b of bills.values()) {
    const card = ctx.accounts.get(b.cardId);
    const paid = ctx.payments.get(`${b.cardId}|${month}`) || 0;
    const settled = b.total > 0 ? Math.min(paid, b.total) : b.total;
    const open = b.total > 0 ? b.total - settled : 0;
    r.expenseDone += settled;
    r.expensePending += open;
    cardBills.push({ ...b, paid, open, dueDate: dueDateOf(month, card), status: billStatus(b.total, paid, dueDateOf(month, card), ctx.today) });
  }
  // Pagamentos de fatura sem compras registradas no mês ainda aparecem na lista.
  for (const [key, paid] of ctx.payments) {
    const [cardId, m] = key.split('|');
    if (m !== month || bills.has(cardId)) continue;
    const card = ctx.accounts.get(cardId);
    cardBills.push({ cardId, total: 0, paid, open: 0, dueDate: dueDateOf(month, card), status: 'paid' });
  }

  r.incomeTotal = r.incomeReceived + r.incomeExpected;
  r.currentSurplus = r.incomeReceived - r.expenseDone;
  r.projectedSurplus = r.incomeTotal - r.expenseTotal;
  const overflow = Math.max(0, r.restrictedExpense - r.restrictedIncome);
  r.restrictedLeft = Math.max(0, r.restrictedIncome - r.restrictedExpense);
  r.freeSurplus = (r.incomeTotal - r.restrictedIncome) - (r.expenseTotal - r.restrictedExpense) - overflow;
  r.safetyMargin = Math.max(0, ctx.prefs.safetyMargin || 0);
  r.contributed = 0; r.withdrawn = 0;
  for (const e of ctx.investmentEvents) {
    if (monthOf(e.date) !== month) continue;
    if (e.type === 'contribution') r.contributed += e.amount;
    if (e.type === 'withdrawal') r.withdrawn += e.amount;
  }
  r.investable = Math.max(0, r.freeSurplus - r.safetyMargin);
  r.availableToInvest = Math.max(0, r.investable - r.contributed);
  r.goalsPlanned = ctx.goals.filter((g) => !g.archived && g.monthly > 0).reduce((t, g) => t + g.monthly, 0);
  r.freeAfterGoals = Math.max(0, r.availableToInvest - r.goalsPlanned);

  r.byCategory = sortedGroups(byCategory, r.expenseTotal);
  r.byBlock = sortedGroups(byBlock, r.expenseTotal);
  r.bySource = sortedGroups(bySource, r.expenseTotal);
  r.byIncomeCategory = sortedGroups(byIncomeCategory, r.incomeTotal);
  r.days = days;
  r.cardBills = cardBills;
  r.items = items;
  r.budgets = ctx.budgets.map((b) => {
    const groups = b.scope === 'block' ? byBlock : byCategory;
    const used = groups.get(b.refId)?.total || 0;
    return { ...b, used, remaining: b.amount - used, ratio: b.amount > 0 ? used / b.amount : 0 };
  });
  ctx.cache.set(month, r);
  return r;
}

export function billStatus(total, paid, dueDate, today) {
  if (total <= 0 || paid >= total) return 'paid';
  if (dueDate && dueDate < today) return 'overdue';
  return paid > 0 ? 'partial' : 'open';
}

/** Saldos reais das contas (somente movimentações realizadas). */
export function accountBalances(ctx) {
  const bal = new Map();
  for (const a of ctx.accounts.values()) bal.set(a.id, a.kind === 'credit' ? 0 : (a.openingBalance || 0));
  const add = (id, v) => { if (id && bal.has(id)) bal.set(id, bal.get(id) + v); };
  for (const tx of ctx.transactions) {
    if (tx.status !== 'done') continue;
    const acc = ctx.accounts.get(tx.sourceId);
    if (tx.type === 'income') add(tx.sourceId, tx.amount);
    else if (tx.type === 'expense') add(tx.sourceId, isCard(acc) ? tx.amount : -tx.amount);
    else if (tx.type === 'refund') add(tx.sourceId, isCard(acc) ? -tx.amount : tx.amount);
    else if (tx.type === 'transfer') {
      add(tx.sourceId, isCard(acc) ? tx.amount : -tx.amount);
      const to = ctx.accounts.get(tx.toAccountId);
      add(tx.toAccountId, isCard(to) ? -tx.amount : tx.amount);
    }
  }
  for (const e of ctx.investmentEvents) {
    if (!e.accountId) continue;
    if (e.type === 'contribution') add(e.accountId, -e.amount);
    if (e.type === 'withdrawal') add(e.accountId, e.amount);
  }
  // Para cartões o saldo representa o valor devido (positivo = dívida).
  return bal;
}

export function cashPosition(ctx) {
  const bal = accountBalances(ctx);
  let free = 0, restricted = 0, cardDebt = 0;
  for (const a of ctx.accounts.values()) {
    if (a.archived && !bal.get(a.id)) continue;
    const v = bal.get(a.id) || 0;
    if (a.kind === 'credit') cardDebt += Math.max(0, v);
    else if (a.kind === 'benefit') restricted += v;
    else free += v;
  }
  return { balances: bal, free, restricted, cardDebt };
}

/** Projeção mês a mês. */
export function projection(ctx, fromMonth, count) {
  return Array.from({ length: count }, (_, i) => summarize(ctx, addMonths(fromMonth, i)));
}

/** Faturas de um cartão em uma janela de meses. */
export function cardBillsFor(ctx, cardId, fromMonth, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const m = addMonths(fromMonth, i);
    const bill = summarize(ctx, m).cardBills.find((b) => b.cardId === cardId);
    if (bill) out.push({ month: m, ...bill });
  }
  return out;
}

export function isBillSettled(ctx, cardId, month) {
  const s = summarize(ctx, month).cardBills.find((b) => b.cardId === cardId);
  return !s || s.status === 'paid';
}

/** Competência de uma compra, para exibição no formulário. */
export function previewBill(dateISO, account) {
  if (!isCard(account)) return null;
  return billFor(dateISO, account);
}

export { dateInMonth };
