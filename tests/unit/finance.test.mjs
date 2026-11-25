import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, summarize, accountBalances, projection, cashPosition } from '../../js/services/finance.js';
import { billFor, competenceOf } from '../../js/services/cards.js';
import { occurrences } from '../../js/services/recurrence.js';
import { buildInstallments } from '../../js/services/installments.js';

let seq = 0;
const tx = (o) => {
  const t = { id: `t${++seq}`, status: 'done', description: 'x', categoryId: null, blockId: null, sourceId: null, createdAt: seq, ...o };
  t.month = t.month || competenceOf(t, accounts.find((a) => a.id === t.sourceId));
  return t;
};
const accounts = [
  { id: 'conta', name: 'Conta Nubank', kind: 'checking', openingBalance: 500000 },
  { id: 'nu', name: 'Cartão Nubank', kind: 'credit', closingDay: 3, dueDay: 10 },
  { id: 'cfg', name: 'Cartão sem regra', kind: 'credit' },
  { id: 'va', name: 'VA', kind: 'benefit' },
];
const ctxOf = (transactions, extra = {}) => createContext({ transactions, accounts, today: '2026-11-25', ...extra });

test('Cenário 1: despesa aparece em categoria, bloco e fonte sem duplicar o total', () => {
  const c = ctxOf([tx({ type: 'expense', amount: 12990, date: '2026-11-25', categoryId: 'alim', blockId: 'nam', sourceId: 'conta' })]);
  const s = summarize(c, '2026-11');
  assert.equal(s.expenseTotal, 12990);
  assert.equal(s.expenseDone, 12990);
  assert.equal(s.byCategory[0].key, 'alim'); assert.equal(s.byCategory[0].total, 12990);
  assert.equal(s.byBlock[0].key, 'nam'); assert.equal(s.byBlock[0].total, 12990);
  assert.equal(s.bySource[0].key, 'conta'); assert.equal(s.bySource[0].total, 12990);
  assert.equal(s.byCategory[0].pct, 100);
});

test('Cenário 2: 3.000 de receitas, 1.450 realizadas, 650 futuras → sobra de 900', () => {
  const c = ctxOf([
    tx({ type: 'income', amount: 300000, date: '2026-11-05', sourceId: 'conta' }),
    tx({ type: 'expense', amount: 145000, date: '2026-11-10', sourceId: 'conta' }),
    tx({ type: 'expense', amount: 65000, date: '2026-11-28', status: 'planned', sourceId: 'conta' }),
  ]);
  const s = summarize(c, '2026-11');
  assert.equal(s.incomeReceived, 300000);
  assert.equal(s.expenseDone, 145000);
  assert.equal(s.expensePending, 65000);
  assert.equal(s.projectedSurplus, 90000);
  assert.equal(s.currentSurplus, 155000);
  assert.equal(s.availableToInvest, 90000);
});

test('receita prevista não conta como recebida', () => {
  const s = summarize(ctxOf([tx({ type: 'income', amount: 100000, date: '2026-11-30', status: 'planned' })]), '2026-11');
  assert.equal(s.incomeReceived, 0);
  assert.equal(s.incomeExpected, 100000);
  assert.equal(s.currentSurplus, 0);
});

test('regra da fatura: fechamento, vencimento e dias inexistentes', () => {
  const nu = accounts[1];
  assert.equal(billFor('2026-11-02', nu).month, '2026-11');
  assert.equal(billFor('2026-11-03', nu).month, '2026-12');
  assert.equal(billFor('2026-11-25', nu).month, '2026-12');
  assert.equal(billFor('2026-11-25', nu).dueDate, '2026-12-10');
  const late = { kind: 'credit', closingDay: 31, dueDay: 7 };
  assert.equal(billFor('2026-02-27', late).closingDate, '2026-02-28');
  assert.equal(billFor('2026-02-28', late).month, '2026-04');
  assert.equal(billFor('2026-02-27', late).month, '2026-03');
  // Cartão sem regra configurada: nada é inventado.
  const r = billFor('2026-11-25', accounts[2]);
  assert.equal(r.configured, false);
  assert.equal(r.month, '2026-11');
  assert.equal(r.dueDate, null);
});

test('Cenário 5: compra no cartão + pagamento da fatura não duplicam a despesa', () => {
  const compra = tx({ type: 'expense', amount: 20000, date: '2026-11-25', sourceId: 'nu' });
  const before = summarize(ctxOf([compra]), '2026-12');
  assert.equal(before.expenseTotal, 20000);
  assert.equal(before.expenseDone, 0);
  assert.equal(before.expensePending, 20000);
  const pagamento = tx({ type: 'transfer', amount: 20000, date: '2026-12-10', sourceId: 'conta', toAccountId: 'nu', billMonth: '2026-12' });
  const c = ctxOf([compra, pagamento]);
  const after = summarize(c, '2026-12');
  assert.equal(after.expenseTotal, 20000);
  assert.equal(after.expenseDone, 20000);
  assert.equal(after.expensePending, 0);
  assert.equal(after.cardBills[0].status, 'paid');
  const bal = accountBalances(c);
  assert.equal(bal.get('conta'), 500000 - 20000);
  assert.equal(bal.get('nu'), 0);
  // Novembro não é afetado pela compra (competência dezembro).
  assert.equal(summarize(c, '2026-11').expenseTotal, 0);
});

