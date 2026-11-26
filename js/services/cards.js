import { parseISO, dateInMonth, addMonths, monthOf } from '../utils/dates.js';

export function isCard(account) {
  return account?.kind === 'credit';
}

export function cardConfigured(account) {
  return isCard(account) && Number.isInteger(account.closingDay) && Number.isInteger(account.dueDay);
}

/**
 * Regra de fatura: compras feitas até o dia anterior ao fechamento entram na
 * fatura que fecha naquele mês; compras no dia do fechamento ou depois entram
 * na fatura seguinte. Dias inexistentes (29, 30, 31) usam o último dia do mês.
 * A competência orçamentária é o mês de vencimento da fatura.
 * Para cartões sem fechamento e vencimento configurados, nada é inventado:
 * a competência é o próprio mês da compra.
 */
export function billFor(dateISO, card) {
  if (!cardConfigured(card)) {
    return { month: monthOf(dateISO), configured: false, closingDate: null, dueDate: null };
  }
  const purchaseMonth = monthOf(dateISO);
  const closingThisMonth = dateInMonth(purchaseMonth, card.closingDay);
  const closingMonth = dateISO >= closingThisMonth ? addMonths(purchaseMonth, 1) : purchaseMonth;
  const dueMonth = card.dueDay > card.closingDay ? closingMonth : addMonths(closingMonth, 1);
  return {
    month: dueMonth,
    configured: true,
    closingDate: dateInMonth(closingMonth, card.closingDay),
    dueDate: dateInMonth(dueMonth, card.dueDay),
  };
}

/** Vencimento da fatura cuja competência é `month`. */
export function dueDateOf(month, card) {
  if (!cardConfigured(card)) return null;
  return dateInMonth(month, card.dueDay);
}

export function closingDateOf(month, card) {
  if (!cardConfigured(card)) return null;
  const closingMonth = card.dueDay > card.closingDay ? month : addMonths(month, -1);
  return dateInMonth(closingMonth, card.closingDay);
}

/** Competência de uma movimentação: respeita a correção manual quando existir. */
export function competenceOf(tx, account) {
  if (tx.monthManual && tx.month) return tx.month;
  // Compromisso com data a definir: pertence ao período em que foi planejado.
  if (!tx.date) return tx.period || tx.month;
  if (isCard(account) && (tx.type === 'expense' || tx.type === 'refund')) return billFor(tx.date, account).month;
  return monthOf(tx.date);
}

export function dayInMonth(iso) {
  return parseISO(iso).d;
}
