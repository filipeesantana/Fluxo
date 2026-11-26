import { isISODate, isMonth } from '../utils/dates.js';

const TYPES = ['expense', 'income', 'transfer', 'refund'];
const STATUS = ['done', 'planned'];
const ACCOUNT_KINDS = ['checking', 'savings', 'cash', 'credit', 'benefit', 'other'];
export const METHODS = { pix: 'Pix', debit: 'Débito', boleto: 'Boleto', cash: 'Dinheiro', transfer: 'TED/DOC', auto: 'Débito automático' };

const isStr = (v, max = 200) => typeof v === 'string' && v.length <= max;
const optStr = (v, max = 200) => v == null || isStr(v, max);
const isCents = (v) => Number.isSafeInteger(v);
const posCents = (v) => Number.isSafeInteger(v) && v > 0;
const optDay = (v) => v == null || (Number.isInteger(v) && v >= 1 && v <= 31);

function check(errors, cond, msg) { if (!cond) errors.push(msg); }

export function validateTransaction(t) {
  const e = [];
  check(e, isStr(t.id, 64) && t.id, 'id ausente');
  check(e, TYPES.includes(t.type), 'tipo inválido');
  check(e, STATUS.includes(t.status), 'situação inválida');
  check(e, isStr(t.description, 200), 'descrição inválida');
  check(e, posCents(t.amount), 'valor deve ser maior que zero');
  check(e, isISODate(t.date), 'data inválida');
  check(e, isMonth(t.month), 'competência inválida');
  for (const k of ['categoryId', 'blockId', 'sourceId', 'toAccountId', 'refundOf', 'planId', 'recurrenceId', 'note', 'method']) check(e, optStr(t[k], 500), `${k} inválido`);
  if (t.type === 'transfer') {
    check(e, t.sourceId && t.toAccountId, 'transferência precisa de origem e destino');
    check(e, t.sourceId !== t.toAccountId, 'origem e destino iguais');
  }
  if (t.occurrenceDate != null) check(e, isISODate(t.occurrenceDate), 'data de ocorrência inválida');
  if (t.billMonth != null) check(e, isMonth(t.billMonth), 'mês de fatura inválido');
  if (t.installment != null) check(e, Number.isInteger(t.installment.index) && Number.isInteger(t.installment.count) && t.installment.index >= 1 && t.installment.index <= t.installment.count, 'parcela inválida');
  return e;
}

export function validateNamed(x) {
  const e = [];
  check(e, isStr(x.id, 64) && x.id, 'id ausente');
  check(e, isStr(x.name, 80) && x.name.trim(), 'nome inválido');
  return e;
}

export function validateCategory(c) {
  const e = validateNamed(c);
  check(e, c.type === 'expense' || c.type === 'income', 'tipo de categoria inválido');
  return e;
}

export function validateAccount(a) {
  const e = validateNamed(a);
  check(e, ACCOUNT_KINDS.includes(a.kind), 'tipo de conta inválido');
  check(e, optDay(a.closingDay) && optDay(a.dueDay), 'dia de fechamento/vencimento inválido');
  check(e, a.limit == null || isCents(a.limit), 'limite inválido');
  check(e, a.openingBalance == null || isCents(a.openingBalance), 'saldo inicial inválido');
  return e;
}

export function validateRecurrence(r) {
  const e = [];
  check(e, isStr(r.id, 64) && r.id, 'id ausente');
  check(e, r.type === 'expense' || r.type === 'income', 'tipo inválido');
  check(e, isStr(r.description, 200) && r.description.trim(), 'descrição obrigatória');
  check(e, posCents(r.amount), 'valor deve ser maior que zero');
  check(e, ['monthly', 'weekly', 'yearly'].includes(r.frequency), 'frequência inválida');
  check(e, r.interval == null || (Number.isInteger(r.interval) && r.interval >= 1 && r.interval <= 60), 'intervalo inválido');
  check(e, isISODate(r.startDate), 'data inicial inválida');
  check(e, r.endDate == null || (isISODate(r.endDate) && r.endDate >= r.startDate), 'data final inválida');
  check(e, r.exceptions == null || (typeof r.exceptions === 'object' && !Array.isArray(r.exceptions) && Object.keys(r.exceptions).length <= 5000 && Object.keys(r.exceptions).every(isISODate)), 'exceções inválidas');
  check(e, r.anchorDay == null || (Number.isInteger(r.anchorDay) && r.anchorDay >= 1 && r.anchorDay <= 31), 'dia de referência inválido');
  check(e, r.count == null || (Number.isInteger(r.count) && r.count >= 1 && r.count <= 1000), 'quantidade de repetições inválida');
  check(e, r.pauses == null || (Array.isArray(r.pauses) && r.pauses.length <= 100 && r.pauses.every((p) => p && isISODate(p.from) && (p.to == null || (isISODate(p.to) && p.to >= p.from)))), 'pausas inválidas');
  return e;
}