test('pagamento parcial de fatura deixa o restante como compromisso', () => {
  const c = ctxOf([
    tx({ type: 'expense', amount: 30000, date: '2026-11-10', sourceId: 'nu' }),
    tx({ type: 'transfer', amount: 10000, date: '2026-12-05', sourceId: 'conta', toAccountId: 'nu', billMonth: '2026-12' }),
  ]);
  const s = summarize(c, '2026-12');
  assert.equal(s.expenseDone, 10000);
  assert.equal(s.expensePending, 20000);
  assert.equal(s.cardBills[0].status, 'partial');
});

test('transferências e aportes não são consumo', () => {
  const c = ctxOf([
    tx({ type: 'income', amount: 100000, date: '2026-11-01', sourceId: 'conta' }),
    tx({ type: 'transfer', amount: 50000, date: '2026-11-02', sourceId: 'conta', toAccountId: 'va' }),
  ], { investmentEvents: [{ id: 'e', investmentId: 'i', type: 'contribution', amount: 30000, date: '2026-11-03', accountId: 'conta' }] });
  const s = summarize(c, '2026-11');
  assert.equal(s.expenseTotal, 0);
  assert.equal(s.projectedSurplus, 100000);
  assert.equal(s.contributed, 30000);
  assert.equal(s.availableToInvest, 70000);
  assert.equal(accountBalances(c).get('conta'), 500000 + 100000 - 50000 - 30000);
});

test('reembolso e estorno reduzem a despesa original', () => {
  const c = ctxOf([
    tx({ type: 'expense', amount: 10000, date: '2026-11-10', sourceId: 'conta', categoryId: 'lazer' }),
    tx({ type: 'refund', amount: 4000, date: '2026-11-12', sourceId: 'conta', categoryId: 'lazer' }),
  ]);
  const s = summarize(c, '2026-11');
  assert.equal(s.expenseTotal, 6000);
  assert.equal(s.byCategory[0].total, 6000);
  assert.equal(accountBalances(c).get('conta'), 500000 - 6000);
});

test('Cenário 20: benefício restrito não é considerado disponível para aportes', () => {
  const c = ctxOf([
    tx({ type: 'income', amount: 300000, date: '2026-11-05', sourceId: 'conta' }),
    tx({ type: 'income', amount: 60000, date: '2026-11-05', sourceId: 'va', restricted: true }),
    tx({ type: 'expense', amount: 40000, date: '2026-11-08', sourceId: 'va' }),
    tx({ type: 'expense', amount: 170000, date: '2026-11-09', sourceId: 'conta' }),
  ]);
  const s = summarize(c, '2026-11');
  assert.equal(s.projectedSurplus, 150000);
  assert.equal(s.restrictedLeft, 20000);
  assert.equal(s.freeSurplus, 130000);
  assert.equal(s.availableToInvest, 130000);
  // Gasto do benefício acima do recebido consome dinheiro livre.
  const c2 = ctxOf([
    tx({ type: 'income', amount: 300000, date: '2026-11-05', sourceId: 'conta' }),
    tx({ type: 'income', amount: 60000, date: '2026-11-05', sourceId: 'va', restricted: true }),
    tx({ type: 'expense', amount: 80000, date: '2026-11-08', sourceId: 'va' }),
  ]);
  assert.equal(summarize(c2, '2026-11').freeSurplus, 300000 - 20000);
  assert.equal(cashPosition(c2).restricted, -20000);
});

test('margem de segurança reduz o disponível para aportes', () => {
  const c = ctxOf([tx({ type: 'income', amount: 100000, date: '2026-11-05' })], { prefs: { safetyMargin: 20000 } });
  assert.equal(summarize(c, '2026-11').availableToInvest, 80000);
});

