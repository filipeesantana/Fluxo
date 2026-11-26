// Esquema versionado do IndexedDB. Migrações são cumulativas e não destrutivas:
// cada função leva o banco da versão (n − 1) para n sem apagar dados.

export const DB_NAME = 'guia-financeiro.pessoal';
export const DB_VERSION = 2;
export const APP_VERSION = '2.0.0';

export const STORES = [
  'transactions', 'categories', 'blocks', 'accounts', 'recurrences',
  'installmentPlans', 'budgets', 'investments', 'investmentEvents', 'goals', 'meta',
];

export const DATA_STORES = STORES.filter((s) => s !== 'meta');

export const MIGRATIONS = {
  1(db) {
    const tx = db.createObjectStore('transactions', { keyPath: 'id' });
    tx.createIndex('month', 'month');
    tx.createIndex('date', 'date');
    tx.createIndex('categoryId', 'categoryId');
    tx.createIndex('blockId', 'blockId');
    tx.createIndex('sourceId', 'sourceId');
    tx.createIndex('recurrenceId', 'recurrenceId');
    tx.createIndex('planId', 'planId');
    db.createObjectStore('categories', { keyPath: 'id' }).createIndex('name', 'name');
    db.createObjectStore('blocks', { keyPath: 'id' }).createIndex('name', 'name');
    db.createObjectStore('accounts', { keyPath: 'id' }).createIndex('kind', 'kind');
    db.createObjectStore('recurrences', { keyPath: 'id' });
    db.createObjectStore('installmentPlans', { keyPath: 'id' });
    db.createObjectStore('budgets', { keyPath: 'id' });
    db.createObjectStore('investments', { keyPath: 'id' });
    const ev = db.createObjectStore('investmentEvents', { keyPath: 'id' });
    ev.createIndex('investmentId', 'investmentId');
    ev.createIndex('date', 'date');
    db.createObjectStore('goals', { keyPath: 'id' });
    db.createObjectStore('meta', { keyPath: 'key' });
  },

  // v2: índice único que impede duas ocorrências materializadas da mesma
  // recorrência na mesma data. Duplicatas pré-existentes são removidas antes.
  2(db, upgradeTx) {
    const store = upgradeTx.objectStore('transactions');
    const seen = new Set();
    const req = store.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        const v = cur.value;
        if (v.recurrenceId && v.occurrenceDate) {
          const k = `${v.recurrenceId}|${v.occurrenceDate}`;
          if (seen.has(k)) cur.delete(); else seen.add(k);
        }
        cur.continue();
      } else {
        store.createIndex('occurrence', ['recurrenceId', 'occurrenceDate'], { unique: true });
      }
    };
  },
};
