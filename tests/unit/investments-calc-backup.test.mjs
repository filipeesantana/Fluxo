import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlyRate, futureValue, requiredMonthly, monthsToTarget, simulateGoal, investmentValue } from '../../js/services/investments.js';
import { evaluate, CalcError } from '../../js/services/calculator.js';
import { buildBackup, validateBackup, parseBackupText, transactionsToCSV } from '../../js/services/backup.js';
import { descriptionSuggestions } from '../../js/services/suggest.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('Cenário 10: juros compostos conferidos com referências independentes', () => {
  // 12% a.a. efetivos → 0,948879293% a.m.
  close(monthlyRate(12), 0.00948879293, 1e-11);
  close(Math.pow(1 + monthlyRate(12), 12), 1.12, 1e-12);
  // Referência: 100 por mês a 1% a.m. por 12 meses (fim do mês) = 1268,250301 (tabela de série uniforme).
  close(futureValue(0, 100, 0.01, 12), 1268.2503013, 1e-6);
  // Início do mês: multiplica por (1+i) → 1280,9328043.
  close(futureValue(0, 100, 0.01, 12, 'start'), 1280.9328043, 1e-6);
  // Montante de 1.000 a 1% a.m. por 24 meses = 1000 × 1,01^24 = 1269,7346485.
  close(futureValue(1000, 0, 0.01, 24), 1269.7346485, 1e-6);
  // Conferência por iteração independente.
  let v = 5000; for (let n = 0; n < 60; n++) v = v * 1.007 + 300;
  close(futureValue(5000, 300, 0.007, 60), v, 1e-6);
});

test('Cenário 11: rentabilidade zero', () => {
  assert.equal(futureValue(1000, 500, 0, 10), 6000);
  assert.equal(requiredMonthly(10000, 1000, 0, 10), 900);
  assert.equal(monthsToTarget(10000, 1000, 900, 0), 10);
  assert.equal(monthsToTarget(10000, 1000, 0, 0), null);
  const s = simulateGoal({ target: 1000000, initial: 0, monthly: 90000, annualRate: 0, startMonth: '2026-11' });
  assert.equal(s.months, 12);
  assert.equal(s.completionMonth, '2027-11');
  assert.equal(s.contributed, 1080000);
  assert.equal(s.earnings, 0);
});

test('aporte necessário reproduz a meta', () => {
  const i = monthlyRate(10);
  const pmt = requiredMonthly(10000000, 500000, i, 120);
  close(futureValue(500000, pmt, i, 120), 10000000, 1e-4);
  const pmtStart = requiredMonthly(10000000, 500000, i, 120, 'start');
  close(futureValue(500000, pmtStart, i, 120, 'start'), 10000000, 1e-4);
  assert.ok(pmtStart < pmt);
});

test('metas já atingidas e inalcançáveis', () => {
  assert.equal(monthsToTarget(1000, 2000, 0, 0.01), 0);
  const reached = simulateGoal({ target: 1000, initial: 5000, monthly: 0, annualRate: 5, startMonth: '2026-11' });
  assert.equal(reached.reached, true);
  assert.equal(reached.months, 0);
  const never = simulateGoal({ target: 1000000, initial: 0, monthly: 0, annualRate: 10, startMonth: '2026-11' });
  assert.equal(never.reachable, false);
  const deadline = simulateGoal({ target: 1200000, initial: 0, monthly: 50000, annualRate: 0, startMonth: '2026-11', deadline: '2027-11' });
  assert.equal(deadline.requiredMonthly, 100000);
  assert.equal(deadline.onTrack, false);
});

test('patrimônio informado × estimado', () => {
  const inv = { id: 'i', annualRate: 10 };
  const ev = [
    { investmentId: 'i', type: 'balance', amount: 100000, date: '2025-11-25' },
    { investmentId: 'i', type: 'contribution', amount: 50000, date: '2025-11-25' },
  ];
  const v = investmentValue(inv, ev, '2026-11-25');
  assert.equal(v.informed, 150000);
  close(v.estimated, 150000 * 1.1, 1);
});

