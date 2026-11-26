import { VALIDATORS } from './validation.js';
import { STORES, DB_VERSION, APP_VERSION } from '../database/schema.js';
import { formatDate, formatMonth } from '../utils/dates.js';

/*
 * Formato de backup do Fluxo
 * --------------------------
 * format 'fluxo-backup', version 2:
 *   { format, version, backupId, createdAt, appVersion, schemaVersion,
 *     counts: { store: n }, period: { from, to } | null,
 *     checksum: { algorithm: 'SHA-256', value }, data: { store: rows[] } }
 * O checksum é calculado sobre a serialização DETERMINÍSTICA de `data`
 * (chaves ordenadas). Ele detecta corrupção e alterações acidentais; NÃO é
 * assinatura: quem altera o arquivo de propósito pode recalcular o checksum.
 *
 * Formato legado aceito: 'guia-financeiro-backup' version 1 (Guia Financeiro 1.0 e Fluxo 2.0).
 *
 * Backup protegido (opcional): 'fluxo-backup-encrypted' version 1, com o JSON
 * acima cifrado por AES-256-GCM (criptografia autenticada) e chave derivada
 * da senha por PBKDF2-SHA-256. Sem a senha, não há recuperação possível.
 */

export const BACKUP_FORMAT = 'fluxo-backup';
export const BACKUP_VERSION = 2;
export const LEGACY_FORMAT = 'guia-financeiro-backup';
export const ENCRYPTED_FORMAT = 'fluxo-backup-encrypted';
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
export const PBKDF2_ITERATIONS = 600000;

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('Este navegador não oferece a Web Crypto API necessária.');
  return s;
};

/** JSON com chaves ordenadas (determinístico para o checksum). */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : stableStringify(x))).join(',')}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const toB64 = (buf) => { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); };
const fromB64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

export async function sha256Hex(text) {
  return toHex(await subtle().digest('SHA-256', new TextEncoder().encode(text)));
}

function periodOf(transactions) {
  let from = null, to = null;
  for (const t of transactions || []) {
    if (typeof t?.date !== 'string') continue;
    if (!from || t.date < from) from = t.date;
    if (!to || t.date > to) to = t.date;
  }
  return from ? { from, to } : null;
}

export async function buildBackup(data, now = new Date()) {
  const out = {};
  for (const s of STORES) out[s] = (data[s] || []).map((r) => structuredClone(r));
  const counts = Object.fromEntries(STORES.map((s) => [s, out[s].length]));
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    backupId: globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${now.getTime()}`,
    createdAt: now.toISOString(),
    appVersion: APP_VERSION,
    schemaVersion: DB_VERSION,
    counts,
    period: periodOf(out.transactions),
    checksum: { algorithm: 'SHA-256', value: await sha256Hex(stableStringify(out)) },
    data: out,
  };
}

export function backupFileName(now = new Date(), { encrypted = false } = {}) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(now.getHours())}-${p(now.getMinutes())}`;
  return `Fluxo-backup-${stamp}${encrypted ? '-protegido' : ''}.json`;
}

const REFS = {
  transactions: [['categoryId', 'categories'], ['blockId', 'blocks'], ['sourceId', 'accounts'], ['toAccountId', 'accounts'], ['planId', 'installmentPlans'], ['recurrenceId', 'recurrences']],
  recurrences: [['categoryId', 'categories'], ['blockId', 'blocks'], ['sourceId', 'accounts']],
  installmentPlans: [['sourceId', 'accounts']],
  investmentEvents: [['investmentId', 'investments'], ['accountId', 'accounts']],
};

const isPlainObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o) && (Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null);

/**
 * Valida um backup (formatos 1 e 2) sem tocar no banco. Retorna erros
 * (bloqueantes), avisos (inconsistências não bloqueantes) e dados para a prévia.
 */
