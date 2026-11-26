// Fluxo 3.1 — modos de recorrência, compromissos e reconciliação no motor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, summarize } from '../../js/services/finance.js';
import { competenceOf } from '../../js/services/cards.js';
import { ruleOccurrences, endDateForCount, parseDays, describeFrequency } from '../../js/services/recurrence.js';
import { commitmentsFor, commitmentOf } from '../../js/services/commitments.js';
import { validateRecurrence, validateTransaction, isOccKey } from '../../js/services/validation.js';

const accounts = [
  { id: 'conta', name: 'Conta', kind: 'checking' },
  { id: 'cash', name: 'Dinheiro', kind: 'cash' },
  { id: 'nu', name: 'Cartão', kind: 'credit', closingDay: 3, dueDay: 10 },
  { id: 'va', name: 'VA', kind: 'benefit' },
];
const acc = (id) => accounts.find((a) => a.id === id);
const tx = (o) => {
  const t = { status: 'planned', description: 'x', categoryId: null, blockId: null, sourceId: null, createdAt: 1, ...o };
  t.month = t.date ? competenceOf(t, acc(t.sourceId)) : (t.period || t.month);
  return t;
};
const ctxOf = (transactions, recurrences, today = '2026-11-25') => createContext({ transactions, recurrences, accounts, today });

const psico = { id: 'psi', type: 'expense', description: 'Psicóloga', amount: 5000, frequency: 'monthly', interval: 1, mode: 'flex', perPeriod: 2, startDate: '2026-11-01', categoryId: 'saude', exceptions: {} };

test('Cenário 1 — psicóloga: 2 consultas flexíveis de R$ 50; pagar uma não duplica nem some do previsto', () => {
  // Datas definidas: 04/11 (paga) e 18/11 (pendente). Nenhuma data é inventada para dezembro.
  const t1 = tx({ id: 'psi:2026-11#1', recurrenceId: 'psi', occurrenceKey: '2026-11#1', period: '2026-11', type: 'expense', status: 'done', amount: 5000, date: '2026-11-04' });
  const t2 = tx({ id: 'psi:2026-11#2', recurrenceId: 'psi', occurrenceKey: '2026-11#2', period: '2026-11', type: 'expense', status: 'planned', amount: 5000, date: '2026-11-18' });
  let s = summarize(ctxOf([t1, t2], [psico]), '2026-11');
  assert.equal(s.expenseDone, 5000);
  assert.equal(s.expensePending, 5000);
  assert.equal(s.expenseTotal, 10000, 'nunca 150 ou 200');
  const c = commitmentOf(ctxOf([t1, t2], [psico]), psico, '2026-11');
  assert.equal(c.count, 2); assert.equal(c.doneCount, 1); assert.equal(c.paid, 5000); assert.equal(c.left, 5000); assert.equal(c.state, 'overdue', '18/11 já passou em 25/11');
  // Pagar a segunda → compromisso concluído.
  const t2p = { ...t2, status: 'done' };
  const c2 = commitmentOf(ctxOf([t1, t2p], [psico]), psico, '2026-11');
  assert.equal(c2.state, 'done'); assert.equal(c2.doneCount, 2);
  s = summarize(ctxOf([t1, t2p], [psico]), '2026-11');
  assert.equal(s.expenseDone, 10000); assert.equal(s.expensePending, 0); assert.equal(s.expenseTotal, 10000);
  // Dezembro continua com duas ocorrências pendentes, sem data definida.
  const dec = commitmentOf(ctxOf([t1, t2p], [psico]), psico, '2026-12');
  assert.equal(dec.count, 2); assert.equal(dec.doneCount, 0); assert.equal(dec.state, 'tbd');
  assert.ok(dec.entries.every((e) => e.date === null && e.state === 'tbd'));
  const sd = summarize(ctxOf([t1, t2p], [psico]), '2026-12');
  assert.equal(sd.expensePending, 10000); assert.equal(sd.overdue, 0, 'sem data nunca é atrasado');
  assert.equal(sd.days.reduce((a, d) => a + d.planned, 0), 0, 'nenhum dia inventado no gráfico diário');
});