test('Calculadora: precedência, parênteses, decimais e porcentagem', () => {
  assert.equal(evaluate('2+3*4'), 14);
  assert.equal(evaluate('(2+3)*4'), 20);
  assert.equal(evaluate('10/4'), 2.5);
  assert.equal(evaluate('129,90*3'), 389.7);
  assert.equal(evaluate('0.1+0.2'), 0.3);
  assert.equal(evaluate('200+10%'), 220);
  assert.equal(evaluate('200-10%'), 180);
  assert.equal(evaluate('200*10%'), 20);
  assert.equal(evaluate('50%'), 0.5);
  assert.equal(evaluate('-3+5'), 2);
  assert.equal(evaluate('2*-3'), -6);
  assert.equal(evaluate('1.234,5+0,5'), 1235);
  assert.equal(evaluate('3 × 4 ÷ 2 − 1'), 5);
  assert.equal(evaluate('((1))'), 1);
});

test('Calculadora: erros tratados sem eval', () => {
  assert.throws(() => evaluate('1/0'), CalcError);
  assert.throws(() => evaluate('2+'), CalcError);
  assert.throws(() => evaluate('(2+3'), CalcError);
  assert.throws(() => evaluate('2+3)'), CalcError);
  assert.throws(() => evaluate('alert(1)'), CalcError);
  assert.throws(() => evaluate(''), CalcError);
  assert.throws(() => evaluate('1..2'), CalcError);
});

const sample = () => ({
  transactions: [{ id: 't1', type: 'expense', status: 'done', description: '=HYPERLINK("x")', amount: 12990, date: '2026-11-25', month: '2026-11', categoryId: 'c1', blockId: null, sourceId: null }],
  categories: [{ id: 'c1', name: 'Alimentação', type: 'expense' }],
  meta: [{ key: 'seeded', value: true }],
});

test('Cenário 8 (lógica): backup exportado é válido e completo', async () => {
  const b = await buildBackup(sample());
  const res = await parseBackupText(JSON.stringify(b));
  assert.equal(res.ok, true, res.errors.join());
  assert.equal(res.counts.transactions, 1);
  assert.deepEqual(res.backup.data.transactions[0], sample().transactions[0]);
});

test('Cenário 9 (lógica): backups inválidos são rejeitados', async () => {
  assert.equal((await parseBackupText('{nope')).ok, false);
  assert.equal(validateBackup({ format: 'outro' }).ok, false);
  const future = await buildBackup(sample()); future.version = 99;
  assert.equal(validateBackup(future).ok, false);
  const bad = await buildBackup(sample()); bad.data.transactions[0].amount = 12.5;
  assert.equal(validateBackup(bad).ok, false);
  const dup = await buildBackup(sample()); dup.data.transactions.push({ ...dup.data.transactions[0] });
  assert.equal(validateBackup(dup).ok, false);
  const orphan = await buildBackup(sample()); orphan.data.transactions[0].categoryId = 'zzz'; delete orphan.counts;
  const r = validateBackup(orphan);
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
});

test('CSV protege contra injeção de fórmulas', () => {
  const s = sample();
  const csv = transactionsToCSV(s.transactions, { categories: new Map(s.categories.map((c) => [c.id, c])), blocks: new Map(), accounts: new Map() });
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(csv.includes('-129,90'));
});

test('sugestões priorizam prefixo, frequência e uso recente', () => {
  const txs = [
    { type: 'expense', description: 'Jantar Figueiredo', categoryId: 'a', blockId: 'n', sourceId: 'nu', amount: 12990, date: '2026-11-01', createdAt: 1 },
    { type: 'expense', description: 'Jantar Figueiredo', categoryId: 'a', blockId: 'n', sourceId: 'bb', amount: 9000, date: '2026-11-20', createdAt: 2 },
    { type: 'expense', description: 'Mercado', categoryId: 'a', amount: 5000, date: '2026-11-21', createdAt: 3 },
  ];
  const s = descriptionSuggestions('jan', txs);
  assert.equal(s.length, 1);
  assert.equal(s[0].count, 2);
  assert.equal(s[0].sourceId, 'bb');
  assert.equal(descriptionSuggestions('merc', txs)[0].description, 'Mercado');
});
