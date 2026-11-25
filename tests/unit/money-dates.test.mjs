import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney, formatMoney, splitCents, toCents } from '../../js/utils/money.js';
import { addMonths, dateInMonth, isLeap, addDays, parseDateBR, monthDiff, lastDay, isISODate, today } from '../../js/utils/dates.js';

test('parseMoney aceita formatos brasileiros e internacionais', () => {
  assert.equal(parseMoney('129,90'), 12990);
  assert.equal(parseMoney('R$ 1.234,56'), 123456);
  assert.equal(parseMoney('1234.56'), 123456);
  assert.equal(parseMoney('1.234'), 123400);
  assert.equal(parseMoney('1.234.567,8'), 123456780);
  assert.equal(parseMoney('1,234.50'), 123450);
  assert.equal(parseMoney('3000'), 300000);
  assert.equal(parseMoney('0,05'), 5);
  assert.equal(parseMoney('1,5'), 150);
  assert.equal(parseMoney('-50'), -5000);
  assert.equal(parseMoney(',99'), 99);
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney('abc'), null);
  assert.equal(parseMoney('1,2,3'), null);
  assert.equal(parseMoney('12.34.5'), null);
});

test('arredondamento meio centavo para longe do zero', () => {
  assert.equal(toCents(1.005), 101);
  assert.equal(toCents(-1.005), -101);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.equal(parseMoney('2,675'), 268);
});

test('formatMoney em pt-BR', () => {
  assert.equal(formatMoney(12990).replace(/ /g, ' '), 'R$ 129,90');
  assert.equal(formatMoney(-90000).replace(/ /g, ' '), '-R$ 900,00');
});

test('splitCents distribui centavos e soma exatamente o total', () => {
  assert.deepEqual(splitCents(100000, 3), [33334, 33333, 33333]);
  assert.deepEqual(splitCents(100, 3), [34, 33, 33]);
  for (const [t, n] of [[1, 2], [99999, 7], [12345678, 12], [10, 10]]) {
    assert.equal(splitCents(t, n).reduce((a, b) => a + b, 0), t);
  }
});

test('datas: virada de mês/ano, bissextos e dias 29–31', () => {
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(addMonths('2026-11', 14), '2028-01');
  assert.equal(dateInMonth('2026-02', 31), '2026-02-28');
  assert.equal(dateInMonth('2028-02', 30), '2028-02-29');
  assert.equal(dateInMonth('2026-04', 31), '2026-04-30');
  assert.ok(isLeap(2028) && !isLeap(2100) && isLeap(2000));
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(parseDateBR('25/11/2026'), '2026-11-25');
  assert.equal(parseDateBR('31/02/2026'), null);
  assert.equal(monthDiff('2026-11', '2027-11'), 12);
  assert.equal(lastDay('2026-02'), '2026-02-28');
  assert.ok(!isISODate('2026-02-30'));
});

test('today() usa o calendário local, não UTC', () => {
  // 23h30 do dia 30/11 em qualquer fuso continua sendo 30/11 localmente.
  const d = new Date(2026, 10, 30, 23, 30);
  assert.equal(today(d), '2026-11-30');
});
