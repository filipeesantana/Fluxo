import { openDB, loadAll, loadRecent, loadOlder, getByKeys, commit, replaceAll, listSnapshots, requestPersistence, setVersionChangeHandler } from './db.js';
import { STORES } from './schema.js';
import { VALIDATORS, normalizeName, sameName } from '../services/validation.js';
import { competenceOf, isCard, billFor } from '../services/cards.js';
import { buildInstallments } from '../services/installments.js';
import { endDateForCount } from '../services/recurrence.js';
import { createContext } from '../services/finance.js';
import { today, addDays, currentMonth, monthOf, addMonths } from '../utils/dates.js';
import { uid } from '../utils/dom.js';

const DEFAULT_CATEGORIES = {
  expense: ['Alimentação', 'Moradia', 'Transporte', 'Saúde', 'Educação', 'Lazer', 'Assinaturas', 'Compras', 'Serviços', 'Outros'],
  income: ['Salário', 'Benefícios', 'Renda extra', 'Outras receitas'],
};

const listeners = new Set();
const channel = 'BroadcastChannel' in globalThis ? new BroadcastChannel('guia-financeiro.sync') : null;
const data = Object.fromEntries(STORES.map((s) => [s, new Map()]));
let ctxCache = null;

export const db = { data };

export class ValidationError extends Error {}

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function notify(origin = 'local') {
  ctxCache = null;
  for (const fn of listeners) fn(origin);
}

function keyOf(store, row) { return store === 'meta' ? row.key : row.id; }

function setMemory(rows) {
  for (const [store, row] of rows) data[store].set(keyOf(store, row), row);
}

let fullyLoaded = false;
let fullLoad = null;

async function reloadFromDB() {
  const all = await loadAll();
  for (const s of STORES) {
    data[s].clear();
    for (const row of all[s] || []) data[s].set(keyOf(s, row), row);
  }
  fullyLoaded = true;
}

/** Indica se o histórico antigo já foi carregado (saldos e exportações dependem disso). */
export const isFullyLoaded = () => fullyLoaded;
export function whenFullyLoaded() { return fullyLoaded ? Promise.resolve() : fullLoad; }

export async function init() {
  setVersionChangeHandler(() => {
    dbClosed = true;
    for (const fn of listeners) fn('versionchange');
  });
  await openDB();
  // Fase 1: últimos 13 meses + futuro (o suficiente para abrir a aplicação).
  const cutoff = addMonths(currentMonth(), -13);
  const recent = await loadRecent(`${cutoff}`);
  for (const s of STORES) {
    data[s].clear();
    for (const row of recent[s] || []) data[s].set(keyOf(s, row), row);
  }
  // Fase 2: histórico antigo em segundo plano; registros já presentes têm precedência.
  fullLoad = loadOlder(cutoff).then((rows) => {
    for (const row of rows) if (!data.transactions.has(row.id)) data.transactions.set(row.id, row);
    fullyLoaded = true;
    notify('loaded');
  }).catch(async () => { await reloadFromDB(); notify('loaded'); });
  if (!data.meta.get('seeded')) await seed();
  if (channel) {
    channel.onmessage = async (ev) => {
      try {
        const msg = ev.data || {};
        if (msg.t === 'lock') { writeLock = msg.reason || 'restore'; notify('lock'); return; }
        if (msg.t === 'unlock') { writeLock = null; notify('lock'); return; }
        if (msg.t === 'ops' && Array.isArray(msg.ops)) {
          // Sincronização incremental: relê apenas os registros alterados.
          const byStore = new Map();
          for (const o of msg.ops) { if (!byStore.has(o.store)) byStore.set(o.store, []); byStore.get(o.store).push(o.key); }
          for (const [store, keys] of byStore) {
            if (!data[store]) continue;
            const rows = await getByKeys(store, keys);
            for (const [k, row] of rows) { if (row) data[store].set(k, row); else data[store].delete(k); }
          }
        } else {
          await whenFullyLoaded();
          await reloadFromDB();
          writeLock = null;
        }
        notify('remote');
      } catch { /* aba antiga: ignora */ }
    };
  }
}

async function seed() {
  const ops = [];
  let order = 0;
  for (const [type, names] of Object.entries(DEFAULT_CATEGORIES)) {
    for (const name of names) {
      if ([...data.categories.values()].some((c) => c.type === type && sameName(c.name, name))) continue;
      ops.push({ store: 'categories', put: { id: uid(), name, type, archived: false, order: order++, createdAt: Date.now() } });
    }
  }
  ops.push({ store: 'meta', put: { key: 'seeded', value: true, at: Date.now() } });
  await apply(ops);
}

