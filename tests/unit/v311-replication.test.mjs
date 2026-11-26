// Fluxo 3.1.1 — replicação, repetição a partir de um lançamento, pagamento antecipado e datas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, summarize } from '../../js/services/finance.js';
import { competenceOf } from '../../js/services/cards.js';
import { ruleOccurrences, describeFrequency, firstKeyFor, monthlyAmount } from '../../js/services/recurrence.js';
import { commitmentOf } from '../../js/services/commitments.js';
import { validateTransaction, isOccKey } from '../../js/services/validation.js';
import { byDateDesc } from '../../js/utils/dates.js';

const accounts = [{ id: 'conta', name: 'Conta', kind: 'checking' }, { id: 'nu', name: 'Cartão', kind: 'credit', closingDay: 3, dueDay: 10 }];
const acc = (id) => accounts.find((a) => a.id === id);
const tx = (o) => {
  const t = { status: 'planned', description: 'x', categoryId: null, blockId: null, sourceId: null, createdAt: 1, ...o };
  if (!t.monthManual) t.month = t.date ? competenceOf(t, acc(t.sourceId)) : (t.period || t.month);
  return t;
};
const ctxOf = (transactions, recurrences, today = '2026-11-25') => createContext({ transactions, recurrences, accounts, today });
const keys = (rule, from, to) => ruleOccurrences(rule, from, to).map((o) => o.key);

test('firstKeyFor: o lançamento ocupa a vaga do mês, nunca cria outra', () => {
  const monthly = { frequency: 'monthly', interval: 1, startDate: '2026-11-10', anchorDay: 10 };
  assert.equal(firstKeyFor(monthly, '2026-11-25'), '2026-11-10', 'pago no dia 25: é a ocorrência de novembro (dia 10)');
  const days = { mode: 'days', frequency: 'monthly', days: [5, 20] };
  assert.equal(firstKeyFor(days, '2026-11-20'), '2026-11@20');
  assert.equal(firstKeyFor(days, '2026-11-25'), '2026-11@20', 'depois do dia 20: vaga anterior mais próxima');
  assert.equal(firstKeyFor(days, '2026-11-03'), '2026-11@5', 'antes da primeira vaga: a primeira');
  assert.equal(firstKeyFor({ mode: 'flex', frequency: 'monthly', perPeriod: 2 }, null, '2027-01'), '2027-01#1', 'sem data: 1ª vaga do período');
  assert.equal(firstKeyFor({ frequency: 'weekly', interval: 2, startDate: '2026-11-04' }, '2026-11-04'), '2026-11-04');
  assert.equal(firstKeyFor({ mode: 'forecast', frequency: 'monthly' }, '2026-11-04'), null);
});

test('Mensal a partir de um lançamento: série com o original como 1ª ocorrência não duplica', () => {
  const rule = { id: 'r', type: 'expense', description: 'Streaming', amount: 9990, frequency: 'monthly', interval: 1, startDate: '2026-11-05', anchorDay: 5, exceptions: {} };
  const original = tx({ id: 'orig', recurrenceId: 'r', occurrenceKey: '2026-11-05', occurrenceDate: '2026-11-05', period: '2026-11', type: 'expense', status: 'done', amount: 9990, date: '2026-11-05' });
  const ctx = ctxOf([original], [rule]);
  assert.equal(summarize(ctx, '2026-11').items.filter((i) => i.description === 'Streaming' || i.recurrenceId === 'r').length, 1, 'novembro: só o original');
  assert.equal(summarize(ctx, '2026-11').expenseTotal, 9990);
  assert.equal(summarize(ctx, '2026-12').expensePending, 9990, 'dezembro: prevista');
});

