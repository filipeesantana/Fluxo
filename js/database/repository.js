import { openDB, loadAll, loadRecent, loadOlder, getByKeys, commit, replaceAll, listSnapshots, requestPersistence, setVersionChangeHandler } from './db.js';
import { STORES } from './schema.js';
import { VALIDATORS, normalizeName, sameName } from '../services/validation.js';
import { competenceOf, isCard, billFor } from '../services/cards.js';
import { buildInstallments } from '../services/installments.js';
import { endDateForCount, ruleOccurrences, ruleMode, parseDays, firstKeyFor } from '../services/recurrence.js';
export { firstKeyFor };
import { createContext, monthItems } from '../services/finance.js';
import { today, addDays, currentMonth, monthOf, addMonths, firstDay, lastDay, dateInMonth } from '../utils/dates.js';
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
// Gravações desta aba em fila: cada uma parte do estado já confirmado pela
// anterior. Sem isso, duas ações rápidas no mesmo registro (ex.: dois eventos
// "change" seguidos) disputariam a mesma revisão e uma delas seria recusada.
let writeChain = Promise.resolve();
function apply(ops, opts) {
  const run = writeChain.then(() => applyNow(ops, opts));
  writeChain = run.catch(() => {});
  return run;
}

async function applyNow(ops, { broadcast = true, silent = false } = {}) {
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
  if (!tx.date) {
    // Data a definir: o compromisso pertence ao período planejado e nunca está "pago".
    tx.date = null;
    tx.period = tx.period || input.month || previous?.month || monthOf(today());
    tx.month = tx.period;
    tx.monthManual = false;
  } else if (!tx.monthManual) tx.month = competenceOf(tx, acc);
  for (const k of ['occurrenceDate', 'occurrenceKey', 'plannedAmount', 'estimated', 'forecastId', 'remainderOf', 'replicaOf']) if (tx[k] == null || tx[k] === false) delete tx[k];
  if (tx.status !== 'done') delete tx.plannedDate;
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
  const key = tx.occurrenceKey || tx.occurrenceDate;
  if (tx.recurrenceId && key && !tx.remainderOf) {
    const clash = list('transactions').find((t) => t.id !== tx.id && t.recurrenceId === tx.recurrenceId && (t.occurrenceKey || t.occurrenceDate) === key && !t.remainderOf);
    if (clash) tx.id = clash.id; // nunca cria duas ocorrências para a mesma chave
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

/** Exclui vários lançamentos de uma vez (ex.: desfazer uma replicação), numa transação. */
export async function deleteTransactions(ids) {
  const ops = [...new Set(ids)].filter((id) => data.transactions.has(id)).map((id) => ({ store: 'transactions', del: id }));
  if (ops.length) await apply(ops);
  return ops.length;
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
  // A cópia nunca herda vínculo de série, parcela, previsão nem pagamento parcial.
  const { id: _, rev, recurrenceId, occurrenceDate, occurrenceKey, period, remainderOf, plannedAmount, plannedDate, planId, installment, createdAt, ...rest } = tx;
  return saveTransaction({ ...rest, ...overrides, monthManual: false });
}

/**
 * Replica um lançamento para outros meses (ação "Replicar para outros meses").
 * - As cópias começam SEMPRE como previstas (o "pago" não é replicado), salvo escolha explícita;
 * - dateMode: 'same' (mesmo dia, ajustado a meses curtos) · 'day' (dia escolhido) · 'flex' (data a definir);
 * - ids determinísticos por operação (`opId:mês`): repetir o clique não duplica;
 * - tudo em uma única transação.
 */
export async function replicateTransaction(id, { months, dateMode = 'same', day = null, days = null, status = 'planned', opId }) {
  const tx = data.transactions.get(id);
  if (!tx) throw new ValidationError('Lançamento não encontrado.');
  if (tx.type === 'transfer') throw new ValidationError('Transferências não podem ser replicadas por aqui.');
  const uniq = [...new Set(months)].filter((m) => /^\d{4}-\d{2}$/.test(m)).sort();
  if (!uniq.length) throw new ValidationError('Escolha pelo menos um mês.');
  if (uniq.length > 60) throw new ValidationError('Escolha no máximo 60 meses de uma vez.');
  if (!opId) throw new ValidationError('Operação sem identificador.');
  const { id: _, rev, recurrenceId, occurrenceDate, occurrenceKey, period, remainderOf, plannedAmount, planId, installment, createdAt, refundOf, monthManual, month, billMonth, ...rest } = tx;
  const srcDay = tx.date ? Number(tx.date.slice(8, 10)) : 1;
  const dayList = dateMode === 'days' ? parseDays(days || []) : null;
  if (dateMode === 'days' && !dayList.length) throw new ValidationError('Informe ao menos um dia do mês (ex.: 5, 20).');
  if (dateMode === 'day' && !(Number.isInteger(day) && day >= 1 && day <= 31)) throw new ValidationError('Dia do mês: de 1 a 31.');
  const ops = [];
  const created = [];
  for (const m of uniq) {
    // Um lançamento por mês (ou por dia escolhido, em "vários dias"); a data nunca é inventada em "a definir".
    const slots = dayList ? dayList.map((d) => ({ cid: `${opId}:${m}@${d}`, date: dateInMonth(m, d) }))
      : [{ cid: `${opId}:${m}`, date: dateMode === 'flex' ? null : dateInMonth(m, dateMode === 'day' ? day : srcDay) }];
    for (const { cid, date } of slots) {
      if (data.transactions.has(cid)) continue; // mesma operação repetida
      const row = normalizeTransaction({ ...rest, id: cid, status: date ? status : 'planned', date, period: date ? undefined : m, month: date ? undefined : m, monthManual: false, replicaOf: tx.id });
      ops.push({ store: 'transactions', put: row });
      created.push(row);
    }
  }
  if (ops.length) await apply(ops);
  return created;
}

const foldDesc = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/**
 * Lançamento "igual" já previsto ou realizado no mês de destino: mesma descrição e
 * tipo (inclui ocorrências projetadas de recorrências). Serve para avisar, nunca para apagar.
 */
export function conflictIn(tx, month, items = monthItems(context(), month)) {
  const q = foldDesc(tx.description);
  return items.find((i) => i.id !== tx.id && i.type === tx.type && i.type !== 'transfer' && foldDesc(i.description) === q && !i.remainderOf) || null;
}

/**
 * Copia lançamentos para um mês (próximo mês, outro mês, em lote ou "trazer do mês
 * anterior"), numa única transação. Mantém descrição, valor, categoria, bloco, fonte,
 * método e observação; a cópia é independente e sempre prevista (o pago não é copiado).
 * - conflitos (já existe no destino) são devolvidos e não copiados, salvo force;
 * - parcelas, transferências e restantes não são copiados;
 * - ids determinísticos por operação: repetir a mesma operação não duplica.
 */
export async function copyTransactionsTo(ids, month, { opId, force = false } = {}) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new ValidationError('Mês inválido.');
  if (!opId) throw new ValidationError('Operação sem identificador.');
  const uniq = [...new Set(ids)].slice(0, 500);
  const items = monthItems(context(), month);
  const ops = [], created = [], conflicts = [], skipped = [];
  uniq.forEach((id, i) => {
    const tx = data.transactions.get(id);
    if (!tx) return;
    if (tx.type === 'transfer' || tx.planId || tx.remainderOf) { skipped.push(tx); return; }
    const cid = `${opId}:${month}:${i}`;
    if (data.transactions.has(cid)) return; // mesma operação repetida
    const hit = conflictIn(tx, month, items);
    if (hit && !force) { conflicts.push({ tx, existing: hit }); return; }
    const { id: _, rev, recurrenceId, occurrenceDate, occurrenceKey, period, remainderOf, plannedAmount, plannedDate, planId, installment, createdAt, updatedAt, refundOf, monthManual, month: m0, billMonth, forecastId, replicaOf, estimated, ...rest } = tx;
    const date = tx.date ? dateInMonth(month, Number(tx.date.slice(8, 10))) : null;
    const row = normalizeTransaction({ ...rest, id: cid, status: 'planned', amount: tx.plannedAmount || tx.amount, date, period: date ? undefined : month, month: date ? undefined : month, monthManual: false, replicaOf: tx.id });
    ops.push({ store: 'transactions', put: row });
    created.push(row);
  });
  if (ops.length) await apply(ops);
  return { created, conflicts, skipped };
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

/** Normaliza campos derivados de uma regra (modo, âncora do dia, quantidade → data final, benefício). */
function finalizeRule(rule) {
  const mode = ruleMode(rule);
  if (mode === 'fixed') delete rule.mode; else { rule.mode = mode; rule.frequency = 'monthly'; }
  if (mode !== 'days') delete rule.days; else rule.days = parseDays(rule.days);
  if (mode !== 'flex') delete rule.perPeriod; else rule.perPeriod = Math.min(31, Math.max(1, Math.round(Number(rule.perPeriod) || 1)));
  if (mode !== 'forecast') delete rule.closed;
  if (mode === 'fixed' && rule.frequency !== 'weekly' && rule.frequency !== 'daily' && !rule.anchorDay) rule.anchorDay = Number(rule.startDate.slice(8, 10));
  if (mode !== 'fixed' || rule.frequency === 'weekly' || rule.frequency === 'daily') delete rule.anchorDay;
  if (rule.count) rule.endDate = endDateForCount(rule, rule.count);
  if (rule.type === 'income') rule.restricted = Boolean(rule.restricted) || data.accounts.get(rule.sourceId)?.kind === 'benefit';
  if (!rule.pauses?.length) delete rule.pauses;
  if (!rule.estimated) delete rule.estimated;
  return rule;
}

/** Chave da ocorrência que corresponde a uma data, no modo da regra (ou null). */
export function keyForDate(rule, date) {
  const mode = ruleMode(rule);
  const m = monthOf(date);
  if (mode === 'fixed') return ruleOccurrences(rule, date, date)[0]?.key || null;
  if (mode === 'days') return ruleOccurrences(rule, firstDay(m), lastDay(m)).find((o) => o.date === date)?.key || null;
  if (mode === 'flex') {
    const free = ruleOccurrences(rule, firstDay(m), lastDay(m)).find((o) => !existingOcc(rule.id, o.key));
    return free?.key || null;
  }
  return null;
}

/**
 * Cria a regra e, opcionalmente, a ocorrência já realizada que deu origem a ela,
 * em UMA transação. Idempotente pelo id da regra. Em previsões mensais o
 * lançamento de origem vira um gasto vinculado (consome a previsão).
 */
export async function createRecurrence(input, firstOccurrence = null, firstKey = null) {
  if (input.id && data.recurrences.has(input.id)) return data.recurrences.get(input.id);
  const rule = finalizeRule({
    ...input, id: input.id || uid(), description: String(input.description || '').trim().slice(0, 200), interval: input.interval || 1,
    endDate: input.endDate || null, categoryId: input.categoryId || null, blockId: input.blockId || null, sourceId: input.sourceId || null,
    exceptions: {}, createdAt: Date.now(), updatedAt: Date.now(),
  });
  const ops = [{ store: 'recurrences', put: rule }];
  if (firstOccurrence) {
    const date = firstOccurrence.date || rule.startDate;
    if (ruleMode(rule) === 'forecast') {
      ops.push({ store: 'transactions', put: normalizeTransaction({ ...firstOccurrence, id: `${rule.id}:origem`, date, forecastId: rule.id, recurrenceId: null }) });
    } else {
      const key = firstKey || keyForDate(rule, date);
      if (key) ops.push({ store: 'transactions', put: occurrenceTx(rule, key, { ...firstOccurrence, date }) });
      else ops.push({ store: 'transactions', put: normalizeTransaction({ ...firstOccurrence, id: `${rule.id}:origem`, date }) });
    }
  }
  await apply(ops);
  return rule;
}

/**
 * Transforma um lançamento existente em recorrente. O lançamento passa a ser a
 * primeira ocorrência (nenhuma cópia é criada) e o restante da série é projetado.
 * - patch: alterações do formulário gravadas na mesma transação (edição + repetição);
 * - anchorDay: dia do mês das próximas ocorrências (padrão: o dia da data);
 * - lançamento sem data (previsto "a definir") vira série de datas flexíveis;
 * - em previsão mensal, o lançamento passa a consumir a previsão do mês.
 * O estado "pago" do original nunca é copiado para os meses seguintes.
 */
export async function convertToRecurring(txId, { frequency = 'monthly', interval = 1, endDate = null, count = null, mode = 'fixed', days = null, perPeriod = null, anchorDay = null, estimated } = {}, patch = null) {
  const prev = data.transactions.get(txId);
  if (!prev) throw new ValidationError('Lançamento não encontrado.');
  if (patch && patch.rev !== undefined && (prev.rev || 0) !== (patch.rev || 0)) {
    throw new ValidationError('Este lançamento foi alterado em outra aba enquanto você editava. Feche o formulário e abra novamente; nada foi gravado.');
  }
  const tx = patch ? normalizeTransaction({ ...prev, ...patch, id: prev.id }, prev) : prev;
  if (prev.recurrenceId || prev.forecastId) throw new ValidationError('Este lançamento já faz parte de uma recorrência.');
  if (prev.planId) throw new ValidationError('Parcelas não podem virar recorrência; use o parcelamento.');
  if (tx.type !== 'expense' && tx.type !== 'income') throw new ValidationError('Somente receitas e despesas podem ser recorrentes.');
  if (mode === 'forecast' && tx.type !== 'expense') throw new ValidationError('Previsão mensal é só para despesas.');
  if (!tx.date && mode !== 'flex' && mode !== 'forecast') {
    if (mode === 'fixed' && frequency === 'monthly') mode = 'flex';
    else throw new ValidationError('Defina a data do lançamento antes de repeti-lo.');
  }
  const period = tx.date ? monthOf(tx.date) : tx.period || tx.month;
  const fixedMonthly = mode === 'fixed' && frequency === 'monthly' && (interval || 1) === 1;
  const anchor = fixedMonthly ? (Number.isInteger(anchorDay) && anchorDay >= 1 && anchorDay <= 31 ? anchorDay : Number(tx.date.slice(8, 10))) : undefined;
  const startDate = mode === 'fixed' ? (fixedMonthly ? dateInMonth(period, anchor) : tx.date) : firstDay(period);
  if (endDate && endDate < startDate) throw new ValidationError('A data de término é anterior ao início.');
  const rule = finalizeRule({
    id: uid(), type: tx.type, description: tx.description, amount: tx.amount, startDate, endDate: endDate || null, count: count || undefined,
    frequency: mode === 'fixed' ? frequency : 'monthly', interval: interval || 1, mode, anchorDay: anchor,
    days: mode === 'days' ? (days?.length ? parseDays(days) : [Number(tx.date.slice(8, 10))]) : undefined,
    perPeriod: mode === 'flex' ? perPeriod || 1 : undefined,
    categoryId: tx.categoryId || null, blockId: tx.blockId || null, sourceId: tx.sourceId || null, method: tx.method || null, restricted: tx.restricted,
    estimated: estimated || undefined, exceptions: {}, createdAt: Date.now(), updatedAt: Date.now(),
  });
  if (!rule.count) delete rule.count;
  let linked;
  if (mode === 'forecast') linked = { ...tx, forecastId: rule.id, updatedAt: Date.now() };
  else {
    const key = firstKeyFor(rule, tx.date, period);
    linked = { ...tx, recurrenceId: rule.id, occurrenceKey: key, period, updatedAt: Date.now() };
    if (mode === 'fixed' && /^\d{4}-\d{2}-\d{2}$/.test(key)) linked.occurrenceDate = key; else delete linked.occurrenceDate;
    if (!tx.date) linked.month = period;
  }
  await apply([{ store: 'recurrences', put: rule }, { store: 'transactions', put: normalizeTransaction(linked, prev) }]);
  return rule;
}

/**
 * Desfaz "Transformar em recorrente": remove a regra e devolve o lançamento
 * original como estava, numa transação. Ocorrências previstas criadas depois
 * saem junto; pagas continuam como lançamentos avulsos.
 */
export async function undoConversion(ruleId, original) {
  const ops = [];
  if (data.recurrences.has(ruleId)) ops.push({ store: 'recurrences', del: ruleId });
  for (const t of list('transactions')) {
    if (t.id === original.id) continue;
    if (t.forecastId === ruleId) ops.push({ store: 'transactions', put: { ...t, forecastId: null, updatedAt: Date.now() } });
    else if (t.recurrenceId === ruleId) ops.push(t.status === 'planned' ? { store: 'transactions', del: t.id } : { store: 'transactions', put: { ...t, recurrenceId: null, occurrenceKey: null, occurrenceDate: null, updatedAt: Date.now() } });
  }
  const { rev, ...back } = original;
  ops.push({ store: 'transactions', put: normalizeTransaction({ ...back, updatedAt: Date.now() }, null) });
  await apply(ops);
}

/**
 * Ocorrência extra num mês (ex.: uma terceira consulta). Fica ligada à série,
 * conta no compromisso do mês e não altera os outros meses nem a regra.
 */
const extraOps = new Map();
export async function addExtraOccurrence(ruleId, month, { date = null, amount = null, opId } = {}) {
  const rule = data.recurrences.get(ruleId);
  if (!rule) throw new ValidationError('Recorrência não encontrada.');
  if (ruleMode(rule) === 'forecast') throw new ValidationError('Numa previsão mensal, registre o gasto: ele consome a previsão.');
  if (!/^\d{4}-\d{2}$/.test(month)) throw new ValidationError('Mês inválido.');
  if (date && monthOf(date) !== month) throw new ValidationError('Escolha uma data dentro do mês.');
  // Mesma operação repetida (clique duplo, Enter repetido): devolve a ocorrência já criada.
  if (opId && extraOps.has(opId) && data.transactions.has(extraOps.get(opId))) return data.transactions.get(extraOps.get(opId));
  const used = new Set(list('transactions').filter((t) => t.recurrenceId === ruleId).map(occKeyOf));
  for (const o of ruleOccurrences(rule, firstDay(month), lastDay(month))) used.add(o.key);
  let n = ruleMode(rule) === 'flex' ? (rule.perPeriod || 1) + 1 : 1;
  while (used.has(`${month}#${n}`) && n <= 31) n++;
  if (n > 31) throw new ValidationError('Limite de ocorrências neste mês atingido.');
  const tx = occurrenceTx(rule, `${month}#${n}`, { date: date || null, amount: amount || rule.amount, status: 'planned' });
  if (opId) extraOps.set(opId, tx.id);
  await apply([{ store: 'transactions', put: tx }]);
  return tx;
}

/** Pausa a série a partir de `fromDate` (ocorrências futuras deixam de ser projetadas). */
export async function pauseRecurrence(ruleId, fromDate) {
  const rule = data.recurrences.get(ruleId);
  if (!rule) return;
  const pauses = [...(rule.pauses || []).filter((p) => p.to), { from: fromDate, to: null }];
  const ops = [{ store: 'recurrences', put: { ...rule, pauses, updatedAt: Date.now() } }];
  for (const t of list('transactions')) if (t.recurrenceId === ruleId && occStart(t) >= fromDate && t.status === 'planned') ops.push({ store: 'transactions', del: t.id });
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

/** Chave de ocorrência de um lançamento (compatível com a 3.0, que só tinha a data). */
export const occKeyOf = (t) => t.occurrenceKey || t.occurrenceDate || null;
/** Início do período de uma chave (para comparar "desta data em diante"). */
const keyStart = (k) => (/^\d{4}-\d{2}-\d{2}$/.test(k) ? k : firstDay(k.slice(0, 7)));
const occStart = (t) => (occKeyOf(t) ? keyStart(occKeyOf(t)) : t.date || firstDay(t.month));

const existingOcc = (ruleId, key) => list('transactions').find((t) => t.recurrenceId === ruleId && occKeyOf(t) === key && !t.remainderOf);

function occurrenceTx(rule, key, overrides = {}) {
  const prev = existingOcc(rule.id, key);
  const keyDate = /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : /@/.test(key) ? dateInMonth(key.slice(0, 7), Number(key.split('@')[1])) : null;
  const period = key.slice(0, 7);
  const date = overrides.date !== undefined ? overrides.date : prev ? prev.date : keyDate;
  return normalizeTransaction({
    type: rule.type, status: 'planned', description: rule.description, amount: rule.amount,
    categoryId: rule.categoryId, blockId: rule.blockId, sourceId: rule.sourceId, restricted: rule.restricted, method: rule.method || null,
    estimated: rule.estimated || undefined,
    ...(prev || {}), ...overrides,
    date, period, month: overrides.monthManual ? overrides.month : date ? undefined : period, monthManual: overrides.monthManual ?? prev?.monthManual ?? false,
    // occurrenceDate só no modo de data única (o índice da v2 é único por data).
    recurrenceId: rule.id, occurrenceKey: key, occurrenceDate: ruleMode(rule) === 'fixed' ? keyDate : undefined,
    // Identidade determinística: a mesma ocorrência sempre tem o mesmo id,
    // mesmo que data, valor ou fonte sejam ajustados depois.
    id: prev?.id || `${rule.id}:${key}`,
  }, prev);
}

/** Transforma uma ocorrência projetada em movimentação real (paga, editada ou com data definida). */
export async function materializeOccurrence(ruleId, key, overrides) {
  const rule = data.recurrences.get(ruleId);
  if (!rule) throw new ValidationError('Recorrência não encontrada');
  const tx = occurrenceTx(rule, key, overrides);
  await apply([{ store: 'transactions', put: tx }]);
  return tx;
}

/** Define (ou remove) a data de uma ocorrência flexível. Nunca cria uma segunda ocorrência. */
export async function setOccurrenceDate(ruleId, key, date) {
  return materializeOccurrence(ruleId, key, { date: date || null });
}

/**
 * Pagamento (ou recebimento) de qualquer item previsto: ocorrência projetada,
 * ocorrência materializada ou lançamento previsto avulso.
 * - date/amount/sourceId: dados efetivos do pagamento;
 * - keepRemainder: pagamento parcial — a diferença continua prevista, vinculada ao mesmo item;
 * - grava tudo em uma transação e guarda o valor previsto para permitir desfazer.
 */
export async function payItem(item, { date, amount, sourceId, keepRemainder = false } = {}) {
  if (item.forecast) throw new ValidationError('Uma previsão mensal não é paga: registre os gastos e eles consomem a previsão.');
  if (!date) throw new ValidationError('Informe a data do pagamento.');
  const planned = item.amount;
  const paid = amount ?? planned;
  if (!Number.isSafeInteger(paid) || paid <= 0) throw new ValidationError('Informe um valor pago maior que zero.');
  const fields = { status: 'done', date, amount: paid, sourceId: sourceId === undefined ? item.sourceId : sourceId || null };
  if (paid !== planned) fields.plannedAmount = planned;
  // Data efetiva diferente da prevista: guarda a prevista para o "desfazer".
  if ((item.date || null) !== date) fields.plannedDate = item.date || null;
  // Ocorrência de série paga antes ou depois do mês: continua no compromisso do mês dela
  // (pagar a consulta de dezembro em novembro não esvazia dezembro nem infla novembro).
  // No cartão vale a fatura da data da compra.
  const period = item.period || (item.virtual ? String(item.occurrenceKey || '').slice(0, 7) : null);
  const recurring = item.recurrenceId && !item.remainderOf;
  if (recurring && /^\d{4}-\d{2}$/.test(period || '') && monthOf(date) !== period && !isCard(data.accounts.get(fields.sourceId))) { fields.monthManual = true; fields.month = period; }
  let tx;
  if (item.virtual) {
    const rule = data.recurrences.get(item.recurrenceId);
    if (!rule) throw new ValidationError('Recorrência não encontrada.');
    tx = occurrenceTx(rule, item.occurrenceKey || item.occurrenceDate, fields);
  } else {
    const prev = data.transactions.get(item.id);
    if (!prev) throw new ValidationError('Lançamento não encontrado.');
    tx = normalizeTransaction({ ...prev, ...fields }, prev);
  }
  const ops = [{ store: 'transactions', put: tx }];
  const diff = planned - paid;
  if (keepRemainder && diff > 0) {
    const rid = `${tx.id}~resto`;
    const prevRest = data.transactions.get(rid);
    ops.push({ store: 'transactions', put: normalizeTransaction({
      ...(prevRest || {}), id: rid, type: tx.type, status: 'planned', amount: diff,
      description: `${tx.description} (restante)`, date: item.date || null, period: tx.period || tx.month, month: item.date ? undefined : (tx.period || tx.month),
      categoryId: tx.categoryId, blockId: tx.blockId, sourceId: item.sourceId || null, recurrenceId: tx.recurrenceId || null, remainderOf: tx.id, forecastId: tx.forecastId || null,
    }, prevRest) });
  }
  await apply(ops);
  return tx;
}

/** Desfaz um pagamento: volta a previsto com o valor planejado e remove o restante criado. */
export async function unpayItem(id) {
  const tx = data.transactions.get(id);
  if (!tx || tx.status !== 'done') return null;
  const rest = data.transactions.get(`${id}~resto`);
  const back = { ...tx, status: 'planned', amount: tx.plannedAmount || tx.amount, updatedAt: Date.now() };
  if ('plannedDate' in tx) {
    back.date = tx.plannedDate || null;
    // Volta à competência normal (a da data prevista, ou o período quando a data é a definir).
    if (tx.recurrenceId) { back.monthManual = false; if (!back.date) back.month = tx.period || tx.month; }
  }
  delete back.plannedAmount;
  delete back.plannedDate;
  const ops = [{ store: 'transactions', put: normalizeTransaction(back) }];
  if (rest && rest.status === 'planned') ops.push({ store: 'transactions', del: rest.id });
  await apply(ops);
  return back;
}

/**
 * Ignora (ou cancela) a ocorrência de chave `key`. Por padrão só remove a
 * versão prevista; com removeDone (exclusão pedida explicitamente) remove
 * também a realizada. Ignorar ou cancelar nunca significa pagamento.
 */
export async function skipOccurrence(ruleId, key, { removeDone = false, reason = 'skipped' } = {}) {
  const rule = data.recurrences.get(ruleId);
  if (!rule) return;
  const ops = [{ store: 'recurrences', put: { ...rule, exceptions: { ...(rule.exceptions || {}), [key]: reason === 'cancelled' ? 'cancelled' : 'skipped' }, updatedAt: Date.now() } }];
  for (const t of list('transactions')) {
    if (t.recurrenceId !== ruleId) continue;
    const own = occKeyOf(t) === key || (t.remainderOf && occKeyOf(data.transactions.get(t.remainderOf) || {}) === key);
    if (own && (removeDone || t.status === 'planned')) ops.push({ store: 'transactions', del: t.id });
  }
  await apply(ops);
}

/** Desfaz a exclusão de uma ocorrência (volta a exceção e o lançamento, atomicamente). */
export async function restoreOccurrence(ruleId, tx) {
  const rule = data.recurrences.get(ruleId);
  if (!rule) return restoreTransactions([tx]);
  const exceptions = { ...(rule.exceptions || {}) };
  delete exceptions[occKeyOf(tx)];
  await apply([{ store: 'recurrences', put: { ...rule, exceptions, updatedAt: Date.now() } }, { store: 'transactions', put: tx }]);
}

export async function unskipOccurrence(ruleId, key) {
  const rule = data.recurrences.get(ruleId);
  if (!rule) return;
  const exceptions = { ...(rule.exceptions || {}) };
  delete exceptions[key];
  await apply([{ store: 'recurrences', put: { ...rule, exceptions, updatedAt: Date.now() } }]);
}

/** Encerra (ou reabre) a previsão de um mês: o que não foi usado deixa de contar, sem virar despesa. */
export async function setForecastClosed(ruleId, month, closed = true) {
  const rule = data.recurrences.get(ruleId);
  if (!rule || ruleMode(rule) !== 'forecast') return;
  const map = { ...(rule.closed || {}) };
  if (closed) map[month] = true; else delete map[month];
  await apply([{ store: 'recurrences', put: { ...rule, closed: map, updatedAt: Date.now() } }]);
}

/** Encerra a série a partir de `fromDate` (inclusive). Ocorrências já pagas são preservadas. */
export async function endSeries(ruleId, fromDate, { removeDoneFrom = null } = {}) {
  const rule = data.recurrences.get(ruleId);
  if (!rule) return;
  const ops = [];
  if (removeDoneFrom) {
    const own = list('transactions').find((t) => t.recurrenceId === ruleId && occKeyOf(t) === removeDoneFrom && t.status === 'done');
    if (own) ops.push({ store: 'transactions', del: own.id });
  }
  // Datas flexíveis e previsões encerram por mês inteiro.
  const from = ruleMode(rule) === 'fixed' ? fromDate : firstDay(monthOf(fromDate));
  const endDate = addDays(from, -1);
  if (endDate < rule.startDate) ops.push({ store: 'recurrences', put: { ...rule, archived: true, endDate: rule.startDate, count: undefined, updatedAt: Date.now() } });
  else ops.push({ store: 'recurrences', put: { ...rule, endDate, count: undefined, updatedAt: Date.now() } });
  for (const t of list('transactions')) {
    if (t.recurrenceId === ruleId && occStart(t) >= from && t.status === 'planned') ops.push({ store: 'transactions', del: t.id });
  }
  await apply(ops);
}

/** Altera a série a partir de `fromDate`: encerra a regra atual e cria a continuação. */
export async function editSeriesFrom(ruleId, fromDate, changes) {
  const rule = data.recurrences.get(ruleId);
  if (!rule) return null;
  const mode = ruleMode(rule);
  const from = mode === 'fixed' ? fromDate : firstDay(monthOf(fromDate));
  if (from <= rule.startDate) return saveRecurrence({ ...rule, ...changes, id: rule.id });
  const nextId = uid();
  const exceptions = Object.fromEntries(Object.entries(rule.exceptions || {}).filter(([k]) => keyStart(k) >= from));
  // A continuação preserva o dia de referência (ex.: 31) mesmo começando em um mês curto.
  const next = { ...rule, ...changes, id: nextId, startDate: changes.startDate || from, exceptions, createdAt: Date.now(), updatedAt: Date.now() };
  if (mode === 'fixed') next.anchorDay = changes.anchorDay || rule.anchorDay || Number(rule.startDate.slice(8, 10));
  if (rule.closed) next.closed = Object.fromEntries(Object.entries(rule.closed).filter(([m]) => m >= monthOf(from)));
  delete next.count;
  next.endDate = changes.endDate !== undefined ? changes.endDate : rule.endDate;
  if (next.endDate && next.endDate < next.startDate) next.endDate = null;
  const ops = [
    { store: 'recurrences', put: { ...rule, endDate: addDays(from, -1), count: undefined, updatedAt: Date.now() } },
    { store: 'recurrences', put: finalizeRule({ ...next, description: String(next.description).trim() }) },
  ];
  for (const t of list('transactions')) {
    if (t.forecastId === ruleId && (t.date || firstDay(t.month)) >= from) { ops.push({ store: 'transactions', put: { ...t, forecastId: nextId, updatedAt: Date.now() } }); continue; }
    if (t.recurrenceId !== ruleId || occStart(t) < from) continue;
    if (t.status === 'planned' && !t.remainderOf && !(mode === 'flex' && t.date)) ops.push({ store: 'transactions', del: t.id });
    else ops.push({ store: 'transactions', put: { ...t, recurrenceId: nextId, ...(t.status === 'planned' ? pick(changes, ['amount', 'description', 'categoryId', 'blockId', 'sourceId']) : {}), updatedAt: Date.now() } });
  }
  await apply(ops);
  return next;
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

/**
 * "Somente este mês": aplica as alterações a todas as ocorrências previstas do
 * período, sem mudar a regra nem os outros meses. Ocorrências pagas ficam como estão.
 */
export async function editSeriesPeriod(ruleId, period, changes) {
  const rule = data.recurrences.get(ruleId);
  if (!rule) return [];
  const ops = [];
  for (const o of ruleOccurrences(rule, firstDay(period), lastDay(period))) {
    const prev = existingOcc(rule.id, o.key);
    if (prev?.status === 'done') continue;
    ops.push({ store: 'transactions', put: occurrenceTx(rule, o.key, pick(changes, ['amount', 'description', 'categoryId', 'blockId', 'sourceId'])) });
  }
  if (ops.length) await apply(ops);
  return ops.map((o) => o.put);
}

export async function deleteRecurrence(ruleId) {
  const rule = data.recurrences.get(ruleId);
  if (!rule) return;
  const ops = [{ store: 'recurrences', del: ruleId }];
  for (const t of list('transactions')) {
    if (t.forecastId === ruleId) { ops.push({ store: 'transactions', put: { ...t, forecastId: null, updatedAt: Date.now() } }); continue; }
    if (t.recurrenceId !== ruleId) continue;
    // Pagas permanecem como histórico; previstas materializadas são removidas.
    if (t.status === 'planned') ops.push({ store: 'transactions', del: t.id });
    else ops.push({ store: 'transactions', put: { ...t, recurrenceId: null, occurrenceDate: null, occurrenceKey: null, updatedAt: Date.now() } });
  }
  await apply(ops);
}

// ——— Cálculos salvos (calculadora) ———

/** Salva um cálculo (estático ou dinâmico). Apenas texto e referências estruturadas; validado antes de gravar. */
export async function saveCalculation(input) {
  const prev = input.id ? data.calculations.get(input.id) : null;
  const row = {
    ...(prev || {}), ...input,
    id: input.id || uid(),
    name: String(input.name || '').trim().slice(0, 80),
    expr: String(input.expr || '').slice(0, 400),
    refs: Array.isArray(input.refs) ? input.refs.slice(0, 12).map((r) => ({ id: r.id, kind: r.kind, entityId: r.entityId || null, month: r.month || null })) : [],
    favorite: Boolean(input.favorite),
    createdAt: prev?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  if (row.mode === 'static') row.refs = row.refs.map((r) => ({ ...r }));
  await apply([{ store: 'calculations', put: row }]);
  return row;
}

export async function deleteCalculation(id) {
  const row = data.calculations.get(id);
  if (!row) return null;
  await apply([{ store: 'calculations', del: id }]);
  return row;
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

// ——— Modelos de lançamento (atalhos de preenchimento; nunca movimentações) ———

export const listTemplates = () => [...(data.meta.get('templates')?.value || [])];

/** Salva (ou atualiza pelo mesmo id ou pela mesma descrição) um modelo. */
export async function saveTemplate(input) {
  const list0 = listTemplates();
  const fold = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const same = list0.find((t) => t.id === input.id || (fold(t.description) === fold(input.description) && t.type === input.type));
  const row = {
    id: same?.id || input.id || uid(), type: input.type === 'income' ? 'income' : 'expense', description: String(input.description || '').trim().slice(0, 200),
    amount: Number.isSafeInteger(input.amount) && input.amount > 0 ? input.amount : null,
    categoryId: input.categoryId || null, blockId: input.blockId || null, sourceId: input.sourceId || null,
    note: input.note ? String(input.note).slice(0, 500) : null, repeat: ['weekly', 'biweekly', 'monthly', 'yearly'].includes(input.repeat) ? input.repeat : 'none',
  };
  if (!row.description) throw new ValidationError('O modelo precisa de uma descrição.');
  const next = same ? list0.map((t) => (t.id === same.id ? row : t)) : [...list0, row];
  if (next.length > 60) throw new ValidationError('Limite de 60 modelos atingido. Remova algum antes de criar outro.');
  await apply([{ store: 'meta', put: { key: 'templates', value: next } }]);
  return row;
}

export async function deleteTemplate(id) {
  const next = listTemplates().filter((t) => t.id !== id);
  await apply([{ store: 'meta', put: { key: 'templates', value: next } }]);
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
