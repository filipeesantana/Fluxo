import { addMonths, monthOf, monthDiff, dayDiff } from '../utils/dates.js';

/*
 * Simulador patrimonial
 * • Taxas informadas são anuais efetivas; a taxa mensal equivalente é
 *   i = (1 + a)^(1/12) − 1.
 * • Aportes ocorrem no FIM de cada mês por padrão (timing "end");
 *   com timing "start" o aporte rende já no próprio mês.
 * • Cálculos usam ponto flutuante em reais e são arredondados para centavos
 *   apenas na apresentação; nada aqui altera valores reais.
 */

export const MAX_MONTHS = 1200; // horizonte de 100 anos

export function monthlyRate(annualPct) {
  const a = (Number(annualPct) || 0) / 100;
  if (a <= -1) return -1;
  return Math.pow(1 + a, 1 / 12) - 1;
}

/** Valor futuro após n meses. Valores em centavos (podem ser fracionários). */
export function futureValue(initial, monthly, i, n, timing = 'end') {
  if (n <= 0) return initial;
  if (i === 0) return initial + monthly * n;
  const g = Math.pow(1 + i, n);
  const annuity = monthly * ((g - 1) / i) * (timing === 'start' ? 1 + i : 1);
  return initial * g + annuity;
}

/** Aporte mensal necessário para atingir `target` em n meses. */
export function requiredMonthly(target, initial, i, n, timing = 'end') {
  if (n <= 0) return initial >= target ? 0 : Infinity;
  const gap = target - (i === 0 ? initial : initial * Math.pow(1 + i, n));
  if (gap <= 0) return 0;
  if (i === 0) return gap / n;
  const factor = ((Math.pow(1 + i, n) - 1) / i) * (timing === 'start' ? 1 + i : 1);
  return gap / factor;
}

/** Número de meses (inteiro, arredondado para cima) até atingir a meta. */
export function monthsToTarget(target, initial, monthly, i, timing = 'end') {
  if (initial >= target) return 0;
  if (monthly <= 0 && (i <= 0 || initial <= 0)) return null; // inalcançável
  let v = initial;
  for (let n = 1; n <= MAX_MONTHS; n++) {
    if (timing === 'start') v = (v + monthly) * (1 + i);
    else v = v * (1 + i) + monthly;
    if (v >= target - 1e-6) return n;
  }
  return null;
}

/** Série mês a mês para gráficos. */
export function projectSeries(initial, monthly, i, months, timing = 'end') {
  const series = [{ n: 0, value: initial, contributed: initial }];
  let v = initial, c = initial;
  for (let n = 1; n <= months; n++) {
    if (timing === 'start') v = (v + monthly) * (1 + i);
    else v = v * (1 + i) + monthly;
    c += monthly;
    series.push({ n, value: v, contributed: c });
  }
  return series;
}

export function simulateGoal(goal, { fromMonth } = {}) {
  const target = goal.target || 0;
  const initial = goal.initial || 0;
  const monthly = goal.monthly || 0;
  const timing = goal.timing === 'start' ? 'start' : 'end';
  const i = monthlyRate(goal.annualRate || 0);
  const start = goal.startMonth || fromMonth;
  const months = monthsToTarget(target, initial, monthly, i, timing);
  const reached = initial >= target;
  const res = { i, timing, reached, months, reachable: months !== null };
  res.completionMonth = months !== null ? addMonths(start, months) : null;
  const horizon = months !== null ? months : Math.min(MAX_MONTHS, 360);
  res.horizon = horizon;
  res.projected = futureValue(initial, monthly, i, horizon, timing);
  res.contributed = initial + monthly * horizon;
  res.earnings = res.projected - res.contributed;
  res.remaining = Math.max(0, target - initial);
  if (goal.deadline) {
    const n = monthDiff(start, goal.deadline);
    res.deadlineMonths = n;
    res.requiredMonthly = n > 0 ? requiredMonthly(target, initial, i, n, timing) : (reached ? 0 : Infinity);
    res.onTrack = months !== null && months <= n;
    res.atDeadline = n > 0 ? futureValue(initial, monthly, i, n, timing) : initial;
  }
  return res;
}

/**
 * Valor de um investimento a partir dos eventos.
 * informed: último saldo informado + aportes − resgates posteriores (real).
 * estimated: informed corrigido pela rentabilidade informada até hoje (estimativa).
 */
export function investmentValue(inv, events, todayISO) {
  const own = events.filter((e) => e.investmentId === inv.id).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || 0) - (b.createdAt || 0)));
  let informed = 0, refDate = null, contributed = 0, withdrawn = 0;
  let lastFlowDate = null;
  for (const e of own) {
    if (e.type === 'balance') { informed = e.amount; refDate = e.date; }
    else if (e.type === 'contribution') { informed += e.amount; contributed += e.amount; lastFlowDate = e.date; }
    else if (e.type === 'withdrawal') { informed -= e.amount; withdrawn += e.amount; lastFlowDate = e.date; }
  }
  const base = refDate && (!lastFlowDate || refDate >= lastFlowDate) ? refDate : (lastFlowDate || refDate);
  let estimated = informed;
  if (base && inv.annualRate && todayISO > base) {
    const days = dayDiff(base, todayISO);
    estimated = informed * Math.pow(1 + inv.annualRate / 100, days / 365);
  }
  return { informed, estimated, refDate: base, contributed, withdrawn, events: own };
}

export { monthOf };
