// Fluxo 3.2 — validação de blocos com fonte, modelos e repetição a partir do formulário.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VALIDATORS, validateTemplate } from '../../js/services/validation.js';
import { ruleOccurrences, describeFrequency } from '../../js/services/recurrence.js';
import { createContext, summarize } from '../../js/services/finance.js';
import { competenceOf } from '../../js/services/cards.js';

test('Bloco aceita fonte padrão opcional e recusa valores inválidos', () => {
  assert.deepEqual(VALIDATORS.blocks({ id: 'b1', name: 'Fatura Nubank', sourceId: 'nu' }), []);
  assert.deepEqual(VALIDATORS.blocks({ id: 'b1', name: 'Moto' }), []);
  assert.ok(VALIDATORS.blocks({ id: 'b1', name: 'X', sourceId: { evil: 1 } }).length);
});

test('Modelos em meta: validados um a um, com limite', () => {
  const ok = { id: 't1', type: 'expense', description: 'Spotify', amount: 3190, categoryId: 'c', blockId: 'b', sourceId: 's', note: null, repeat: 'monthly' };
  assert.deepEqual(VALIDATORS.meta({ key: 'templates', value: [ok] }), []);
  assert.ok(validateTemplate({ ...ok, amount: -1 }).length, 'valor negativo');
  assert.ok(validateTemplate({ ...ok, repeat: 'hourly' }).length, 'repetição desconhecida');
  assert.ok(VALIDATORS.meta({ key: 'templates', value: 'x' }).length, 'não é lista');
  assert.ok(VALIDATORS.meta({ key: 'templates', value: Array.from({ length: 61 }, (_, i) => ({ ...ok, id: `t${i}` })) }).length, 'limite de 60');
  const evil = JSON.parse('{"key":"templates","value":[{"id":"t","type":"expense","description":"x","__proto__":{"polluted":1}}]}');
  assert.ok(VALIDATORS.meta(evil).length, 'chave __proto__ recusada');
});

test('Spotify mensal dia 5 no cartão (fecha dia 28, vence 7): uma compra por fatura, sem duplicar', () => {
  const nu = { id: 'nu', name: 'Cartão Nubank', kind: 'credit', closingDay: 28, dueDay: 7 };
  const rule = { id: 'sp', type: 'expense', description: 'Spotify', amount: 3190, frequency: 'monthly', interval: 1, startDate: '2026-11-05', anchorDay: 5, sourceId: 'nu', blockId: 'fn', exceptions: {} };
  const first = { id: 'sp:2026-11-05', type: 'expense', status: 'done', description: 'Spotify', amount: 3190, date: '2026-11-05', sourceId: 'nu', blockId: 'fn', recurrenceId: 'sp', occurrenceKey: '2026-11-05', occurrenceDate: '2026-11-05', period: '2026-11', createdAt: 1 };
  first.month = competenceOf(first, nu);
  assert.equal(first.month, '2026-12');
  const ctx = createContext({ transactions: [first], recurrences: [rule], accounts: [nu], today: '2026-11-25' });
  for (const [m, date, status] of [['2026-12', '2026-11-05', 'done'], ['2027-01', '2026-12-05', 'planned'], ['2027-02', '2027-01-05', 'planned']]) {
    const s = summarize(ctx, m);
    assert.deepEqual(s.items.filter((i) => i.description === 'Spotify').map((i) => `${i.status}:${i.date}`), [`${status}:${date}`], m);
    assert.equal(s.cardBills.find((b) => b.cardId === 'nu').total, 3190, `fatura de ${m}`);
  }
  assert.equal(describeFrequency(rule), 'Mensal, dia 5');
  assert.deepEqual(ruleOccurrences(rule, '2027-02-01', '2027-02-28').map((o) => o.key), ['2027-02-05']);
});
