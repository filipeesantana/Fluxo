import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, summarize } from '../../js/services/finance.js';
import { competenceOf } from '../../js/services/cards.js';
import { monthInsights } from '../../js/services/insights.js';
import { calendarMonth, upcoming, eventDate } from '../../js/services/calendar.js';
import { baselineRows, applyScenario, compareRows, endingCommitments } from '../../js/services/scenarios.js';
import { findSimilar, auditData, normalizeDescription } from '../../js/services/integrity.js';
import { simulateGoal, simulateSchedule, goalRate } from '../../js/services/investments.js';

const accounts = [
  { id: 'conta', name: 'Conta', kind: 'checking' },
  { id: 'nu', name: 'Nubank', kind: 'credit', closingDay: 3, dueDay: 10 },
];
let seq = 0;
const tx = (o) => { const t = { id: `t${++seq}`, status: 'done', description: 'x', categoryId: null, blockId: null, sourceId: null, createdAt: seq, ...o }; t.month = t.month || competenceOf(t, accounts.find((a) => a.id === t.sourceId)); return t; };
const ctxOf = (transactions, extra = {}) => createContext({ transactions, accounts, today: '2026-11-25', ...extra });

test('insights: comparações só existem com dados reais do mês anterior', () => {
  const only = ctxOf([tx({ type: 'expense', amount: 10000, date: '2026-11-10' })]);
  const a = monthInsights(only, '2026-11');
  assert.equal(a.expenseVsPrev, undefined, 'sem mês anterior não há comparação');
  assert.equal(a.incomeCommitted, undefined, 'sem renda não há percentual comprometido');
  assert.equal(a.commitmentsPaid.ratio, 1);
  const c = ctxOf([
    tx({ type: 'expense', amount: 10000, date: '2026-10-10', categoryId: 'alim' }),
    tx({ type: 'income', amount: 50000, date: '2026-10-05' }),
    tx({ type: 'expense', amount: 15000, date: '2026-11-10', categoryId: 'alim' }),
    tx({ type: 'expense', amount: 5000, date: '2026-11-28', status: 'planned', categoryId: 'lazer' }),
    tx({ type: 'income', amount: 40000, date: '2026-11-05' }),
  ]);
  const b = monthInsights(c, '2026-11');
  assert.equal(b.expenseVsPrev.diff, 10000);
  assert.equal(b.expenseVsPrev.ratio, 1);
  assert.equal(b.incomeCommitted.ratio, 0.5);
  assert.equal(b.commitmentsPaid.ratio, 0.75);
  assert.equal(b.surplusVsPrev.diff, 20000 - 40000);
  assert.equal(b.categoryChange.key, 'alim');
  assert.equal(b.categoryChange.diff, 5000);
});

test('calendário: datas locais, faturas no vencimento e parcelas no mês correto', () => {
  const c = ctxOf([
    tx({ type: 'expense', amount: 12990, date: '2026-11-25', sourceId: 'nu' }),
    tx({ type: 'expense', amount: 5000, date: '2026-11-30', sourceId: 'conta', status: 'planned' }),
    tx({ type: 'expense', amount: 3000, date: '2026-11-02', sourceId: 'conta', status: 'planned' }),
    tx({ type: 'income', amount: 300000, date: '2026-11-05', sourceId: 'conta' }),
    tx({ type: 'expense', amount: 33333, date: '2026-10-31', month: '2026-12', monthManual: true, planId: 'p', installment: { index: 2, count: 3 }, sourceId: 'conta', status: 'planned' }),
  ], { recurrences: [{ id: 'r', type: 'expense', description: 'Internet', amount: 10000, frequency: 'monthly', startDate: '2026-01-31' }] });
  const nov = calendarMonth(c, '2026-11');
  assert.equal(nov.days.get('2026-11-25').events[0].kind, 'card');
  assert.equal(nov.days.get('2026-11-25').out, 0, 'compra no cartão não sai do caixa no dia');
  assert.equal(nov.days.get('2026-11-02').overdue, 3000);
  assert.equal(nov.days.get('2026-11-05').in, 300000);
  assert.equal(nov.days.get('2026-11-30').events.find((e) => e.item?.recurrenceId).date, '2026-11-30', 'dia 31 cai no dia 30 em novembro');
  const dec = calendarMonth(c, '2026-12');
  const bill = dec.days.get('2026-12-10').events.find((e) => e.kind === 'bill');
  assert.equal(bill.amount, 12990);
  assert.equal(dec.days.get('2026-12-31').events.some((e) => e.item?.planId === 'p'), true, 'parcela fora do cartão no dia da compra, no mês da parcela');
  const feb = calendarMonth(c, '2028-02');
  assert.ok(feb.days.has('2028-02-29'), 'ano bissexto');
  assert.equal(eventDate({ planId: 'p', month: '2027-02', date: '2026-10-31' }, c), '2027-02-28');
  const up = upcoming(c, { horizon: 20 });
  assert.equal(up.items[0].status, 'overdue');
  assert.ok(up.items.some((e) => e.kind === 'bill'));
});

