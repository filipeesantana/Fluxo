// Auditoria matemática da 3.0: propriedades que precisam valer para QUALQUER
// conjunto de dados. Os dados são gerados por um PRNG com semente fixa
// (reprodutível) e as somas de referência são recalculadas aqui, de forma
// independente do motor, a partir dos lançamentos brutos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, summarize } from '../../js/services/finance.js';
import { competenceOf } from '../../js/services/cards.js';
import { occurrences, endDateForCount } from '../../js/services/recurrence.js';
import { buildInstallments } from '../../js/services/installments.js';

function prng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const accounts = [
  { id: 'conta', name: 'Conta', kind: 'checking', openingBalance: 100000 },
  { id: 'cash', name: 'Dinheiro', kind: 'cash' },
  { id: 'va', name: 'VA', kind: 'benefit' },
];

function dataset(seed, n = 300) {
  const r = prng(seed);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const txs = [];
  for (let i = 0; i < n; i++) {
    const type = pick(['expense', 'expense', 'expense', 'income', 'refund', 'transfer']);
    const d = 1 + Math.floor(r() * 28);
    const m = pick(['2026-10', '2026-11', '2026-12']);
    const t = {
      id: `t${seed}-${i}`, type, status: r() < 0.7 ? 'done' : 'planned', amount: 1 + Math.floor(r() * 250000),
      date: `${m}-${String(d).padStart(2, '0')}`, description: `x${i}`, createdAt: i,
      categoryId: pick([null, 'c1', 'c2', 'c3']), blockId: pick([null, 'b1', 'b2']), sourceId: pick(['conta', 'cash', 'va', null]),
    };
    if (type === 'transfer') { t.sourceId = 'conta'; t.toAccountId = 'cash'; }
    t.month = competenceOf(t, accounts.find((a) => a.id === t.sourceId));
    txs.push(t);
  }
  const recurrences = [
    { id: 'r1', type: 'expense', description: 'Fixa', amount: 12345, frequency: 'monthly', interval: 1, startDate: '2026-01-31', exceptions: {} },
    { id: 'r2', type: 'income', description: 'Salário', amount: 400000, frequency: 'monthly', interval: 1, startDate: '2026-01-05', sourceId: 'conta', exceptions: {} },
  ];
  return createContext({ transactions: txs, recurrences, accounts, investmentEvents: [{ id: 'e', type: 'contribution', amount: 7000, date: '2026-11-03' }], prefs: { safetyMargin: 5000 }, today: '2026-11-25' });
}

for (const seed of [1, 7, 42, 2026, 31337]) {
  test(`identidades do resumo mensal (semente ${seed})`, () => {
    const ctx = dataset(seed);
    for (const m of ['2026-10', '2026-11', '2026-12']) {
      const s = summarize(ctx, m);
      // 1. Todos os valores são inteiros (centavos): nenhuma fração aparece em somas.
      for (const k of ['incomeReceived', 'incomeExpected', 'expenseDone', 'expensePending', 'expenseTotal', 'projectedSurplus', 'freeSurplus', 'availableToInvest']) assert.ok(Number.isInteger(s[k]), `${k} inteiro`);
      // 2. Sobra projetada = recebidas + previstas − realizadas − pendentes (mesma conta do detalhamento).
      assert.equal(s.projectedSurplus, s.incomeReceived + s.incomeExpected - s.expenseDone - s.expensePending);
      // 3. Despesas totais = realizadas + pendentes = fixas + parcelas + pontuais.
      assert.equal(s.expenseTotal, s.expenseDone + s.expensePending);
      assert.equal(s.expenseTotal, s.expFixed + s.expInstallments + s.expOneOff);
      // 4. Distribuições: cada agrupamento soma exatamente o total de despesas.
      for (const g of [s.byCategory, s.byBlock, s.bySource]) assert.equal(g.reduce((t, x) => t + x.total, 0), s.expenseTotal);
      // 5. Cadeia do disponível para investir (nunca negativo).
      const overflow = Math.max(0, s.restrictedExpense - s.restrictedIncome);
      assert.equal(s.freeSurplus, s.projectedSurplus - s.restrictedIncome + s.restrictedExpense - overflow);
      assert.equal(s.availableToInvest, Math.max(0, Math.max(0, s.freeSurplus - s.safetyMargin) - s.contributed));
      assert.ok(s.availableToInvest >= 0);
      // 6. Recalculo independente a partir dos registros brutos (sem cartões neste conjunto).
      const raw = s.items;
      const income = raw.filter((i) => i.type === 'income').reduce((t, i) => t + i.amount, 0);
      const expense = raw.filter((i) => i.type === 'expense').reduce((t, i) => t + i.amount, 0) - raw.filter((i) => i.type === 'refund').reduce((t, i) => t + i.amount, 0);
      assert.equal(s.incomeReceived + s.incomeExpected, income, 'receitas recalculadas');
      assert.equal(s.expenseTotal, expense, 'despesas recalculadas (estornos abatem)');
      // 7. Transferências nunca entram como receita ou despesa.
      const withoutTransfers = summarize(createContext({ transactions: ctx.transactions.filter((t) => t.type !== 'transfer'), recurrences: ctx.recurrences, accounts, investmentEvents: ctx.investmentEvents, prefs: ctx.prefs, today: '2026-11-25' }), m);
      assert.equal(withoutTransfers.projectedSurplus, s.projectedSurplus, 'transferência não altera a sobra');
    }
  });
}