test('Cenário 2 — a cada 14 dias: dezembro tem três ocorrências (R$ 150)', () => {
  const r = { id: 'q', type: 'expense', description: 'Consulta', amount: 5000, frequency: 'weekly', interval: 2, startDate: '2026-11-04', exceptions: {} };
  assert.deepEqual(ruleOccurrences(r, '2026-11-01', '2027-01-31').map((o) => o.date), ['2026-11-04', '2026-11-18', '2026-12-02', '2026-12-16', '2026-12-30', '2027-01-13', '2027-01-27']);
  const ctx = ctxOf([], [r]);
  assert.equal(summarize(ctx, '2026-11').expenseTotal, 10000);
  assert.equal(summarize(ctx, '2026-12').expenseTotal, 15000);
  assert.equal(commitmentOf(ctx, r, '2026-12').count, 3);
});

test('vários dias no mês (5 e 20): cada ocorrência tem estado próprio; dia 31 vira 28/02', () => {
  const r = { id: 'd', type: 'expense', description: 'Diarista', amount: 5000, frequency: 'monthly', mode: 'days', days: [5, 20], startDate: '2026-11-01', exceptions: {} };
  assert.equal(summarize(ctxOf([], [r]), '2026-11').expenseTotal, 10000);
  const paid = tx({ id: 'd:2026-11@5', recurrenceId: 'd', occurrenceKey: '2026-11@5', period: '2026-11', type: 'expense', status: 'done', amount: 5000, date: '2026-11-05' });
  const c = commitmentOf(ctxOf([paid], [r]), r, '2026-11');
  assert.deepEqual(c.entries.map((e) => e.state), ['done', 'overdue']);
  const r31 = { ...r, id: 'e', days: [15, 31], startDate: '2027-01-01' };
  assert.deepEqual(ruleOccurrences(r31, '2027-02-01', '2027-03-31').map((o) => o.date), ['2027-02-15', '2027-02-28', '2027-03-15', '2027-03-31']);
  assert.deepEqual(parseDays('20, 5, 5, 40'), [5, 20]);
  assert.equal(describeFrequency(r), 'Nos dias 5 e 20');
});

test('Cenário 7 — previsão de combustível: gastos vinculados consomem o previsto; excedente aparece', () => {
  const f = { id: 'f', type: 'expense', description: 'Combustível', amount: 40000, frequency: 'monthly', mode: 'forecast', startDate: '2026-11-01', categoryId: 'transp', exceptions: {} };
  const g = (id, amount, date) => tx({ id, type: 'expense', status: 'done', amount, date, forecastId: 'f', categoryId: 'transp', sourceId: 'conta' });
  let list = [g('a', 10000, '2026-11-04'), g('b', 8000, '2026-11-11'), g('c', 12000, '2026-11-19')];
  let s = summarize(ctxOf(list, [f]), '2026-11');
  assert.equal(s.expenseDone, 30000);
  assert.equal(s.forecastLeft, 10000, 'restante planejado');
  assert.equal(s.expenseTotal, 40000, 'não 70.000');
  assert.equal(s.expensePending, 0, 'previsão não é obrigação');
  let c = commitmentOf(ctxOf(list, [f]), f, '2026-11');
  assert.equal(c.used, 30000); assert.equal(c.left, 10000); assert.equal(c.excess, 0);
  list = [...list, g('d', 15000, '2026-11-24')];
  s = summarize(ctxOf(list, [f]), '2026-11');
  assert.equal(s.expenseDone, 45000); assert.equal(s.forecastLeft, 0); assert.equal(s.expenseTotal, 45000);
  c = commitmentOf(ctxOf(list, [f]), f, '2026-11');
  assert.equal(c.excess, 5000); assert.equal(c.state, 'over');
  // Encerrar o mês com sobra: o não usado deixa de contar e não vira despesa.
  const closed = { ...f, closed: { '2026-11': true } };
  s = summarize(ctxOf(list.slice(0, 3), [closed]), '2026-11');
  assert.equal(s.forecastLeft, 0); assert.equal(s.expenseTotal, 30000);
  // Dezembro sem gastos: previsão inteira como restante.
  assert.equal(summarize(ctxOf(list, [f]), '2026-12').forecastLeft, 40000);
});