/** Valida, grava atomicamente no IndexedDB e só então atualiza a memória. */
// Estado da camada de dados nesta aba.
let writeLock = null;   // motivo do bloqueio (ex.: restauração em outra aba)
let dbClosed = false;   // banco fechado por atualização de versão em outra aba

export const writeBlockedReason = () => writeLock || (dbClosed ? 'closed' : null);

function assertWritable() {
  if (dbClosed) throw new ValidationError('O banco foi atualizado por outra aba. Recarregue esta página antes de continuar; nada foi gravado.');
  if (writeLock) throw new ValidationError('Há uma restauração de backup em andamento em outra aba. Aguarde a conclusão; nada foi gravado.');
}

/**
 * Valida, grava atomicamente no IndexedDB e só então atualiza a memória.
 * Cada registro financeiro carrega uma revisão (`rev`). A gravação exige que o
 * banco ainda tenha a revisão que esta aba conhece: se outra aba alterou ou
 * excluiu o registro nesse meio tempo, nada é gravado (ConflictError).
 */
async function apply(ops, { broadcast = true, silent = false } = {}) {
  assertWritable();
  const prepared = ops.map((op) => {
    if (op.store === 'meta') return op;
    const key = op.put ? keyOf(op.store, op.put) : op.del;
    const prev = data[op.store].get(key);
    const expectRev = prev ? (prev.rev || 0) : 'absent';
    if (op.put) return { ...op, expectRev, put: { ...op.put, rev: (prev?.rev || 0) + 1 } };
    return prev ? { ...op, expectRev } : op;
  });
  for (const op of prepared) {
    if (!op.put) continue;
    const errs = VALIDATORS[op.store](op.put);
    if (errs.length) throw new ValidationError(errs.join('; '));
  }
  try {
    await commit(prepared);
  } catch (err) {
    if (err?.name === 'ConflictError') {
      // Atualiza a memória com o estado real do banco para o usuário revisar.
      const fresh = await getByKeys(err.store, [err.key]).catch(() => null);
      const row = fresh?.get(err.key);
      if (row) data[err.store].set(err.key, row); else if (fresh) data[err.store].delete(err.key);
      notify('conflict');
      throw new ValidationError(`${err.message} A tela foi atualizada com a versão mais recente; revise e tente novamente. Nada foi gravado.`);
    }
    throw err;
  }
  for (const op of prepared) {
    if (op.put) data[op.store].set(keyOf(op.store, op.put), op.put);
    else data[op.store].delete(op.del);
  }
  if (silent) ctxCache = null; else notify();
  if (broadcast) channel?.postMessage({ t: 'ops', ops: ops.map((op) => ({ store: op.store, key: op.put ? keyOf(op.store, op.put) : op.del })) });
  if (!data.meta.get('persistAsked')) {
    data.meta.set('persistAsked', { key: 'persistAsked', value: true });
    requestPersistence().then((status) => commit([{ store: 'meta', put: { key: 'persistAsked', value: status } }]).catch(() => {}));
  }
}

// ——— Consultas ———

export const list = (store) => [...data[store].values()];
export const get = (store, id) => data[store].get(id);

export function prefs() {
  return { safetyMargin: 0, ...(data.meta.get('prefs')?.value || {}) };
}

export function context() {
  if (ctxCache && ctxCache.today === today()) return ctxCache;
  ctxCache = createContext({
    transactions: list('transactions'),
    recurrences: list('recurrences'),
    accounts: list('accounts'),
    investmentEvents: list('investmentEvents'),
    budgets: list('budgets'),
    goals: list('goals'),
    prefs: prefs(),
    today: today(),
  });
  ctxCache.complete = fullyLoaded;
  return ctxCache;
}

export function activeList(store, filter = () => true) {
  return list(store).filter((x) => !x.archived && filter(x)).sort(byOrderThenName);
}

function byOrderThenName(a, b) {
  return (a.order ?? 1e9) - (b.order ?? 1e9) || a.name.localeCompare(b.name, 'pt-BR');
}

export function isEmpty() {
  return data.transactions.size === 0 && data.recurrences.size === 0 && data.accounts.size === 0;
}

// ——— Movimentações ———

