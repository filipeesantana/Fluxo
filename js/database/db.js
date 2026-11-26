import { DB_NAME, DB_VERSION, MIGRATIONS, STORES, SNAPSHOT_STORE } from './schema.js';

let dbPromise = null;
let onVersionChange = null;

export function setVersionChangeHandler(fn) { onVersionChange = fn; }

export function openDB({ name = DB_NAME, version = DB_VERSION } = {}) {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) { reject(new Error('IndexedDB indisponível neste navegador.')); return; }
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const tx = req.transaction;
      for (let v = ev.oldVersion + 1; v <= version; v++) MIGRATIONS[v]?.(db, tx);
    };
    req.onblocked = () => reject(new Error('Feche outras abas do aplicativo para concluir a atualização do banco de dados.'));
    req.onerror = () => reject(req.error || new Error('Falha ao abrir o banco de dados.'));
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; onVersionChange?.(); };
      resolve(db);
    };
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

export function closeDB() {
  if (!dbPromise) return Promise.resolve();
  return dbPromise.then((db) => { db.close(); dbPromise = null; }).catch(() => {});
}

/**
 * Executa `fn(stores)` dentro de uma única transação. A promessa só resolve
 * quando a transação é efetivada (oncomplete); qualquer erro aborta tudo.
 */
export async function withTx(storeNames, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let result;
    let tx;
    try {
      tx = db.transaction(storeNames, mode);
    } catch (e) { reject(e); return; }
    const stores = Object.fromEntries(storeNames.map((n) => [n, tx.objectStore(n)]));
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error('Operação cancelada.'));
    tx.onerror = (ev) => { ev.preventDefault?.(); };
    try {
      result = fn(stores, tx);
    } catch (e) {
      try { tx.abort(); } catch { /* já abortada */ }
      reject(e);
    }
  });
}

export function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadAll() {
  const out = {};
  await withTx(STORES, 'readonly', (s) => {
    for (const name of STORES) {
      const req = s[name].getAll();
      req.onsuccess = () => { out[name] = req.result; };
    }
  });
  return out;
}

/**
 * Carga em duas fases (consulta indexada por competência):
 * loadRecent traz todas as coleções pequenas e só as movimentações com
 * competência >= cutoff; loadOlder traz o restante do histórico.
 */
export async function loadRecent(cutoff) {
  const out = {};
  await withTx(STORES, 'readonly', (s) => {
    for (const name of STORES) {
      const req = name === 'transactions' ? s[name].index('month').getAll(IDBKeyRange.lowerBound(cutoff)) : s[name].getAll();
      req.onsuccess = () => { out[name] = req.result; };
    }
  });
  return out;
}

export async function loadOlder(cutoff) {
  let rows = [];
  await withTx(['transactions'], 'readonly', (s) => {
    const req = s.transactions.index('month').getAll(IDBKeyRange.upperBound(cutoff, true));
    req.onsuccess = () => { rows = req.result; };
  });
  return rows;
}

/** Lê registros específicos (sincronização incremental entre abas). */
export async function getByKeys(store, keys) {
  const out = new Map();
  await withTx([store], 'readonly', (s) => {
    for (const k of keys) {
      const req = s[store].get(k);
      req.onsuccess = () => out.set(k, req.result);
    }
  });
  return out;
}

export class ConflictError extends Error {
  constructor(message, store, key) { super(message); this.name = 'ConflictError'; this.store = store; this.key = key; }
}

/**
 * Grava/remove um conjunto de alterações em UMA transação (tudo ou nada).
 * ops: [{ store, put | del, expectRev? }]
 * expectRev (controle de concorrência otimista): número de revisão que o
 * registro deve ter no banco no momento da gravação, ou 'absent' quando ele
 * não deve existir. A verificação acontece dentro da própria transação; se
 * outra aba alterou o registro, tudo é abortado e nada é gravado.
 */
export function commit(ops) {
  const names = [...new Set(ops.map((o) => o.store))];
  if (!names.length) return Promise.resolve();
  let conflict = null;
  return withTx(names, 'readwrite', (s, tx) => {
    const write = (op) => {
      if (op.put) s[op.store].put(op.put);
      else if (op.del != null) s[op.store].delete(op.del);
    };
    for (const op of ops) {
      if (op.expectRev === undefined) { write(op); continue; }
      const key = op.put ? s[op.store].keyPath && op.put[s[op.store].keyPath] : op.del;
      const req = s[op.store].get(key);
      req.onsuccess = () => {
        if (conflict) return;
        const cur = req.result;
        const ok = op.expectRev === 'absent' ? !cur : cur && (cur.rev || 0) === op.expectRev;
        if (!ok) {
          conflict = new ConflictError(cur ? 'Este registro foi alterado em outra aba.' : 'Este registro foi excluído em outra aba.', op.store, key);
          try { tx.abort(); } catch { /* já abortada */ }
          return;
        }
        write(op);
      };
    }
  }).catch((err) => { throw conflict || err; });
}

/**
 * Substitui todo o conteúdo do banco em uma única transação. Antes, opcionalmente,
 * guarda um snapshot interno do estado anterior NA MESMA transação.
 */
export function replaceAll(data, { snapshot = null, keepSnapshots = 3 } = {}) {
  const names = snapshot ? [...STORES, SNAPSHOT_STORE] : STORES;
  return withTx(names, 'readwrite', (s) => {
    if (snapshot) {
      s[SNAPSHOT_STORE].put(snapshot);
      const req = s[SNAPSHOT_STORE].getAllKeys();
      req.onsuccess = () => {
        const keys = req.result.filter((k) => k !== snapshot.id).sort();
        for (const k of keys.slice(0, Math.max(0, keys.length - (keepSnapshots - 1)))) s[SNAPSHOT_STORE].delete(k);
      };
    }
    for (const name of STORES) {
      s[name].clear();
      for (const row of data[name] || []) s[name].add(row);
    }
  });
}

export async function listSnapshots() {
  let rows = [];
  await withTx([SNAPSHOT_STORE], 'readonly', (s) => {
    const req = s[SNAPSHOT_STORE].getAll();
    req.onsuccess = () => { rows = req.result; };
  });
  return rows.sort((a, b) => (a.id < b.id ? 1 : -1));
}

export async function requestPersistence() {
  try {
    if (!navigator.storage?.persist) return 'unsupported';
    if (await navigator.storage.persisted()) return 'granted';
    return (await navigator.storage.persist()) ? 'granted' : 'denied';
  } catch { return 'unsupported'; }
}

export async function persistenceStatus() {
  try {
    if (!navigator.storage?.persisted) return 'unsupported';
    return (await navigator.storage.persisted()) ? 'granted' : 'denied';
  } catch { return 'unsupported'; }
}

export async function storageEstimate() {
  try { return await navigator.storage?.estimate?.(); } catch { return null; }
}