test('Cenário 3 — recorrência independe da fonte: Pix, dinheiro, débito, cartão e VA', () => {
  const base = { type: 'expense', description: 'Fixa', amount: 1000, frequency: 'monthly', startDate: '2026-11-15', exceptions: {} };
  const rules = [
    { ...base, id: 'pix', sourceId: 'conta', method: 'pix' }, { ...base, id: 'din', sourceId: 'cash' },
    { ...base, id: 'deb', sourceId: 'conta', method: 'debit' }, { ...base, id: 'car', sourceId: 'nu' }, { ...base, id: 'vr', sourceId: 'va' },
    { ...base, id: 'sem', sourceId: null },
  ];
  for (const r of rules) assert.deepEqual(validateRecurrence(r), [], r.id);
  const s = summarize(ctxOf([], rules), '2026-12');
  // Cartão: compra de 15/12 cai na fatura de janeiro (fecha dia 3) — não conta em dezembro.
  assert.equal(s.expenseTotal, 5000 + 1000 /* compra de 15/11 no cartão vence em dezembro */);
  assert.equal(s.cardBills.length, 1);
  assert.equal(s.restrictedExpense, 1000, 'VA continua restrito');
});

test('pagamento parcial: pago + restante = previsto; nada é contado duas vezes', () => {
  const r = { id: 'p', type: 'expense', description: 'Curso', amount: 10000, frequency: 'monthly', startDate: '2026-11-10', exceptions: {} };
  const paid = tx({ id: 'p:2026-11-10', recurrenceId: 'p', occurrenceKey: '2026-11-10', occurrenceDate: '2026-11-10', period: '2026-11', type: 'expense', status: 'done', amount: 6000, plannedAmount: 10000, date: '2026-11-10' });
  const rest = tx({ id: 'p:2026-11-10~resto', recurrenceId: 'p', remainderOf: 'p:2026-11-10', period: '2026-11', type: 'expense', status: 'planned', amount: 4000, date: '2026-11-10' });
  const ctx = ctxOf([paid, rest], [r]);
  const s = summarize(ctx, '2026-11');
  assert.equal(s.expenseDone, 6000); assert.equal(s.expensePending, 4000); assert.equal(s.expenseTotal, 10000);
  const c = commitmentOf(ctx, r, '2026-11');
  assert.equal(c.entries.length, 1); assert.equal(c.entries[0].state, 'partial'); assert.equal(c.paid, 6000); assert.equal(c.left, 4000);
});

test('ignorar e cancelar não são pagamento; independência entre meses', () => {
  const r = { id: 'i', type: 'expense', description: 'Academia', amount: 9000, frequency: 'monthly', startDate: '2026-11-05', exceptions: { '2026-12-05': 'skipped', '2027-01-05': 'cancelled' } };
  const ctx = ctxOf([], [r]);
  assert.equal(summarize(ctx, '2026-12').expenseTotal, 0);
  const dec = commitmentOf(ctx, r, '2026-12');
  assert.equal(dec.state, 'skipped'); assert.equal(dec.paid, 0);
  assert.equal(commitmentOf(ctx, r, '2027-01').entries[0].state, 'cancelled');
  assert.equal(summarize(ctx, '2027-02').expenseTotal, 9000);
});