export function normalizeTransaction(input, previous) {
  const now = Date.now();
  const tx = {
    ...(previous || {}),
    ...input,
    id: input.id || previous?.id || uid(),
    description: String(input.description ?? previous?.description ?? '').trim().slice(0, 200),
    categoryId: input.categoryId || null,
    blockId: input.blockId || null,
    sourceId: input.sourceId || null,
    createdAt: previous?.createdAt || input.createdAt || now,
    updatedAt: now,
  };
  if (tx.type !== 'transfer') { delete tx.toAccountId; delete tx.billMonth; }
  if (tx.type === 'transfer') { tx.categoryId = null; tx.blockId = null; }
  const acc = data.accounts.get(tx.sourceId);
  if (tx.type === 'income') tx.restricted = Boolean(input.restricted) || acc?.kind === 'benefit';
  else delete tx.restricted;
  if (tx.type === 'transfer') {
    const to = data.accounts.get(tx.toAccountId);
    if (isCard(to)) tx.billMonth = tx.billMonth || monthOf(tx.date);
    else delete tx.billMonth;
  }
  if (!tx.monthManual) tx.month = competenceOf(tx, acc);
  if (!tx.description) tx.description = defaultDescription(tx);
  return tx;
}

function defaultDescription(tx) {
  if (tx.type === 'transfer') {
    const to = data.accounts.get(tx.toAccountId);
    return isCard(to) ? `Pagamento da fatura ${to.name}` : `Transferência para ${to?.name || 'conta'}`;
  }
  return data.categories.get(tx.categoryId)?.name || (tx.type === 'income' ? 'Receita' : 'Despesa');
}

/**
 * opts.baseRev: revisão em que a edição foi baseada (formulário aberto). Se o
 * registro mudou desde então — em outra aba, por exemplo — a gravação é
 * recusada em vez de sobrescrever a alteração mais recente.
 */
export async function saveTransaction(input, { baseRev } = {}) {
  const prev = input.id ? data.transactions.get(input.id) : null;
  if (baseRev !== undefined && prev && (prev.rev || 0) !== (baseRev || 0)) {
    throw new ValidationError('Este lançamento foi alterado em outra aba enquanto você editava. Feche o formulário e abra novamente para ver a versão atual; nada foi gravado.');
  }
  if (baseRev !== undefined && !prev && input.id && baseRev !== null) {
    throw new ValidationError('Este lançamento foi excluído em outra aba enquanto você editava; nada foi gravado.');
  }
  const tx = normalizeTransaction(input, prev);
  if (tx.recurrenceId && tx.occurrenceDate) {
    const clash = list('transactions').find((t) => t.id !== tx.id && t.recurrenceId === tx.recurrenceId && t.occurrenceDate === tx.occurrenceDate);
    if (clash) tx.id = clash.id; // nunca cria duas ocorrências para a mesma data
  }
  await apply([{ store: 'transactions', put: tx }]);
  return tx;
}

export async function deleteTransaction(id) {
  const tx = data.transactions.get(id);
  if (!tx) return null;
  const ops = [{ store: 'transactions', del: id }];
  // Reembolsos vinculados perdem o vínculo, mas continuam existindo.
  for (const r of list('transactions')) if (r.refundOf === id) ops.push({ store: 'transactions', put: { ...r, refundOf: null, updatedAt: Date.now() } });
  await apply(ops);
  return tx;
}

export async function restoreTransactions(rows) {
  await apply(rows.map((r) => ({ store: 'transactions', put: r })));
}

export async function setStatus(id, status) {
  const tx = data.transactions.get(id);
  if (!tx) return;
  await apply([{ store: 'transactions', put: { ...tx, status, updatedAt: Date.now() } }]);
}

export async function duplicateTransaction(id, overrides = {}) {
  const tx = data.transactions.get(id);
  if (!tx) return null;
  const { id: _, recurrenceId, occurrenceDate, planId, installment, createdAt, ...rest } = tx;
  return saveTransaction({ ...rest, ...overrides, monthManual: false });
}

// ——— Recorrências ———