test('cenários: cancelar assinatura, parcelar compra e comparar sem alterar a base', () => {
  const rules = [{ id: 'net', type: 'expense', description: 'Streaming', amount: 4000, frequency: 'monthly', startDate: '2026-01-05' },
    { id: 'sal', type: 'income', description: 'Salário', amount: 300000, frequency: 'monthly', startDate: '2026-01-05' }];
  const c = ctxOf([], { recurrences: rules });
  const base = baselineRows(c, '2026-12', 6, { variable: 100000 });
  assert.equal(base[0].income, 300000);
  assert.equal(base[0].fixed, 4000);
  assert.equal(base[0].variable, 100000);
  assert.equal(base[0].surplus, 196000);
  const sim = applyScenario(base, [
    { type: 'cancelRecurrence', ruleId: 'net', from: '2027-01' },
    { type: 'installment', total: 100000, count: 3, from: '2027-02' },
    { type: 'income', amount: 20000, from: '2027-03', months: null },
  ]);
  assert.equal(sim[0].surplus, base[0].surplus, 'dezembro inalterado');
  assert.equal(sim[1].surplus, base[1].surplus + 4000);
  assert.equal(sim[2].surplus, base[2].surplus + 4000 - 33334);
  assert.equal(sim[3].surplus, base[3].surplus + 4000 - 33333 + 20000);
  assert.equal(base[1].fixed, 4000, 'linhas-base não são modificadas');
  const cmp = compareRows(base, sim);
  assert.equal(cmp.diff, 5 * 4000 - 100000 + 3 * 20000); // mar, abr e mai
});

test('compromissos que terminam liberam valor mensal', () => {
  const plans = [{ id: 'p', description: 'Moto', count: 3, total: 300000 }];
  const transactions = [1, 2, 3].map((i) => ({ id: `x${i}`, planId: 'p', amount: 100000, month: `2027-0${i}` }));
  const end = endingCommitments(null, { plans, recurrences: [], transactions, fromMonth: '2026-11' });
  assert.equal(end[0].lastMonth, '2027-03');
  assert.equal(end[0].freedFrom, '2027-04');
  assert.equal(end[0].monthly, 100000);
});

test('semelhança: avisa sem bloquear e detecta recorrência prevista', () => {
  const existing = tx({ type: 'expense', amount: 10000, date: '2026-11-15', description: 'Internet ', sourceId: 'conta' });
  const c = ctxOf([existing], { recurrences: [{ id: 'r', type: 'expense', description: 'Plano de saúde', amount: 7990, frequency: 'monthly', startDate: '2026-01-20' }] });
  const s = findSimilar({ type: 'expense', amount: 10000, date: '2026-11-15', description: 'internet', sourceId: 'conta', month: '2026-11' }, c);
  assert.equal(s.matches.length, 1);
  assert.equal(findSimilar({ type: 'expense', amount: 10001, date: '2026-11-15', description: 'internet', month: '2026-11' }, c).matches.length, 0);
  assert.equal(findSimilar({ type: 'income', amount: 10000, date: '2026-11-15', description: 'internet', month: '2026-11' }, c).matches.length, 0);
  const o = findSimilar({ type: 'expense', amount: 7990, date: '2026-11-20', description: 'Plano de Saúde', month: '2026-11' }, c);
  assert.equal(o.occurrence?.recurrenceId, 'r');
  assert.equal(normalizeDescription('  Jantar   FIGUEIRÊDO! '), 'jantar figueiredo');
});

