import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBackup, parseBackupText, validateBackup, verifyChecksum, stableStringify, encryptBackup, decryptBackup, backupFileName } from '../../js/services/backup.js';
import { structuralErrors, VALIDATORS } from '../../js/services/validation.js';

const tx = (o = {}) => ({ id: 't1', type: 'expense', status: 'done', description: 'Mercado', amount: 12990, date: '2026-11-25', month: '2026-11', categoryId: null, blockId: null, sourceId: null, ...o });
const data = () => ({ transactions: [tx(), tx({ id: 't2', date: '2025-02-01', month: '2025-02' })], categories: [], meta: [{ key: 'seeded', value: true }, { key: 'ui.layout', value: { version: 1, sections: {} } }] });

test('backup v2: metadados, período, contagens e checksum SHA-256', async () => {
  const b = await buildBackup(data(), new Date('2026-11-26T15:30:00'));
  assert.equal(b.format, 'fluxo-backup');
  assert.equal(b.version, 2);
  assert.equal(b.counts.transactions, 2);
  assert.deepEqual(b.period, { from: '2025-02-01', to: '2026-11-25' });
  assert.match(b.checksum.value, /^[0-9a-f]{64}$/);
  assert.equal((await verifyChecksum(b)).status, 'ok');
  const res = await parseBackupText(JSON.stringify(b));
  assert.equal(res.ok, true);
  assert.equal(res.checksum, 'ok');
  assert.equal(res.backup.data.meta.find((m) => m.key === 'ui.layout').value.version, 1, 'personalização incluída');
  assert.equal(backupFileName(new Date(2026, 10, 26, 15, 30)), 'Fluxo-backup-2026-11-26_15-30.json');
});

test('serialização determinística independe da ordem das chaves', () => {
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: [3, { y: 1, x: 2 }] } }), stableStringify({ a: { c: [3, { x: 2, y: 1 }], d: 2 }, b: 1 }));
});

test('arquivo adulterado ou truncado é rejeitado antes de qualquer gravação', async () => {
  const b = await buildBackup(data());
  const tampered = structuredClone(b); tampered.data.transactions[0].amount = 1;
  const r1 = await parseBackupText(JSON.stringify(tampered));
  assert.equal(r1.ok, false);
  assert.equal(r1.checksum, 'mismatch');
  const truncated = structuredClone(b); truncated.data.transactions.pop();
  assert.equal((await parseBackupText(JSON.stringify(truncated))).ok, false, 'contagem do cabeçalho não confere');
});

test('formato legado (1.0/2.0) continua aceito; versões futuras não', async () => {
  const legacy = { format: 'guia-financeiro-backup', version: 1, schemaVersion: 2, exportedAt: '2026-11-20T10:00:00Z', data: data() };
  const r = await parseBackupText(JSON.stringify(legacy));
  assert.equal(r.ok, true);
  assert.equal(r.legacy, true);
  assert.equal(r.checksum, 'absent');
  const future = await buildBackup(data()); future.version = 3;
  assert.match(validateBackup(future).errors[0], /mais nova/);
  const futureSchema = await buildBackup(data()); futureSchema.schemaVersion = 99;
  assert.equal(validateBackup(futureSchema).ok, false);
});

test('prototype pollution e objetos inesperados são recusados', async () => {
  const evil = JSON.parse('{"id":"x","type":"expense","status":"done","description":"a","amount":1,"date":"2026-11-01","month":"2026-11","__proto__":{"polluted":true}}');
  assert.ok(structuralErrors(evil).some((e) => /__proto__/.test(e)));
  const nested = tx({ note: null, extra: { constructor: { prototype: { x: 1 } } } });
  assert.ok(structuralErrors(nested).length);
  assert.ok(VALIDATORS.transactions(tx({ description: 'x'.repeat(30000) })).length, 'texto gigante');
  assert.ok(VALIDATORS.meta(JSON.parse('{"key":"prefs","value":{"__proto__":{"a":1}}}')).length);
  const b = await buildBackup({ transactions: [] });
  b.data.transactions.push(evil);
  b.counts.transactions = 1;
  const r = await parseBackupText(JSON.stringify(b));
  assert.equal(r.ok, false);
  assert.equal({}.polluted, undefined, 'Object.prototype intacto');
  assert.equal((await parseBackupText(JSON.stringify({ format: 'fluxo-backup', version: 2, data: [] }))).ok, false);
  assert.equal((await parseBackupText('[]')).ok, false);
  assert.equal((await parseBackupText('"texto"')).ok, false);
});

test('backup protegido: AES-GCM + PBKDF2, senha errada falha, sem senha pede senha', async () => {
  const b = await buildBackup(data());
  const env = await encryptBackup(b, 'senha-forte-123', { iterations: 100000 });
  assert.equal(env.format, 'fluxo-backup-encrypted');
  assert.ok(!JSON.stringify(env).includes('Mercado'), 'conteúdo não fica legível');
  const back = await decryptBackup(env, 'senha-forte-123');
  assert.deepEqual(back, b);
  await assert.rejects(() => decryptBackup(env, 'errada-000'), /Senha incorreta/);
  const r = await parseBackupText(JSON.stringify(env));
  assert.equal(r.needsPassword, true);
  const ok = await parseBackupText(JSON.stringify(env), { password: 'senha-forte-123' });
  assert.equal(ok.ok, true);
  assert.equal(ok.encrypted, true);
  const flipped = structuredClone(env); flipped.ciphertext = flipped.ciphertext.slice(0, -4) + 'AAAA';
  await assert.rejects(() => decryptBackup(flipped, 'senha-forte-123'), /Senha incorreta ou arquivo danificado/);
  await assert.rejects(() => encryptBackup(b, 'curta'), /8 caracteres/);
});
