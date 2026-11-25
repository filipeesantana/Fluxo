import { splitCents } from '../utils/money.js';
import { addMonths } from '../utils/dates.js';

/**
 * Gera as parcelas de uma compra parcelada.
 * A soma das parcelas é sempre exatamente o valor total; os centavos de
 * diferença ficam nas primeiras parcelas. A data original da compra é
 * preservada em todas as parcelas; a competência avança mês a mês.
 */
export function buildInstallments({ total, count, firstMonth }) {
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error('Valor total inválido');
  if (!Number.isInteger(count) || count < 2 || count > 120) throw new Error('Quantidade de parcelas inválida');
  return splitCents(total, count).map((amount, i) => ({
    index: i + 1,
    count,
    amount,
    month: addMonths(firstMonth, i),
  }));
}

/** Situação de um plano a partir das parcelas existentes. */
export function planProgress(parcels, settledFn) {
  let paid = 0, pending = 0, paidCount = 0, cancelled = 0;
  for (const p of parcels) {
    if (p.cancelled) { cancelled++; continue; }
    if (settledFn(p)) { paid += p.amount; paidCount++; } else pending += p.amount;
  }
  return { paid, pending, paidCount, total: paid + pending, count: parcels.length - cancelled, cancelled };
}
