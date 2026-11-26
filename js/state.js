import { currentMonth, addMonths, isMonth } from './utils/dates.js';

const listeners = new Set();

export const ui = {
  month: currentMonth(),
  route: 'overview',
  // Filtros da tela de lançamentos (complementares, nunca obrigatórios).
  entries: { query: '', type: '', status: '', categoryId: '', blockId: '', sourceId: '', scope: 'month', groupBy: 'day', sort: 'date' },
};

export function onUI(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emitUI(reason) { for (const fn of listeners) fn(reason); }

export function setMonth(m) {
  if (!isMonth(m) || m === ui.month) return;
  ui.month = m;
  emitUI('month');
}
export const shiftMonth = (n) => setMonth(addMonths(ui.month, n));
export const goToday = () => setMonth(currentMonth());

export function setEntriesFilter(patch, { navigate = false } = {}) {
  Object.assign(ui.entries, patch);
  if (navigate && ui.route !== 'entries') location.hash = '#/lancamentos';
  else emitUI('filter');
}

export function resetEntriesFilter() {
  Object.assign(ui.entries, { query: '', type: '', status: '', categoryId: '', blockId: '', sourceId: '' });
}

export function readPref(key, fallback) {
  try { return localStorage.getItem(`gf.${key}`) ?? fallback; } catch { return fallback; }
}
export function writePref(key, value) {
  try { localStorage.setItem(`gf.${key}`, value); } catch { /* preferências são opcionais */ }
}

/**
 * Lê uma preferência de escolha fechada. Valores antigos são convertidos por
 * `legacy`; qualquer valor desconhecido volta ao padrão (e é regravado), para
 * que uma preferência de outra versão nunca quebre uma tela.
 */
export function readChoice(key, allowed, fallback, legacy = {}) {
  const raw = readPref(key, fallback);
  const v = legacy[raw] ?? raw;
  if (allowed.includes(v)) { if (v !== raw) writePref(key, v); return v; }
  writePref(key, fallback);
  return fallback;
}
