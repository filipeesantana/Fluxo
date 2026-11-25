import { VALIDATORS } from './validation.js';
import { STORES, DB_VERSION, APP_VERSION } from '../database/schema.js';
import { formatDate, formatMonth } from '../utils/dates.js';

export const BACKUP_FORMAT = 'guia-financeiro-backup';
export const BACKUP_VERSION = 1;
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;

export function buildBackup(data, now = new Date()) {
  const out = {};
  for (const s of STORES) out[s] = (data[s] || []).map((r) => structuredClone(r));
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    schemaVersion: DB_VERSION,
    appVersion: APP_VERSION,
    exportedAt: now.toISOString(),
    data: out,
  };
}

const REFS = {
  transactions: [['categoryId', 'categories'], ['blockId', 'blocks'], ['sourceId', 'accounts'], ['toAccountId', 'accounts'], ['planId', 'installmentPlans'], ['recurrenceId', 'recurrences']],
  recurrences: [['categoryId', 'categories'], ['blockId', 'blocks'], ['sourceId', 'accounts']],
  installmentPlans: [['sourceId', 'accounts']],
  investmentEvents: [['investmentId', 'investments'], ['accountId', 'accounts']],
};

/**
 * Valida um backup sem tocar no banco. Retorna erros (bloqueantes),
 * avisos (inconsistências não bloqueantes) e contagens para o resumo.
 */
export function validateBackup(obj) {
  const errors = [], warnings = [], counts = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['O arquivo não contém um objeto JSON.'], warnings, counts };
  if (obj.format !== BACKUP_FORMAT) errors.push('O arquivo não é um backup do Guia Financeiro.');
  if (!Number.isInteger(obj.version)) errors.push('Versão do backup ausente.');
  else if (obj.version > BACKUP_VERSION) errors.push(`Backup criado por uma versão mais nova do aplicativo (formato ${obj.version}).`);
  if (Number.isInteger(obj.schemaVersion) && obj.schemaVersion > DB_VERSION) errors.push(`Esquema de dados ${obj.schemaVersion} é mais novo que o suportado (${DB_VERSION}).`);
  if (!obj.data || typeof obj.data !== 'object') { errors.push('Estrutura de dados ausente.'); return { ok: false, errors, warnings, counts }; }
  if (errors.length) return { ok: false, errors, warnings, counts };

  const ids = {};
  for (const s of STORES) {
    const rows = obj.data[s] ?? [];
    if (!Array.isArray(rows)) { errors.push(`"${s}" deveria ser uma lista.`); continue; }
    counts[s] = rows.length;
    ids[s] = new Set();
    const validate = VALIDATORS[s];
    rows.forEach((r, i) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) { errors.push(`${s}[${i}]: registro inválido.`); return; }
      const key = s === 'meta' ? r.key : r.id;
      if (ids[s].has(key)) errors.push(`${s}[${i}]: identificador duplicado.`);
      ids[s].add(key);
      const errs = validate(r);
      if (errs.length) errors.push(`${s}[${i}]: ${errs.join(', ')}.`);
    });
  }
  for (const k of Object.keys(obj.data)) if (!STORES.includes(k)) warnings.push(`Coleção desconhecida ignorada: ${k}.`);
  if (errors.length > 20) errors.splice(20, errors.length - 20, `… e mais ${errors.length - 20} erros.`);
  if (errors.length) return { ok: false, errors, warnings, counts };

  for (const [store, refs] of Object.entries(REFS)) {
    let orphans = 0;
    for (const r of obj.data[store] || []) {
      for (const [field, target] of refs) if (r[field] && !ids[target].has(r[field])) orphans++;
    }
    if (orphans) warnings.push(`${orphans} referência(s) em ${store} apontam para registros inexistentes; serão exibidas como "sem classificação".`);
  }
  const occ = new Set();
  let dupOcc = 0;
  for (const t of obj.data.transactions || []) {
    if (!t.recurrenceId || !t.occurrenceDate) continue;
    const k = `${t.recurrenceId}|${t.occurrenceDate}`;
    if (occ.has(k)) dupOcc++; else occ.add(k);
  }
  if (dupOcc) errors.push(`${dupOcc} ocorrência(s) recorrente(s) duplicada(s).`);
  return { ok: errors.length === 0, errors, warnings, counts, exportedAt: obj.exportedAt };
}

export function parseBackupText(text) {
  if (text.length > MAX_BACKUP_BYTES) return { ok: false, errors: ['Arquivo grande demais.'], warnings: [], counts: {} };
  let obj;
  try { obj = JSON.parse(text); } catch { return { ok: false, errors: ['O arquivo não é um JSON válido.'], warnings: [], counts: {} }; }
  const res = validateBackup(obj);
  return { ...res, backup: res.ok ? obj : null };
}

const TYPE_LABEL = { expense: 'Despesa', income: 'Receita', transfer: 'Transferência', refund: 'Reembolso/estorno' };

function csvCell(v) {
  let s = v == null ? '' : String(v);
  // Evita injeção de fórmulas em planilhas.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function transactionsToCSV(transactions, { categories, blocks, accounts }) {
  const name = (map, id) => (id && map.get(id)?.name) || '';
  const header = ['Data', 'Competência', 'Tipo', 'Situação', 'Descrição', 'Valor', 'Categoria', 'Bloco', 'Fonte', 'Destino', 'Parcela'];
  const rows = [...transactions]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((t) => {
      const sign = t.type === 'expense' ? -1 : t.type === 'transfer' ? 0 : 1;
      const value = (sign === 0 ? t.amount : sign * t.amount) / 100;
      return [
        formatDate(t.date), formatMonth(t.month), TYPE_LABEL[t.type], t.status === 'done' ? 'Realizado' : 'Previsto',
        csvCell(t.description),
        value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }),
        csvCell(name(categories, t.categoryId)), csvCell(name(blocks, t.blockId)), csvCell(name(accounts, t.sourceId)), csvCell(name(accounts, t.toAccountId)),
        t.installment ? `${t.installment.index}/${t.installment.count}` : '',
      ].join(';');
    });
  return '﻿' + [header.join(';'), ...rows].join('\r\n');
}