test('Cenário 4: conta mensal projetada em 12 meses, sem duplicações', () => {
  const rule = { id: 'r1', type: 'expense', description: 'Internet', amount: 10000, frequency: 'monthly', startDate: '2026-11-15', sourceId: 'conta' };
  const c = ctxOf([], { recurrences: [rule] });
  const months = projection(c, '2026-11', 12);
  for (const m of months) {
    const items = m.items.filter((i) => i.recurrenceId === 'r1');
    assert.equal(items.length, 1, m.month);
    assert.equal(m.expensePending, 10000);
  }
  // Navegar novamente (recalcular) não duplica.
  assert.equal(summarize(c, '2027-03').items.length, 1);
  // Ocorrência paga é materializada e substitui a projeção.
  const paid = tx({ type: 'expense', amount: 10000, date: '2026-11-15', sourceId: 'conta', recurrenceId: 'r1', occurrenceDate: '2026-11-15' });
  const c2 = ctxOf([paid], { recurrences: [rule] });
  const nov = summarize(c2, '2026-11');
  assert.equal(nov.items.length, 1);
  assert.equal(nov.expenseDone, 10000);
  assert.equal(nov.expensePending, 0);
});

test('recorrências: dia 31, 29/02 anual, semanal, exceções e data final', () => {
  const m31 = { frequency: 'monthly', startDate: '2026-01-31' };
  assert.deepEqual(occurrences(m31, '2026-01-01', '2026-05-31'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  const leap = { frequency: 'yearly', startDate: '2028-02-29' };
  assert.deepEqual(occurrences(leap, '2028-01-01', '2032-12-31'), ['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
  const weekly = { frequency: 'weekly', startDate: '2026-11-02' };
  assert.deepEqual(occurrences(weekly, '2026-11-01', '2026-11-30'), ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30']);
  assert.deepEqual(occurrences({ ...weekly, interval: 2 }, '2026-11-10', '2026-12-31'), ['2026-11-16', '2026-11-30', '2026-12-14', '2026-12-28']);
  const skip = { frequency: 'monthly', startDate: '2026-11-10', exceptions: { '2026-12-10': 'skipped' }, endDate: '2027-02-10' };
  assert.deepEqual(occurrences(skip, '2026-01-01', '2027-12-31'), ['2026-11-10', '2027-01-10', '2027-02-10']);
  const far = { frequency: 'monthly', startDate: '2000-01-15' };
  assert.deepEqual(occurrences(far, '2026-11-01', '2026-11-30'), ['2026-11-15']);
});

test('recorrência no cartão cai na competência da fatura', () => {
  const rule = { id: 'r2', type: 'expense', description: 'Streaming', amount: 3990, frequency: 'monthly', startDate: '2026-11-05', sourceId: 'nu' };
  const c = ctxOf([], { recurrences: [rule] });
  assert.equal(summarize(c, '2026-11').items.length, 0);
  const dec = summarize(c, '2026-12');
  assert.equal(dec.items.length, 1);
  assert.equal(dec.items[0].date, '2026-11-05');
  assert.equal(summarize(c, '2027-01').items[0].date, '2026-12-05');
});

test('Cenário 3: parcelamento de 1.000 em 3 vezes soma exatamente 1.000', () => {
  const p = buildInstallments({ total: 100000, count: 3, firstMonth: '2026-12' });
  assert.deepEqual(p.map((x) => x.amount), [33334, 33333, 33333]);
  assert.deepEqual(p.map((x) => x.month), ['2026-12', '2027-01', '2027-02']);
  assert.equal(p.reduce((a, b) => a + b.amount, 0), 100000);
  assert.throws(() => buildInstallments({ total: 100, count: 1, firstMonth: '2026-12' }));
});

test('Cenário 6: edição retroativa atualiza os indicadores do mês correto', () => {
  const t = tx({ type: 'expense', amount: 5000, date: '2026-09-10', sourceId: 'conta' });
  assert.equal(summarize(ctxOf([t]), '2026-09').expenseTotal, 5000);
  const edited = { ...t, amount: 7500, date: '2026-08-10', month: '2026-08' };
  const c = ctxOf([edited]);
  assert.equal(summarize(c, '2026-09').expenseTotal, 0);
  assert.equal(summarize(c, '2026-08').expenseTotal, 7500);
});

test('orçamentos usam o total do mês (realizado + pendente)', () => {
  const c = ctxOf([
    tx({ type: 'expense', amount: 30000, date: '2026-11-02', categoryId: 'alim' }),
    tx({ type: 'expense', amount: 10000, date: '2026-11-20', status: 'planned', categoryId: 'alim' }),
  ], { budgets: [{ id: 'b', scope: 'category', refId: 'alim', amount: 50000 }] });
  const b = summarize(c, '2026-11').budgets[0];
  assert.equal(b.used, 40000);
  assert.equal(b.remaining, 10000);
});

test('evolução diária separa realizado de futuro', () => {
  const c = ctxOf([
    tx({ type: 'expense', amount: 1000, date: '2026-11-03' }),
    tx({ type: 'expense', amount: 2000, date: '2026-11-28', status: 'planned' }),
  ]);
  const d = summarize(c, '2026-11').days;
  assert.equal(d.length, 30);
  assert.equal(d[2].done, 1000);
  assert.equal(d[27].planned, 2000);
});
