// Datas financeiras são strings no calendário local: "AAAA-MM-DD"; meses: "AAAA-MM".
// Nenhuma conversão de fuso é feita: a aritmética usa Date.UTC apenas como
// calculadora de calendário, nunca para representar instantes.

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const MONTHS_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

const pad = (n, l = 2) => String(n).padStart(l, '0');

export function toISO(y, m, d) {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

export function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}

export function isISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const { y, m, d } = parseISO(s);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

export function isMonth(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}$/.test(s)) return false;
  const m = Number(s.slice(5));
  return m >= 1 && m <= 12;
}

export function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y, m) {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

export function today(now = new Date()) {
  return toISO(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function monthOf(iso) {
  return iso ? iso.slice(0, 7) : null;
}

export function currentMonth(now = new Date()) {
  return monthOf(today(now));
}

export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${pad(Math.floor(idx / 12), 4)}-${pad((idx % 12) + 1)}`;
}

export function monthDiff(a, b) {
  // número de meses de a até b
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  return (yb * 12 + mb) - (ya * 12 + ma);
}

/** Dia do mês ajustado ao último dia quando necessário (31 → 30, 29/02 → 28/02). */
export function dateInMonth(month, day) {
  const [y, m] = month.split('-').map(Number);
  return toISO(y, m, Math.min(day, daysInMonth(y, m)));
}

export function firstDay(month) {
  return `${month}-01`;
}

export function lastDay(month) {
  const [y, m] = month.split('-').map(Number);
  return toISO(y, m, daysInMonth(y, m));
}

function toDayNumber(iso) {
  const { y, m, d } = parseISO(iso);
  return Date.UTC(y, m - 1, d) / 86400000;
}

function fromDayNumber(n) {
  const dt = new Date(n * 86400000);
  return toISO(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addDays(iso, n) {
  return fromDayNumber(toDayNumber(iso) + n);
}

export function dayDiff(a, b) {
  return toDayNumber(b) - toDayNumber(a);
}

export function weekday(iso) {
  return new Date(toDayNumber(iso) * 86400000).getUTCDay();
}

export function formatDate(iso) {
  if (!iso) return '';
  const { y, m, d } = parseISO(iso);
  return `${pad(d)}/${pad(m)}/${y}`;
}

export function formatDateShort(iso) {
  if (!iso) return 'a definir';
  const { m, d } = parseISO(iso);
  return `${pad(d)} ${MONTHS_SHORT[m - 1]}`;
}

export function formatDayHeading(iso, todayISO) {
  if (!iso) return 'Data a definir';
  const { y, m, d } = parseISO(iso);
  const diff = todayISO ? dayDiff(todayISO, iso) : null;
  const rel = diff === 0 ? 'Hoje · ' : diff === -1 ? 'Ontem · ' : diff === 1 ? 'Amanhã · ' : '';
  return `${rel}${WEEKDAYS[weekday(iso)]}, ${d} de ${MONTHS[m - 1]}${todayISO && y !== parseISO(todayISO).y ? ` de ${y}` : ''}`;
}

export function formatMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return `${MONTHS[m - 1]} de ${y}`;
}

export function formatMonthShort(month) {
  const [y, m] = month.split('-').map(Number);
  return `${MONTHS_SHORT[m - 1]}/${String(y).slice(2)}`;
}

/** "25/11/2026" ou "25/11/26" → "2026-11-25"; aceita também ISO. */
export function parseDateBR(s) {
  if (isISODate(s)) return s;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(String(s).trim());
  if (!m) return null;
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  const iso = toISO(y, Number(m[2]), Number(m[1]));
  return isISODate(iso) ? iso : null;
}

export function compareISO(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Ordem das listas do mês: mais recentes primeiro; itens com data a definir no fim
 * (sob "Data a definir"), nunca misturados aos datados.
 */
export function byDateDesc(a, b) {
  const da = a.date || '', db = b.date || '';
  if (da !== db) return !da ? 1 : !db ? -1 : da < db ? 1 : -1;
  return (b.createdAt || 0) - (a.createdAt || 0);
}
