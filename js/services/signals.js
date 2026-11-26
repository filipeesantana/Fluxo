import { addDays, monthOf } from '../utils/dates.js';
import { summarize } from './finance.js';
import { commitmentsFor } from './commitments.js';
import { upcoming } from './calendar.js';

/*
 * Avisos discretos do mês. Cada aviso é um fato calculado pelo mesmo motor
 * financeiro, com tom suave (ok · info · warn · neg). Nada pisca, nada se
 * repete: a lista é recalculada só quando os dados mudam.
 * Limites configuráveis (Configurações → Preferências financeiras):
 *   budgetWarnAt  % do orçamento/previsão que dispara "atenção" (padrão 80)
 *   dueSoonDays   antecedência para "vence em breve" (padrão 3 dias)
 */
export const DEFAULT_WARN_AT = 80;
export const DEFAULT_DUE_SOON = 3;

export function budgetLevel(ratio, warnAt = DEFAULT_WARN_AT) {
  if (ratio > 1) return 'over';
  if (ratio >= 1) return 'full';
  if (ratio >= warnAt / 100) return 'warn';
  return 'ok';
}

export function monthSignals(ctx, month, prefs = {}, goals = []) {
  const warnAt = clamp(prefs.budgetWarnAt, 50, 100, DEFAULT_WARN_AT);
  const dueSoon = clamp(prefs.dueSoonDays, 0, 15, DEFAULT_DUE_SOON);
  const s = summarize(ctx, month);
  const out = [];
  const isCurrent = month === monthOf(ctx.today);

  if (s.projectedSurplus < 0) out.push({ id: 'deficit', tone: 'neg', icon: 'alert', title: 'Déficit projetado', detail: `As despesas do mês superam as receitas em ${fmt(-s.projectedSurplus)}.`, value: s.projectedSurplus });
  else if (s.safetyMargin > 0 && s.freeSurplus < s.safetyMargin) out.push({ id: 'margin', tone: 'warn', icon: 'shield', title: 'Sobra abaixo da margem de segurança', detail: `Sobra livre de ${fmt(s.freeSurplus)} para uma margem de ${fmt(s.safetyMargin)}.` });

  if (isCurrent || month < monthOf(ctx.today)) {
    if (s.overdue > 0) out.push({ id: 'overdue', tone: 'neg', icon: 'clock', title: 'Contas atrasadas', detail: `${fmt(s.overdue)} com vencimento já passado.`, href: '#/planejamento/compromissos' });
  }
  if (isCurrent) {
    const soon = upcoming(ctx, { horizon: dueSoon, back: 0, limit: 50 }).items.filter((e) => e.status === 'planned' && e.kind !== 'income');
    if (soon.length) {
      const total = soon.reduce((a, e) => a + (e.kind === 'bill' ? e.open : e.amount), 0);
      out.push({ id: 'soon', tone: 'info', icon: 'calendar', title: dueSoon === 0 ? 'Vence hoje' : `Vence em até ${dueSoon} dia${dueSoon === 1 ? '' : 's'}`, detail: `${soon.length} ${soon.length === 1 ? 'compromisso' : 'compromissos'} · ${fmt(total)} · próximo em ${shortDate(soon[0].date)}.`, href: '#/planejamento/calendario' });
    }
  }
  for (const b of s.budgets) {
    const lvl = budgetLevel(b.ratio, warnAt);
    if (lvl === 'ok') continue;
    out.push({ id: `budget:${b.id}`, tone: lvl === 'over' ? 'neg' : 'warn', icon: 'target', title: lvl === 'over' ? 'Orçamento ultrapassado' : lvl === 'full' ? 'Limite do orçamento atingido' : 'Orçamento perto do limite',
      detail: lvl === 'over' ? `${fmt(-b.remaining)} acima de ${fmt(b.amount)}.` : `${Math.round(b.ratio * 100)}% de ${fmt(b.amount)} usados.`, refId: b.refId, scope: b.scope, href: '#/planejamento/orcamentos' });
  }
  for (const c of commitmentsFor(ctx, month).forecasts) {
    if (c.closed || c.planned <= 0) continue;
    const lvl = budgetLevel(c.ratio, warnAt);
    if (lvl === 'ok') continue;
    out.push({ id: `forecast:${c.rule.id}`, tone: lvl === 'over' ? 'neg' : 'warn', icon: 'target', title: `${c.rule.description}: ${lvl === 'over' ? 'acima da previsão' : 'perto da previsão'}`,
      detail: lvl === 'over' ? `${fmt(c.excess)} acima de ${fmt(c.planned)}.` : `${fmt(c.used)} de ${fmt(c.planned)} usados.`, href: '#/planejamento/compromissos' });
  }
  // goals: [{ id, name, current, target }] (valor atual calculado pela tela de investimentos)
  for (const g of goals) {
    if (!g.target) continue;
    if (g.current >= g.target) out.push({ id: `goal:${g.id}`, tone: 'ok', icon: 'check', title: `Meta “${g.name}” concluída`, detail: `${fmt(g.target)} alcançados.`, href: '#/investimentos' });
  }
  const order = { neg: 0, warn: 1, info: 2, ok: 3 };
  return out.sort((a, b) => order[a.tone] - order[b.tone]);
}

const clamp = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const fmt = (c) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(c / 100);
const shortDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
export { addDays };
