import { addMonths, monthOf, dateInMonth, parseISO, addDays, firstDay, lastDay, daysInMonth } from '../utils/dates.js';
import { isCard } from './cards.js';
import { monthItems, summarize } from './finance.js';

/*
 * Calendário de caixa. Cada evento tem uma data no calendário local e um papel:
 *   income      entrada (receita)                → conta em "entradas"
 *   expense     saída paga com conta/dinheiro     → conta em "saídas"
 *   card        compra no cartão                  → listada, mas não sai do caixa no dia
 *   bill        vencimento de fatura              → saldo em aberto conta como saída prevista
 *   payment     pagamento de fatura               → saída realizada
 *   transfer    transferência entre contas         → neutra
 *   invest      aporte/resgate                    → informado à parte
 * Parcelas fora do cartão aparecem no dia da compra dentro do mês da parcela.
 */

export function eventDate(item, ctx) {
  const acc = ctx.accounts.get(item.sourceId);
  if (item.planId && !isCard(acc)) return dateInMonth(item.month, parseISO(item.date).d);
  return item.date;
}

function statusOf(item, today) {
  if (item.status === 'done') return 'done';
  return item.date < today ? 'overdue' : 'planned';
}

function kindOf(item, ctx) {
  if (item.type === 'income') return 'income';
  if (item.type === 'transfer') return isCard(ctx.accounts.get(item.toAccountId)) ? 'payment' : 'transfer';
  return isCard(ctx.accounts.get(item.sourceId)) ? 'card' : 'expense';
}

/** Eventos do mês agrupados por data (AAAA-MM-DD). */
export function calendarMonth(ctx, month) {
  const key = `cal:${month}`;
  if (ctx.cache.has(key)) return ctx.cache.get(key);
  const from = firstDay(month), to = lastDay(month);
  const days = new Map();
  const day = (d) => {
    if (!days.has(d)) days.set(d, { date: d, events: [], in: 0, inPlanned: 0, out: 0, outPlanned: 0, overdue: 0, invested: 0 });
    return days.get(d);
  };
  const seen = new Set();
  // Compras no cartão de um mês podem ter competência um ou dois meses depois.
  for (const m of [addMonths(month, -1), month, addMonths(month, 1), addMonths(month, 2)]) {
    for (const it of monthItems(ctx, m)) {
      if (seen.has(it.id)) continue;
      const d = eventDate(it, ctx);
      if (d < from || d > to) continue;
      seen.add(it.id);
      const kind = kindOf(it, ctx);
      const status = statusOf(it, ctx.today);
      const sign = it.type === 'refund' ? -1 : 1;
      const ev = { kind, status, date: d, amount: it.amount, item: it };
      const dd = day(d);
      dd.events.push(ev);
      if (kind === 'income') { if (status === 'done') dd.in += it.amount; else dd.inPlanned += it.amount; }
      else if (kind === 'expense') {
        if (status === 'done') dd.out += sign * it.amount; else dd.outPlanned += sign * it.amount;
        if (status === 'overdue' && sign > 0) dd.overdue += it.amount;
      } else if (kind === 'payment' && status === 'done') dd.out += it.amount;
    }
  }
  for (const b of summarize(ctx, month).cardBills) {
    if (!b.dueDate || b.dueDate < from || b.dueDate > to) continue;
    const status = b.status === 'paid' ? 'done' : b.status === 'overdue' ? 'overdue' : 'planned';
    const dd = day(b.dueDate);
    dd.events.push({ kind: 'bill', status, date: b.dueDate, amount: b.total, open: b.open, paid: b.paid, cardId: b.cardId, item: null });
    dd.outPlanned += b.open;
    if (status === 'overdue') dd.overdue += b.open;
  }
  for (const e of ctx.investmentEvents) {
    if (e.type === 'balance' || e.date < from || e.date > to) continue;
    const dd = day(e.date);
    dd.events.push({ kind: 'invest', status: 'done', date: e.date, amount: e.amount, event: e });
    dd.invested += e.type === 'contribution' ? e.amount : -e.amount;
  }
  const order = { overdue: 0, planned: 1, done: 2 };
  let totals = { in: 0, inPlanned: 0, out: 0, outPlanned: 0, overdue: 0, invested: 0 };
  for (const dd of days.values()) {
    dd.events.sort((a, b) => order[a.status] - order[b.status] || b.amount - a.amount);
    for (const k of Object.keys(totals)) totals[k] += dd[k];
  }
  const res = { month, days, totals, dayCount: daysInMonth(...month.split('-').map(Number)) };
  ctx.cache.set(key, res);
  return res;
}

/**
 * Próximos compromissos: tudo que vence nos próximos `horizon` dias e o que
 * está atrasado (até 60 dias para trás). Itens realizados dentro da janela
 * aparecem como concluídos.
 */
export function upcoming(ctx, { horizon = 30, back = 60, limit = 8 } = {}) {
  const t = ctx.today;
  const start = addDays(t, -back), end = addDays(t, horizon);
  const out = [];
  for (let m = monthOf(start); m <= monthOf(end); m = addMonths(m, 1)) {
    for (const dd of calendarMonth(ctx, m).days.values()) {
      if (dd.date < start || dd.date > end) continue;
      for (const ev of dd.events) {
        if (ev.kind === 'transfer' || ev.kind === 'invest' || ev.kind === 'card' || ev.kind === 'payment') continue;
        if (ev.status === 'done' && (ev.date < t || ev.kind === 'income')) continue;
        if (dd.date < t && ev.status !== 'overdue') continue;
        if (ev.kind === 'bill' && ev.amount <= 0) continue;
        out.push(ev);
      }
    }
  }
  const rank = { overdue: 0, planned: 1, done: 2 };
  out.sort((a, b) => (a.status === 'overdue') !== (b.status === 'overdue') ? rank[a.status] - rank[b.status] : a.date < b.date ? -1 : a.date > b.date ? 1 : b.amount - a.amount);
  return { items: out.slice(0, limit), total: out.length, pending: out.filter((e) => e.status !== 'done').reduce((s, e) => s + (e.kind === 'bill' ? e.open : e.kind === 'income' ? 0 : e.amount), 0) };
}