export function validatePlan(p) {
  const e = [];
  check(e, isStr(p.id, 64) && p.id, 'id ausente');
  check(e, posCents(p.total), 'total inválido');
  check(e, Number.isInteger(p.count) && p.count >= 2 && p.count <= 120, 'parcelas inválidas');
  check(e, isISODate(p.purchaseDate), 'data da compra inválida');
  check(e, isMonth(p.firstMonth), 'primeira competência inválida');
  return e;
}

export function validateBudget(b) {
  const e = [];
  check(e, isStr(b.id, 64) && b.id, 'id ausente');
  check(e, b.scope === 'category' || b.scope === 'block', 'escopo inválido');
  check(e, isStr(b.refId, 64) && b.refId, 'referência ausente');
  check(e, posCents(b.amount), 'limite inválido');
  return e;
}

export function validateInvestment(i) {
  const e = validateNamed(i);
  check(e, i.annualRate == null || (typeof i.annualRate === 'number' && i.annualRate > -100 && i.annualRate < 1000), 'rentabilidade inválida');
  return e;
}

export function validateEvent(ev) {
  const e = [];
  check(e, isStr(ev.id, 64) && ev.id, 'id ausente');
  check(e, isStr(ev.investmentId, 64), 'investimento ausente');
  check(e, ['balance', 'contribution', 'withdrawal'].includes(ev.type), 'tipo de evento inválido');
  check(e, ev.type === 'balance' ? isCents(ev.amount) && ev.amount >= 0 : posCents(ev.amount), 'valor inválido');
  check(e, isISODate(ev.date), 'data inválida');
  check(e, optStr(ev.accountId, 64), 'conta inválida');
  return e;
}

export function validateGoal(g) {
  const e = validateNamed(g);
  check(e, posCents(g.target), 'valor desejado inválido');
  check(e, isCents(g.initial || 0) && (g.initial || 0) >= 0, 'patrimônio inicial inválido');
  check(e, isCents(g.monthly || 0) && (g.monthly || 0) >= 0, 'aporte mensal inválido');
  check(e, g.annualRate == null || (typeof g.annualRate === 'number' && g.annualRate > -100 && g.annualRate < 1000), 'rentabilidade inválida');
  check(e, g.rateMode == null || g.rateMode === 'annual' || g.rateMode === 'monthly', 'tipo de taxa inválido');
  check(e, g.extras == null || (Array.isArray(g.extras) && g.extras.every((x) => x && isMonth(x.month) && posCents(x.amount))), 'aportes extraordinários inválidos');
  check(e, isMonth(g.startMonth), 'mês inicial inválido');
  check(e, g.deadline == null || isMonth(g.deadline), 'prazo inválido');
  return e;
}

export function validateMeta(m) {
  return typeof m.key === 'string' && m.key ? [] : ['chave ausente'];
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_RECORD_CHARS = 20000;

/**
 * Proteção estrutural aplicada a TODO registro antes de gravar ou importar:
 * objeto simples, sem chaves capazes de poluir protótipos, profundidade e
 * tamanho limitados, números finitos. Dados de backups são sempre tratados
 * como dados, nunca como código.
 */
export function structuralErrors(rec, { maxDepth = 6, maxChars = MAX_RECORD_CHARS } = {}) {
  const e = [];
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return ['registro não é um objeto'];
  const proto = Object.getPrototypeOf(rec);
  if (proto !== Object.prototype && proto !== null) return ['registro com tipo inesperado'];
  const walk = (v, depth) => {
    if (depth > maxDepth) { e.push('estrutura profunda demais'); return; }
    if (typeof v === 'number' && !Number.isFinite(v)) { e.push('número inválido'); return; }
    if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') { e.push('tipo de valor não permitido'); return; }
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (FORBIDDEN_KEYS.has(k)) { e.push(`chave não permitida: ${k}`); return; }
        walk(v[k], depth + 1);
      }
    }
  };
  walk(rec, 0);
  if (!e.length) {
    let size = 0;
    try { size = JSON.stringify(rec).length; } catch { e.push('registro não serializável'); }
    if (size > maxChars) e.push('registro grande demais');
  }
  if (rec.rev != null && !(Number.isInteger(rec.rev) && rec.rev >= 0)) e.push('revisão inválida');
  return [...new Set(e)];
}

// Metadados (preferências, layout da personalização) têm estrutura mais aninhada
// que os registros financeiros, mas continuam limitados em profundidade e tamanho.
const META_LIMITS = { maxDepth: 12, maxChars: 200000 };
const guarded = (fn, limits) => (rec) => {
  const s = structuralErrors(rec, limits);
  return s.length ? s : fn(rec);
};

export const VALIDATORS = {
  transactions: guarded(validateTransaction),
  categories: guarded(validateCategory),
  blocks: guarded(validateNamed),
  accounts: guarded(validateAccount),
  recurrences: guarded(validateRecurrence),
  installmentPlans: guarded(validatePlan),
  budgets: guarded(validateBudget),
  investments: guarded(validateInvestment),
  investmentEvents: guarded(validateEvent),
  goals: guarded(validateGoal),
  meta: guarded(validateMeta, META_LIMITS),
};

export function normalizeName(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

export function sameName(a, b) {
  return normalizeName(a).localeCompare(normalizeName(b), 'pt-BR', { sensitivity: 'base' }) === 0;
}
