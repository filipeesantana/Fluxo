// Esquema versionado do IndexedDB. Migrações são cumulativas e não destrutivas:
// cada função leva o banco da versão (n − 1) para n sem apagar dados.

import { APP_VERSION } from '../version.js';

// O nome interno do banco nunca muda: é ele que mantém os dados entre versões.
export const DB_NAME = 'guia-financeiro.pessoal';
export const DB_VERSION = 4;
export { APP_VERSION };

export const STORES = [
  'transactions', 'categories', 'blocks', 'accounts', 'recurrences',
  'installmentPlans', 'budgets', 'investments', 'investmentEvents', 'goals', 'calculations', 'meta',
];

export const DATA_STORES = STORES.filter((s) => s !== 'meta');
// Snapshots internos de recuperação: fora de STORES (não entram em backups nem são limpos na restauração).
export const SNAPSHOT_STORE = 'snapshots';

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

  // v3: armazenamento de snapshots internos (estado anterior a restaurações).
  // Apenas acrescenta; nenhum dado existente é lido, alterado ou removido.
  3(db) {
    if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'id' });
  },

  // v4 (Fluxo 3.1): cálculos salvos da calculadora e índice único por CHAVE de
  // ocorrência (datas flexíveis, vários dias no mês). Só acrescenta: registros
  // antigos não têm a chave e por isso não entram no índice; nada é reescrito.
  4(db, upgradeTx) {
    if (!db.objectStoreNames.contains('calculations')) db.createObjectStore('calculations', { keyPath: 'id' });
    const tx = upgradeTx.objectStore('transactions');
    if (!tx.indexNames.contains('occurrenceKey')) tx.createIndex('occurrenceKey', ['recurrenceId', 'occurrenceKey'], { unique: true });
  },
};