test('Dia 31 preserva a referência em meses curtos e em ano bissexto', () => {
  const rule = { frequency: 'monthly', interval: 1, startDate: '2027-01-31', anchorDay: 31, exceptions: {} };
  assert.deepEqual(keys(rule, '2027-01-01', '2027-04-30'), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
  assert.deepEqual(keys(rule, '2028-02-01', '2028-03-31'), ['2028-02-29', '2028-03-31']);
});

test('Início e término: mensal de janeiro a junho não gera nada fora do intervalo', () => {
  const rule = { frequency: 'monthly', interval: 1, startDate: '2027-01-15', anchorDay: 15, endDate: '2027-06-30', exceptions: {} };
  assert.deepEqual(keys(rule, '2026-12-01', '2027-08-31'), ['2027-01-15', '2027-02-15', '2027-03-15', '2027-04-15', '2027-05-15', '2027-06-15']);
});

test('A cada 14 dias a partir de 04/11/2026: 2 em novembro, 3 em dezembro (R$ 150)', () => {
  const rule = { id: 'b', type: 'expense', description: 'Consulta', amount: 5000, frequency: 'weekly', interval: 2, startDate: '2026-11-04', exceptions: {} };
  assert.deepEqual(keys(rule, '2026-11-01', '2026-11-30'), ['2026-11-04', '2026-11-18']);
  assert.deepEqual(keys(rule, '2026-12-01', '2026-12-31'), ['2026-12-02', '2026-12-16', '2026-12-30']);
  assert.equal(summarize(ctxOf([], [rule]), '2026-12').expenseTotal, 15000);
});

test('Pagamento antecipado de uma ocorrência continua no mês do compromisso (sem esvaziar dezembro)', () => {
  const psi = { id: 'psi', type: 'expense', description: 'Psicóloga', amount: 5000, frequency: 'monthly', interval: 1, mode: 'flex', perPeriod: 2, startDate: '2026-11-01', exceptions: {} };
  // Consulta de dezembro paga em 25/11 por R$ 60: competência mantida em dezembro.
  const early = tx({ id: 'psi:2026-12#1', recurrenceId: 'psi', occurrenceKey: '2026-12#1', period: '2026-12', type: 'expense', status: 'done', amount: 6000, plannedAmount: 5000, plannedDate: null, date: '2026-11-25', monthManual: true, month: '2026-12' });
  const ctx = ctxOf([early], [psi]);
  const dec = summarize(ctx, '2026-12');
  assert.equal(dec.expenseDone, 6000); assert.equal(dec.expensePending, 5000); assert.equal(dec.expenseTotal, 11000, 'paga com outro valor: sem sobra de R$ 50 prevista');
  assert.equal(summarize(ctx, '2026-11').expenseTotal, 10000, 'novembro só com as suas duas consultas');
  const c = commitmentOf(ctx, psi, '2026-12');
  assert.equal(c.doneCount, 1); assert.equal(c.paid, 6000); assert.equal(c.left, 5000);
  assert.deepEqual(validateTransaction({ ...early }), [], 'plannedDate nula é válida');
  assert.ok(validateTransaction({ ...early, plannedDate: '2026-13-01' }).length, 'plannedDate inválida é recusada');
});

test('Ocorrência extra: chave além das vagas, conta só no mês dela', () => {
  const psi = { id: 'psi', type: 'expense', description: 'Psicóloga', amount: 5000, frequency: 'monthly', interval: 1, mode: 'flex', perPeriod: 2, startDate: '2026-11-01', exceptions: {} };
  assert.ok(isOccKey('2026-12#3'));
  const extra = tx({ id: 'psi:2026-12#3', recurrenceId: 'psi', occurrenceKey: '2026-12#3', period: '2026-12', type: 'expense', status: 'planned', amount: 5000, date: '2026-12-28' });
  const ctx = ctxOf([extra], [psi]);
  assert.equal(summarize(ctx, '2026-12').expenseTotal, 15000);
  assert.equal(summarize(ctx, '2027-01').expenseTotal, 10000);
  assert.equal(commitmentOf(ctx, psi, '2026-12').count, 3);
  assert.ok(`${'a'.repeat(36)}:2026-12#31~resto`.length <= 64, 'ids derivados cabem no limite de 64 caracteres');
});

test('Nomes simples para os modelos mensais', () => {
  assert.equal(describeFrequency({ mode: 'flex', perPeriod: 1, frequency: 'monthly' }), 'Mensal, data a definir');
  assert.equal(describeFrequency({ mode: 'flex', perPeriod: 2, frequency: 'monthly' }), '2× por mês, datas flexíveis');
  assert.equal(describeFrequency({ mode: 'days', days: [5, 20], frequency: 'monthly' }), 'Nos dias 5 e 20');
  assert.equal(monthlyAmount({ mode: 'flex', perPeriod: 2, amount: 5000 }), 10000);
});

test('Listas do mês: mais recentes primeiro e "data a definir" sempre no fim', () => {
  const rows = [{ date: null, createdAt: 3 }, { date: '2026-11-05', createdAt: 1 }, { date: '2026-11-24', createdAt: 2 }, { date: null, createdAt: 9 }, { date: '2026-11-24', createdAt: 5 }];
  assert.deepEqual(rows.sort(byDateDesc).map((r) => `${r.date}|${r.createdAt}`), ['2026-11-24|5', '2026-11-24|2', '2026-11-05|1', 'null|9', 'null|3']);
});
