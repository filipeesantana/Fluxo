import { fold } from './suggest.js';
import { dayDiff, monthOf, isISODate } from '../utils/dates.js';
import { monthItems } from './finance.js';
import { occurrences } from './recurrence.js';

/*
 * Duas coisas diferentes:
 * 1. Semelhança (findSimilar): avisa sobre lançamentos parecidos no momento do
 *    cadastro. Nunca bloqueia — gastos legítimos podem ser idênticos.
 * 2. Auditoria (auditData): lista inconsistências técnicas para revisão manual.
 *    Nada é excluído ou alterado automaticamente.
 */

export const normalizeDescription = (s) => fold(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const sameKind = (a, b) => a === b;

/**
 * candidate: { type, amount, date, description, sourceId, categoryId, id? }
 * Retorna lançamentos semelhantes e, se houver, uma ocorrência recorrente
 * projetada que provavelmente corresponde ao mesmo gasto.
 */
export function findSimilar(candidate, ctx, { limit = 3 } = {}) {
  if (!candidate || !Number.isSafeInteger(candidate.amount) || !isISODate(candidate.date)) return { matches: [], occurrence: null };
  const desc = normalizeDescription(candidate.description);
  const month = monthOf(candidate.date);
  const pool = [];
  for (const m of new Set([month, candidate.month].filter(Boolean))) pool.push(...(ctx.byMonth.get(m) || []));
  // vizinhos de data na virada de mês
  for (const t of ctx.transactions) if (Math.abs(dayDiff(t.date, candidate.date)) <= 1 && monthOf(t.date) !== month) pool.push(t);
  const seen = new Set();
  const matches = [];
  for (const t of pool) {
    if (seen.has(t.id) || t.id === candidate.id) continue;
    seen.add(t.id);
    if (!sameKind(t.type, candidate.type) || t.amount !== candidate.amount) continue;
    const dd = Math.abs(dayDiff(t.date, candidate.date));
    const sameDesc = desc && normalizeDescription(t.description) === desc;
    const sameSource = (t.sourceId || null) === (candidate.sourceId || null);
    const sameCategory = (t.categoryId || null) === (candidate.categoryId || null);
    let score = 0;
    if (dd === 0 && sameDesc) score = 3;
    else if (dd === 0 && sameSource && sameCategory) score = 2;
    else if (dd <= 1 && sameDesc && sameSource) score = 2;
    if (score) matches.push({ tx: t, score, sameDesc, sameSource, sameDate: dd === 0 });
  }
  matches.sort((a, b) => b.score - a.score);
  let occurrence = null;
  if (candidate.type === 'expense' || candidate.type === 'income') {
    for (const v of monthItems(ctx, candidate.month || month)) {
      if (!v.virtual || v.type !== candidate.type) continue;
      const vd = normalizeDescription(v.description);
      if ((desc && vd === desc) || (v.amount === candidate.amount && (v.categoryId || null) === (candidate.categoryId || null) && candidate.categoryId)) { occurrence = v; break; }
    }
  }
  return { matches: matches.slice(0, limit).map((m) => m.tx), occurrence };
}

/** Auditoria completa sobre um snapshot { store: rows[] }. */
export function auditData(data) {
  const issues = [];
  const ids = (s) => new Set((data[s] || []).map((r) => r.id));
  const cats = new Map((data.categories || []).map((c) => [c.id, c]));
  const blocks = ids('blocks'), accounts = new Map((data.accounts || []).map((a) => [a.id, a]));
  const plans = new Map((data.installmentPlans || []).map((p) => [p.id, p]));
  const rules = new Map((data.recurrences || []).map((r) => [r.id, r]));
  const invs = ids('investments');
  const tx = data.transactions || [];
  const add = (type, severity, message, refs = []) => issues.push({ type, severity, message, refs });

  // Possíveis duplicidades: mesmo tipo, valor, data, descrição normalizada e fonte.
  const groups = new Map();
  for (const t of tx) {
    if (t.planId) continue;
    const k = [t.type, t.amount, t.date, normalizeDescription(t.description), t.sourceId || '', t.toAccountId || ''].join('|');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  for (const g of groups.values()) if (g.length > 1) add('duplicate', 'warn', `${g.length} lançamentos idênticos: “${g[0].description}”`, g.map((t) => t.id));

  for (const t of tx) {
    if (t.categoryId && !cats.has(t.categoryId)) add('ref', 'error', `“${t.description}” aponta para uma categoria inexistente`, [t.id]);
    else if (t.categoryId && t.type === 'income' && cats.get(t.categoryId).type !== 'income') add('ref', 'warn', `Receita “${t.description}” usa uma categoria de despesa`, [t.id]);
    if (t.blockId && !blocks.has(t.blockId)) add('ref', 'error', `“${t.description}” aponta para um bloco inexistente`, [t.id]);
    if (t.sourceId && !accounts.has(t.sourceId)) add('ref', 'error', `“${t.description}” aponta para uma conta inexistente`, [t.id]);
    if (t.toAccountId && !accounts.has(t.toAccountId)) add('ref', 'error', `Transferência “${t.description}” tem destino inexistente`, [t.id]);
    if (t.type === 'transfer' && t.sourceId && t.sourceId === t.toAccountId) add('ref', 'error', `Transferência “${t.description}” tem origem e destino iguais`, [t.id]);
    if (t.planId && !plans.has(t.planId)) add('plan', 'warn', `Parcela “${t.description}” sem parcelamento correspondente`, [t.id]);
    if (t.recurrenceId && !rules.has(t.recurrenceId)) add('recurrence', 'warn', `“${t.description}” vinculado a uma recorrência que não existe mais`, [t.id]);
  }

  for (const p of plans.values()) {
    const parcels = tx.filter((t) => t.planId === p.id);
    const idx = parcels.map((t) => t.installment?.index).filter(Boolean);
    if (new Set(idx).size !== idx.length) add('plan', 'error', `Parcelamento “${p.description}” tem parcelas repetidas`, parcels.map((t) => t.id));
    if (!p.cancelledAt && parcels.length !== p.count) add('plan', 'warn', `Parcelamento “${p.description}” tem ${parcels.length} de ${p.count} parcelas`, parcels.map((t) => t.id));
    const sum = parcels.reduce((s, t) => s + t.amount, 0);
    if (!p.cancelledAt && parcels.length === p.count && sum !== p.total) add('plan', 'info', `Parcelas de “${p.description}” somam valor diferente do total (parcela editada individualmente?)`, parcels.map((t) => t.id));
  }

  const occ = new Map();
  for (const t of tx) {
    if (!t.recurrenceId || !t.occurrenceDate) continue;
    const k = `${t.recurrenceId}|${t.occurrenceDate}`;
    if (occ.has(k)) add('recurrence', 'error', `Ocorrência duplicada de “${t.description}” em ${t.occurrenceDate}`, [occ.get(k), t.id]);
    else occ.set(k, t.id);
    const r = rules.get(t.recurrenceId);
    if (r && t.status === 'planned' && !occurrences({ ...r, exceptions: {} }, t.occurrenceDate, t.occurrenceDate).length) add('recurrence', 'warn', `Ocorrência prevista de “${t.description}” fora das datas da regra`, [t.id]);
  }
  for (const r of rules.values()) {
    if (r.endDate && r.endDate < r.startDate) add('recurrence', 'error', `Recorrência “${r.description}” termina antes de começar`, []);
    if (r.sourceId && !accounts.has(r.sourceId)) add('recurrence', 'warn', `Recorrência “${r.description}” aponta para conta inexistente`, []);
    if (r.categoryId && !cats.has(r.categoryId)) add('recurrence', 'warn', `Recorrência “${r.description}” aponta para categoria inexistente`, []);
  }
  for (const e of data.investmentEvents || []) if (!invs.has(e.investmentId)) add('orphan', 'warn', 'Registro de investimento sem investimento correspondente', []);
  for (const g of data.goals || []) if (g.investmentId && !invs.has(g.investmentId)) add('orphan', 'warn', `Meta “${g.name}” vinculada a investimento inexistente`, []);
  for (const b of data.budgets || []) {
    const ok = b.scope === 'block' ? blocks.has(b.refId) : cats.has(b.refId);
    if (!ok) add('orphan', 'warn', 'Orçamento aponta para categoria ou bloco inexistente', []);
  }
  const rank = { error: 0, warn: 1, info: 2 };
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