export async function saveRecurrence(input) {
  const prev = input.id ? data.recurrences.get(input.id) : null;
  const rule = {
    ...(prev || {}),
    ...input,
    id: input.id || uid(),
    description: String(input.description || '').trim().slice(0, 200),
    interval: input.interval || 1,
    endDate: input.endDate || null,
    categoryId: input.categoryId || null,
    blockId: input.blockId || null,
    sourceId: input.sourceId || null,
    exceptions: input.exceptions || prev?.exceptions || {},
    createdAt: prev?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  finalizeRule(rule);
  await apply([{ store: 'recurrences', put: rule }]);
  return rule;
}

/** Normaliza campos derivados de uma regra (âncora do dia, quantidade → data final, benefício). */
function finalizeRule(rule) {
  if (rule.frequency !== 'weekly' && !rule.anchorDay) rule.anchorDay = Number(rule.startDate.slice(8, 10));
  if (rule.frequency === 'weekly') delete rule.anchorDay;
  if (rule.count) rule.endDate = endDateForCount(rule, rule.count);
  if (rule.type === 'income') rule.restricted = Boolean(rule.restricted) || data.accounts.get(rule.sourceId)?.kind === 'benefit';
  if (!rule.pauses?.length) delete rule.pauses;
  return rule;
}

/**
 * Cria a regra e, opcionalmente, sua primeira ocorrência já realizada, em UMA
 * transação: nunca fica uma regra sem a ocorrência paga (ou o contrário).
 * Idempotente pelo id da regra.
 */
export async function createRecurrence(input, firstOccurrence = null) {
  if (input.id && data.recurrences.has(input.id)) return data.recurrences.get(input.id);
  const rule = finalizeRule({
    ...input, id: input.id || uid(), description: String(input.description || '').trim().slice(0, 200), interval: input.interval || 1,
    endDate: input.endDate || null, categoryId: input.categoryId || null, blockId: input.blockId || null, sourceId: input.sourceId || null,
    exceptions: {}, createdAt: Date.now(), updatedAt: Date.now(),
  });
  const ops = [{ store: 'recurrences', put: rule }];
  if (firstOccurrence) {
    const date = firstOccurrence.date || rule.startDate;
    ops.push({ store: 'transactions', put: normalizeTransaction({
      type: rule.type, description: rule.description, amount: rule.amount, date, categoryId: rule.categoryId, blockId: rule.blockId,
      sourceId: rule.sourceId, restricted: rule.restricted, ...firstOccurrence, id: `${rule.id}:${date}`, recurrenceId: rule.id, occurrenceDate: date,
    }) });
  }
  await apply(ops);
  return rule;
}

/**
 * Transforma um lançamento existente em recorrente: a regra começa na data do
 * lançamento e o próprio lançamento passa a ser a primeira ocorrência
 * (nenhuma cópia é criada).
 */
export async function convertToRecurring(txId, { frequency = 'monthly', interval = 1, endDate = null, count = null } = {}) {
  const tx = data.transactions.get(txId);
  if (!tx) throw new ValidationError('Lançamento não encontrado.');
  if (tx.recurrenceId) throw new ValidationError('Este lançamento já faz parte de uma recorrência.');
  if (tx.planId) throw new ValidationError('Parcelas não podem virar recorrência; use o parcelamento.');
  if (tx.type === 'transfer' || tx.type === 'refund') throw new ValidationError('Somente receitas e despesas podem ser recorrentes.');
  const rule = finalizeRule({
    id: uid(), type: tx.type, description: tx.description, amount: tx.amount, startDate: tx.date, endDate, count: count || undefined,
    frequency, interval, categoryId: tx.categoryId, blockId: tx.blockId, sourceId: tx.sourceId, restricted: tx.restricted,
    exceptions: {}, createdAt: Date.now(), updatedAt: Date.now(),
  });
  if (!rule.count) delete rule.count;
  await apply([
    { store: 'recurrences', put: rule },
    { store: 'transactions', put: { ...tx, recurrenceId: rule.id, occurrenceDate: tx.date, updatedAt: Date.now() } },
  ]);
  return rule;
}

/** Pausa a série a partir de `fromDate` (ocorrências futuras deixam de ser projetadas). */
export async function pauseRecurrence(ruleId, fromDate) {
  const rule = data.recurrences.get(ruleId);
  if (!rule) return;
  const pauses = [...(rule.pauses || []).filter((p) => p.to), { from: fromDate, to: null }];
  const ops = [{ store: 'recurrences', put: { ...rule, pauses, updatedAt: Date.now() } }];
  for (const t of list('transactions')) if (t.recurrenceId === ruleId && t.occurrenceDate >= fromDate && t.status === 'planned') ops.push({ store: 'transactions', del: t.id });
  await apply(ops);
}

/** Retoma a série: ocorrências a partir de `date` voltam a ser projetadas. */
export async function resumeRecurrence(ruleId, date) {
  const rule = data.recurrences.get(ruleId);
  if (!rule) return;
  const pauses = (rule.pauses || []).map((p) => (p.to ? p : { from: p.from, to: addDays(date, -1) < p.from ? p.from : addDays(date, -1) }));
  await apply([{ store: 'recurrences', put: { ...rule, pauses, updatedAt: Date.now() } }]);
}

export const isRulePaused = (rule) => (rule.pauses || []).some((p) => !p.to);

const existingOcc = (ruleId, date) => list('transactions').find((t) => t.recurrenceId === ruleId && t.occurrenceDate === date);

function occurrenceTx(rule, date, overrides = {}) {
  return normalizeTransaction({
    type: rule.type, status: 'planned', description: rule.description, amount: rule.amount, date,
    categoryId: rule.categoryId, blockId: rule.blockId, sourceId: rule.sourceId, restricted: rule.restricted,
    recurrenceId: rule.id, occurrenceDate: date, ...overrides,
    // Identidade determinística: a mesma ocorrência sempre tem o mesmo id,
    // mesmo que valor ou data sejam ajustados depois.
    id: existingOcc(rule.id, date)?.id || `${rule.id}:${date}`,
  }, existingOcc(rule.id, date));
}

/** Transforma uma ocorrência projetada em movimentação real (paga ou editada). */
export async function materializeOccurrence(ruleId, date, overrides) {
  const rule = data.recurrences.get(ruleId);
  if (!rule) throw new ValidationError('Recorrência não encontrada');
  const tx = occurrenceTx(rule, date, overrides);
  await apply([{ store: 'transactions', put: tx }]);
  return tx;
}

/**
 * Ignora a ocorrência de `date`. Por padrão só remove a versão prevista;
 * com removeDone (exclusão pedida explicitamente) remove também a realizada.
 */
export async function skipOccurrence(ruleId, date, { removeDone = false } = {}) {
  const rule = data.recurrences.get(ruleId);
  if (!rule) return;
  const ops = [{ store: 'recurrences', put: { ...rule, exceptions: { ...(rule.exceptions || {}), [date]: 'skipped' }, updatedAt: Date.now() } }];
  const mat = list('transactions').find((t) => t.recurrenceId === ruleId && t.occurrenceDate === date && (removeDone || t.status === 'planned'));
  if (mat) ops.push({ store: 'transactions', del: mat.id });
  await apply(ops);
}

/** Desfaz a exclusão de uma ocorrência (volta a exceção e o lançamento, atomicamente). */
export async function restoreOccurrence(ruleId, tx) {
  const rule = data.recurrences.get(ruleId);
  if (!rule) return restoreTransactions([tx]);
  const exceptions = { ...(rule.exceptions || {}) };
  delete exceptions[tx.occurrenceDate];
  await apply([{ store: 'recurrences', put: { ...rule, exceptions, updatedAt: Date.now() } }, { store: 'transactions', put: tx }]);
}

export async function unskipOccurrence(ruleId, date) {
  const rule = data.recurrences.get(ruleId);
  if (!rule) return;
  const exceptions = { ...(rule.exceptions || {}) };
  delete exceptions[date];
  await apply([{ store: 'recurrences', put: { ...rule, exceptions, updatedAt: Date.now() } }]);
}

/** Encerra a série a partir de `fromDate` (inclusive). Ocorrências já pagas são preservadas. */
export async function endSeries(ruleId, fromDate, { removeDoneFrom = null } = {}) {
  const rule = data.recurrences.get(ruleId);
  if (!rule) return;
  const ops = [];
  if (removeDoneFrom) {
    const own = list('transactions').find((t) => t.recurrenceId === ruleId && t.occurrenceDate === removeDoneFrom && t.status === 'done');
    if (own) ops.push({ store: 'transactions', del: own.id });
  }
  const endDate = addDays(fromDate, -1);
  if (endDate < rule.startDate) ops.push({ store: 'recurrences', put: { ...rule, archived: true, endDate: rule.startDate, updatedAt: Date.now() } });
  else ops.push({ store: 'recurrences', put: { ...rule, endDate, updatedAt: Date.now() } });
  for (const t of list('transactions')) {
    if (t.recurrenceId === ruleId && t.occurrenceDate >= fromDate && t.status === 'planned') ops.push({ store: 'transactions', del: t.id });
  }
  await apply(ops);
}

/** Altera a série a partir de `fromDate`: encerra a regra atual e cria a continuação. */
export async function editSeriesFrom(ruleId, fromDate, changes) {
  const rule = data.recurrences.get(ruleId);
  if (!rule) return null;
  if (fromDate <= rule.startDate) return saveRecurrence({ ...rule, ...changes, id: rule.id });
  const nextId = uid();
  const exceptions = Object.fromEntries(Object.entries(rule.exceptions || {}).filter(([d]) => d >= fromDate));
  // A continuação preserva o dia de referência (ex.: 31) mesmo começando em um mês curto.
  const next = { ...rule, ...changes, id: nextId, startDate: changes.startDate || fromDate, exceptions, anchorDay: changes.anchorDay || rule.anchorDay || Number(rule.startDate.slice(8, 10)), createdAt: Date.now(), updatedAt: Date.now() };
  delete next.count;
  next.endDate = changes.endDate !== undefined ? changes.endDate : rule.endDate;
  if (next.endDate && next.endDate < next.startDate) next.endDate = null;
  const ops = [
    { store: 'recurrences', put: { ...rule, endDate: addDays(fromDate, -1), updatedAt: Date.now() } },
    { store: 'recurrences', put: finalizeRule({ ...next, description: String(next.description).trim() }) },
  ];
  for (const t of list('transactions')) {
    if (t.recurrenceId !== ruleId || t.occurrenceDate < fromDate) continue;
    if (t.status === 'planned') ops.push({ store: 'transactions', del: t.id });
    else ops.push({ store: 'transactions', put: { ...t, recurrenceId: nextId, updatedAt: Date.now() } });
  }
  await apply(ops);
  return next;
}

export async function deleteRecurrence(ruleId) {
  const rule = data.recurrences.get(ruleId);
  if (!rule) return;
  const ops = [{ store: 'recurrences', del: ruleId }];
  for (const t of list('transactions')) {
    if (t.recurrenceId !== ruleId) continue;
    // Pagas permanecem como histórico; previstas materializadas são removidas.
    if (t.status === 'planned') ops.push({ store: 'transactions', del: t.id });
    else ops.push({ store: 'transactions', put: { ...t, recurrenceId: null, occurrenceDate: null, updatedAt: Date.now() } });
  }
  await apply(ops);
}

// ——— Parcelamentos ———

export async function createInstallmentPlan(input) {
  const acc = data.accounts.get(input.sourceId);
  const firstMonth = input.firstMonth || (isCard(acc) ? billFor(input.purchaseDate, acc).month : monthOf(input.purchaseDate));
  if (input.id && data.installmentPlans.has(input.id)) return data.installmentPlans.get(input.id); // idempotente
  const plan = {
    id: input.id || uid(),
    description: String(input.description || '').trim().slice(0, 200) || 'Compra parcelada',
    total: input.total, count: input.count, purchaseDate: input.purchaseDate, firstMonth,
    sourceId: input.sourceId || null, categoryId: input.categoryId || null, blockId: input.blockId || null,
    createdAt: Date.now(),
  };
  const parcels = buildInstallments({ total: plan.total, count: plan.count, firstMonth });
  const ops = [{ store: 'installmentPlans', put: plan }];
  const cm = currentMonth();
  for (const p of parcels) {
    const status = isCard(acc) ? 'done' : (input.firstPaid && p.index === 1) || (input.markPastPaid && p.month < cm) ? 'done' : 'planned';
    ops.push({ store: 'transactions', put: normalizeTransaction({
      id: `${plan.id}-p${p.index}`,
      type: 'expense', status, description: plan.description, amount: p.amount, date: plan.purchaseDate,
      month: p.month, monthManual: true, sourceId: plan.sourceId, categoryId: plan.categoryId, blockId: plan.blockId, method: input.method || null,
      planId: plan.id, installment: { index: p.index, count: p.count },
    }) });
  }
  await apply(ops);
  return plan;
}

export async function updatePlan(planId, changes) {
  const plan = data.installmentPlans.get(planId);
  if (!plan) return;
  const next = { ...plan, ...changes, description: String(changes.description ?? plan.description).trim() || plan.description, updatedAt: Date.now() };
  const ops = [{ store: 'installmentPlans', put: next }];
  for (const t of list('transactions')) {
    if (t.planId !== planId) continue;
    ops.push({ store: 'transactions', put: { ...t, description: next.description, categoryId: next.categoryId || null, blockId: next.blockId || null, updatedAt: Date.now() } });
  }
  await apply(ops);
}

/** Cancela parcelas futuras não liquidadas; o histórico já pago permanece intacto. */
export async function cancelPlan(planId, isSettled) {
  const plan = data.installmentPlans.get(planId);
  if (!plan) return 0;
  const cm = currentMonth();
  const ops = [];
  let removed = 0;
  for (const t of list('transactions')) {
    if (t.planId !== planId) continue;
    if (t.month >= cm && !isSettled(t)) { ops.push({ store: 'transactions', del: t.id }); removed++; }
  }
  ops.push({ store: 'installmentPlans', put: { ...plan, cancelledAt: today(), updatedAt: Date.now() } });
  await apply(ops);
  return removed;
}

export async function deletePlan(planId) {
  const ops = [{ store: 'installmentPlans', del: planId }];
  for (const t of list('transactions')) if (t.planId === planId) ops.push({ store: 'transactions', del: t.id });
  await apply(ops);
}

// ——— Categorias, blocos e contas ———

export function findByName(store, name, extra = () => true) {
  return list(store).find((x) => sameName(x.name, name) && extra(x));
}

export async function createNamed(store, fields) {
  const name = normalizeName(fields.name);
  if (!name) throw new ValidationError('Informe um nome');
  const existing = findByName(store, name, (x) => (store !== 'categories' || x.type === fields.type));
  if (existing) {
    if (existing.archived) await saveNamed(store, { ...existing, archived: false });
    return existing;
  }
  const row = { ...fields, id: uid(), name, archived: false, createdAt: Date.now() };
  await apply([{ store, put: row }]);
  return row;
}

export async function saveNamed(store, row) {
  const name = normalizeName(row.name);
  const dup = findByName(store, name, (x) => x.id !== row.id && !x.archived && (store !== 'categories' || x.type === row.type));
  if (dup) throw new ValidationError(`Já existe "${dup.name}"`);
  const prev = data[store].get(row.id);
  const next = { ...prev, ...row, name, updatedAt: Date.now() };
  const ops = [{ store, put: next }];
  // Mudança nas regras de um cartão recalcula a competência das compras não ajustadas manualmente.
  if (store === 'accounts' && prev && (prev.closingDay !== next.closingDay || prev.dueDay !== next.dueDay || prev.kind !== next.kind)) {
    for (const t of list('transactions')) {
      if (t.sourceId !== next.id || t.monthManual) continue;
      const month = competenceOf(t, next);
      if (month !== t.month) ops.push({ store: 'transactions', put: { ...t, month, updatedAt: Date.now() } });
    }
  }
  await apply(ops);
  return next;
}

export function usageOf(store, id) {
  const field = { categories: ['categoryId'], blocks: ['blockId'], accounts: ['sourceId', 'toAccountId'] }[store];
  let count = 0;
  for (const t of data.transactions.values()) if (field.some((f) => t[f] === id)) count++;
  for (const r of data.recurrences.values()) if (field.some((f) => r[f] === id)) count++;
  for (const b of data.budgets.values()) if (b.refId === id) count++;
  for (const e of data.investmentEvents.values()) if (e.accountId === id) count++;
  return count;
}

export async function setArchived(store, id, archived) {
  const row = data[store].get(id);
  if (!row) return;
  await apply([{ store, put: { ...row, archived, updatedAt: Date.now() } }]);
}

/** Exclui somente registros sem uso; caso contrário, o chamador deve arquivar. */
export async function deleteNamed(store, id) {
  if (usageOf(store, id) > 0) throw new ValidationError('Item em uso: arquive em vez de excluir.');
  await apply([{ store, del: id }]);
}

// ——— Orçamentos ———

export async function saveBudget({ id, scope, refId, amount }) {
  const existing = list('budgets').find((b) => b.scope === scope && b.refId === refId && b.id !== id);
  const row = { id: id || existing?.id || uid(), scope, refId, amount, updatedAt: Date.now() };
  const ops = [{ store: 'budgets', put: row }];
  if (existing && id && existing.id !== id) ops.push({ store: 'budgets', del: existing.id });
  await apply(ops);
}

export async function deleteBudget(id) { await apply([{ store: 'budgets', del: id }]); }

// ——— Investimentos e metas ———

export async function saveInvestment(input) {
  const prev = input.id ? data.investments.get(input.id) : null;
  const row = { ...(prev || {}), ...input, id: input.id || uid(), name: normalizeName(input.name), archived: Boolean(input.archived), createdAt: prev?.createdAt || Date.now(), updatedAt: Date.now() };
  const ops = [{ store: 'investments', put: row }];
  if (!prev && input.initialBalance != null) {
    ops.push({ store: 'investmentEvents', put: { id: uid(), investmentId: row.id, type: 'balance', amount: input.initialBalance, date: input.refDate || today(), createdAt: Date.now() } });
  }
  delete row.initialBalance; delete row.refDate;
  await apply(ops);
  return row;
}

export async function deleteInvestment(id) {
  const ops = [{ store: 'investments', del: id }];
  for (const e of list('investmentEvents')) if (e.investmentId === id) ops.push({ store: 'investmentEvents', del: e.id });
  for (const g of list('goals')) if (g.investmentId === id) ops.push({ store: 'goals', put: { ...g, investmentId: null } });
  await apply(ops);
}

export async function addInvestmentEvent(input) {
  const row = { ...input, id: input.id || uid(), accountId: input.accountId || null, createdAt: input.createdAt || Date.now() };
  await apply([{ store: 'investmentEvents', put: row }]);
  return row;
}

export async function deleteInvestmentEvent(id) { await apply([{ store: 'investmentEvents', del: id }]); }

export async function saveGoal(input) {
  const prev = input.id ? data.goals.get(input.id) : null;
  const row = { ...(prev || {}), ...input, id: input.id || uid(), name: normalizeName(input.name), createdAt: prev?.createdAt || Date.now(), updatedAt: Date.now() };
  await apply([{ store: 'goals', put: row }]);
  return row;
}

export async function deleteGoal(id) { await apply([{ store: 'goals', del: id }]); }

// ——— Preferências e dados ———

export async function setPrefs(patch) {
  await apply([{ store: 'meta', put: { key: 'prefs', value: { ...prefs(), ...patch } } }]);
}

export function snapshot() {
  if (!fullyLoaded) throw new Error('O histórico ainda está carregando. Tente novamente em instantes.');
  return Object.fromEntries(STORES.map((s) => [s, list(s)]));
}

export async function fullSnapshot() {
  await whenFullyLoaded();
  return snapshot();
}

/** Substitui toda a base pelo conteúdo do backup já validado (atômico). */
/**
 * Substitui toda a base pelo conteúdo de um backup JÁ VALIDADO.
 * - coordena as abas: as outras param de gravar até o fim (BroadcastChannel)
 *   e, quando suportado, um Web Lock impede duas restaurações simultâneas;
 * - guarda um snapshot interno do estado anterior na MESMA transação;
 * - se qualquer etapa falhar, a transação é abortada e a base anterior fica intacta.
 */
export async function importData(backupData, { reason = 'restore' } = {}) {
  assertWritable();
  const clean = Object.fromEntries(STORES.map((s) => [s, (backupData[s] || []).map((r) => structuredClone(r))]));
  if (!clean.meta.some((m) => m.key === 'seeded')) clean.meta.push({ key: 'seeded', value: true, at: Date.now() });
  await whenFullyLoaded();
  const run = async () => {
    channel?.postMessage({ t: 'lock', reason });
    try {
      const current = await loadAll();
      const hasData = STORES.some((st) => st !== 'meta' && (current[st] || []).length);
      const snapshot = hasData ? { id: new Date().toISOString(), createdAt: Date.now(), reason, counts: Object.fromEntries(STORES.map((st) => [st, (current[st] || []).length])), data: JSON.stringify(current) } : null;
      await replaceAll(clean, { snapshot });
      await reloadFromDB();
    } finally {
      channel?.postMessage({ t: 'reload', at: Date.now() });
    }
  };
  if (globalThis.navigator?.locks?.request) await navigator.locks.request('fluxo-restore', { mode: 'exclusive' }, run);
  else await run();
  notify();
}

export { listSnapshots };

/** Leitura consistente de TODAS as coleções em uma única transação (para backup). */
export async function readConsistent() {
  await whenFullyLoaded();
  return loadAll();
}

/** Registra que um arquivo de backup foi GERADO (não que foi salvo pelo usuário). */
export async function recordBackup(info) {
  await apply([{ store: 'meta', put: { key: 'lastBackup', value: { at: Date.now(), ...info } } }], { silent: true });
}
/** Preferências visuais (layout): separadas dos dados; gravação silenciosa (sem redesenhar tudo). */
export async function setUiLayout(value) {
  await apply([{ store: 'meta', put: { key: 'ui.layout', value } }], { silent: true });
}

export const lastBackup = () => data.meta.get('lastBackup')?.value || null;
export const dbState = () => ({ closed: dbClosed, locked: writeLock, fullyLoaded });

// Chaves de meta que NÃO são dados financeiros: sobrevivem a "Apagar dados financeiros".
const APPEARANCE_META = ['ui.layout', 'lastBackup'];

export async function wipeAll() {
  const keep = list('meta').filter((m) => APPEARANCE_META.includes(m.key)).map((m) => structuredClone(m));
  await importData({ meta: [{ key: 'seeded', value: true, at: Date.now() }, ...keep] }, { reason: 'wipe' });
  await seed();
}
