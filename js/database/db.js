import { DB_NAME, DB_VERSION, MIGRATIONS, STORES } from './schema.js';

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

/** Grava/remove um conjunto de alterações atomicamente. ops: [{store, put|del}] */
export function commit(ops) {
  const names = [...new Set(ops.map((o) => o.store))];
  if (!names.length) return Promise.resolve();
  return withTx(names, 'readwrite', (s) => {
    for (const op of ops) {
      if (op.put) s[op.store].put(op.put);
      else if (op.del != null) s[op.store].delete(op.del);
    }
  });
}

/** Substitui todo o conteúdo do banco em uma única transação. */
export function replaceAll(data) {
  return withTx(STORES, 'readwrite', (s) => {
    for (const name of STORES) {
      s[name].clear();
      for (const row of data[name] || []) s[name].add(row);
    }
  });
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
