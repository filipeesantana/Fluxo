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
  // Data a definir só é aceita em compromissos previstos (nunca em algo já pago).
  check(e, isISODate(t.date) || (t.date == null && t.status === 'planned' && t.type !== 'transfer'), t.date == null ? 'um lançamento realizado precisa de data' : 'data inválida');
  check(e, isMonth(t.month), 'competência inválida');
  for (const k of ['categoryId', 'blockId', 'sourceId', 'toAccountId', 'refundOf', 'planId', 'recurrenceId', 'note', 'method', 'forecastId', 'remainderOf']) check(e, optStr(t[k], 500), `${k} inválido`);
  if (t.occurrenceKey != null) check(e, isOccKey(t.occurrenceKey), 'chave de ocorrência inválida');
  if (t.period != null) check(e, isMonth(t.period), 'período inválido');
  if (t.plannedAmount != null) check(e, posCents(t.plannedAmount), 'valor previsto inválido');
  if (t.plannedDate != null) check(e, isISODate(t.plannedDate), 'data prevista inválida');
  if (t.estimated != null) check(e, typeof t.estimated === 'boolean', 'indicador de estimativa inválido');
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

/** Bloco: agrupamento principal; pode ter uma fonte padrão (ex.: Fatura Nubank → Cartão Nubank). */
export function validateBlock(b) {
  const e = validateNamed(b);
  check(e, optStr(b.sourceId, 64), 'fonte do bloco inválida');
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

/** Chaves de ocorrência: 'AAAA-MM-DD' · 'AAAA-MM' · 'AAAA-MM@dia' · 'AAAA-MM#n'. */
export function isOccKey(k) {
  if (typeof k !== 'string' || k.length > 16) return false;
  if (isISODate(k) || isMonth(k)) return true;
  const m = /^(\d{4}-\d{2})([@#])(\d{1,2})$/.exec(k);
  return Boolean(m && isMonth(m[1]) && Number(m[3]) >= 1 && Number(m[3]) <= 31);
}
const RULE_MODES = ['fixed', 'days', 'flex', 'forecast'];

export function validateRecurrence(r) {
  const e = [];
  check(e, isStr(r.id, 64) && r.id, 'id ausente');
  check(e, r.type === 'expense' || r.type === 'income', 'tipo inválido');
  check(e, isStr(r.description, 200) && r.description.trim(), 'descrição obrigatória');
  check(e, posCents(r.amount), 'valor deve ser maior que zero');
  check(e, ['monthly', 'weekly', 'yearly', 'daily'].includes(r.frequency), 'frequência inválida');
  // Intervalo sempre positivo e finito: impede frequência zero/negativa e geração infinita.
  check(e, r.interval == null || (Number.isInteger(r.interval) && r.interval >= 1 && r.interval <= (r.frequency === 'daily' ? 366 : 60)), 'intervalo inválido');
  check(e, r.mode == null || RULE_MODES.includes(r.mode), 'modo de recorrência inválido');
  if (r.mode && r.mode !== 'fixed') check(e, r.frequency === 'monthly', 'este modo só existe para repetição mensal');
  if (r.mode === 'days') check(e, Array.isArray(r.days) && r.days.length >= 1 && r.days.length <= 10 && r.days.every((d) => Number.isInteger(d) && d >= 1 && d <= 31) && new Set(r.days).size === r.days.length, 'dias do mês inválidos');
  if (r.mode === 'flex') check(e, Number.isInteger(r.perPeriod) && r.perPeriod >= 1 && r.perPeriod <= 31, 'quantidade por mês inválida');
  if (r.mode === 'forecast') check(e, r.type === 'expense', 'previsão mensal é só para despesas');
  check(e, r.closed == null || (typeof r.closed === 'object' && !Array.isArray(r.closed) && Object.keys(r.closed).length <= 1200 && Object.keys(r.closed).every(isMonth)), 'meses encerrados inválidos');
  check(e, optStr(r.method, 20) && optStr(r.sourceId, 64), 'fonte ou método inválido');
  check(e, r.estimated == null || typeof r.estimated === 'boolean', 'indicador de estimativa inválido');
  check(e, isISODate(r.startDate), 'data inicial inválida');
  check(e, r.endDate == null || (isISODate(r.endDate) && r.endDate >= r.startDate), 'data final inválida');
  check(e, r.exceptions == null || (typeof r.exceptions === 'object' && !Array.isArray(r.exceptions) && Object.keys(r.exceptions).length <= 5000 && Object.keys(r.exceptions).every(isOccKey) && Object.values(r.exceptions).every((v) => v === 'skipped' || v === 'cancelled')), 'exceções inválidas');
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

/**
 * Cálculo salvo da calculadora. Guarda apenas texto de expressão (gramática
 * aritmética fechada, sem código) e referências estruturadas a dados do Fluxo.
 * Referências nunca apontam para outros cálculos: dependência circular é
 * impossível por construção.
 */
export const CALC_REF_KINDS = ['incomeReceived', 'incomeExpected', 'incomeTotal', 'expenseDone', 'expensePending', 'expenseTotal', 'projectedSurplus', 'availableToInvest', 'freeSurplus', 'patrimony', 'category', 'block', 'source', 'accountBalance', 'goalTarget', 'goalRemaining', 'transaction', 'commitmentLeft'];
export function validateCalculation(c) {
  const e = [];
  check(e, isStr(c.id, 64) && c.id, 'id ausente');
  check(e, isStr(c.name, 80) && c.name.trim(), 'nome inválido');
  check(e, isStr(c.expr, 400) && /^[0-9.,+\-*/×÷−()%\s@de]*$/i.test(c.expr), 'expressão inválida');
  check(e, c.mode === 'static' || c.mode === 'dynamic', 'tipo de cálculo inválido');
  check(e, Array.isArray(c.refs) && c.refs.length <= 12 && c.refs.every((r) => r && isStr(r.id, 8) && /^r\d{1,2}$/.test(r.id) && CALC_REF_KINDS.includes(r.kind) && optStr(r.entityId, 64) && (r.month == null || r.month === 'current' || r.month === 'selected' || isMonth(r.month))), 'referências inválidas');
  check(e, c.value == null || Number.isFinite(c.value), 'resultado inválido');
  check(e, c.values == null || (typeof c.values === 'object' && !Array.isArray(c.values) && Object.values(c.values).every(Number.isFinite)), 'valores de referência inválidos');
  check(e, c.unit == null || c.unit === 'money' || c.unit === 'number' || c.unit === 'percent', 'unidade inválida');
  check(e, c.favorite == null || typeof c.favorite === 'boolean', 'favorito inválido');
  check(e, optStr(c.note, 300), 'observação inválida');
  return e;
}

export const MAX_TEMPLATES = 60;
/** Modelo de lançamento: só um atalho de preenchimento (nunca uma movimentação). */
export function validateTemplate(t) {
  const e = [];
  check(e, t && typeof t === 'object' && !Array.isArray(t), 'modelo inválido');
  if (e.length) return e;
  check(e, isStr(t.id, 64) && t.id, 'id do modelo ausente');
  check(e, ['expense', 'income'].includes(t.type), 'tipo do modelo inválido');
  check(e, isStr(t.description, 200) && t.description.trim(), 'descrição do modelo inválida');
  check(e, t.amount == null || posCents(t.amount), 'valor do modelo inválido');
  for (const k of ['categoryId', 'blockId', 'sourceId', 'note']) check(e, optStr(t[k], 500), `${k} do modelo inválido`);
  check(e, t.repeat == null || ['none', 'weekly', 'biweekly', 'monthly', 'yearly'].includes(t.repeat), 'repetição do modelo inválida');
  return e;
}

export function validateMeta(m) {
  if (!(typeof m.key === 'string' && m.key)) return ['chave ausente'];
  if (m.key === 'templates') {
    if (!Array.isArray(m.value) || m.value.length > MAX_TEMPLATES) return ['modelos inválidos'];
    return m.value.flatMap(validateTemplate);
  }
  return [];
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
  blocks: guarded(validateBlock),
  accounts: guarded(validateAccount),
  recurrences: guarded(validateRecurrence),
  installmentPlans: guarded(validatePlan),
  budgets: guarded(validateBudget),
  investments: guarded(validateInvestment),
  investmentEvents: guarded(validateEvent),
  goals: guarded(validateGoal),
  calculations: guarded(validateCalculation),
  meta: guarded(validateMeta, META_LIMITS),
};

export function normalizeName(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

export function sameName(a, b) {
  return normalizeName(a).localeCompare(normalizeName(b), 'pt-BR', { sensitivity: 'base' }) === 0;
}