test('recorrências: sem datas repetidas, ordenadas, dentro do intervalo e respeitando o dia-âncora', () => {
  const r = prng(99);
  for (let k = 0; k < 400; k++) {
    const freq = ['weekly', 'monthly', 'yearly'][k % 3];
    const day = 1 + Math.floor(r() * 31);
    const month = 1 + Math.floor(r() * 12);
    const startDate = `2025-${String(month).padStart(2, '0')}-${String(Math.min(day, 28)).padStart(2, '0')}`;
    const rule = { id: `r${k}`, frequency: freq, interval: 1 + Math.floor(r() * 3), startDate, anchorDay: freq === 'weekly' ? undefined : day, exceptions: {} };
    const out = occurrences(rule, '2025-01-01', '2030-12-31');
    assert.equal(new Set(out).size, out.length, 'sem duplicadas');
    assert.deepEqual([...out].sort(), out, 'ordenadas');
    assert.ok(out.every((d) => d >= startDate && d <= '2030-12-31'), 'dentro do intervalo');
    if (freq !== 'weekly') for (const d of out) {
      const [y, m, dd] = d.split('-').map(Number);
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      assert.equal(dd, Math.min(day, last), `dia-âncora ${day} em ${d}`);
    }
  }
});

test('quantidade de repetições e data final são equivalentes', () => {
  for (const [frequency, interval] of [['weekly', 1], ['weekly', 2], ['monthly', 1], ['monthly', 3], ['yearly', 1]]) {
    for (const count of [1, 2, 5, 12, 37]) {
      const rule = { id: 'x', frequency, interval, startDate: '2027-01-31', anchorDay: frequency === 'weekly' ? undefined : 31, exceptions: {} };
      const endDate = endDateForCount(rule, count);
      assert.equal(occurrences({ ...rule, endDate }, '2000-01-01', '2200-01-01').length, count, `${frequency}/${interval} × ${count}`);
    }
  }
});

test('parcelamentos: a soma das parcelas é exatamente o total, para qualquer total e quantidade', () => {
  const r = prng(5);
  for (let k = 0; k < 2000; k++) {
    const total = 1 + Math.floor(r() * 10_000_000);
    const count = 2 + Math.floor(r() * 119);
    if (total < count) continue;
    const amounts = buildInstallments({ total, count, firstMonth: '2026-11' }).map((p) => p.amount);
    assert.equal(amounts.reduce((a, b) => a + b, 0), total);
    assert.ok(Math.max(...amounts) - Math.min(...amounts) <= 1, 'diferença máxima de 1 centavo entre parcelas');
  }
});