test('auditoria lista problemas sem alterar nada', () => {
  const data = {
    categories: [{ id: 'c', name: 'Alim', type: 'expense' }],
    blocks: [], accounts: [{ id: 'a', name: 'Conta', kind: 'checking' }],
    installmentPlans: [{ id: 'p', description: 'TV', count: 3, total: 300 }],
    recurrences: [{ id: 'r', type: 'expense', description: 'Net', amount: 100, frequency: 'monthly', startDate: '2026-01-10' }],
    transactions: [
      { id: '1', type: 'expense', amount: 500, date: '2026-11-01', description: 'Mercado', sourceId: 'a', categoryId: 'c' },
      { id: '2', type: 'expense', amount: 500, date: '2026-11-01', description: 'mercado', sourceId: 'a', categoryId: 'c' },
      { id: '3', type: 'expense', amount: 10, date: '2026-11-02', description: 'X', categoryId: 'sumiu' },
      { id: '4', type: 'expense', amount: 100, date: '2026-11-01', description: 'TV', planId: 'p', installment: { index: 1, count: 3 } },
      { id: '5', type: 'expense', amount: 100, date: '2026-11-10', description: 'Net', recurrenceId: 'r', occurrenceDate: '2026-11-10' },
      { id: '6', type: 'expense', amount: 100, date: '2026-11-10', description: 'Net', recurrenceId: 'r', occurrenceDate: '2026-11-10' },
    ],
    investmentEvents: [], goals: [], budgets: [],
  };
  const before = JSON.stringify(data);
  const issues = auditData(data);
  assert.equal(JSON.stringify(data), before, 'dados intactos');
  const types = issues.map((i) => i.type);
  assert.ok(types.includes('duplicate'));
  assert.ok(issues.some((i) => i.type === 'ref' && i.refs[0] === '3'));
  assert.ok(issues.some((i) => i.type === 'plan' && /1 de 3/.test(i.message)));
  assert.ok(issues.some((i) => i.type === 'recurrence' && /duplicada/.test(i.message)));
});

test('metas: rentabilidade opcional e o exemplo da moto (12 meses)', () => {
  const g = simulateGoal({ name: 'Entrada da moto', target: 2000000, initial: 800000, monthly: 100000, startMonth: '2026-11' });
  assert.equal(g.i, 0);
  assert.equal(g.months, 12);
  assert.equal(g.completionMonth, '2027-11');
  assert.equal(g.remaining, 1200000);
  assert.equal(goalRate({ annualRate: 1, rateMode: 'monthly' }), 0.01);
  assert.equal(goalRate({ annualRate: null }), 0);
});

test('metas: aportes extraordinários e variáveis', () => {
  const g = simulateGoal({ target: 2000000, initial: 800000, monthly: 100000, startMonth: '2026-11', extras: [{ month: '2026-12', amount: 300000 }] });
  assert.equal(g.months, 9);
  const v = simulateSchedule({ initial: 0, target: 300000, contribution: (n) => (n % 2 ? 100000 : 50000) });
  assert.equal(v.months, 4);
  const never = simulateGoal({ target: 1000, initial: 0, monthly: 0, startMonth: '2026-11', extras: [] });
  assert.equal(never.reachable, false);
});

test('decomposição do mês: fixas, parcelas e pontuais', () => {
  const c = ctxOf([
    tx({ type: 'expense', amount: 1000, date: '2026-11-03' }),
    tx({ type: 'expense', amount: 2000, date: '2026-11-03', planId: 'p', installment: { index: 1, count: 2 }, month: '2026-11', monthManual: true }),
  ], { recurrences: [{ id: 'r', type: 'expense', description: 'Net', amount: 500, frequency: 'monthly', startDate: '2026-11-10' }] });
  const s = summarize(c, '2026-11');
  assert.equal(s.expOneOff, 1000);
  assert.equal(s.expInstallments, 2000);
  assert.equal(s.expFixed, 500);
  assert.equal(s.byRule.get('r'), 500);
});