test('Cenário 8 — início e fim: nada fora do intervalo; quantidade em meses para datas flexíveis', () => {
  const r = { id: 'x', mode: 'flex', perPeriod: 2, frequency: 'monthly', startDate: '2027-01-01', endDate: '2027-02-28', exceptions: {} };
  const occ = ruleOccurrences(r, '2026-01-01', '2028-12-31');
  assert.deepEqual([...new Set(occ.map((o) => o.period))], ['2027-01', '2027-02']);
  assert.equal(endDateForCount({ ...r, endDate: null }, 3), '2027-03-31');
  const leap = { id: 'y', mode: 'days', days: [29], frequency: 'monthly', startDate: '2028-01-29', endDate: '2028-03-29', exceptions: {} };
  assert.deepEqual(ruleOccurrences(leap, '2028-01-01', '2028-12-31').map((o) => o.date), ['2028-01-29', '2028-02-29', '2028-03-29']);
  const daily = { id: 'z', frequency: 'daily', interval: 10, startDate: '2026-11-25', endDate: '2026-12-31', exceptions: {} };
  assert.deepEqual(ruleOccurrences(daily, '2026-11-01', '2027-12-31').map((o) => o.date), ['2026-11-25', '2026-12-05', '2026-12-15', '2026-12-25']);
});

test('validação: frequência zero/negativa, modos inválidos e data a definir só em previstos', () => {
  const ok = { id: 'r', type: 'expense', description: 'X', amount: 1, frequency: 'monthly', startDate: '2026-11-01' };
  assert.notDeepEqual(validateRecurrence({ ...ok, interval: 0 }), []);
  assert.notDeepEqual(validateRecurrence({ ...ok, interval: -1 }), []);
  assert.notDeepEqual(validateRecurrence({ ...ok, frequency: 'daily', interval: 400 }), []);
  assert.notDeepEqual(validateRecurrence({ ...ok, mode: 'flex', perPeriod: 0 }), []);
  assert.notDeepEqual(validateRecurrence({ ...ok, mode: 'days', days: [5, 5] }), []);
  assert.notDeepEqual(validateRecurrence({ ...ok, mode: 'days', days: [5], frequency: 'weekly' }), []);
  assert.notDeepEqual(validateRecurrence({ ...ok, type: 'income', mode: 'forecast' }), []);
  assert.deepEqual(validateRecurrence({ ...ok, mode: 'flex', perPeriod: 2, exceptions: { '2026-12#2': 'skipped' } }), []);
  const t = { id: 't', type: 'expense', status: 'planned', description: 'x', amount: 100, date: null, month: '2026-12' };
  assert.deepEqual(validateTransaction(t), []);
  assert.notDeepEqual(validateTransaction({ ...t, status: 'done' }), [], 'pago precisa de data');
  assert.ok(isOccKey('2026-11#2') && isOccKey('2026-11@31') && isOccKey('2026-11') && isOccKey('2026-11-05'));
  assert.ok(!isOccKey('2026-11#99') && !isOccKey('__proto__') && !isOccKey('2026-13#1'));
});

test('lista de compromissos do mês: totais conferem com o resumo', () => {
  const r = { id: 'r', type: 'expense', description: 'Internet', amount: 10000, frequency: 'monthly', startDate: '2026-11-10', sourceId: 'conta', exceptions: {} };
  const one = tx({ id: 'one', type: 'expense', status: 'planned', amount: 2500, date: null, period: '2026-12', description: 'Consulta' });
  const ctx = ctxOf([one], [r, psico]);
  const cm = commitmentsFor(ctx, '2026-12');
  assert.equal(cm.totals.total, 20000);
  assert.equal(cm.totals.count, 3);
  assert.equal(cm.oneOff.length, 1);
  assert.equal(cm.oneOff[0].state, 'tbd');
  assert.equal(summarize(ctx, '2026-12').expensePending, 22500);
});