export function validateBackup(obj) {
  const errors = [], warnings = [], counts = {};
  const fail = (msg) => ({ ok: false, errors: [...errors, msg].filter(Boolean), warnings, counts });
  if (!isPlainObject(obj)) return fail('O arquivo não contém um objeto JSON.');
  if (obj.format === ENCRYPTED_FORMAT) return fail('Backup protegido por senha: informe a senha para abrir.');
  const legacy = obj.format === LEGACY_FORMAT;
  if (obj.format !== BACKUP_FORMAT && !legacy) return fail('O arquivo não é um backup do Fluxo (nem da versão anterior, Guia Financeiro).');
  if (!Number.isInteger(obj.version)) return fail('Versão do backup ausente.');
  if (legacy && obj.version !== 1) return fail(`Versão de backup legada desconhecida (${obj.version}).`);
  if (!legacy && obj.version > BACKUP_VERSION) return fail(`Backup criado por uma versão mais nova do Fluxo (formato ${obj.version}). Atualize o aplicativo antes de restaurar.`);
  if (!legacy && obj.version < 2) return fail(`Formato de backup inválido (${obj.version}).`);
  if (obj.schemaVersion != null && (!Number.isInteger(obj.schemaVersion) || obj.schemaVersion > DB_VERSION)) return fail(`Esquema de dados ${obj.schemaVersion} é mais novo que o suportado (${DB_VERSION}).`);
  if (!isPlainObject(obj.data)) return fail('Estrutura de dados ausente.');

  const ids = {};
  for (const s of STORES) {
    const rows = obj.data[s] ?? [];
    if (!Array.isArray(rows)) { errors.push(`"${s}" deveria ser uma lista.`); continue; }
    counts[s] = rows.length;
    ids[s] = new Set();
    const validate = VALIDATORS[s];
    rows.forEach((r, i) => {
      if (!isPlainObject(r)) { errors.push(`${s}[${i}]: registro inválido.`); return; }
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

  if (!legacy && isPlainObject(obj.counts)) {
    for (const s of STORES) if (obj.counts[s] != null && obj.counts[s] !== counts[s]) errors.push(`A quantidade de ${s} não confere com o cabeçalho do arquivo (arquivo incompleto?).`);
  }
  for (const [store, refs] of Object.entries(REFS)) {
    let orphans = 0;
    for (const r of obj.data[store] || []) for (const [field, target] of refs) if (r[field] && !ids[target].has(r[field])) orphans++;
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
  return {
    ok: errors.length === 0, errors, warnings, counts, legacy,
    createdAt: obj.createdAt || obj.exportedAt || null,
    appVersion: typeof obj.appVersion === 'string' ? obj.appVersion.slice(0, 20) : null,
    period: periodOf(obj.data.transactions),
    hasChecksum: Boolean(!legacy && obj.checksum),
  };
}

/** Verifica o checksum SHA-256 (formato 2). */
export async function verifyChecksum(obj) {
  if (obj.format !== BACKUP_FORMAT) return { status: 'absent' };
  if (!isPlainObject(obj.checksum) || obj.checksum.algorithm !== 'SHA-256' || typeof obj.checksum.value !== 'string') return { status: 'invalid' };
  const data = Object.fromEntries(STORES.map((s) => [s, obj.data[s] || []]));
  const value = await sha256Hex(stableStringify(data));
  return { status: value === obj.checksum.value ? 'ok' : 'mismatch' };
}

// ——— Criptografia opcional (AES-GCM + PBKDF2) ———

async function deriveKey(password, salt, iterations) {
  const base = await subtle().importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptBackup(backupObj, password, { iterations = PBKDF2_ITERATIONS } = {}) {
  if (typeof password !== 'string' || password.length < 8) throw new Error('Use uma senha com pelo menos 8 caracteres.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iterations);
  const plain = new TextEncoder().encode(JSON.stringify(backupObj));
  const cipher = await subtle().encrypt({ name: 'AES-GCM', iv }, key, plain);
  return {
    format: ENCRYPTED_FORMAT,
    version: 1,
    createdAt: backupObj.createdAt,
    appVersion: backupObj.appVersion,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toB64(salt) },
    cipher: { name: 'AES-GCM', iv: toB64(iv) },
    ciphertext: toB64(cipher),
  };
}

export async function decryptBackup(env, password) {
  if (!isPlainObject(env) || env.format !== ENCRYPTED_FORMAT || env.version !== 1) throw new Error('Arquivo protegido em formato desconhecido.');
  const it = env.kdf?.iterations;
  if (env.kdf?.name !== 'PBKDF2' || env.kdf?.hash !== 'SHA-256' || !Number.isInteger(it) || it < 100000 || it > 5000000) throw new Error('Parâmetros de proteção inválidos.');
  if (env.cipher?.name !== 'AES-GCM' || typeof env.ciphertext !== 'string') throw new Error('Parâmetros de proteção inválidos.');
  let plain;
  try {
    const key = await deriveKey(password, fromB64(env.kdf.salt), it);
    plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(env.cipher.iv) }, key, fromB64(env.ciphertext));
  } catch {
    throw new Error('Senha incorreta ou arquivo danificado.');
  }
  return JSON.parse(new TextDecoder().decode(plain));
}

/**
 * Lê um arquivo de backup: tamanho → JSON → (descriptografia) → estrutura,
 * tipos, identificadores, relacionamentos e duplicidades → checksum.
 * Nada é gravado aqui.
 */
export async function parseBackupText(text, { password } = {}) {
  const fail = (msg, extra = {}) => ({ ok: false, errors: [msg], warnings: [], counts: {}, ...extra });
  if (typeof text !== 'string' || text.length > MAX_BACKUP_BYTES) return fail('Arquivo grande demais para ser um backup.');
  let obj;
  try { obj = JSON.parse(text); } catch { return fail('O arquivo não é um JSON válido.'); }
  let encrypted = false;
  if (isPlainObject(obj) && obj.format === ENCRYPTED_FORMAT) {
    encrypted = true;
    if (!password) return fail('Este backup é protegido por senha.', { needsPassword: true });
    try { obj = await decryptBackup(obj, password); } catch (err) { return fail(err.message, { needsPassword: true }); }
  }
  const res = validateBackup(obj);
  if (!res.ok) return { ...res, encrypted };
  const sum = await verifyChecksum(obj);
  if (sum.status === 'mismatch' || sum.status === 'invalid') {
    return { ...res, ok: false, encrypted, checksum: sum.status, errors: ['A verificação de integridade (SHA-256) falhou: o arquivo foi alterado ou está corrompido. Nenhum dado foi modificado.'] };
  }
  return { ...res, encrypted, checksum: sum.status, backup: obj };
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
