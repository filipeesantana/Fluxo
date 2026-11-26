// Testes de aceitação no navegador (Chromium via Playwright).
// Uso: node tests/e2e/run.mjs   (requer o pacote "playwright" com Chromium instalado)
// O app é servido em /guia-financeiro/ para reproduzir o GitHub Pages.
import { createRequire } from 'node:module';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ARTIFACTS = join(ROOT, 'tests', '.artifacts');
const NOW = new Date('2026-11-25T10:00:00-03:00');
const norm = (s) => String(s).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

const results = [];
let browser, base;

async function newPage(opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', acceptDownloads: true, ...opts });
  await context.clock.setFixedTime(NOW);
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) page.errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400) page.errors.push(`HTTP ${r.status()} ${r.url()}`); });
  page.on('requestfailed', (r) => page.errors.push(`falha ${r.url()}`));
  page.on('dialog', (d) => { page.errors.push(`dialog inesperado: ${d.message()}`); d.dismiss(); });
  await page.goto(base);
  await page.waitForSelector('.page-head');
  return { context, page };
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: esperado ${JSON.stringify(b)}, obtido ${JSON.stringify(a)}`); }

async function waitText(page, selectorOrFn, expected, { timeout = 4000 } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = typeof selectorOrFn === 'function' ? await selectorOrFn() : norm(await page.locator(selectorOrFn).first().textContent().catch(() => ''));
    if (last === expected || (expected instanceof RegExp && expected.test(last))) return last;
    await page.waitForTimeout(80);
  }
  throw new Error(`Texto esperado ${expected} mas obtido ${JSON.stringify(last)}`);
}

const kpi = (page, label) => async () => norm(await page.locator('.kpi', { has: page.locator('.kpi-label', { hasText: label }) }).locator('.kpi-value').textContent());
async function expectKpi(page, label, value) { await waitText(page, kpi(page, label), value); }
const evolutionHint = (page) => async () => norm(await page.locator('.panel', { has: page.locator('h2', { hasText: /^Evolução$/ }) }).locator('.panel-head .hint').textContent()).split(' · ')[0];
async function barValue(page, section, name) {
  const row = page.locator('.panel', { has: page.locator('h2', { hasText: section }) }).locator('.bar-row', { has: page.locator('.bar-name', { hasText: name }) });
  if (!(await row.count())) return null;
  return norm(await row.first().locator('.bar-value').textContent());
}

/** Executa código com o repositório do app dentro da página. */
// A CSP do app proíbe eval/new Function dentro da página; o Playwright avalia
// a expressão pelo protocolo de depuração, que não é afetado pela CSP.
function api(page, fn, arg) {
  return page.evaluate(`(async () => { const repo = await import('./js/database/repository.js'); return (${fn.toString()})(repo, ${JSON.stringify(arg ?? null)}); })()`);
}

async function openForm(page) {
  await page.locator('.sidebar [data-action="new-entry"]').click();
  await page.waitForSelector('.entry-modal');
  return page.locator('.entry-modal');
}

/** Seletor pesquisável: abre, digita e confirma com Enter. */
async function pick(modal, name, label) {
  const page = modal.page();
  await modal.locator(`[data-picker="${name}"] .picker-btn`).click();
  const input = page.locator('.picker-pop.is-open input');
  await input.waitFor();
  await input.fill(label);
  await input.press('Enter');
  await page.waitForFunction(([n, v]) => document.querySelector(`[data-picker="${n}"] .picker-value`)?.textContent === v, [name, label]);
}

/** Cria uma opção nova dentro do seletor (com escolha do tipo para contas). */
async function createInline(modal, name, value, kind) {
  const page = modal.page();
  await modal.locator(`[data-picker="${name}"] .picker-btn`).click();
  const input = page.locator('.picker-pop.is-open input');
  await input.waitFor();
  await input.fill(value);
  await input.press('Enter');
  if (name === 'source' || name === 'to') await page.locator(`.picker-pop .picker-kinds .chip[data-kind="${kind || 'checking'}"]`).click();
  await page.waitForFunction(([n, v]) => document.querySelector(`[data-picker="${n}"] .picker-value`)?.textContent === v, [name, value]);
}

async function save(modal) {
  await modal.locator('.modal-foot button[type=submit]').click();
  await modal.waitFor({ state: 'detached' });
}

async function test(name, fn) {
  // ONLY=trecho executa apenas os testes cujo nome contém o trecho (útil durante a manutenção).
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: err.message });
    console.log(`  ✗ ${name}\n      ${process.env.VERBOSE ? err.message : err.message.split('\n')[0]}`);
  }
}

/** Instante UTC em que o relógio local de `tz` marca a data/hora indicada. */
function utcForLocal(tz, y, mo, d, hh, mm) {
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return guess - (asUtc - guess);
}

/** Exporta o backup completo (JSON comum) pela interface e devolve o download. */
async function exportBackupUI(page) {
  await page.getByRole('button', { name: 'Exportar backup completo' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.modal').getByRole('button', { name: 'Gerar arquivo' }).click()]);
  return dl;
}

async function noErrors(page) { eq(page.errors.length, 0, `Erros no console/rede: ${page.errors.join(' | ')}`); }

// ————————————————————————————————————————————————————————————————

async function run() {
  await mkdir(ARTIFACTS, { recursive: true });
  const { server, url } = await startServer();
  base = url;
  browser = await chromium.launch();
  console.log(`Servindo em ${url}\n`);

  await test('Cenário 15/1/7 — banco vazio, primeiro lançamento pela interface, agrupamentos e persistência', async () => {
    const { context, page } = await newPage();
    await page.waitForSelector('[data-kpi]');
    assert(await page.locator('.empty-block').count() >= 3, 'estrutura do painel visível com estados vazios');
    const m = await openForm(page);
    await m.locator('input[name=amount]').fill('129,90');
    await m.locator('input[name=description]').fill('Jantar Figueiredo');
    await pick(m, 'category', 'Alimentação');
    await createInline(m, 'block', 'Namorada');
    await createInline(m, 'source', 'Cartão Nubank', 'credit');
    await m.locator('input[name=date]').fill('2026-11-25');
    await save(m);
    await waitText(page, '.toast', /Lançamento salvo/);
    await expectKpi(page, 'Compromissos pendentes', 'R$ 129,90'); // compra no cartão = obrigação até a fatura ser paga
    eq(await barValue(page, 'Por categoria', 'Alimentação'), 'R$ 129,90', 'categoria');
    eq(await barValue(page, 'Por bloco', 'Namorada'), 'R$ 129,90', 'bloco');
    eq(await barValue(page, 'Por fonte', 'Cartão Nubank'), 'R$ 129,90', 'fonte');
    await waitText(page, evolutionHint(page), 'R$ 129,90 em despesas');
    await expectKpi(page, 'Despesas realizadas', 'R$ 0,00');
    await page.reload();
    await page.waitForSelector('[data-kpi]');
    eq(await barValue(page, 'Por bloco', 'Namorada'), 'R$ 129,90', 'persistência após recarregar');
    eq(await page.locator('.tx-row').count(), 1, 'uma única movimentação');
    await noErrors(page);
    await page.screenshot({ path: join(ARTIFACTS, 'cenario-01.png') });
    await context.close();
  });

  await test('Cenário 2 — receitas 3.000, realizadas 1.450, futuras 650 → sobra 900', async () => {
    const { context, page } = await newPage();
    await api(page, async (repo) => {
      const a = await repo.createNamed('accounts', { name: 'Conta', kind: 'checking', openingBalance: 0 });
      await repo.saveTransaction({ type: 'income', status: 'done', amount: 300000, date: '2026-11-05', description: 'Salário', sourceId: a.id });
      await repo.saveTransaction({ type: 'expense', status: 'done', amount: 145000, date: '2026-11-10', description: 'Despesas', sourceId: a.id });
      await repo.saveTransaction({ type: 'expense', status: 'planned', amount: 65000, date: '2026-11-28', description: 'Futuras', sourceId: a.id });
    });
    await expectKpi(page, 'Receitas recebidas', 'R$ 3.000,00');
    await expectKpi(page, 'Despesas realizadas', 'R$ 1.450,00');
    await expectKpi(page, 'Compromissos pendentes', 'R$ 650,00');
    await expectKpi(page, 'Sobra projetada', 'R$ 900,00');
    await expectKpi(page, 'Disponível para investir', 'R$ 900,00');
    await noErrors(page);
    await context.close();
  });

  await test('Cenário 3 — parcelar R$ 1.000,00 em 3× soma exatamente R$ 1.000,00', async () => {
    const { context, page } = await newPage();
    const m = await openForm(page);
    await m.locator('input[name=amount]').fill('1000');
    await m.locator('input[name=description]').fill('Capacete');
    await m.locator('[data-toggle="parcel"]').click();
    await m.locator('.extra-box input[type=number]').fill('3');
    await waitText(page, '.extra-box .faint', /1ª de R\$ 333,34 e 2× de R\$ 333,33 · total exato R\$ 1.000,00/);
    await save(m);
    const parcels = await api(page, (repo) => repo.list('transactions').map((t) => [t.amount, t.month, t.installment?.index]).sort((a, b) => a[2] - b[2]));
    eq(JSON.stringify(parcels), JSON.stringify([[33334, '2026-11', 1], [33333, '2026-12', 2], [33333, '2027-01', 3]]), 'parcelas');
    await page.goto(`${base}#/planejamento/parcelamentos`);
    await waitText(page, '.plan-stats', /Restante R\$ 1\.000,00/);
    await noErrors(page);
    await context.close();
  });

  await test('Cenário 4 — conta mensal projetada nos próximos 12 meses sem duplicar (inclusive após recarregar)', async () => {
    const { context, page } = await newPage();
    await page.goto(`${base}#/planejamento/recorrencias`);
    await page.getByRole('button', { name: 'Nova recorrência' }).click();
    const m = page.locator('.modal');
    await m.locator('input[placeholder^="Ex.: Internet"]').fill('Internet');
    await m.locator('input[data-money]').fill('100');
    await m.locator('input[type=date]').first().fill('2026-11-15');
    await m.locator('button[type=submit]').click();
    await m.waitFor({ state: 'detached' });
    await page.goto(`${base}#/visao-geral`);
    for (let i = 0; i < 12; i++) {
      if (i === 6) { await page.reload(); await page.waitForSelector('[data-kpi]'); for (let k = 0; k < 6; k++) await page.keyboard.press('ArrowRight'); }
      await page.waitForTimeout(60);
      const rows = await page.locator('.tx-row', { hasText: 'Internet' }).count();
      const label = norm(await page.locator('.month-label').textContent());
      eq(rows, 1, `ocorrências em ${label}`);
      await expectKpi(page, 'Compromissos pendentes', 'R$ 100,00');
      await page.keyboard.press('ArrowRight');
    }
    eq(await api(page, (repo) => repo.list('transactions').length), 0, 'navegar não cria registros');
    await noErrors(page);
    await context.close();
  });

  await test('Cenário 5 — compra no cartão e pagamento da fatura sem dupla contabilização', async () => {
    const { context, page } = await newPage();
    await api(page, async (repo) => {
      await repo.createNamed('accounts', { name: 'Conta Nubank', kind: 'checking', openingBalance: 100000 });
      await repo.createNamed('accounts', { name: 'Cartão Nubank', kind: 'credit', closingDay: 3, dueDay: 10 });
    });
    const m = await openForm(page);
    await m.locator('input[name=amount]').fill('200');
    await m.locator('input[name=description]').fill('Tênis');
    await pick(m, 'source', 'Cartão Nubank');
    await waitText(page, '.bill-info', /Entra na fatura de dezembro de 2026, vence 10\/12\/2026/);
    await save(m);
    await page.keyboard.press('ArrowRight');
    await waitText(page, '.month-label', 'Dezembro de 2026');
    await expectKpi(page, 'Compromissos pendentes', 'R$ 200,00');
    await expectKpi(page, 'Despesas realizadas', 'R$ 0,00');
    await page.locator('.kv-action button', { hasText: 'Pagar' }).first().click();
    const pay = page.locator('.entry-modal');
    await pick(pay, 'source', 'Conta Nubank');
    eq(norm(await pay.locator('input[name=amount]').inputValue()), '200,00', 'valor sugerido da fatura');
    await save(pay);
    await expectKpi(page, 'Despesas realizadas', 'R$ 200,00');
    await expectKpi(page, 'Compromissos pendentes', 'R$ 0,00');
    await waitText(page, evolutionHint(page), 'R$ 200,00 em despesas');
    const bal = await api(page, async (repo) => {
      const { accountBalances } = await import('./js/services/finance.js');
      const b = accountBalances(repo.context());
      return repo.list('accounts').map((a) => [a.name, b.get(a.id)]);
    });
    eq(JSON.stringify(bal.sort()), JSON.stringify([['Cartão Nubank', 0], ['Conta Nubank', 80000]].sort()), 'saldos');
    await noErrors(page);
    await context.close();
  });

  await test('Cenário 6 — edição retroativa atualiza os indicadores dos meses afetados', async () => {
    const { context, page } = await newPage();
    await api(page, (repo) => repo.saveTransaction({ type: 'expense', status: 'done', amount: 5000, date: '2026-09-10', description: 'Retroativa' }));
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
    await waitText(page, '.month-label', 'Setembro de 2026');
    await expectKpi(page, 'Despesas realizadas', 'R$ 50,00');
    await page.locator('.tx-main', { hasText: 'Retroativa' }).click();
    const m = page.locator('.entry-modal');
    await m.locator('input[name=amount]').fill('75');
    await m.locator('input[name=date]').fill('2026-08-10');
    await save(m);
    await expectKpi(page, 'Despesas realizadas', 'R$ 0,00');
    await page.keyboard.press('ArrowLeft');
    await expectKpi(page, 'Despesas realizadas', 'R$ 75,00');
    await noErrors(page);
    await context.close();
  });

  let backupPath;
  await test('Cenário 8 — exportar backup e restaurar em uma base vazia', async () => {
    const a = await newPage();
    await api(a.page, async (repo) => {
      const acc = await repo.createNamed('accounts', { name: 'Conta', kind: 'checking', openingBalance: 1000 });
      const b = await repo.createNamed('blocks', { name: 'Moto' });
      for (let i = 0; i < 25; i++) await repo.saveTransaction({ type: 'expense', status: 'done', amount: 1000 + i, date: `2026-11-${String(1 + (i % 25)).padStart(2, '0')}`, description: `Item ${i}`, sourceId: acc.id, blockId: b.id });
      await repo.saveRecurrence({ type: 'expense', description: 'Internet', amount: 10000, frequency: 'monthly', startDate: '2026-11-15' });
      await repo.createInstallmentPlan({ description: 'TV', total: 100000, count: 4, purchaseDate: '2026-11-02' });
      const inv = await repo.saveInvestment({ name: 'Reserva', annualRate: 10, initialBalance: 500000 });
      await repo.saveGoal({ name: 'Meta', target: 1000000, initial: 0, monthly: 50000, annualRate: 10, startMonth: '2026-11', investmentId: inv.id });
    });
    await a.page.goto(`${base}#/configuracoes`);
    const dl = await exportBackupUI(a.page);
    backupPath = join(ARTIFACTS, 'backup-teste.json');
    await dl.saveAs(backupPath);
    const original = await api(a.page, (repo) => JSON.stringify(repo.snapshot(), Object.keys(repo.snapshot()).sort()));
    const counts = await api(a.page, (repo) => Object.fromEntries(Object.entries(repo.snapshot()).map(([k, v]) => [k, v.length])));
    await a.context.close();

    const b = await newPage();
    await b.page.goto(`${base}#/configuracoes`);
    const [chooser] = await Promise.all([b.page.waitForEvent('filechooser'), b.page.getByRole('button', { name: 'Restaurar backup' }).click()]);
    await chooser.setFiles(backupPath);
    await b.page.waitForSelector('.modal', { hasText: 'Restaurar backup (arquivo)?' });
    await waitText(b.page, '.impact', /29 lançamentos/); // 25 avulsos + 4 parcelas
    await b.page.getByRole('button', { name: 'Restaurar', exact: true }).click();
    await waitText(b.page, '.toast', /Backup restaurado/);
    const restored = await api(b.page, (repo) => Object.fromEntries(Object.entries(repo.snapshot()).map(([k, v]) => [k, v.length])));
    for (const k of Object.keys(counts)) if (k !== 'meta') eq(restored[k], counts[k], `quantidade em ${k}`);
    const restoredTx = await api(b.page, (repo) => repo.list('transactions').reduce((s, t) => s + t.amount, 0));
    eq(restoredTx, 25 * 1000 + (24 * 25) / 2 + 100000, 'soma dos valores restaurados');
    assert(original.length > 100, 'snapshot original');
    await noErrors(b.page);
    await b.context.close();
  });

  await test('Cenário 9 — backup inválido é rejeitado e os dados existentes são preservados', async () => {
    const { context, page } = await newPage();
    await api(page, (repo) => repo.saveTransaction({ type: 'expense', status: 'done', amount: 4200, date: '2026-11-10', description: 'Preservar' }));
    const bad = [
      ['invalido.json', '{ isto não é json'],
      ['estrutura.json', JSON.stringify({ format: 'guia-financeiro-backup', version: 1, schemaVersion: 2, data: { transactions: [{ id: 'x', type: 'expense', status: 'done', description: 'x', amount: 12.5, date: '2026-13-40', month: '2026-11' }] } })],
      ['futuro.json', JSON.stringify({ format: 'guia-financeiro-backup', version: 99, data: {} })],
    ];
    await page.goto(`${base}#/configuracoes`);
    for (const [name, content] of bad) {
      const p = join(ARTIFACTS, name);
      await writeFile(p, content);
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Restaurar backup' }).click()]);
      await chooser.setFiles(p);
      await page.waitForSelector('.modal', { hasText: 'Backup inválido' });
      await page.getByRole('button', { name: 'Entendi' }).click();
      await page.waitForSelector('.modal', { state: 'detached' });
    }
    const left = await api(page, (repo) => repo.list('transactions').map((t) => t.description));
    eq(JSON.stringify(left), JSON.stringify(['Preservar']), 'dados preservados');
    await noErrors(page);
    await context.close();
  });

  await test('Cenários 10/11 — simulador: juros compostos conferidos e rentabilidade zero', async () => {
    const { context, page } = await newPage();
    await page.goto(`${base}#/investimentos`);
    const sim = page.locator('.panel', { has: page.locator('h2', { hasText: 'Simulador de aportes' }) });
    const kvv = (label) => async () => norm(await sim.locator('.kv', { hasText: label }).first().locator('.kv-value').textContent());
    const inputs = sim.locator('.sim-in .form-grid').first().locator('input');
    await inputs.nth(0).fill('0'); await inputs.nth(1).fill('100'); await inputs.nth(2).fill(''); await inputs.nth(3).fill('1');
    // Rentabilidade é opcional: sem preencher nada, o cálculo usa 0%.
    await waitText(page, kvv('Em 1 ano'), 'R$ 1.200,00');
    await waitText(page, kvv('Rendimentos'), 'não considerados (0%)');
    // 12% a.a. efetivos, R$ 1.000/mês por 10 anos, aporte no fim do mês: referência independente por iteração.
    await sim.locator('details.advanced summary').click();
    await sim.locator('details.advanced input').first().fill('12');
    await inputs.nth(1).fill('1000'); await inputs.nth(3).fill('10');
    const i = Math.pow(1.12, 1 / 12) - 1;
    let v = 0; for (let n = 0; n < 120; n++) v = v * (1 + i) + 100000;
    const expected = norm(new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Math.round(v) / 100));
    await waitText(page, kvv('Em 10 anos'), expected);
    await waitText(page, kvv('Taxa mensal equivalente'), '0,9489%');
    await noErrors(page);
    await context.close();
  });

  await test('Cenário 12 — calculadora por teclado insere o resultado no lançamento', async () => {
    const { context, page } = await newPage();
    const m = await openForm(page);
    await m.locator('input[name=amount]').focus();
    await page.keyboard.press('Alt+c');
    await page.waitForSelector('.calc.is-open');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('(129,90 + 70,10) * 2 - 10%');
    await waitText(page, '.calc-result', '360');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('.calc', { state: 'hidden' });
    eq(await m.locator('input[name=amount]').inputValue(), '360,00', 'valor inserido');
    await m.locator('input[name=description]').fill('Compra calculada');
    await save(m);
    eq(await api(page, (repo) => repo.list('transactions')[0].amount), 36000, 'valor salvo em centavos');
    // Divisão por zero tratada, sem fechar a calculadora.
    await page.keyboard.press('c');
    await page.waitForSelector('.calc.is-open');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('5/0');
    await page.keyboard.press('Enter');
    await waitText(page, '.calc-error', 'Divisão por zero');
    await page.keyboard.press('Escape');
    await noErrors(page);
    await context.close();
  });

  await test('Cenário 13 — arquivar categoria em uso não corrompe registros; exclusão só sem uso', async () => {
    const { context, page } = await newPage();
    await api(page, async (repo) => {
      const c = await repo.createNamed('categories', { name: 'Hobby', type: 'expense' });
      await repo.saveTransaction({ type: 'expense', status: 'done', amount: 9900, date: '2026-11-12', description: 'Tintas', categoryId: c.id });
      await repo.createNamed('categories', { name: 'Sem uso', type: 'expense' });
    });
    await page.goto(`${base}#/configuracoes`);
    await page.locator('.tag-item', { hasText: 'Hobby' }).click();
    assert(await page.locator('.menu-item', { hasText: 'Excluir (em uso em 1)' }).isDisabled(), 'excluir deve estar desabilitado');
    await page.locator('.menu-item', { hasText: 'Arquivar' }).click();
    await page.waitForSelector('.tag-item.is-archived');
    await page.locator('.tag-item', { hasText: 'Sem uso' }).click();
    await page.locator('.menu-item', { hasText: 'Excluir' }).click();
    await page.getByRole('button', { name: 'Excluir', exact: true }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll('.tag-item')].some((e) => e.textContent.includes('Sem uso')));
    await page.goto(`${base}#/visao-geral`);
    eq(await barValue(page, 'Por categoria', 'Hobby (arquivado)'), 'R$ 99,00', 'categoria arquivada continua nos totais');
    const tx = await api(page, (repo) => { const t = repo.list('transactions')[0]; return { ok: Boolean(repo.get('categories', t.categoryId)), amount: t.amount }; });
    eq(JSON.stringify(tx), JSON.stringify({ ok: true, amount: 9900 }), 'relacionamento preservado');
    const m = await openForm(page);
    await m.locator('[data-picker="category"] .picker-btn').click();
    const opts = await page.locator('.picker-pop .picker-opt').allTextContents();
    assert(opts.length > 3, 'opções da categoria');
    assert(!opts.some((o) => o.startsWith('Hobby')), 'categoria arquivada não aparece para novos lançamentos');
    await page.keyboard.press('Escape');
    await noErrors(page);
    await context.close();
  });

  await test('Cenário 14 — navegação entre meses passados, atual e futuros', async () => {
    const { context, page } = await newPage();
    await api(page, (repo) => repo.saveTransaction({ type: 'expense', status: 'planned', amount: 250000, date: '2027-02-10', description: 'Moto' }));
    await waitText(page, '.month-label', 'Novembro de 2026');
    await page.getByRole('button', { name: 'Mês anterior' }).click();
    await waitText(page, '.month-label', 'Outubro de 2026');
    assert(await page.locator('.month-flag', { hasText: 'Histórico' }).isVisible(), 'marcador de histórico');
    for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Próximo mês' }).click();
    await waitText(page, '.month-label', 'Fevereiro de 2027');
    assert(await page.locator('.month-flag', { hasText: 'Projeção' }).isVisible(), 'marcador de projeção');
    await expectKpi(page, 'Compromissos pendentes', 'R$ 2.500,00');
    await page.getByRole('button', { name: 'Mês atual' }).click();
    await waitText(page, '.month-label', 'Novembro de 2026');
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
    await waitText(page, '.month-label', 'Janeiro de 2027');
    await page.keyboard.press('t');
    await waitText(page, '.month-label', 'Novembro de 2026');
    await noErrors(page);
    await context.close();
  });

  await test('Cenários 16/17 — subdiretório estilo GitHub Pages: todos os recursos carregam, sem caminhos absolutos', async () => {
    const { context, page } = await newPage();
    const loaded = new Set();
    page.on('response', (r) => loaded.add(new URL(r.url()).pathname));
    await page.reload();
    await page.waitForSelector('[data-kpi]');
    for (const hash of ['#/lancamentos', '#/planejamento/recorrencias', '#/planejamento/programadas', '#/planejamento/parcelamentos', '#/planejamento/orcamentos', '#/investimentos', '#/configuracoes', '#/visao-geral']) {
      await page.goto(`${base}${hash}`);
      await page.waitForSelector('.page-head');
    }
    const jsFiles = (await listFiles(join(ROOT, 'js'))).map((f) => `/guia-financeiro/${f.slice(ROOT.length).replace(/\\/g, '/')}`);
    const css = (await readdir(join(ROOT, 'css'))).map((f) => `/guia-financeiro/css/${f}`);
    for (const f of [...jsFiles, ...css, '/guia-financeiro/assets/icons/favicon.svg']) assert(loaded.has(f), `recurso não carregado: ${f}`);
    assert([...loaded].every((p) => p.startsWith('/guia-financeiro/')), 'requisição fora do subdiretório');
    // O Chromium só busca o manifest sob demanda; conferimos que ele é servido e é JSON válido.
    const man = await page.evaluate(async () => { const r = await fetch(document.querySelector('link[rel=manifest]').href); return { s: r.status, j: await r.json() }; });
    eq(man.s, 200, 'manifest');
    eq(man.j.start_url, './', 'start_url relativo');
    const html = await readFile(join(ROOT, 'index.html'), 'utf8');
    assert(!/(src|href)="\//.test(html), 'index.html contém caminho absoluto');
    for (const f of await listFiles(join(ROOT, 'js'))) {
      const src = await readFile(f, 'utf8');
      assert(!/from '\//.test(src) && !/import\('\//.test(src), `import absoluto em ${f}`);
      assert(!/\beval\s*\(|new Function\s*\(/.test(src), `eval/new Function em ${f}`);
      // Só são permitidos o namespace SVG e os dois links informativos de “Sobre o Fluxo” (abertos pelo usuário, nunca buscados pelo app).
      const rest = src.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '').replace(/'https:\/\/github\.com\/filipeesantana\/Fluxo'/g, '').replace(/'https:\/\/filipeesantana\.github\.io\/Fluxo\/'/g, '');
      assert(!/https?:\/\//.test(rest), `URL externa em ${f}`);
    }
    await noErrors(page);
    await context.close();
  });

  await test('Cenário 18 — fluxo principal no mobile (sem rolagem horizontal)', async () => {
    const { context, page } = await newPage({ ...devices['iPhone 13'], locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
    await page.locator('.tab-add').click();
    const m = page.locator('.entry-modal');
    await m.locator('input[name=amount]').fill('42,50');
    await m.locator('input[name=description]').fill('Lanche');
    await save(m);
    await expectKpi(page, 'Despesas realizadas', 'R$ 42,50');
    for (const hash of ['#/visao-geral', '#/lancamentos', '#/planejamento/proximos', '#/investimentos', '#/configuracoes']) {
      await page.goto(`${base}${hash}`);
      await page.waitForSelector('.page-head');
      await page.waitForTimeout(250);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert(overflow <= 0, `rolagem horizontal em ${hash}: ${overflow}px`);
    }
    await page.goto(`${base}#/visao-geral`);
    await page.screenshot({ path: join(ARTIFACTS, 'mobile.png'), fullPage: true });
    await page.locator('.tab[data-route="entries"]').click();
    await page.waitForSelector('#entries-search');
    await page.locator('#entries-search').fill('lanc');
    await waitText(page, '.list-summary span', '1 lançamento');
    await noErrors(page);
    await context.close();
  });

  await test('Cenário 19 — atualização do esquema v1 → v4 preserva o banco existente', async () => {
    const { context, page } = await newPage();
    await page.goto('about:blank');
    await page.goto(`${base}manifest.webmanifest`);
    await page.evaluate(async () => {
      const { MIGRATIONS, DB_NAME } = await import('./js/database/schema.js');
      await new Promise((ok, fail) => { const d = indexedDB.deleteDatabase(DB_NAME); d.onsuccess = ok; d.onerror = fail; });
      await new Promise((ok, fail) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => MIGRATIONS[1](req.result, req.transaction);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['transactions', 'meta', 'recurrences'], 'readwrite');
          const base = { type: 'expense', status: 'done', description: 'Antigo', amount: 1234, date: '2026-10-01', month: '2026-10', categoryId: null, blockId: null, sourceId: null };
          tx.objectStore('transactions').put({ ...base, id: 'a' });
          tx.objectStore('transactions').put({ ...base, id: 'dup1', recurrenceId: 'r', occurrenceDate: '2026-10-05', status: 'planned' });
          tx.objectStore('transactions').put({ ...base, id: 'dup2', recurrenceId: 'r', occurrenceDate: '2026-10-05', status: 'planned' });
          tx.objectStore('recurrences').put({ id: 'r', type: 'expense', description: 'Antiga', amount: 500, frequency: 'monthly', startDate: '2026-10-05', exceptions: {} });
          tx.objectStore('meta').put({ key: 'seeded', value: true });
          tx.oncomplete = () => { db.close(); ok(); };
          tx.onerror = () => fail(tx.error);
        };
        req.onerror = () => fail(req.error);
      });
    });
    await page.goto(`${base}#/visao-geral`);
    await page.waitForSelector('[data-kpi]');
    const info = await page.evaluate(async () => {
      const { DB_NAME } = await import('./js/database/schema.js');
      const repo = await import('./js/database/repository.js');
      const db = await new Promise((ok) => { const r = indexedDB.open(DB_NAME); r.onsuccess = () => ok(r.result); });
      const v = db.version;
      const idx = [...db.transaction('transactions').objectStore('transactions').indexNames];
      db.close();
      return { v, idx, ids: repo.list('transactions').map((t) => t.id).sort() };
    });
    eq(info.v, 4, 'versão do banco');
    assert(info.idx.includes('occurrence'), 'índice único de ocorrências criado');
    eq(JSON.stringify(info.ids), JSON.stringify(['a', 'dup1']), 'dados preservados e duplicata removida');
    await noErrors(page);
    await context.close();
  });

  await test('Cenário 20 — benefício restrito não entra no disponível para aportes', async () => {
    const { context, page } = await newPage();
    await api(page, async (repo) => {
      const c = await repo.createNamed('accounts', { name: 'Conta', kind: 'checking' });
      const va = await repo.createNamed('accounts', { name: 'VA', kind: 'benefit' });
      await repo.saveTransaction({ type: 'income', status: 'done', amount: 300000, date: '2026-11-05', sourceId: c.id, description: 'Salário' });
      await repo.saveTransaction({ type: 'income', status: 'done', amount: 60000, date: '2026-11-05', sourceId: va.id, description: 'VA' });
      await repo.saveTransaction({ type: 'expense', status: 'done', amount: 40000, date: '2026-11-06', sourceId: va.id, description: 'Mercado' });
      await repo.saveTransaction({ type: 'expense', status: 'done', amount: 170000, date: '2026-11-07', sourceId: c.id, description: 'Contas' });
    });
    await expectKpi(page, 'Sobra projetada', 'R$ 1.500,00');
    await expectKpi(page, 'Disponível para investir', 'R$ 1.300,00');
    assert(await page.locator('.kv', { hasText: 'Benefícios livres' }).locator('.kv-value', { hasText: 'R$ 200,00' }).count(), 'benefício livre exibido separadamente');
    const isRestricted = await api(page, (repo) => repo.list('transactions').find((t) => t.description === 'VA').restricted);
    eq(isRestricted, true, 'receita em conta de benefício marcada como restrita');
    await noErrors(page);
    await context.close();
  });

  await test('Ocorrências recorrentes: pagar, ignorar, editar só uma e encerrar a série', async () => {
    const { context, page } = await newPage();
    await api(page, (repo) => repo.saveRecurrence({ type: 'expense', description: 'Plano móvel', amount: 3800, frequency: 'monthly', startDate: '2026-11-20' }));
    await page.locator('.tx-row', { hasText: 'Plano móvel' }).locator('.status-btn').click();
    await expectKpi(page, 'Despesas realizadas', 'R$ 38,00');
    await page.keyboard.press('ArrowRight');
    await page.locator('.tx-row', { hasText: 'Plano móvel' }).locator('.tx-more').click();
    await page.locator('.menu-item', { hasText: 'Ignorar esta ocorrência' }).click();
    await waitText(page, async () => String(await page.locator('.tx-row', { hasText: 'Plano móvel' }).count()), '0');
    await page.keyboard.press('ArrowRight');
    await page.locator('.tx-row', { hasText: 'Plano móvel' }).locator('.tx-main').click();
    const m = page.locator('.entry-modal');
    await m.locator('input[name=amount]').fill('45');
    await m.locator('.modal-foot button[type=submit]').click();
    await page.locator('.scope-opt', { hasText: 'Apenas esta ocorrência' }).click();
    await m.waitFor({ state: 'detached' });
    await expectKpi(page, 'Compromissos pendentes', 'R$ 45,00');
    await page.keyboard.press('ArrowRight');
    await expectKpi(page, 'Compromissos pendentes', 'R$ 38,00');
    await page.locator('.tx-row', { hasText: 'Plano móvel' }).locator('.tx-more').click();
    await page.locator('.menu-item', { hasText: 'Encerrar série' }).click();
    await page.getByRole('button', { name: 'Encerrar série' }).click();
    await expectKpi(page, 'Compromissos pendentes', 'R$ 0,00');
    await page.keyboard.press('ArrowLeft');
    await expectKpi(page, 'Compromissos pendentes', 'R$ 45,00');
    const occ = await api(page, (repo) => repo.list('transactions').map((t) => [t.occurrenceDate, t.status, t.amount]).sort());
    eq(JSON.stringify(occ), JSON.stringify([['2026-11-20', 'done', 3800], ['2027-01-20', 'planned', 4500]]), 'ocorrências materializadas');
    await noErrors(page);
    await context.close();
  });

  await test('Segurança — texto do usuário não é interpretado como HTML (XSS)', async () => {
    const { context, page } = await newPage();
    const payload = '<img src=x onerror="window.__xss=1">';
    const m = await openForm(page);
    await m.locator('input[name=amount]').fill('10');
    await m.locator('input[name=description]').fill(payload);
    await createInline(m, 'block', '<b>bloco</b>');
    await save(m);
    await page.waitForSelector('.tx-row');
    eq(norm(await page.locator('.tx-desc').first().textContent()), payload, 'descrição exibida como texto');
    eq(await page.evaluate(() => window.__xss), undefined, 'script não executado');
    eq(await page.locator('.tx-row img, .bars b').count(), 0, 'sem elementos injetados');
    await noErrors(page);
    await context.close();
  });

  await test('Sincronização entre abas', async () => {
    const { context, page } = await newPage();
    const other = await context.newPage();
    await other.goto(base);
    await other.waitForSelector('.page-head');
    await api(page, (repo) => repo.saveTransaction({ type: 'income', status: 'done', amount: 12345, date: '2026-11-03', description: 'Outra aba' }));
    await expectKpi(other, 'Receitas recebidas', 'R$ 123,45');
    await context.close();
  });

  await test('Reembolso, duplicação, alteração de situação e exclusão com desfazer', async () => {
    const { context, page } = await newPage();
    await api(page, (repo) => repo.saveTransaction({ type: 'expense', status: 'done', amount: 10000, date: '2026-11-10', description: 'Show' }));
    await page.locator('.tx-row', { hasText: 'Show' }).locator('.tx-more').click();
    await page.locator('.menu-item', { hasText: 'Registrar reembolso' }).click();
    const m = page.locator('.entry-modal');
    await m.locator('input[name=amount]').fill('40');
    await save(m);
    await expectKpi(page, 'Despesas realizadas', 'R$ 60,00');
    await page.locator('.tx-row', { hasText: /^.*Show$/ }).first();
    await page.locator('.tx-row').filter({ hasNotText: 'Reembolso' }).locator('.tx-more').click();
    await page.locator('.menu-item', { hasText: 'Duplicar' }).click();
    await expectKpi(page, 'Despesas realizadas', 'R$ 160,00');
    const dupRow = page.locator('.tx-row').filter({ hasNotText: 'Reembolso' }).first();
    await dupRow.locator('.status-btn').click();
    await expectKpi(page, 'Compromissos pendentes', 'R$ 100,00');
    await dupRow.locator('.tx-more').click();
    await page.locator('.menu-item', { hasText: 'Excluir' }).click();
    await expectKpi(page, 'Compromissos pendentes', 'R$ 0,00');
    await page.locator('.toast .link-btn', { hasText: 'Desfazer' }).last().click();
    await expectKpi(page, 'Compromissos pendentes', 'R$ 100,00');
    await noErrors(page);
    await context.close();
  });

  await test('Todos os botões visíveis de cada seção funcionam sem erros', async () => {
    const { context, page } = await newPage();
    await api(page, async (repo) => {
      const c = await repo.createNamed('accounts', { name: 'Conta', kind: 'checking' });
      const k = await repo.createNamed('accounts', { name: 'Cartão', kind: 'credit', closingDay: 1, dueDay: 8 });
      await repo.saveTransaction({ type: 'expense', status: 'done', amount: 1000, date: '2026-11-10', description: 'A', sourceId: c.id });
      await repo.saveTransaction({ type: 'expense', status: 'done', amount: 2000, date: '2026-10-10', description: 'B', sourceId: k.id });
      await repo.saveRecurrence({ type: 'expense', description: 'R', amount: 500, frequency: 'monthly', startDate: '2026-11-01' });
      await repo.createInstallmentPlan({ description: 'P', total: 9000, count: 3, purchaseDate: '2026-11-01', sourceId: c.id });
      const cat = repo.list('categories')[0];
      await repo.saveBudget({ scope: 'category', refId: cat.id, amount: 5000 });
      await repo.saveInvestment({ name: 'Inv', annualRate: 8, initialBalance: 10000 });
      await repo.saveGoal({ name: 'G', target: 100000, initial: 0, monthly: 1000, annualRate: 5, startMonth: '2026-11' });
    });
    let clicked = 0;
    for (const hash of ['#/visao-geral', '#/lancamentos', '#/planejamento/proximos', '#/planejamento/recorrencias', '#/planejamento/programadas', '#/planejamento/parcelamentos', '#/planejamento/orcamentos', '#/investimentos', '#/configuracoes']) {
      await page.goto(`${base}${hash}`);
      await page.waitForSelector('.page-head');
      const text = await page.locator('#view').innerText();
      assert(!/\b(null|undefined|NaN)\b|\[object /.test(text), `texto inválido renderizado em ${hash}`);
      const count = await page.locator('#view button:visible').count();
      for (let i = 0; i < count; i++) {
        const btn = page.locator('#view button:visible').nth(i);
        if (!(await btn.count())) break;
        const label = norm(await btn.textContent());
        if (/Restaurar backup/.test(label)) continue; // coberto pelos cenários 8 e 9
        if (await btn.isDisabled()) continue;
        page.once('filechooser', () => {});
        await btn.click({ timeout: 2000 }).catch(() => {});
        clicked++;
        await page.waitForTimeout(40);
        for (let k = 0; k < 3 && (await page.locator('.modal, .menu, .calc.is-open, .picker-pop').count()); k++) {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(200);
          if (await page.locator('.modal', { hasText: 'Descartar alterações?' }).count()) await page.getByRole('button', { name: 'Descartar' }).click();
        }
        if (!page.url().endsWith(hash)) { await page.goto(`${base}${hash}`); await page.waitForSelector('.page-head'); }
      }
    }
    assert(clicked > 60, `poucos botões exercitados (${clicked})`);
    eq(await api(page, (repo) => repo.list('transactions').filter((t) => !t.planId).length >= 2), true, 'dados intactos');
    await noErrors(page);
    await context.close();
  });

  await test('Performance — 5.000 lançamentos: abertura e troca de mês fluidas', async () => {
    const { context, page } = await newPage();
    await page.evaluate(async () => {
      const db = await import('./js/database/db.js');
      const cats = (await import('./js/database/repository.js')).list('categories');
      const ops = [];
      for (let i = 0; i < 5000; i++) {
        const m = 1 + (i % 12), d = 1 + (i % 28);
        ops.push({ store: 'transactions', put: { id: `p${i}`, type: i % 10 ? 'expense' : 'income', status: 'done', description: `Item ${i % 97}`, amount: 1000 + (i % 500), date: `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, month: `2026-${String(m).padStart(2, '0')}`, categoryId: cats[i % cats.length].id, blockId: null, sourceId: null, createdAt: i } });
      }
      await db.commit(ops);
    });
    const t0 = Date.now();
    await page.reload();
    await page.waitForSelector('[data-kpi]');
    await page.waitForSelector('.tx-row');
    const load = Date.now() - t0;
    const t1 = Date.now();
    for (let i = 0; i < 6; i++) { await page.keyboard.press('ArrowLeft'); await page.waitForFunction(() => true); }
    await page.waitForTimeout(50);
    const nav = (Date.now() - t1) / 6;
    await page.goto(`${base}#/lancamentos`);
    await page.locator('.segmented button', { hasText: 'Todos os meses' }).click();
    const t2 = Date.now();
    await page.locator('#entries-search').fill('Item 5');
    await waitText(page, '.list-summary span', /lançamentos/);
    const search = Date.now() - t2;
    console.log(`      carga ${load} ms · troca de mês ~${Math.round(nav)} ms · busca ${search} ms`);
    assert(load < 4000 && nav < 400, 'desempenho abaixo do esperado');
    await noErrors(page);
    await context.close();
  });


  // ——————————————— Fluxo 2.0 ———————————————

  await test('2.0 — identidade Fluxo, menu com seção selecionada evidente e menu recolhível persistente', async () => {
    const { context, page } = await newPage();
    eq(await page.title(), 'Visão geral · Fluxo', 'título');
    eq(norm(await page.locator('.brand-name').textContent()), 'Fluxo', 'marca');
    const current = page.locator('.nav-link[aria-current="page"]');
    eq(norm(await current.textContent()).replace(/\d$/, ''), 'Visão geral', 'item selecionado');
    const bg = await current.evaluate((el) => getComputedStyle(el).backgroundColor);
    const bgOther = await page.locator('.nav-link:not([aria-current])').first().evaluate((el) => getComputedStyle(el).backgroundColor);
    assert(bg !== bgOther, 'seção selecionada tem superfície própria');
    const indicator = await current.evaluate((el) => getComputedStyle(el, '::before').width);
    eq(indicator, '3px', 'indicador lateral');
    await page.locator('[data-action="collapse"]').click();
    await page.waitForFunction(() => document.documentElement.classList.contains('sidebar-collapsed'));
    await page.locator('.nav-link[data-route="entries"]').hover();
    await waitText(page, '.tooltip', 'Lançamentos');
    await page.reload();
    await page.waitForSelector('[data-kpi]');
    assert(await page.evaluate(() => document.documentElement.classList.contains('sidebar-collapsed')), 'preferência persistida');
    const w = await page.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().width);
    assert(w < 80, `menu recolhido estreito (${w}px)`);
    eq(await page.locator('[data-action="new-entry"]').count(), 1, 'uma única ação global de novo lançamento no desktop');
    await noErrors(page);
    await context.close();
  });

  await test('2.0 — calendário: eventos por dia, painel do dia, lançamento na data e ano bissexto', async () => {
    const { context, page } = await newPage();
    await api(page, async (repo) => {
      const c = await repo.createNamed('accounts', { name: 'Conta', kind: 'checking' });
      const k = await repo.createNamed('accounts', { name: 'Cartão', kind: 'credit', closingDay: 3, dueDay: 10 });
      await repo.saveRecurrence({ type: 'expense', description: 'Internet', amount: 10000, frequency: 'monthly', startDate: '2026-01-15', sourceId: c.id });
      await repo.saveTransaction({ type: 'income', status: 'done', amount: 300000, date: '2026-11-05', description: 'Salário', sourceId: c.id });
      await repo.saveTransaction({ type: 'expense', status: 'done', amount: 20000, date: '2026-10-20', description: 'Tênis', sourceId: k.id });
    });
    await page.goto(`${base}#/planejamento/calendario`);
    await page.waitForSelector('.cal-grid');
    eq(await page.locator('.cal-day[data-date]').count(), 30, 'novembro tem 30 dias');
    await page.locator('.cal-day[data-date="2026-11-15"]').click();
    await waitText(page, '#day-panel .tx-desc', /Internet/);
    await page.locator('.cal-day[data-date="2026-11-10"]').click();
    await waitText(page, '#day-panel', /Fatura Cartão/);
    await page.locator('.cal-day[data-date="2026-11-05"]').click();
    await waitText(page, '#day-panel .day-totals', /R\$ 3\.000,00/);
    await page.locator('#day-panel').getByRole('button', { name: 'Lançar neste dia' }).click();
    eq(await page.locator('.entry-modal input[name=date]').inputValue(), '2026-11-05', 'data pré-preenchida');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.entry-modal', { state: 'detached' });
    await page.evaluate(async () => { const st = await import('./js/state.js'); st.setMonth('2028-02'); });
    await page.waitForSelector('.cal-day[data-date="2028-02-29"]');
    eq(await page.locator('.cal-day[data-date]').count(), 29, 'fevereiro bissexto');
    await noErrors(page);
    await context.close();
  });

  await test('2.0 — próximos vencimentos na visão geral (atrasado, fatura e conta fixa)', async () => {
    const { context, page } = await newPage();
    await api(page, async (repo) => {
      const k = await repo.createNamed('accounts', { name: 'Nubank', kind: 'credit', closingDay: 3, dueDay: 10 });
      await repo.saveTransaction({ type: 'expense', status: 'done', amount: 78000, date: '2026-11-20', description: 'Compra', sourceId: k.id });
      await repo.saveTransaction({ type: 'expense', status: 'planned', amount: 5000, date: '2026-11-20', description: 'Boleto esquecido' });
      await repo.saveRecurrence({ type: 'expense', description: 'Plano de saúde', amount: 7990, frequency: 'monthly', startDate: '2026-12-15' });
    });
    const panelUp = page.locator('.panel', { has: page.locator('h2', { hasText: 'Próximos vencimentos' }) });
    await waitText(page, async () => norm(await panelUp.locator('.up-row').first().textContent()), /Boleto esquecido.*Atrasado/);
    const txt = norm(await panelUp.textContent());
    assert(/Fatura Nubank.*R\$ 780,00/.test(txt), 'fatura de dezembro listada');
    assert(/Plano de saúde.*R\$ 79,90/.test(txt), 'conta fixa listada');
    await noErrors(page);
    await context.close();
  });

  await test('2.0 — projeção de longo prazo: horizontes 3 a 60 meses, personalizado e compromissos que terminam', async () => {
    const { context, page } = await newPage();
    await api(page, async (repo) => {
      await repo.saveRecurrence({ type: 'income', description: 'Salário', amount: 300000, frequency: 'monthly', startDate: '2026-01-05' });
      await repo.createInstallmentPlan({ description: 'Moto', total: 2400000, count: 24, purchaseDate: '2026-11-02', firstMonth: '2026-11' });
    });
    await page.goto(`${base}#/planejamento/projecao`);
    await page.waitForSelector('.horizon');
    await page.locator('.horizon .seg', { hasText: '5 anos' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.table tbody tr').length === 60);
    await page.locator('.horizon .seg', { hasText: '3 meses' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.table tbody tr').length === 3);
    await page.locator('.horizon input').fill('30');
    await page.locator('.horizon input').press('Enter');
    await page.locator('.horizon input').blur();
    await page.waitForFunction(() => document.querySelectorAll('.table tbody tr').length === 30);
    await waitText(page, '.ending', /Moto.*\+R\$ 1\.000,00\/mês.*outubro de 2028.*novembro de 2028/);
    assert(await page.locator('.note.is-warn', { hasText: 'não inclui despesas variáveis' }).count(), 'aviso de projeção incompleta');
    eq(await api(page, (repo) => repo.list('transactions').length), 24, 'consultar não cria registros');
    await noErrors(page);
    await context.close();
  });

  await test('2.0 — simulação de decisões compara cenários e descarta sem alterar registros', async () => {
    const { context, page } = await newPage();
    await api(page, async (repo) => {
      await repo.saveRecurrence({ type: 'income', description: 'Salário', amount: 300000, frequency: 'monthly', startDate: '2026-01-05' });
      await repo.saveRecurrence({ type: 'expense', description: 'Streaming', amount: 5000, frequency: 'monthly', startDate: '2026-01-10' });
    });
    const before = await api(page, (repo) => JSON.stringify(repo.snapshot()));
    await page.goto(`${base}#/planejamento/simulacoes`);
    await page.locator('.horizon .seg', { hasText: '1 ano' }).click();
    await page.locator('.adj-builder select').first().selectOption('cancelRecurrence');
    await page.locator('.adj-builder .form-grid .field', { hasText: 'Conta recorrente' }).locator('select').selectOption({ label: 'Streaming · R$ 50,00' });
    await page.getByRole('button', { name: 'Adicionar ao cenário' }).click();
    await waitText(page, () => page.locator('.cal-stat', { hasText: 'diferença no período' }).locator('b').textContent().then(norm), '+R$ 550,00');
    await page.locator('.adj-builder select').first().selectOption('installment');
    await page.locator('.adj-builder .form-grid .field', { hasText: 'Valor total' }).locator('input').fill('1200');
    await page.locator('.adj-builder .form-grid .field', { hasText: 'Parcelas' }).locator('input').fill('12');
    await page.getByRole('button', { name: 'Adicionar ao cenário' }).click();
    await waitText(page, () => page.locator('.cal-stat', { hasText: 'diferença no período' }).locator('b').textContent().then(norm), '−R$ 550,00'.replace('−', '-'));
    eq(await page.locator('.adj').count(), 2, 'dois ajustes');
    await page.getByRole('button', { name: 'Descartar simulação' }).click();
    await waitText(page, () => page.locator('.cal-stat', { hasText: 'diferença no período' }).locator('b').textContent().then(norm), 'R$ 0,00');
    eq(await api(page, (repo) => JSON.stringify(repo.snapshot())), before, 'base financeira intacta');
    await noErrors(page);
    await context.close();
  });

  await test('2.0 — meta sem rentabilidade: entrada da moto em 12 meses; usar sobra mensal', async () => {
    const { context, page } = await newPage();
    await api(page, (repo) => repo.saveTransaction({ type: 'income', status: 'done', amount: 90000, date: '2026-11-05', description: 'Renda' }));
    await page.goto(`${base}#/investimentos`);
    await page.getByRole('button', { name: 'Nova meta' }).click();
    const m = page.locator('.modal');
    await m.locator('.field', { hasText: 'Nome da meta' }).locator('input').fill('Entrada da moto');
    await m.locator('.field', { hasText: 'Valor desejado' }).locator('input').fill('20000');
    await m.locator('.field', { hasText: 'Valor que já tenho' }).locator('input').fill('8000');
    await m.locator('.field', { hasText: 'Quanto consigo guardar' }).locator('input').fill('1000');
    await waitText(page, () => m.locator('.banner').textContent().then(norm), /Falta R\$ 12\.000,00 · 40% concluído.*novembro de 2027 \(1 ano de aportes\)/);
    await m.locator('.chip', { hasText: 'Usar sobra mensal' }).click();
    eq(await m.locator('.field', { hasText: 'Quanto consigo guardar' }).locator('input').inputValue(), '900,00', 'sobra mensal como referência');
    await m.locator('.field', { hasText: 'Quanto consigo guardar' }).locator('input').fill('1000');
    await m.getByRole('button', { name: 'Criar meta' }).click();
    await m.waitFor({ state: 'detached' });
    const card = page.locator('.goal-card', { hasText: 'Entrada da moto' });
    await waitText(page, () => card.locator('.goal-forecast').textContent().then(norm), 'Conclusão em novembro de 2027 · 1 ano');
    assert(/40%.*R\$ 12\.000,00.*R\$ 1\.000,00/.test(norm(await card.locator('.goal-stats').textContent())), 'estatísticas da meta');
    const g = await api(page, (repo) => repo.list('goals')[0]);
    eq(g.annualRate, null, 'rentabilidade não exigida');
    eq(await api(page, (repo) => repo.list('investmentEvents').length), 0, 'nenhum investimento registrado automaticamente');
    await noErrors(page);
    await context.close();
  });

  await test('2.0 — duplicidades: aviso sem bloquear, registro legítimo e recorrência prevista', async () => {
    const { context, page } = await newPage();
    await api(page, async (repo) => {
      const c = await repo.createNamed('accounts', { name: 'Conta Nubank', kind: 'checking' });
      await repo.saveTransaction({ type: 'expense', status: 'done', amount: 10000, date: '2026-11-25', description: 'Internet', sourceId: c.id });
      await repo.saveRecurrence({ type: 'expense', description: 'Plano de saúde', amount: 7990, frequency: 'monthly', startDate: '2026-01-20', sourceId: c.id });
    });
    let m = await openForm(page);
    await m.locator('input[name=amount]').fill('100');
    await m.locator('input[name=description]').fill('Internet');
    await pick(m, 'source', 'Conta Nubank');
    await m.locator('.modal-foot button[type=submit]').click();
    await waitText(page, '.banner-warn', /Encontramos um lançamento semelhante/);
    eq(await api(page, (repo) => repo.list('transactions').length), 1, 'nada salvo antes da decisão');
    await m.getByRole('button', { name: 'Registrar mesmo assim' }).click();
    await m.waitFor({ state: 'detached' });
    eq(await api(page, (repo) => repo.list('transactions').filter((t) => t.description === 'Internet').length), 2, 'lançamento legítimo registrado');
    m = await openForm(page);
    await m.locator('input[name=amount]').fill('79,90');
    await m.locator('input[name=description]').fill('Plano de saúde');
    await m.locator('input[name=date]').fill('2026-11-20');
    await m.locator('.modal-foot button[type=submit]').click();
    await waitText(page, '.banner-warn', /conta recorrente já prevista/);
    await m.getByRole('button', { name: /Marcar “Plano de saúde” como paga/ }).click();
    await m.waitFor({ state: 'detached' });
    const occ = await api(page, (repo) => repo.list('transactions').filter((t) => t.description === 'Plano de saúde').map((t) => [t.status, Boolean(t.recurrenceId), t.occurrenceDate]));
    eq(JSON.stringify(occ), JSON.stringify([['done', true, '2026-11-20']]), 'ocorrência marcada como paga, sem duplicar');
    await expectKpi(page, 'Compromissos pendentes', 'R$ 0,00');
    await noErrors(page);
    await context.close();
  });

  await test('2.0 — clique duplo e envio repetido não duplicam lançamentos', async () => {
    const { context, page } = await newPage();
    const m = await openForm(page);
    await m.locator('input[name=amount]').fill('55');
    await m.locator('input[name=description]').fill('Lanche');
    await m.locator('.modal-foot button[type=submit]').dblclick();
    await page.keyboard.press('Control+Enter').catch(() => {});
    await m.waitFor({ state: 'detached' });
    await page.waitForTimeout(300);
    eq(await api(page, (repo) => repo.list('transactions').length), 1, 'exatamente um registro');
    await noErrors(page);
    await context.close();
  });

  await test('2.0 — seletor pesquisável: busca, recentes e criação com seleção automática', async () => {
    const { context, page } = await newPage();
    await api(page, (repo) => repo.saveTransaction({ type: 'expense', status: 'done', amount: 1000, date: '2026-11-01', description: 'X', categoryId: repo.list('categories').find((c) => c.name === 'Lazer').id }));
    const m = await openForm(page);
    await m.locator('[data-picker="category"] .picker-btn').click();
    const groups = await page.locator('.picker-pop .picker-group').allTextContents();
    assert(groups.includes('Recentes'), 'grupo de recentes');
    await page.locator('.picker-pop input').fill('saú');
    eq(norm(await page.locator('.picker-pop .picker-opt').first().textContent()), 'Saúde', 'busca sem acento');
    await page.locator('.picker-pop input').fill('Pets');
    await page.locator('.picker-pop input').press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-picker="category"] .picker-value').textContent === 'Pets');
    eq(await api(page, (repo) => repo.list('categories').filter((c) => c.name === 'Pets').length), 1, 'categoria criada');
    await m.locator('input[name=amount]').fill('30');
    await save(m);
    const t = await api(page, (repo) => { const x = repo.list('transactions').find((y) => y.amount === 3000); return repo.get('categories', x.categoryId).name; });
    eq(t, 'Pets', 'lançamento com a nova categoria');
    await noErrors(page);
    await context.close();
  });

  await test('2.0 — sugestão do histórico preenche só o que não foi escolhido manualmente', async () => {
    const { context, page } = await newPage();
    await api(page, async (repo) => {
      const c = await repo.createNamed('accounts', { name: 'Conta Nubank', kind: 'checking' });
      await repo.createNamed('accounts', { name: 'Banco do Brasil', kind: 'checking' });
      const b = await repo.createNamed('blocks', { name: 'Casa' });
      await repo.saveTransaction({ type: 'expense', status: 'done', amount: 10000, date: '2026-10-05', description: 'Internet', sourceId: c.id, blockId: b.id, categoryId: repo.list('categories').find((x) => x.name === 'Assinaturas').id });
    });
    const m = await openForm(page);
    await pick(m, 'source', 'Banco do Brasil');
    await m.locator('input[name=description]').fill('Inter');
    await page.locator('.suggest-item').first().click();
    await waitText(page, () => m.locator('[data-picker="category"] .picker-value').textContent().then(norm), 'Assinaturas');
    eq(norm(await m.locator('[data-picker="block"] .picker-value').textContent()), 'Casa', 'bloco sugerido');
    eq(norm(await m.locator('[data-picker="source"] .picker-value').textContent()), 'Banco do Brasil', 'escolha manual preservada');
    assert(await m.locator('.suggest-note').isVisible(), 'sugestão sinalizada');
    await noErrors(page);
    await page.keyboard.press('Escape');
    await context.close();
  });

  await test('2.0 — painel contextual por bloco lista gastos e leva a Lançamentos filtrado', async () => {
    const { context, page } = await newPage();
    await api(page, async (repo) => {
      const b = await repo.createNamed('blocks', { name: 'Namorada' });
      await repo.saveTransaction({ type: 'expense', status: 'done', amount: 12990, date: '2026-11-25', description: 'Jantar Figueiredo', blockId: b.id });
      await repo.saveTransaction({ type: 'expense', status: 'done', amount: 5000, date: '2026-11-12', description: 'Cinema', blockId: b.id });
      await repo.saveTransaction({ type: 'expense', status: 'done', amount: 7000, date: '2026-11-12', description: 'Mercado' });
    });
    await page.locator('.panel', { has: page.locator('h2', { hasText: 'Por bloco' }) }).locator('.bar-row', { hasText: 'Namorada' }).click();
    const drawer = page.locator('.modal-root.is-drawer');
    await drawer.waitFor();
    await waitText(page, () => drawer.locator('.kv', { hasText: 'Total no mês' }).locator('.kv-value').textContent().then(norm), 'R$ 179,90');
    eq(await drawer.locator('.tx-row').count(), 2, 'somente os gastos do bloco');
    await drawer.getByRole('button', { name: 'Abrir em Lançamentos' }).click();
    await page.waitForURL(/#\/lancamentos/);
    await waitText(page, '.list-summary span', '2 lançamentos');
    await noErrors(page);
    await context.close();
  });

  await test('2.0 — integridade: auditoria lista duplicidades e referências sem alterar dados', async () => {
    const { context, page } = await newPage();
    await page.evaluate(async () => {
      const db = await import('./js/database/db.js');
      const base = { type: 'expense', status: 'done', amount: 500, date: '2026-11-01', month: '2026-11', description: 'Mercado', categoryId: null, blockId: null, sourceId: null };
      await db.commit([{ store: 'transactions', put: { ...base, id: 'd1' } }, { store: 'transactions', put: { ...base, id: 'd2' } }, { store: 'transactions', put: { ...base, id: 'o1', categoryId: 'apagada', description: 'Órfão' } }]);
    });
    await page.reload();
    await page.goto(`${base}#/configuracoes/integridade`);
    const box = page.locator('#cfg-integridade');
    await waitText(page, () => box.textContent().then(norm), /^(?=.*Possível duplicidade)(?=.*Referência inválida)/);
    eq(await api(page, (repo) => repo.list('transactions').length), 3, 'nada excluído');
    await box.locator('.audit-item', { hasText: 'Referência inválida' }).getByRole('button', { name: 'Abrir' }).click();
    await page.waitForSelector('.entry-modal');
    await noErrors(page);
    await context.close();
  });

  await test('2.0 — compatibilidade: base e backup da versão 1.0 abrem no Fluxo 2.0', async () => {
    const { context, page } = await newPage();
    // Base gravada como a v1 gravava (mesmo banco, esquema v2, metas com rentabilidade obrigatória).
    await page.goto(`${base}manifest.webmanifest`);
    await page.evaluate(async () => {
      const { DB_NAME, MIGRATIONS } = await import('./js/database/schema.js');
      await new Promise((ok) => { const d = indexedDB.deleteDatabase(DB_NAME); d.onsuccess = ok; d.onerror = ok; });
      await new Promise((ok, fail) => {
        const req = indexedDB.open(DB_NAME, 2);
        req.onupgradeneeded = () => { MIGRATIONS[1](req.result, req.transaction); MIGRATIONS[2](req.result, req.transaction); };
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['transactions', 'goals', 'meta', 'categories'], 'readwrite');
          tx.objectStore('categories').put({ id: 'cat1', name: 'Alimentação', type: 'expense', archived: false });
          tx.objectStore('transactions').put({ id: 'v1tx', type: 'expense', status: 'done', description: 'Mercado antigo', amount: 25000, date: '2026-11-03', month: '2026-11', categoryId: 'cat1', blockId: null, sourceId: null, createdAt: 1 });
          tx.objectStore('goals').put({ id: 'v1goal', name: 'Reserva', target: 1000000, initial: 100000, monthly: 50000, annualRate: 10, startMonth: '2026-11', deadline: null, timing: 'end', investmentId: null });
          tx.objectStore('meta').put({ key: 'seeded', value: true });
          tx.objectStore('meta').put({ key: 'prefs', value: { safetyMargin: 10000 } });
          tx.oncomplete = () => { db.close(); ok(); };
          tx.onerror = () => fail(tx.error);
        };
      });
    });
    await page.goto(`${base}#/visao-geral`);
    await page.waitForSelector('[data-kpi]');
    eq(await barValue(page, 'Por categoria', 'Alimentação'), 'R$ 250,00', 'lançamento antigo exibido');
    await page.goto(`${base}#/investimentos`);
    await waitText(page, () => page.locator('.goal-card', { hasText: 'Reserva' }).locator('.goal-forecast').textContent().then(norm), /Conclusão em .*estimativa com rentabilidade/);
    eq(await api(page, (repo) => repo.prefs().safetyMargin), 10000, 'preferências preservadas');
    // Backup da v1 (formato 1) restaura normalmente.
    const v1 = { format: 'guia-financeiro-backup', version: 1, schemaVersion: 2, appVersion: '1.0.0', exportedAt: '2026-11-20T10:00:00.000Z', data: { transactions: [{ id: 'b1', type: 'income', status: 'done', description: 'Salário', amount: 300000, date: '2026-11-05', month: '2026-11', categoryId: null, blockId: null, sourceId: null }], categories: [], blocks: [], accounts: [], recurrences: [], installmentPlans: [], budgets: [], investments: [], investmentEvents: [], goals: [{ id: 'g', name: 'Viagem', target: 500000, initial: 0, monthly: 50000, annualRate: 0, startMonth: '2026-11', timing: 'end' }], meta: [{ key: 'seeded', value: true }] } };
    const path = join(ARTIFACTS, 'backup-v1.json');
    await writeFile(path, JSON.stringify(v1));
    await page.goto(`${base}#/configuracoes/dados`);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Restaurar backup' }).click()]);
    await chooser.setFiles(path);
    await page.getByRole('button', { name: 'Restaurar', exact: true }).click();
    await waitText(page, '.toast:last-child', /Backup restaurado/);
    eq(await api(page, (repo) => repo.list('goals')[0].name), 'Viagem', 'backup v1 restaurado');
    await noErrors(page);
    await context.close();
  });

  await test('2.0 — persistência após fechar e reabrir o navegador (mesmo perfil)', async () => {
    const { context, page } = await newPage();
    await api(page, (repo) => repo.saveTransaction({ type: 'expense', status: 'done', amount: 4321, date: '2026-11-10', description: 'Persistente' }));
    await page.close();
    const again = await context.newPage();
    await again.goto(base);
    await again.waitForSelector('[data-kpi]');
    await expectKpi(again, 'Despesas realizadas', 'R$ 43,21');
    await context.close();
  });

  await test('2.0 — movimento reduzido: interface continua funcional', async () => {
    const { context, page } = await newPage({ reducedMotion: 'reduce' });
    const m = await openForm(page);
    await m.locator('input[name=amount]').fill('12');
    await save(m);
    await expectKpi(page, 'Despesas realizadas', 'R$ 12,00');
    await page.goto(`${base}#/configuracoes`);
    await page.locator('.settings-row', { hasText: 'Animações' }).locator('.seg', { hasText: 'Reduzidas' }).click();
    eq(await page.evaluate(() => document.documentElement.dataset.motion), 'reduced', 'preferência aplicada');
    await page.goto(`${base}#/planejamento/calendario`);
    await page.waitForSelector('.cal-grid');
    await noErrors(page);
    await context.close();
  });

  await test('2.0 — resoluções: 1366×768, 1920×1080, 2560×1440, ultrawide, tablet e celulares de 320 a 430 px sem rolagem horizontal', async () => {
    const sizes = [[1366, 768], [1920, 1080], [2560, 1440], [3440, 1440], [820, 1180], [430, 932], [390, 844], [360, 780], [320, 640]];
    for (const [w, hgt] of sizes) {
      const { context, page } = await newPage({ viewport: { width: w, height: hgt }, isMobile: w < 500, hasTouch: w < 900 });
      await api(page, async (repo) => {
        const b = await repo.createNamed('blocks', { name: 'Pessoal' });
        for (let i = 1; i <= 12; i++) await repo.saveTransaction({ type: i % 4 ? 'expense' : 'income', status: i > 8 ? 'planned' : 'done', amount: 1000 * i, date: `2026-11-${String(i * 2).padStart(2, '0')}`, description: `Item ${i}`, blockId: b.id });
      });
      for (const hash of ['#/visao-geral', '#/lancamentos', '#/planejamento/calendario', '#/planejamento/compromissos', '#/planejamento/projecao', '#/investimentos', '#/configuracoes']) {
        await page.goto(`${base}${hash}`);
        await page.waitForSelector('.page-head');
        await page.waitForTimeout(120);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert(overflow <= 0, `rolagem horizontal em ${w}×${hgt} ${hash}: ${overflow}px`);
      }
      await page.goto(`${base}#/visao-geral`);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(ARTIFACTS, `res-${w}x${hgt}.png`), fullPage: false });
      await noErrors(page);
      await context.close();
    }
  });

  await test('2.0 — carga em duas fases: histórico antigo aparece, entra em saldos e no backup', async () => {
    const { context, page } = await newPage();
    await api(page, async (repo) => {
      const c = await repo.createNamed('accounts', { name: 'Conta', kind: 'checking' });
      await repo.saveTransaction({ type: 'income', status: 'done', amount: 100000, date: '2023-01-10', description: 'Antigo', sourceId: c.id });
      await repo.saveTransaction({ type: 'expense', status: 'done', amount: 2500, date: '2026-11-10', description: 'Recente', sourceId: c.id });
    });
    await page.reload();
    await page.waitForSelector('[data-kpi]');
    await api(page, (repo) => repo.whenFullyLoaded());
    await waitText(page, () => page.locator('.kv', { hasText: 'Saldo em contas hoje' }).locator('.kv-value').textContent().then(norm), 'R$ 975,00');
    await page.evaluate(async () => { const st = await import('./js/state.js'); st.setMonth('2023-01'); });
    await expectKpi(page, 'Receitas recebidas', 'R$ 1.000,00');
    await page.goto(`${base}#/configuracoes/dados`);
    const dl = await exportBackupUI(page);
    const file = join(ARTIFACTS, 'backup-duas-fases.json');
    await dl.saveAs(file);
    const b = JSON.parse(await readFile(file, 'utf8'));
    eq(b.data.transactions.length, 2, 'backup contém o histórico completo');
    await noErrors(page);
    await context.close();
  });
  // ——————————————————— Fluxo 3.0 ———————————————————

  await test('3.0 — Planejamento: preferência antiga "proximos", valores inválidos, todas as abas, recarga e navegação repetida', async () => {
    const { context, page } = await newPage();
    const tabs = ['calendario', 'projecao', 'simulacoes', 'recorrencias', 'programadas', 'parcelamentos', 'orcamentos'];
    // Regressão: a 1.0 gravava "proximos"; a 2.0 fazia TABS[tab]() e quebrava com "... is not a function".
    for (const bad of ['proximos', 'xyz', '{}', '__proto__', 'constructor', '']) {
      await page.evaluate((v) => localStorage.setItem('gf.planning.tab', v), bad);
      await page.goto(`${base}#/planejamento`);
      await page.waitForSelector('.subnav [aria-current="page"]');
      const cur = await page.locator('.subnav [aria-current="page"]').getAttribute('data-tab');
      assert(tabs.includes(cur), `aba válida para preferência ${JSON.stringify(bad)} (obtido ${cur})`);
      if (bad === 'proximos') eq(cur, 'projecao', 'preferência legada convertida');
      eq(await page.locator('.section-error').count(), 0, `sem erro de seção para ${JSON.stringify(bad)}`);
    }
    await page.goto(`${base}#/planejamento/proximos`);
    await page.waitForSelector('.subnav [aria-current="page"][data-tab="projecao"]');
    for (const phase of ['vazio', 'com dados']) {
      if (phase === 'com dados') {
        await api(page, async (repo) => {
          await repo.saveTransaction({ type: 'income', status: 'done', amount: 300000, date: '2026-11-05', description: 'Salário' });
          await repo.saveRecurrence({ type: 'expense', description: 'Aluguel', amount: 120000, frequency: 'monthly', startDate: '2026-11-10' });
          await repo.createInstallmentPlan({ description: 'Notebook', total: 300000, count: 10, purchaseDate: '2026-11-03' });
          const c = (await repo.createNamed('categories', { name: 'Mercado', type: 'expense' }));
          await repo.saveBudget({ scope: 'category', refId: c.id, amount: 80000 });
        });
      }
      for (let round = 0; round < 2; round++) {
        for (const t of tabs) {
          await page.locator(`.subnav-link[data-tab="${t}"]`).click();
          await page.waitForSelector(`.subnav [aria-current="page"][data-tab="${t}"]`);
          eq(await page.locator('.section-error').count(), 0, `aba ${t} (${phase}) sem erro`);
        }
      }
      for (const t of ['calendario', 'orcamentos']) {
        await page.goto(`${base}#/planejamento/${t}`);
        await page.waitForSelector('.month-nav');
        for (let k = 0; k < 14; k++) await page.keyboard.press('ArrowRight'); // atravessa a virada de ano
        for (let k = 0; k < 3; k++) await page.keyboard.press('ArrowLeft');
        eq(await page.locator('.section-error').count(), 0, `troca de mês/ano em ${t}`);
      }
      await page.reload();
      await page.waitForSelector('.subnav [aria-current="page"]');
      eq(await page.locator('.subnav [aria-current="page"]').getAttribute('data-tab'), 'orcamentos', 'aba restaurada após recarregar');
    }
    await noErrors(page);
    await context.close();
  });

  await test('3.0 — Planejamento: organizar abas (ordem e ocultar) persiste; aba oculta continua acessível pelo endereço', async () => {
    const { context, page } = await newPage();
    await page.goto(`${base}#/planejamento/calendario`);
    await page.locator('.subnav-more').click();
    const m = page.locator('.modal', { hasText: 'Organizar abas do Planejamento' });
    await m.locator('.sortable-row', { hasText: 'Orçamentos' }).getByRole('button', { name: /para cima/ }).click();
    await m.locator('.sortable-row', { hasText: 'Simulações' }).locator('input[type=checkbox]').uncheck();
    await m.getByRole('button', { name: 'Salvar' }).click();
    await page.waitForTimeout(500);
    const order = await page.locator('.subnav-link').evaluateAll((els) => els.map((e) => e.dataset.tab));
    eq(order.includes('simulacoes'), false, 'aba oculta some do menu');
    assert(order.indexOf('orcamentos') < order.indexOf('parcelamentos'), `ordem salva: ${order}`);
    await page.reload();
    await page.waitForSelector('.subnav-link');
    eq(JSON.stringify(await page.locator('.subnav-link').evaluateAll((els) => els.map((e) => e.dataset.tab))), JSON.stringify(order), 'ordem persiste após recarregar');
    await page.goto(`${base}#/planejamento/simulacoes`);
    await page.waitForSelector('.subnav [aria-current="page"][data-tab="simulacoes"]');
    await noErrors(page);
    await context.close();
  });

  await test('3.0 — Repetir lançamento: Internet mensal em um único salvamento, sem duplicar após recarregar', async () => {
    const { context, page } = await newPage();
    const m = await openForm(page);
    await m.locator('input[name=amount]').fill('100');
    await m.locator('input[name=description]').fill('Internet');
    await m.locator('input[name=date]').fill('2026-11-15');
    await m.locator('select[name=repeat]').selectOption('monthly');
    await save(m);
    const check = async () => api(page, async (repo) => {
      const { summarize } = await import('./js/services/finance.js');
      const ctx = repo.context();
      const months = ['2026-11', '2026-12', '2027-01', '2027-06', '2027-10'];
      return { rules: repo.list('recurrences').filter((r) => r.description === 'Internet').length,
        perMonth: months.map((mm) => summarize(ctx, mm).items.filter((i) => i.description === 'Internet').length) };
    });
    const a = await check();
    eq(a.rules, 1, 'uma regra');
    eq(JSON.stringify(a.perMonth), '[1,1,1,1,1]', 'uma ocorrência por mês');
    await page.reload();
    await page.waitForSelector('[data-kpi]');
    eq(JSON.stringify(await check()), JSON.stringify(a), 'nada duplicado após recarregar');
    await noErrors(page);
    await context.close();
  });

  await test('3.0 — Recorrência: término inclusivo, quantidade, dia 31 preservado, pausa/retomada e conversão sem duplicar', async () => {
    const { context, page } = await newPage();
    const r = await api(page, async (repo) => {
      const { occurrences } = await import('./js/services/recurrence.js');
      const out = {};
      const a = await repo.createRecurrence({ type: 'expense', description: 'Fim', amount: 1000, frequency: 'monthly', startDate: '2026-11-10', endDate: '2027-02-10' });
      out.inclusive = occurrences(repo.get('recurrences', a.id), '2026-01-01', '2028-01-01');
      const b = await repo.createRecurrence({ type: 'expense', description: 'Qtd', amount: 1000, frequency: 'monthly', startDate: '2026-11-05', count: 3 });
      out.count = occurrences(repo.get('recurrences', b.id), '2026-01-01', '2028-01-01');
      const c = await repo.createRecurrence({ type: 'expense', description: 'D31', amount: 1000, frequency: 'monthly', startDate: '2027-01-31' });
      out.d31 = occurrences(repo.get('recurrences', c.id), '2027-01-01', '2027-05-31');
      const next = await repo.editSeriesFrom(c.id, '2027-03-31', { amount: 2000 });
      out.d31after = occurrences(repo.get('recurrences', next.id), '2027-03-01', '2027-06-30');
      await repo.pauseRecurrence(b.id, '2026-12-01');
      out.paused = occurrences(repo.get('recurrences', b.id), '2026-01-01', '2028-01-01');
      await repo.resumeRecurrence(b.id, '2027-01-01');
      out.resumed = occurrences(repo.get('recurrences', b.id), '2026-01-01', '2028-01-01');
      const tx = await repo.saveTransaction({ type: 'expense', status: 'done', amount: 5000, date: '2026-11-20', description: 'Academia' });
      const rule = await repo.convertToRecurring(tx.id, { frequency: 'monthly' });
      const { summarize } = await import('./js/services/finance.js');
      const ctx = repo.context();
      out.conv = ['2026-11', '2026-12'].map((mm) => summarize(ctx, mm).items.filter((i) => i.description === 'Academia').map((i) => i.status));
      out.convTx = repo.list('transactions').filter((t) => t.description === 'Academia').length;
      out.ruleStart = rule.startDate;
      return out;
    });
    eq(JSON.stringify(r.inclusive), JSON.stringify(['2026-11-10', '2026-12-10', '2027-01-10', '2027-02-10']), 'data final incluída');
    eq(JSON.stringify(r.count), JSON.stringify(['2026-11-05', '2026-12-05', '2027-01-05']), 'quantidade de repetições');
    eq(JSON.stringify(r.d31), JSON.stringify(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31']), 'dia 31 ajusta e volta');
    eq(JSON.stringify(r.d31after), JSON.stringify(['2027-03-31', '2027-04-30', '2027-05-31', '2027-06-30']), 'dia 31 preservado após editar a série');
    eq(JSON.stringify(r.paused), JSON.stringify(['2026-11-05']), 'pausa interrompe as próximas');
    eq(JSON.stringify(r.resumed), JSON.stringify(['2026-11-05', '2027-01-05']), 'retomada volta a projetar (dentro da quantidade)');
    eq(JSON.stringify(r.conv), JSON.stringify([['done'], ['planned']]), 'conversão: o original vira a 1ª ocorrência');
    eq(r.convTx, 1, 'nenhuma cópia criada na conversão');
    eq(r.ruleStart, '2026-11-20', 'regra começa na data do lançamento');
    await noErrors(page);
    await context.close();
  });

  await test('3.0 — Escopo de recorrência: editar "esta e as próximas" e excluir só uma ocorrência', async () => {
    const { context, page } = await newPage();
    await api(page, (repo) => repo.saveRecurrence({ type: 'expense', description: 'Streaming', amount: 3990, frequency: 'monthly', startDate: '2026-11-08' }));
    await page.keyboard.press('ArrowRight');
    await page.locator('.tx-row', { hasText: 'Streaming' }).locator('.tx-main').click();
    const m = page.locator('.entry-modal');
    await m.locator('input[name=amount]').fill('44,90');
    await m.locator('.modal-foot button[type=submit]').click();
    await page.locator('.scope-opt', { hasText: 'Esta e as próximas' }).click();
    await m.waitFor({ state: 'detached' });
    const amounts = await api(page, async (repo) => {
      const { summarize } = await import('./js/services/finance.js');
      const ctx = repo.context();
      return ['2026-11', '2026-12', '2027-01', '2027-05'].map((mm) => summarize(ctx, mm).items.filter((i) => i.description === 'Streaming').map((i) => i.amount)[0]);
    });
    eq(JSON.stringify(amounts), JSON.stringify([3990, 4490, 4490, 4490]), 'novembro mantém o valor antigo; dezembro em diante muda');
    await noErrors(page);
    await context.close();
  });

  await test('3.0 — Indicadores: detalhamento reconcilia com o cartão, navega em níveis e "Simular aporte" não cria lançamentos', async () => {
    const { context, page } = await newPage();
    await api(page, async (repo) => {
      const c = await repo.createNamed('accounts', { name: 'Conta', kind: 'checking' });
      await repo.saveTransaction({ type: 'income', status: 'done', amount: 500000, date: '2026-11-05', description: 'Salário', sourceId: c.id });
      await repo.saveTransaction({ type: 'income', status: 'planned', amount: 40000, date: '2026-11-28', description: 'Freela', sourceId: c.id });
      await repo.saveTransaction({ type: 'expense', status: 'done', amount: 123456, date: '2026-11-10', description: 'Aluguel', sourceId: c.id });
      await repo.saveTransaction({ type: 'expense', status: 'planned', amount: 20001, date: '2026-11-29', description: 'Luz', sourceId: c.id });
      await repo.setPrefs({ safetyMargin: 10000 });
    });
    await expectKpi(page, 'Sobra projetada', 'R$ 3.965,43');
    await page.locator('[data-kpi="surplus"]').click();
    const d = page.locator('.modal');
    await waitText(page, () => d.textContent().then(norm), /A soma dos componentes confere/);
    const val = async (label) => norm(await d.locator('.kv', { hasText: label }).first().locator('.kv-value').textContent());
    eq(await val('Receitas recebidas'), '+ R$ 5.000,00', 'receitas recebidas');
    eq(await val('Compromissos pendentes'), '− R$ 200,01', 'pendentes');
    assert((await d.locator('.note.is-warn').count()) === 0, 'nenhuma divergência');
    await d.locator('.kv-link', { hasText: 'Despesas realizadas' }).click();
    await waitText(page, () => d.locator('h2').textContent().then(norm), /^Despesas realizadas/);
    assert(await d.locator('.tx-row', { hasText: 'Aluguel' }).count() === 1, 'lista do componente');
    await d.getByRole('button', { name: 'Voltar', exact: true }).click();
    await waitText(page, () => d.locator('h2').textContent().then(norm), /^Sobra projetada/);
    await page.keyboard.press('Escape');
    await page.locator('[data-kpi="invest"]').click();
    await waitText(page, () => page.locator('.modal').textContent().then(norm), /Disponível para investirR\$ 3\.865,43/);
    const before = await api(page, (repo) => repo.list('transactions').length + repo.list('investmentEvents').length);
    await page.locator('.modal').getByRole('button', { name: 'Simular aporte' }).click();
    await page.waitForSelector('.page-head h1:text("Investimentos")');
    const after = await api(page, (repo) => repo.list('transactions').length + repo.list('investmentEvents').length);
    eq(after, before, 'simulação não registra movimentações');
    for (const k of ['inRec', 'inExp', 'exDone', 'exPend']) {
      await page.goto(`${base}#/visao-geral`);
      await page.locator(`[data-kpi="${k}"]`).click();
      await waitText(page, () => page.locator('.modal').textContent().then(norm), /A soma dos componentes confere/);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.modal', { state: 'detached' });
    }
    await noErrors(page);
    await context.close();
  });

  await test('3.0 — Personalizar: teclado, tamanho, ocultar, cor, visualização, desfazer e persistência após recarregar', async () => {
    const { context, page } = await newPage();
    await api(page, (repo) => repo.saveTransaction({ type: 'expense', status: 'done', amount: 4500, date: '2026-11-05', description: 'Mercado' }));
    await page.getByRole('button', { name: 'Personalizar' }).click();
    await page.waitForSelector('.wgrid.is-editing');
    const ids = () => page.locator('.wgrid .widget').evaluateAll((els) => els.map((e) => e.dataset.id));
    const before = await ids();
    const i = before.indexOf('dist-block');
    await page.locator('.widget[data-id="dist-block"] .widget-handle').focus();
    await page.keyboard.press('ArrowLeft');
    const moved = await ids();
    eq(moved.indexOf('dist-block'), i - 1, 'movido uma posição pelo teclado');
    const settings = async (id, item) => { await page.locator(`.widget[data-id="${id}"] .widget-settings`).click(); await page.locator('.menu-item', { hasText: item }).first().click(); };
    await settings('kpi-income-received', 'Médio');
    await settings('dist-category', 'Tabela resumida');
    await page.locator('.widget[data-id="insights"]').getByRole('button', { name: /^Ocultar/ }).click();
    eq(await page.locator('.wgrid .widget[data-id="insights"]').count(), 0, 'oculto sai da grade também no modo de edição');
    assert(await page.locator('.hidden-tray', { hasText: 'Leituras do mês' }).count() === 1, 'oculto aparece na bandeja');
    await settings('kpi-surplus', 'Cor de destaque');
    await page.locator('.menu-item', { hasText: 'Verde-azulado' }).click();
    // Desfazer a última alteração (cor), refazer e conferir o histórico.
    await page.locator('.edit-bar').getByRole('button', { name: 'Desfazer' }).click();
    eq(await page.locator('.widget[data-id="kpi-surplus"]').getAttribute('data-color'), null, 'desfazer volta a cor');
    await page.locator('.edit-bar').getByRole('button', { name: 'Refazer' }).click();
    eq(await page.locator('.widget[data-id="kpi-surplus"]').getAttribute('data-color'), 'custom', 'refazer reaplica a cor');
    await page.locator('.edit-bar').getByRole('button', { name: 'Concluir' }).click();
    await page.waitForSelector('.wgrid:not(.is-editing)');
    await page.waitForTimeout(500);
    const check = async () => {
      eq(await page.locator('.widget[data-id="insights"]').count(), 0, 'oculto fora da edição');
      assert(await page.locator('.widget[data-id="kpi-income-received"]').evaluate((e) => e.classList.contains('w-m')), 'tamanho médio');
      assert(await page.locator('.widget[data-id="dist-category"] table').count() === 1, 'visualização em tabela');
      eq(await page.locator('.widget[data-id="kpi-surplus"]').evaluate((e) => e.style.getPropertyValue('--w-accent')), 'var(--pal-teal)', 'cor da paleta');
      const order = await ids();
      assert(order.indexOf('dist-block') < order.indexOf('dist-category'), `ordem preservada: ${order}`);
    };
    await check();
    await page.reload();
    await page.waitForSelector('[data-kpi]');
    await check();
    await noErrors(page);
    await context.close();
  });

  await test('3.0 — Personalizar: arrastar com o mouse reordena (FLIP) e Esc cancela', async () => {
    const { context, page } = await newPage();
    await page.getByRole('button', { name: 'Personalizar' }).click();
    const ids = () => page.locator('.wgrid .widget').evaluateAll((els) => els.map((e) => e.dataset.id));
    const before = await ids();
    const h = await page.locator('.widget[data-id="dist-source"] .widget-handle').boundingBox();
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    // Acompanha o alvo a cada passo (como um usuário faria se a grade se rearranjar).
    for (let s = 1; s <= 12; s++) {
      const target = await page.locator('.widget[data-id="dist-category"]').boundingBox();
      await page.mouse.move(h.x + (target.x + 20 - h.x) * s / 12, h.y + (target.y + 30 - h.y) * s / 12);
    }
    await page.waitForTimeout(100);
    eq(await page.locator('.widget-placeholder').count(), 1, 'marcador de posição visível');
    await page.mouse.up();
    await page.waitForTimeout(400);
    const after = await ids();
    assert(after.indexOf('dist-source') < after.indexOf('dist-category'), `soltar antes do alvo: ${after}`);
    eq(after.length, before.length, 'nenhum componente duplicado ou perdido');
    eq(await page.locator('.widget.is-dragging, .widget-placeholder').count(), 0, 'estado de arraste limpo');
    // Esc cancela
    const h2 = await page.locator('.widget[data-id="upcoming"] .widget-handle').boundingBox();
    await page.mouse.move(h2.x + 5, h2.y + 5);
    await page.mouse.down();
    await page.mouse.move(h2.x - 300, h2.y - 200, { steps: 6 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForTimeout(400);
    eq(JSON.stringify(await ids()), JSON.stringify(after), 'Esc mantém a ordem');
    await noErrors(page);
    await context.close();
  });

  await test('3.0 — Personalização corrompida, de versão futura ou maliciosa não impede a abertura', async () => {
    const { context, page } = await newPage();
    const bad = [
      'lixo', 42, null, [], { version: 99, sections: { overview: { items: [] } } },
      { version: 1, sections: { overview: { items: [{ type: '__proto__' }, { type: 'nao-existe', size: 'enorme' }, 'texto', { type: 'kpi-surplus', size: 'zzz', color: 'javascript:alert(1)', chart: 'pizza3d' }, { type: 'kpi-surplus' }] } } },
      { version: 1, sections: { overview: { items: [{ type: 'dist-category', chart: 'donut', color: '#zzzzzz' }] }, planning: { options: { tabs: [{ id: 'xyz' }, { id: 'calendario', hidden: true }, null] } } } },
    ];
    for (const v of bad) {
      await api(page, (repo, val) => repo.setUiLayout(val), v);
      await page.reload();
      await page.waitForSelector('[data-kpi]');
      eq(await page.locator('.widget[data-id="kpi-surplus"]').count(), 1, `indicador presente com config ${JSON.stringify(v).slice(0, 40)}`);
      const n = await page.locator('.wgrid .widget').evaluateAll((els) => els.map((e) => e.dataset.id));
      eq(new Set(n).size, n.length, 'sem componentes duplicados');
      assert(!(await page.locator('.widget[data-id="kpi-surplus"]').evaluate((e) => e.style.getPropertyValue('--w-accent'))).includes('javascript'), 'cor inválida descartada');
      await page.goto(`${base}#/planejamento`);
      await page.waitForSelector('.subnav-link');
      await page.goto(`${base}#/visao-geral`);
    }
    eq(await page.evaluate(() => ({}).polluted), undefined, 'sem poluição de protótipo');
    await noErrors(page);
    await context.close();
  });

  await test('3.0 — Distribuição: rosca só sem negativos; com estorno maior que o gasto vira barras com aviso', async () => {
    const { context, page } = await newPage();
    await api(page, async (repo) => {
      const cat = await repo.createNamed('categories', { name: 'Eletrônicos', type: 'expense' });
      const cat2 = await repo.createNamed('categories', { name: 'Feira', type: 'expense' });
      await repo.saveTransaction({ type: 'expense', status: 'done', amount: 10000, date: '2026-11-03', description: 'Fone', categoryId: cat.id });
      await repo.saveTransaction({ type: 'expense', status: 'done', amount: 5000, date: '2026-11-04', description: 'Feira', categoryId: cat2.id });
      await repo.setUiLayout({ version: 1, sections: { overview: { items: [{ type: 'dist-category', chart: 'donut', size: 'm' }], known: [] } } });
    });
    await page.reload();
    await page.waitForSelector('.widget[data-id="dist-category"] .donut');
    const txt = norm(await page.locator('.widget[data-id="dist-category"]').textContent());
    assert(txt.includes('R$ 100,00') && txt.includes('R$ 50,00'), 'valores visíveis na legenda');
    await api(page, async (repo) => {
      const cat = repo.list('categories').find((c) => c.name === 'Eletrônicos');
      await repo.saveTransaction({ type: 'refund', status: 'done', amount: 25000, date: '2026-11-10', description: 'Estorno maior', categoryId: cat.id });
    });
    await page.waitForSelector('.widget[data-id="dist-category"] .bars');
    eq(await page.locator('.widget[data-id="dist-category"] .donut').count(), 0, 'rosca desativada com negativos');
    await waitText(page, () => page.locator('.widget[data-id="dist-category"]').textContent().then(norm), /rosca foi trocada por barras/);
    await noErrors(page);
    await context.close();
  });

  await test('3.0 — Lançamentos: tabela com colunas organizáveis, campos visíveis na lista e preferências persistentes', async () => {
    const { context, page } = await newPage();
    await api(page, async (repo) => {
      const b = await repo.createNamed('blocks', { name: 'Casa' });
      await repo.saveTransaction({ type: 'expense', status: 'done', amount: 4321, date: '2026-11-12', description: 'Lâmpada', blockId: b.id });
    });
    await page.goto(`${base}#/lancamentos`);
    await page.getByRole('button', { name: 'Exibição' }).click();
    const m = page.locator('.modal', { hasText: 'Exibição dos lançamentos' });
    await m.locator('label', { hasText: 'Bloco' }).locator('input').uncheck();
    await page.waitForTimeout(300);
    assert(!norm(await page.locator('.tx-row', { hasText: 'Lâmpada' }).locator('.tx-meta').textContent()).includes('Casa'), 'bloco oculto na lista');
    await m.getByRole('radio', { name: 'Tabela' }).click();
    await page.waitForSelector('.entries-table');
    await m.getByRole('button', { name: 'Organizar colunas…' }).click();
    const a = page.locator('.modal', { hasText: 'Colunas da tabela' });
    await a.locator('.sortable-row', { hasText: 'Situação' }).locator('input').uncheck();
    await a.locator('.sortable-row', { hasText: 'Valor' }).getByRole('button', { name: /para cima/ }).click();
    await a.getByRole('button', { name: 'Salvar' }).click();
    await page.waitForTimeout(500);
    const heads = async () => page.locator('.entries-table thead th').evaluateAll((els) => els.map((e) => e.textContent));
    const hs = await heads();
    eq(hs.includes('Situação'), false, 'coluna oculta');
    assert(hs.includes('Descrição') && hs.includes('Valor'), 'colunas obrigatórias sempre visíveis');
    await page.reload();
    await page.waitForSelector('.entries-table');
    eq(JSON.stringify(await heads()), JSON.stringify(hs), 'colunas persistem após recarregar');
    await page.locator('.entries-table tbody tr', { hasText: 'Lâmpada' }).click();
    await page.waitForSelector('.entry-modal');
    await noErrors(page);
    await context.close();
  });

  await test('3.0 — Configurações: densidade persiste, ordem dos grupos e “Restaurar toda a aparência” não toca nos dados', async () => {
    const { context, page } = await newPage();
    await api(page, (repo) => repo.saveTransaction({ type: 'expense', status: 'done', amount: 999, date: '2026-11-02', description: 'Café' }));
    await page.goto(`${base}#/configuracoes`);
    const fsDefault = await page.evaluate(() => getComputedStyle(document.body).fontSize);
    await page.getByRole('radio', { name: 'Compacta' }).click();
    eq(await page.evaluate(() => document.documentElement.dataset.density), 'compact', 'densidade aplicada');
    const fsCompact = await page.evaluate(() => getComputedStyle(document.body).fontSize);
    assert(parseFloat(fsCompact) < parseFloat(fsDefault), `texto menor (${fsCompact} < ${fsDefault})`);
    await page.reload();
    await page.waitForSelector('.settings-nav');
    eq(await page.evaluate(() => document.documentElement.dataset.density), 'compact', 'densidade após recarregar');
    eq(await page.evaluate(() => getComputedStyle(document.documentElement).zoom), '1', 'sem zoom');
    await page.getByRole('button', { name: 'Organizar' }).click();
    const m = page.locator('.modal', { hasText: 'Ordem dos grupos' });
    eq(await m.locator('input[type=checkbox]:not([disabled])').count(), 0, 'nenhum grupo pode ser ocultado');
    await m.locator('.sortable-row', { hasText: 'Dados e backup' }).getByRole('button', { name: /para cima/ }).click();
    await m.getByRole('button', { name: 'Salvar' }).click();
    await page.waitForTimeout(400);
    const groups = await page.locator('.settings-nav a').evaluateAll((els) => els.map((e) => e.dataset.group));
    assert(groups.indexOf('dados') < groups.indexOf('classificacao'), `grupo movido: ${groups}`);
    await page.locator('#cfg-personalizacao').getByRole('button', { name: 'Restaurar toda a aparência' }).click();
    await page.locator('.modal').getByRole('button', { name: 'Restaurar aparência' }).click();
    await waitText(page, '.toast', /Aparência restaurada/);
    eq(await page.evaluate(() => document.documentElement.dataset.density), 'default', 'densidade padrão');
    eq(await api(page, (repo) => repo.list('transactions').length), 1, 'dados financeiros intactos');
    await noErrors(page);
    await context.close();
  });

  await test('3.0 — Backup: nome do arquivo, metadados, checksum, personalização incluída e restaurada; adulterado é rejeitado', async () => {
    const a = await newPage();
    await api(a.page, async (repo) => {
      await repo.saveTransaction({ type: 'expense', status: 'done', amount: 1234, date: '2026-11-03', description: 'Pão' });
      await repo.setUiLayout({ version: 1, sections: { overview: { items: [{ type: 'insights', hidden: true }], known: ['insights'] } } });
    });
    await a.page.goto(`${base}#/configuracoes/dados`);
    const dl = await exportBackupUI(a.page);
    assert(/^Fluxo-backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()), `nome do arquivo: ${dl.suggestedFilename()}`);
    const file = join(ARTIFACTS, 'backup-v3.json');
    await dl.saveAs(file);
    const b = JSON.parse(await readFile(file, 'utf8'));
    eq(b.format, 'fluxo-backup', 'formato');
    eq(b.version, 3, 'versão do formato');
    assert(/^[0-9a-f]{64}$/.test(b.checksum?.value || ''), 'checksum SHA-256');
    eq(b.counts.transactions, 1, 'contagens no cabeçalho');
    assert(b.data.meta.some((m) => m.key === 'ui.layout'), 'personalização incluída');
    eq(await a.page.locator('.settings-row', { hasText: 'Último backup gerado' }).count() > 0, true, 'data do último backup exibida');
    await a.context.close();

    const t = await newPage();
    const tampered = structuredClone(b);
    tampered.data.transactions[0].amount = 1;
    const tf = join(ARTIFACTS, 'backup-adulterado.json');
    await writeFile(tf, JSON.stringify(tampered));
    await t.page.goto(`${base}#/configuracoes/dados`);
    const [ch] = await Promise.all([t.page.waitForEvent('filechooser'), t.page.getByRole('button', { name: 'Restaurar backup' }).click()]);
    await ch.setFiles(tf);
    await waitText(t.page, () => t.page.locator('.modal').textContent().then(norm), /Backup inválido.*(checksum|alterado|corrompido)/i);
    await t.page.getByRole('button', { name: 'Entendi' }).click();
    for (let k = 0; k < 2; k++) {
      const [c2] = await Promise.all([t.page.waitForEvent('filechooser'), t.page.getByRole('button', { name: 'Restaurar backup' }).click()]);
      await c2.setFiles(file);
      await t.page.waitForSelector('.modal', { hasText: 'Restaurar backup (arquivo)?' });
      await waitText(t.page, () => t.page.locator('.modal').textContent().then(norm), /SHA-256 conferido/);
      if (k === 1) eq(await t.page.locator('.modal label.check input').isChecked(), true, 'oferece backup prévio quando há dados');
      if (k === 1) await t.page.locator('.modal label.check input').uncheck();
      await t.page.getByRole('button', { name: 'Restaurar', exact: true }).click();
      await waitText(t.page, '.toast', /Backup restaurado/);
    }
    eq(await api(t.page, (repo) => repo.list('transactions').length), 1, 'restaurar duas vezes não duplica');
    const snaps = await api(t.page, async (repo) => (await repo.listSnapshots()).length);
    assert(snaps >= 1, 'snapshot interno do estado anterior');
    await t.page.goto(`${base}#/visao-geral`);
    await t.page.waitForSelector('[data-kpi]');
    eq(await t.page.locator('.widget[data-id="insights"]').count(), 0, 'personalização restaurada do backup');
    await noErrors(t.page);
    await t.context.close();
  });

  await test('3.0 — Backup protegido por senha: exporta, pede a senha, rejeita senha errada e restaura', async () => {
    const a = await newPage();
    await api(a.page, (repo) => repo.saveTransaction({ type: 'expense', status: 'done', amount: 777, date: '2026-11-03', description: 'Secreto' }));
    await a.page.goto(`${base}#/configuracoes/dados`);
    await a.page.getByRole('button', { name: 'Exportar backup completo' }).click();
    const m = a.page.locator('.modal', { hasText: 'Exportar backup completo' });
    await m.getByRole('radio', { name: 'Protegido por senha' }).click();
    await m.locator('input[type=password]').nth(0).fill('senha-forte-123');
    await m.locator('input[type=password]').nth(1).fill('senha-forte-123');
    const [dl] = await Promise.all([a.page.waitForEvent('download'), m.getByRole('button', { name: 'Gerar arquivo' }).click()]);
    const file = join(ARTIFACTS, 'backup-protegido.json');
    await dl.saveAs(file);
    const raw = await readFile(file, 'utf8');
    assert(!raw.includes('Secreto'), 'conteúdo não aparece em texto claro');
    eq(JSON.parse(raw).format, 'fluxo-backup-encrypted', 'envelope criptografado');
    await a.context.close();
    const b = await newPage();
    await b.page.goto(`${base}#/configuracoes/dados`);
    for (const [pw, ok] of [['errada-123', false], ['senha-forte-123', true]]) {
      const [ch] = await Promise.all([b.page.waitForEvent('filechooser'), b.page.getByRole('button', { name: 'Restaurar backup' }).click()]);
      await ch.setFiles(file);
      const pm = b.page.locator('.modal', { hasText: 'Backup protegido' });
      await pm.locator('input[type=password]').fill(pw);
      await pm.getByRole('button', { name: 'Abrir' }).click();
      if (!ok) { await waitText(b.page, () => b.page.locator('.modal').textContent().then(norm), /Senha incorreta/); await b.page.getByRole('button', { name: 'Entendi' }).click(); continue; }
      await b.page.waitForSelector('.modal', { hasText: 'Restaurar backup (arquivo)?' });
      await b.page.getByRole('button', { name: 'Restaurar', exact: true }).click();
      await waitText(b.page, '.toast', /Backup restaurado/);
    }
    eq(await api(b.page, (repo) => repo.list('transactions').map((t) => t.description).join()), 'Secreto', 'restaurado com a senha correta');
    await noErrors(b.page);
    await b.context.close();
  });

  await test('3.0 — Restauração interrompida no meio da gravação não altera a base (atomicidade)', async () => {
    const { context, page } = await newPage();
    await api(page, (repo) => repo.saveTransaction({ type: 'expense', status: 'done', amount: 100, date: '2026-11-03', description: 'Original' }));
    const res = await api(page, async (repo) => {
      const rows = Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, type: 'expense', status: 'done', amount: 100 + i, date: '2026-11-04', month: '2026-11', description: `Novo ${i}`, createdAt: 1, updatedAt: 1 }));
      const orig = IDBObjectStore.prototype.add;
      let n = 0;
      IDBObjectStore.prototype.add = function (...args) { if (++n === 30) throw new Error('falha simulada no meio da gravação'); return orig.apply(this, args); };
      let error = null;
      try { await repo.importData({ transactions: rows, meta: [] }); } catch (e) { error = e.message; }
      IDBObjectStore.prototype.add = orig;
      const { loadAll } = await import('./js/database/db.js');
      const disk = await loadAll();
      return { error, disk: disk.transactions.map((t) => t.description), mem: repo.list('transactions').map((t) => t.description) };
    });
    assert(res.error, 'erro informado');
    eq(JSON.stringify(res.disk), '["Original"]', 'banco intacto');
    eq(JSON.stringify(res.mem), '["Original"]', 'memória intacta');
    page.errors = page.errors.filter((e) => !/falha simulada/.test(e));
    await noErrors(page);
    await context.close();
  });

  await test('3.0 — Concorrência: edição em outra aba gera conflito (sem sobrescrita silenciosa) e a restauração avisa as abas', async () => {
    const { context, page } = await newPage();
    const tx = await api(page, (repo) => repo.saveTransaction({ type: 'expense', status: 'done', amount: 1000, date: '2026-11-03', description: 'Compartilhado' }));
    const other = await context.newPage();
    other.errors = [];
    other.on('pageerror', (e) => other.errors.push(e.message));
    await other.goto(base);
    await other.waitForSelector('[data-kpi]');
    await api(other, (repo, id) => repo.saveTransaction({ ...repo.get('transactions', id), amount: 2000 }, { baseRev: repo.get('transactions', id).rev || 0 }), tx.id);
    const r = await api(page, async (repo, t) => {
      try { await repo.saveTransaction({ ...t, amount: 3000 }, { baseRev: t.rev || 0 }); return 'gravou'; } catch (e) { return e.name + ': ' + e.message; }
    }, tx);
    assert(/Conflict|alterad/i.test(r), `conflito detectado (${r})`);
    await waitText(page, async () => String(await api(page, (repo, id) => repo.get('transactions', id).amount, tx.id)), '2000');
    // Restauração em uma aba recarrega os dados na outra.
    await api(other, (repo) => repo.importData({ transactions: [{ id: 'z', type: 'expense', status: 'done', amount: 5, date: '2026-11-01', month: '2026-11', description: 'Restaurado', createdAt: 1, updatedAt: 1 }], meta: [] }));
    await waitText(page, async () => String(await api(page, (repo) => repo.list('transactions').map((t) => t.description).join())), 'Restaurado');
    eq(other.errors.length, 0, 'sem erros na outra aba');
    await noErrors(page);
    await context.close();
  });

  await test('3.0 — Apagar dados financeiros mantém a aparência e guarda snapshot', async () => {
    const { context, page } = await newPage();
    await api(page, async (repo) => {
      await repo.saveTransaction({ type: 'expense', status: 'done', amount: 1000, date: '2026-11-03', description: 'X' });
      await repo.setUiLayout({ version: 1, sections: { overview: { items: [{ type: 'insights', hidden: true }], known: ['insights'] } } });
      await repo.wipeAll();
    });
    const st = await api(page, async (repo) => ({ tx: repo.list('transactions').length, layout: Boolean(repo.get('meta', 'ui.layout')), snaps: (await repo.listSnapshots()).length }));
    eq(st.tx, 0, 'lançamentos apagados');
    eq(st.layout, true, 'personalização mantida');
    assert(st.snaps >= 1, 'snapshot interno');
    await noErrors(page);
    await context.close();
  });

  await test('3.0 — Segurança: CSP sem violações em todas as seções; entradas hostis tratadas como texto; arquivo com __proto__ rejeitado', async () => {
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
    await context.clock.setFixedTime(NOW);
    await context.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)); });
    const page = await context.newPage();
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message));
    await page.goto(base);
    await page.waitForSelector('[data-kpi]');
    const hostile = ['<script>window.__x=1</script>', '<img src=x onerror="window.__x=1">', 'javascript:window.__x=1', '"><svg onload=window.__x=1>', '{{constructor.constructor("window.__x=1")()}}', 'A'.repeat(5000), '🚀 ção ñ € ‮texto'];
    await api(page, async (repo, list) => {
      for (const d of list) await repo.saveTransaction({ type: 'expense', status: 'done', amount: 100, date: '2026-11-03', description: d });
      await repo.createNamed('categories', { name: '<b onmouseover=alert(1)>cat</b>', type: 'expense' });
    }, hostile);
    const lens = await api(page, (repo) => repo.list('transactions').map((t) => t.description.length));
    assert(Math.max(...lens) <= 200, 'textos longos limitados');
    for (const r of ['visao-geral', 'lancamentos', 'planejamento/calendario', 'planejamento/projecao', 'planejamento/simulacoes', 'planejamento/recorrencias', 'planejamento/programadas', 'planejamento/parcelamentos', 'planejamento/orcamentos', 'investimentos', 'configuracoes']) {
      await page.goto(`${base}#/${r}`);
      await page.waitForSelector('.page-head');
      await page.waitForTimeout(150);
    }
    await page.goto(`${base}#/lancamentos`);
    await page.getByRole('button', { name: 'Exibição' }).click();
    await page.getByRole('radio', { name: 'Tabela' }).click();
    await page.keyboard.press('Escape');
    eq(await page.evaluate(() => window.__x), undefined, 'nenhum script do usuário executado');
    eq(await page.locator('.view script, .view img[src=x], .view svg[onload]').count(), 0, 'nenhum elemento injetado');
    const evil = join(ARTIFACTS, 'backup-proto.json');
    await writeFile(evil, '{"format":"guia-financeiro-backup","version":1,"data":{"transactions":[{"id":"a","type":"expense","status":"done","amount":1,"date":"2026-11-01","month":"2026-11","description":"x","__proto__":{"polluted":true}}],"meta":[]}}');
    await page.goto(`${base}#/configuracoes/dados`);
    const [ch] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Restaurar backup' }).click()]);
    await ch.setFiles(evil);
    await page.waitForSelector('.modal', { hasText: 'Backup inválido' });
    await waitText(page, () => page.locator('.modal').textContent().then(norm), /chave não permitida: __proto__/);
    eq(await page.evaluate(() => ({}).polluted), undefined, 'protótipo não poluído');
    eq(JSON.stringify(await page.evaluate(() => window.__csp)), '[]', 'sem violações de CSP');
    eq(page.errors.length, 0, `erros: ${page.errors.join(' | ')}`);
    await context.close();
  });

  await test('3.0 — Publicação em /Fluxo/ (repositório renomeado): todas as seções abrem sem erros', async () => {
    const alt = await startServer({ base: '/Fluxo/' });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
    await context.clock.setFixedTime(NOW);
    const page = await context.newPage();
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message));
    page.on('response', (r) => { if (r.status() >= 400) page.errors.push(`HTTP ${r.status()} ${r.url()}`); });
    for (const r of ['visao-geral', 'lancamentos', 'planejamento', 'investimentos', 'configuracoes/sobre']) {
      await page.goto(`${alt.url}#/${r}`);
      await page.waitForSelector('.page-head');
    }
    const man = await page.evaluate(async () => (await fetch('manifest.webmanifest')).json());
    eq(man.start_url, './', 'manifest relativo');
    eq(await page.evaluate(() => document.querySelector('.about-brand img')?.naturalWidth > 0), true, 'símbolo carregado');
    eq(page.errors.length, 0, `erros: ${page.errors.join(' | ')}`);
    await context.close();
    alt.server.close();
  });

  await test('3.0 — Movimento reduzido e densidades em celular: personalização e detalhamento funcionam sem rolagem horizontal', async () => {
    for (const density of ['compact', 'comfortable']) {
      const { context, page } = await newPage({ ...devices['iPhone 13'], reducedMotion: 'reduce' });
      await page.evaluate((d) => localStorage.setItem('gf.density', d), density);
      await page.reload();
      await page.waitForSelector('[data-kpi]');
      eq(await page.evaluate(() => document.documentElement.dataset.density), density, 'densidade aplicada no carregamento');
      await page.locator('[data-kpi="surplus"]').click();
      await page.waitForSelector('.modal');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Personalizar' }).click();
      await page.waitForSelector('.wgrid.is-editing');
      for (const r of ['visao-geral', 'lancamentos', 'planejamento/calendario', 'investimentos', 'configuracoes']) {
        if (r !== 'visao-geral') { await page.goto(`${base}#/${r}`); await page.waitForSelector('.page-head'); }
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert(over <= 1, `rolagem horizontal em ${r} (${density}): ${over}px`);
      }
      await noErrors(page);
      await context.close();
    }
  });

  // ——————————————————— Fluxo 3.1 ———————————————————
  const sumOf = (page, month) => api(page, async (repo, m) => { const { summarize } = await import('./js/services/finance.js'); const s = summarize(repo.context(), m); return { done: s.expenseDone, pending: s.expensePending, total: s.expenseTotal, left: s.forecastLeft }; }, month);
  async function createRepeat(page, { amount, description, date, preset = 'monthly', mode, perMonth, days, end, source }) {
    const m = await openForm(page);
    await m.locator('input[name=amount]').fill(amount);
    await m.locator('input[name=description]').fill(description);
    await m.locator('input[name=date]').fill(date);
    if (source) await pick(m, 'source', source);
    await m.locator('select[name=repeat]').selectOption(preset);
    if (mode) await m.locator(`.mode-opt[data-mode="${mode}"]`).click();
    if (perMonth) await m.locator('input[name=repeatPerMonth]').fill(perMonth);
    if (days) await m.locator('input[name=repeatDays]').fill(days);
    if (end) { await m.locator('.repeat-options summary').click(); await m.locator('input[name=repeatEnd]').fill(end); }
    await save(m);
  }

  await test('3.1 — Cenário 1: psicóloga com datas flexíveis (pagar, concluir e dezembro independente)', async () => {
    const { context, page } = await newPage();
    await createRepeat(page, { amount: '50', description: 'Psicóloga', date: '2026-11-04', mode: 'flex', perMonth: '2' });
    await page.goto(`${base}#/planejamento/compromissos`);
    const card = page.locator('.commit', { hasText: 'Psicóloga' });
    await card.waitFor();
    // 1ª consulta veio paga do formulário (04/11 já passou); define a 2ª para 18/11.
    await card.locator('.occ-row').nth(1).locator('input.occ-date').fill('2026-11-18');
    await card.locator('.occ-row').nth(1).locator('input.occ-date').dispatchEvent('change');
    await waitText(page, async () => JSON.stringify(await sumOf(page, '2026-11')), JSON.stringify({ done: 5000, pending: 5000, total: 10000, left: 0 }));
    await waitText(page, () => card.locator('.commit-progress').textContent().then(norm), /^1 de 2 paga/);
    await card.locator('.occ-row').nth(1).locator('.occ-check').click();
    await waitText(page, async () => String(await page.locator('.commit.is-done', { hasText: 'Psicóloga' }).count()), '1');
    eq(JSON.stringify(await sumOf(page, '2026-11')), JSON.stringify({ done: 10000, pending: 0, total: 10000, left: 0 }), 'novembro concluído');
    await page.keyboard.press('ArrowRight');
    const dec = page.locator('.commit', { hasText: 'Psicóloga' });
    await waitText(page, () => dec.locator('.commit-progress').textContent().then(norm), /^0 de 2/);
    eq(await dec.locator('.pill', { hasText: 'Data a definir' }).count(), 2, 'dezembro: duas consultas sem data inventada');
    eq(JSON.stringify(await sumOf(page, '2026-12')), JSON.stringify({ done: 0, pending: 10000, total: 10000, left: 0 }), 'dezembro previsto');
    eq(await api(page, (repo) => repo.list('transactions').length), 2, 'nenhum lançamento extra criado');
    await noErrors(page);
    await context.close();
  });

  await test('3.1 — Cenário 2: a cada 14 dias gera 3 ocorrências em dezembro (R$ 150)', async () => {
    const { context, page } = await newPage();
    await createRepeat(page, { amount: '50', description: 'Consulta', date: '2026-11-04', preset: 'biweekly' });
    const dates = await api(page, async (repo) => { const { ruleOccurrences } = await import('./js/services/recurrence.js'); return ruleOccurrences(repo.list('recurrences')[0], '2026-11-01', '2027-01-15').map((o) => o.date); });
    eq(JSON.stringify(dates), JSON.stringify(['2026-11-04', '2026-11-18', '2026-12-02', '2026-12-16', '2026-12-30', '2027-01-13']), 'datas reais de 14 em 14 dias');
    eq((await sumOf(page, '2026-12')).total, 15000, 'dezembro com três ocorrências');
    eq((await sumOf(page, '2026-11')).total, 10000, 'novembro com duas');
    await noErrors(page);
    await context.close();
  });

  await test('3.1 — Cenário 3: recorrência independe da fonte (Pix, dinheiro, débito, cartão) e da fonte definida depois', async () => {
    const { context, page } = await newPage();
    const r = await api(page, async (repo) => {
      const conta = await repo.createNamed('accounts', { name: 'Conta', kind: 'checking' });
      const dinheiro = await repo.createNamed('accounts', { name: 'Dinheiro', kind: 'cash' });
      const cartao = await repo.createNamed('accounts', { name: 'Cartão', kind: 'credit', closingDay: 3, dueDay: 10 });
      const base = { type: 'expense', amount: 1000, frequency: 'monthly', startDate: '2026-11-15' };
      await repo.createRecurrence({ ...base, description: 'Pix', sourceId: conta.id, method: 'pix' });
      await repo.createRecurrence({ ...base, description: 'Dinheiro', sourceId: dinheiro.id });
      await repo.createRecurrence({ ...base, description: 'Débito', sourceId: conta.id, method: 'debit' });
      await repo.createRecurrence({ ...base, description: 'Cartão', sourceId: cartao.id });
      await repo.createRecurrence({ ...base, description: 'A definir', sourceId: null });
      const { summarize } = await import('./js/services/finance.js');
      const s = summarize(repo.context(), '2026-12');
      return { rules: repo.list('recurrences').length, total: s.expenseTotal, bills: s.cardBills.map((b) => b.total) };
    });
    eq(r.rules, 5, 'todas criadas');
    eq(r.total, 5000, 'dezembro: 4 diretas + compra de 15/11 no cartão (fatura de dezembro)');
    eq(JSON.stringify(r.bills), '[1000]', 'compra no cartão vai para a fatura, não para o caixa');
    // Fonte definida no pagamento.
    await page.goto(`${base}#/planejamento/compromissos`);
    await page.keyboard.press('ArrowRight');
    const row = page.locator('.commit', { hasText: 'A definir' }).locator('.occ-row').first();
    await row.locator('button[aria-haspopup="menu"]').click();
    await page.locator('.menu-item', { hasText: 'Confirmar pagamento…' }).click();
    const d = page.locator('.pay-modal');
    await d.locator('select[name=paySource]').selectOption({ label: 'Dinheiro' });
    await d.getByRole('button', { name: 'Confirmar pagamento' }).click();
    await waitText(page, '.toast', /pago/);
    const tx = await api(page, (repo) => repo.list('transactions').find((t) => t.description === 'A definir'));
    eq(tx.status, 'done', 'pago');
    eq(Boolean(tx.sourceId), true, 'fonte gravada no pagamento');
    await noErrors(page);
    await context.close();
  });

  await test('3.1 — Cenário 4: alterar a data de uma ocorrência flexível não duplica', async () => {
    const { context, page } = await newPage();
    await api(page, (repo) => repo.createRecurrence({ type: 'expense', description: 'Fisio', amount: 8000, frequency: 'monthly', mode: 'flex', perPeriod: 2, startDate: '2026-12-01' }));
    await page.goto(`${base}#/planejamento/compromissos`);
    await page.keyboard.press('ArrowRight');
    const input = page.locator('.commit', { hasText: 'Fisio' }).locator('.occ-row').first().locator('input.occ-date');
    await input.fill('2026-12-10'); await input.dispatchEvent('change');
    await waitText(page, async () => String(await api(page, (repo) => repo.list('transactions').length)), '1');
    const again = page.locator('.commit', { hasText: 'Fisio' }).locator('.occ-row').first().locator('input.occ-date');
    await again.fill('2026-12-15'); await again.dispatchEvent('change');
    await waitText(page, async () => JSON.stringify(await api(page, (repo) => repo.list('transactions').map((t) => [t.date, t.occurrenceKey]))), JSON.stringify([['2026-12-15', '2026-12#1']]));
    eq((await sumOf(page, '2026-12')).total, 16000, 'continua R$ 160 no mês');
    // Regressão: duas gravações simultâneas na mesma aba não podem ser recusadas como conflito.
    const both = await api(page, async (repo) => {
      const rule = repo.list('recurrences')[0];
      await Promise.all([repo.setOccurrenceDate(rule.id, '2026-12#2', '2026-12-05'), repo.setOccurrenceDate(rule.id, '2026-12#2', '2026-12-06')]);
      return repo.list('transactions').filter((x) => x.occurrenceKey === '2026-12#2').map((x) => x.date);
    });
    eq(JSON.stringify(both), '["2026-12-06"]', 'última gravação vence, sem duplicar nem falhar');
    await noErrors(page);
    await context.close();
  });

  await test('3.1 — Cenário 5: transformar lançamento existente em recorrente mantém o registro único', async () => {
    const { context, page } = await newPage();
    await api(page, (repo) => repo.saveTransaction({ id: 'c1', type: 'expense', status: 'done', amount: 5000, date: '2026-11-04', description: 'Consulta' }));
    await page.locator('.tx-row', { hasText: 'Consulta' }).locator('.tx-more').click();
    await page.locator('.menu-item', { hasText: 'Transformar em recorrente' }).click();
    const m = page.locator('.modal', { hasText: 'Transformar em recorrente' });
    await m.locator('.mode-opt[data-mode="flex"]').click();
    await m.locator('input[name=repeatPerMonth]').fill('2');
    await m.getByRole('button', { name: 'Transformar' }).click();
    await waitText(page, '.toast', /recorrente/);
    const r = await api(page, (repo) => ({ tx: repo.list('transactions').map((t) => [t.id, t.occurrenceKey, t.status]), rule: repo.list('recurrences').map((x) => [x.mode, x.perPeriod]) }));
    eq(JSON.stringify(r.tx), JSON.stringify([['c1', '2026-11#1', 'done']]), 'o original vira a 1ª ocorrência');
    eq(JSON.stringify(r.rule), JSON.stringify([['flex', 2]]), 'regra flexível');
    eq(JSON.stringify(await sumOf(page, '2026-11')), JSON.stringify({ done: 5000, pending: 5000, total: 10000, left: 0 }), 'sem cópia do original');
    await noErrors(page);
    await context.close();
  });

  await test('3.1 — Cenário 6: replicar para três meses específicos (previstas, sem herdar o pago)', async () => {
    const { context, page } = await newPage();
    await api(page, (repo) => repo.saveTransaction({ id: 'r0', type: 'expense', status: 'done', amount: 12000, date: '2026-11-08', description: 'Manutenção' }));
    await page.locator('.tx-row', { hasText: 'Manutenção' }).locator('.tx-more').click();
    await page.locator('.menu-item', { hasText: 'Replicar para outros meses' }).click();
    const m = page.locator('.replicate-modal');
    for (const mm of ['2027-01', '2027-03', '2027-05']) await m.locator(`.month-pick[data-month="${mm}"]`).click();
    await waitText(page, () => m.locator('.replicate-summary').textContent().then(norm), /3 lançamentos previstos serão criados/);
    await m.getByRole('button', { name: 'Replicar' }).dblclick();
    await waitText(page, '.toast', /3 cópias/);
    const rows = await api(page, (repo) => repo.list('transactions').filter((t) => t.id !== 'r0').map((t) => [t.month, t.date, t.status]).sort());
    eq(JSON.stringify(rows), JSON.stringify([['2027-01', '2027-01-08', 'planned'], ['2027-03', '2027-03-08', 'planned'], ['2027-05', '2027-05-08', 'planned']]), 'somente os meses escolhidos, como previstas');
    await noErrors(page);
    await context.close();
  });

  await test('3.1 — Cenário 7: previsão de combustível consome R$ 300, resta R$ 100; R$ 150 a mais gera excedente de R$ 50', async () => {
    const { context, page } = await newPage();
    await createRepeat(page, { amount: '400', description: 'Combustível', date: '2026-11-01', mode: 'forecast' });
    await page.goto(`${base}#/planejamento/compromissos`);
    for (const [v, d] of [['100', '2026-11-04'], ['80', '2026-11-11'], ['120', '2026-11-19']]) {
      await page.locator('.commit.is-forecast').getByRole('button', { name: 'Registrar gasto' }).click();
      const m = page.locator('.entry-modal');
      await m.locator('input[name=amount]').fill(v);
      await m.locator('input[name=date]').fill(d);
      eq(await m.locator('select[name=forecast] option:checked').textContent().then((x) => x.startsWith('Combustível')), true, 'vinculado à previsão');
      await m.locator('.modal-foot button[type=submit]').click();
      const similar = page.locator('.entry-modal .banner-warn');
      if (await similar.isVisible().catch(() => false)) await similar.getByRole('button', { name: 'Registrar mesmo assim' }).click();
      await m.waitFor({ state: 'detached' });
    }
    eq(JSON.stringify(await sumOf(page, '2026-11')), JSON.stringify({ done: 30000, pending: 0, total: 40000, left: 10000 }), 'R$ 300 realizado + R$ 100 restante (não R$ 700)');
    await api(page, (repo) => repo.saveTransaction({ type: 'expense', status: 'done', amount: 15000, date: '2026-11-24', description: 'Combustível', forecastId: repo.list('recurrences')[0].id }));
    eq(JSON.stringify(await sumOf(page, '2026-11')), JSON.stringify({ done: 45000, pending: 0, total: 45000, left: 0 }), 'realizado R$ 450');
    await waitText(page, () => page.locator('.commit.is-forecast').textContent().then(norm), /R\$ 50,00 acima do previsto/);
    await page.locator('.commit.is-forecast').getByRole('button', { name: 'Encerrar mês' }).click().catch(() => {});
    await noErrors(page);
    await context.close();
  });

  await test('3.1 — Cenário 8: data final pelo formulário — nada fora do intervalo', async () => {
    const { context, page } = await newPage();
    await createRepeat(page, { amount: '30', description: 'Curso', date: '2026-11-29', mode: 'days', days: '29, 31', end: '2027-02-28' });
    const occ = await api(page, async (repo) => { const { ruleOccurrences } = await import('./js/services/recurrence.js'); return ruleOccurrences(repo.list('recurrences')[0], '2026-01-01', '2028-12-31').map((o) => o.date); });
    eq(JSON.stringify(occ), JSON.stringify(['2026-11-29', '2026-11-30', '2026-12-29', '2026-12-31', '2027-01-29', '2027-01-31', '2027-02-28', '2027-02-28']), 'dias 29 e 31, fevereiro curto, termina em 28/02');
    eq((await sumOf(page, '2027-03')).total, 0, 'nada depois do fim');
    await noErrors(page);
    await context.close();
  });

  await test('3.1 — Cenários 9/10/11: grade sem sobreposição, organizar automaticamente, ocultos fora da grade e formatos persistentes', async () => {
    const { context, page } = await newPage();
    await api(page, (repo) => repo.saveTransaction({ type: 'expense', status: 'done', amount: 4500, date: '2026-11-05', description: 'Mercado' }));
    await page.getByRole('button', { name: 'Personalizar' }).click();
    const settings = async (id, item) => { await page.locator(`.widget[data-id="${id}"] .widget-settings`).click(); await page.locator('.menu-item', { hasText: item }).first().click(); };
    await settings('kpi-surplus', 'Pequeno');
    await settings('kpi-invest', 'Comparação com o mês anterior');
    await settings('movements', 'Metade');
    await settings('dist-category', 'Rosca');
    await page.locator('.edit-bar').getByRole('button', { name: 'Organizar automaticamente' }).click();
    await page.waitForTimeout(400);
    const overlap = await page.evaluate(() => {
      const rs = [...document.querySelectorAll('.wgrid .widget')].map((e) => ({ id: e.dataset.id, r: e.getBoundingClientRect() }));
      const hits = [];
      for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i].r, b = rs[j].r;
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) hits.push(`${rs[i].id}×${rs[j].id}`);
      }
      return hits;
    });
    eq(JSON.stringify(overlap), '[]', 'nenhum componente sobreposto');
    await page.locator('.widget[data-id="signals"]').getByRole('button', { name: /^Ocultar/ }).click();
    eq(await page.locator('.wgrid .widget[data-id="signals"]').count(), 0, 'oculto não ocupa espaço');
    await page.locator('.edit-bar').getByRole('button', { name: 'Componentes' }).click();
    await page.locator('.lib-row', { hasText: 'Atenção' }).getByRole('button', { name: 'Adicionar' }).click();
    await page.waitForSelector('.wgrid .widget[data-id="signals"]');
    await page.locator('.edit-bar').getByRole('button', { name: 'Concluir' }).click();
    await page.waitForTimeout(500);
    for (let k = 0; k < 2; k++) {
      if (k) { await page.reload(); await page.waitForSelector('[data-kpi]'); }
      assert(await page.locator('.widget[data-id="kpi-surplus"]').evaluate((e) => e.classList.contains('w-s')), 'tamanho pequeno preservado');
      assert(await page.locator('.widget[data-id="kpi-invest"] .kpi-compare, .widget[data-id="kpi-invest"] .kpi-sub').count() > 0, 'formato de comparação');
      assert(await page.locator('.widget[data-id="dist-category"] .donut').count() === 1, 'rosca preservada');
    }
    // Trocar de mês, de seção e de tema não muda a organização.
    await page.keyboard.press('ArrowRight');
    await page.goto(`${base}#/lancamentos`); await page.goto(`${base}#/visao-geral`);
    await page.waitForSelector('[data-kpi]');
    assert(await page.locator('.widget[data-id="kpi-surplus"]').evaluate((e) => e.classList.contains('w-s')), 'após navegar');
    await noErrors(page);
    await context.close();
  });

  await test('3.1 — Personalização no celular é guardada à parte e não altera o desktop', async () => {
    const { context, page } = await newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload(); await page.waitForSelector('[data-kpi]');
    await page.getByRole('button', { name: 'Personalizar' }).click();
    await page.locator('.widget[data-id="insights"]').getByRole('button', { name: /^Ocultar/ }).click();
    await page.locator('.edit-bar').getByRole('button', { name: 'Concluir' }).click();
    await page.waitForTimeout(500);
    const keys = await api(page, (repo) => Object.keys(repo.get('meta', 'ui.layout')?.value?.sections || {}));
    eq(JSON.stringify(keys), JSON.stringify(['overview@m']), 'perfil do celular');
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.reload(); await page.waitForSelector('[data-kpi]');
    eq(await page.locator('.widget[data-id="insights"]').count(), 1, 'desktop intacto');
    await noErrors(page);
    await context.close();
  });

  await test('3.1 — Cenários 12/13/14/15: calculadora percentual, dinâmica, estática e referência inválida', async () => {
    const { context, page } = await newPage();
    await api(page, async (repo) => {
      await repo.saveTransaction({ id: 'inc', type: 'income', status: 'done', amount: 300000, date: '2026-11-05', description: 'Salário' });
      await repo.saveTransaction({ id: 'exp', type: 'expense', status: 'done', amount: 210000, date: '2026-11-06', description: 'Aluguel' });
      await repo.saveGoal({ id: 'g1', name: 'Moto', target: 800000, initial: 0, monthly: 0, startMonth: '2026-11' });
    });
    await page.keyboard.press('c');
    await page.waitForSelector('.calc.is-open');
    const expr = page.locator('.calc-expr');
    const res = () => page.locator('.calc-result').textContent();
    for (const [e, v] of [['10% de 800', '80'], ['800 + 10%', '880'], ['800 − 10%', '720'], ['200 / 800 * 100', '25']]) { await expr.fill(e); eq(await res(), v, e); }
    await expr.fill('5 / 0'); await expr.press('Enter');
    await waitText(page, '.calc-error', 'Divisão por zero');
    // Dinâmico: 70% da sobra projetada.
    await expr.fill('');
    await page.locator('.calc-flux').click();
    await page.locator('.calc-ref-modal select[aria-label="Informação"]').selectOption('projectedSurplus');
    await page.locator('.calc-ref-modal').getByRole('button', { name: 'Inserir' }).click();
    await expr.press('End'); await expr.type(' × 70%');
    eq(await res(), '630', 'R$ 900 × 70%');
    await page.locator('.calc').getByRole('button', { name: 'Salvar' }).click();
    await page.locator('input[name=calcName]').fill('Reserva dinâmica');
    await page.locator('.modal').getByRole('button', { name: 'Salvar' }).click();
    await page.waitForSelector('input[name=calcName]', { state: 'detached' });
    await page.waitForSelector('.calc-saved-row');
    // Estático: 70% de 900.
    await page.locator('.calc-tab', { hasText: 'Calcular' }).click();
    await expr.fill('70% de 900');
    await page.locator('.calc').getByRole('button', { name: 'Salvar' }).click();
    await page.locator('input[name=calcName]').fill('Reserva estática');
    await page.locator('.modal').getByRole('button', { name: 'Salvar' }).click();
    await page.waitForSelector('input[name=calcName]', { state: 'detached' });
    await page.waitForSelector('.calc-saved-row >> nth=1');
    // Dinâmico com meta que depois é excluída.
    await page.locator('.calc-tab', { hasText: 'Calcular' }).click();
    await expr.fill('');
    await page.locator('.calc-flux').click();
    await page.locator('.calc-ref-modal select[aria-label="Informação"]').selectOption('goalTarget');
    await page.locator('.calc-ref-modal').getByRole('button', { name: 'Inserir' }).click();
    await expr.press('End'); await expr.type(' ÷ 12');
    await page.locator('.calc').getByRole('button', { name: 'Salvar' }).click();
    await page.locator('input[name=calcName]').fill('Parcela da meta');
    await page.locator('.modal').getByRole('button', { name: 'Salvar' }).click();
    await page.waitForSelector('input[name=calcName]', { state: 'detached' });
    await page.waitForSelector('.calc-saved-row >> nth=2');
    const before = await api(page, (repo) => JSON.stringify(repo.list('transactions')));
    await api(page, async (repo) => { await repo.saveTransaction({ ...repo.get('transactions', 'exp'), amount: 180000 }); await repo.deleteGoal('g1'); });
    const row = (n) => page.locator('.calc-saved-row', { hasText: n });
    await waitText(page, () => row('Reserva dinâmica').locator('.calc-saved-value').textContent(), '840');
    eq(await row('Reserva estática').locator('.calc-saved-value').textContent(), '630', 'estático não muda');
    await waitText(page, () => row('Parcela da meta').textContent().then(norm), /Indisponível: .*Nenhum valor foi substituído por zero/);
    eq(await row('Parcela da meta').locator('.calc-saved-value').textContent(), '—', 'sem resultado enganoso');
    const after = await api(page, (repo) => JSON.stringify(repo.list('transactions').map((t) => ({ ...t, amount: t.id === 'exp' ? 210000 : t.amount, rev: 0, updatedAt: 0 }))));
    eq(JSON.parse(after).length, JSON.parse(before).length, 'calculadora não criou nem alterou lançamentos');
    eq(await api(page, (repo) => repo.list('calculations').length), 3, 'cálculos salvos no IndexedDB');
    await noErrors(page);
    await context.close();
  });

  await test('3.1 — Cenário 16: duas abas pagando a mesma ocorrência não duplicam (id estável + índice único)', async () => {
    const { context, page } = await newPage();
    await api(page, (repo) => repo.createRecurrence({ id: 'net', type: 'expense', description: 'Internet', amount: 10000, frequency: 'monthly', startDate: '2026-11-10' }));
    const other = await context.newPage();
    other.errors = [];
    await other.goto(base); await other.waitForSelector('[data-kpi]');
    const pay = (pg) => api(pg, async (repo) => {
      const { virtualItems } = await import('./js/services/finance.js');
      const v = virtualItems(repo.context(), '2026-11').find((x) => x.recurrenceId === 'net');
      if (!v) return 'já pago';
      try { await repo.payItem(v, { date: '2026-11-10', amount: 10000 }); return 'ok'; } catch (e) { return `recusado: ${e.message.slice(0, 40)}`; }
    });
    const [a, b] = await Promise.all([pay(page), pay(other)]);
    await page.waitForTimeout(300);
    const n = await api(page, async () => { const { loadAll } = await import('./js/database/db.js'); return (await loadAll()).transactions.length; });
    eq(n, 1, `uma única ocorrência paga (${a} / ${b})`);
    await noErrors(page);
    await context.close();
  });

  await test('3.1 — Cenário 17: backup com recorrências, previsões, cálculos e layout restaura equivalente', async () => {
    const a = await newPage();
    await api(a.page, async (repo) => {
      const r = await repo.createRecurrence({ id: 'psi', type: 'expense', description: 'Psicóloga', amount: 5000, frequency: 'monthly', mode: 'flex', perPeriod: 2, startDate: '2026-11-01' });
      const v = (await import('./js/services/finance.js')).virtualItems(repo.context(), '2026-11').find((x) => x.recurrenceId === r.id);
      await repo.payItem(v, { date: '2026-11-04', amount: 5000 });
      await repo.createRecurrence({ id: 'fuel', type: 'expense', description: 'Combustível', amount: 40000, frequency: 'monthly', mode: 'forecast', startDate: '2026-11-01' });
      await repo.saveTransaction({ id: 'f1', type: 'expense', status: 'done', amount: 10000, date: '2026-11-04', description: 'Posto', forecastId: 'fuel' });
      await repo.saveCalculation({ id: 'c1', name: 'Reserva', expr: '@1 × 70%', mode: 'dynamic', refs: [{ id: 'r1', kind: 'projectedSurplus', month: 'current' }] });
      await repo.setUiLayout({ version: 1, sections: { overview: { items: [{ type: 'commitments', size: 'l', chart: 'list' }], known: ['commitments'] } } });
    });
    await a.page.goto(`${base}#/configuracoes/dados`);
    const dl = await exportBackupUI(a.page);
    const file = join(ARTIFACTS, 'backup-v31.json');
    await dl.saveAs(file);
    const snapA = await api(a.page, (repo) => { const s = repo.snapshot(); s.meta = s.meta.filter((m) => m.key === 'ui.layout' || m.key === 'prefs'); return JSON.stringify(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.map(({ rev, ...x }) => x).sort((p, q) => String(p.id || p.key).localeCompare(String(q.id || q.key)))]))); });
    await a.context.close();
    const b = await newPage();
    await b.page.goto(`${base}#/configuracoes/dados`);
    const [ch] = await Promise.all([b.page.waitForEvent('filechooser'), b.page.getByRole('button', { name: 'Restaurar backup' }).click()]);
    await ch.setFiles(file);
    await b.page.waitForSelector('.modal', { hasText: 'Restaurar backup (arquivo)?' });
    await b.page.getByRole('button', { name: 'Restaurar', exact: true }).click();
    await waitText(b.page, '.toast', /Backup restaurado/);
    const snapB = await api(b.page, (repo) => { const s = repo.snapshot(); s.meta = s.meta.filter((m) => m.key === 'ui.layout' || m.key === 'prefs'); return JSON.stringify(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.map(({ rev, ...x }) => x).sort((p, q) => String(p.id || p.key).localeCompare(String(q.id || q.key)))]))); });
    eq(snapB, snapA, 'registros, recorrências, cálculos e preferências equivalentes');
    const bk = JSON.parse(await readFile(file, 'utf8'));
    eq(bk.version, 3, 'formato 3');
    eq(bk.counts.calculations, 1, 'cálculos no backup');
    await noErrors(b.page);
    await b.context.close();
  });

  await test('3.1 — Cenário 18: migração de uma base da 3.0 (esquema v3) para v4 sem recriar o banco', async () => {
    const context = await browser.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
    await context.clock.setFixedTime(NOW);
    const page = await context.newPage();
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message));
    // Cria, sem o app, um banco no formato da 3.0 com dados representativos.
    await page.goto(base.replace(/\/$/, '') + '/manifest.webmanifest');
    await page.evaluate(() => new Promise((ok, fail) => {
      const req = indexedDB.open('guia-financeiro.pessoal', 3);
      req.onupgradeneeded = () => {
        const db = req.result;
        const tx = db.createObjectStore('transactions', { keyPath: 'id' });
        for (const i of ['month', 'date', 'categoryId', 'blockId', 'sourceId', 'recurrenceId', 'planId']) tx.createIndex(i, i);
        tx.createIndex('occurrence', ['recurrenceId', 'occurrenceDate'], { unique: true });
        for (const s of ['categories', 'blocks', 'accounts', 'recurrences', 'installmentPlans', 'budgets', 'investments', 'investmentEvents', 'goals', 'snapshots']) db.createObjectStore(s, { keyPath: 'id' });
        db.createObjectStore('meta', { keyPath: 'key' });
        const t = req.transaction;
        t.objectStore('recurrences').put({ id: 'net', type: 'expense', description: 'Internet', amount: 10000, frequency: 'monthly', interval: 1, startDate: '2026-10-10', anchorDay: 10, exceptions: { '2026-12-10': 'skipped' }, rev: 1 });
        t.objectStore('transactions').put({ id: 'net:2026-10-10', type: 'expense', status: 'done', amount: 10000, date: '2026-10-10', month: '2026-10', description: 'Internet', recurrenceId: 'net', occurrenceDate: '2026-10-10', rev: 1, createdAt: 1, updatedAt: 1 });
        t.objectStore('transactions').put({ id: 'm1', type: 'expense', status: 'done', amount: 2500, date: '2026-11-03', month: '2026-11', description: 'Padaria', rev: 1, createdAt: 1, updatedAt: 1 });
        t.objectStore('meta').put({ key: 'seeded', value: true });
        t.objectStore('meta').put({ key: 'ui.layout', value: { version: 1, sections: { overview: { items: [{ type: 'insights', hidden: true }], known: ['insights'] } } } });
      };
      req.onsuccess = () => { req.result.close(); ok(); };
      req.onerror = () => fail(req.error);
    }));
    await page.goto(base);
    await page.waitForSelector('[data-kpi]');
    const info = await page.evaluate(() => new Promise((ok) => {
      const req = indexedDB.open('guia-financeiro.pessoal');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['transactions'], 'readonly');
        const r = tx.objectStore('transactions').getAll();
        r.onsuccess = () => { ok({ v: db.version, stores: [...db.objectStoreNames].sort(), idx: [...tx.objectStore('transactions').indexNames].sort(), tx: r.result.map((x) => x.id).sort() }); db.close(); };
      };
    }));
    eq(info.v, 4, 'versão 4');
    assert(info.stores.includes('calculations') && info.stores.includes('snapshots'), `stores: ${info.stores}`);
    assert(info.idx.includes('occurrenceKey') && info.idx.includes('occurrence'), 'índices antigos e novos');
    eq(JSON.stringify(info.tx), JSON.stringify(['m1', 'net:2026-10-10']), 'dados preservados');
    const s = await sumOf(page, '2026-11');
    eq(s.total, 12500, 'recorrência antiga projeta normalmente (novembro)');
    eq((await sumOf(page, '2026-12')).total, 0, 'exceção antiga (ignorada) respeitada');
    eq(await page.locator('.widget[data-id="insights"]').count(), 0, 'personalização da 3.0 preservada');
    eq(page.errors.length, 0, page.errors.join(' | '));
    await context.close();
  });

  for (const tz of ['Pacific/Kiritimati', 'America/Los_Angeles', 'Asia/Tokyo', 'America/New_York', 'UTC']) {
    await test(`3.1 — Cenário 19: datas financeiras estáveis no fuso ${tz} (perto da meia-noite)`, async () => {
      const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'pt-BR', timezoneId: tz });
      // 30/11/2026 às 23:50 no fuso local: o "hoje" financeiro tem de ser 30/11, não 01/12.
      await context.clock.setFixedTime(new Date(utcForLocal(tz, 2026, 11, 30, 23, 50)));
      const page = await context.newPage();
      page.errors = [];
      page.on('pageerror', (e) => page.errors.push(e.message));
      await page.goto(base); await page.waitForSelector('[data-kpi]');
      eq(await page.evaluate(async () => (await import('./js/utils/dates.js')).today()), '2026-11-30', 'hoje local');
      const m = await openForm(page);
      eq(await m.locator('input[name=date]').inputValue(), '2026-11-30', 'data padrão do formulário');
      await m.locator('input[name=amount]').fill('10');
      await m.locator('input[name=description]').fill('Lanche');
      await save(m);
      await api(page, (repo) => repo.createRecurrence({ id: 'w', type: 'expense', description: 'Semanal', amount: 100, frequency: 'weekly', startDate: '2026-10-25' }));
      const r = await api(page, async (repo) => {
        const { ruleOccurrences } = await import('./js/services/recurrence.js');
        return { tx: repo.list('transactions').map((t) => [t.date, t.month]), occ: ruleOccurrences(repo.get('recurrences', 'w'), '2026-10-25', '2026-11-15').map((o) => o.date) };
      });
      eq(JSON.stringify(r.tx), JSON.stringify([['2026-11-30', '2026-11']]), 'data e competência preservadas');
      eq(JSON.stringify(r.occ), JSON.stringify(['2026-10-25', '2026-11-01', '2026-11-08', '2026-11-15']), 'semanas na virada do horário de verão');
      await page.goto(`${base}#/planejamento/calendario`);
      await page.waitForSelector('.cal-day[data-date="2026-11-30"].is-today');
      eq(page.errors.length, 0, page.errors.join(' | '));
      await context.close();
    });
  }

  await test('3.1 — Cenário 20: celular (emulação) — formulário, compromissos, personalização e calculadora acessíveis', async () => {
    const { context, page } = await newPage({ ...devices['iPhone 13'] });
    await api(page, (repo) => repo.createRecurrence({ type: 'expense', description: 'Psicóloga', amount: 5000, frequency: 'monthly', mode: 'flex', perPeriod: 2, startDate: '2026-11-01' }));
    await page.goto(`${base}#/planejamento/compromissos`);
    await page.waitForSelector('.commit');
    const inView = async (sel) => page.locator(sel).first().evaluate((e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth + 1 && r.width > 0; });
    assert(await inView('.commit .occ-check'), 'botão de pagar visível');
    await page.evaluate(() => { location.hash = '#/visao-geral'; });
    await page.waitForSelector('[data-kpi]');
    await page.getByRole('button', { name: 'Personalizar' }).click();
    assert(await inView('.widget .widget-handle'), 'alça de mover');
    assert(await inView('.widget .widget-settings'), 'ajustes do componente');
    await page.locator('.edit-bar').getByRole('button', { name: 'Concluir' }).click();
    await page.evaluate(async () => (await import('./js/components/calculator.js')).openCalculator());
    await page.waitForSelector('.calc.is-open');
    const box = await page.locator('.calc').boundingBox();
    const vp = page.viewportSize();
    assert(box.y >= 0 && box.y + Math.min(box.height, vp.height) <= vp.height + 1 && box.x >= 0 && box.x + box.width <= vp.width + 1, `calculadora dentro da tela: ${JSON.stringify(box)}`);
    await page.locator('.calc').getByRole('button', { name: 'Fechar calculadora' }).click();
    await page.locator('.tabbar .tab-add').click();
    const m = page.locator('.entry-modal');
    await m.waitFor();
    await m.locator('select[name=repeat]').selectOption('monthly');
    assert(await inView('.entry-modal .mode-opt[data-mode="flex"]'), 'opções de repetição legíveis');
    assert(await inView('.entry-modal .modal-foot button[type=submit]'), 'botão salvar visível');
    for (const r of ['visao-geral', 'lancamentos', 'planejamento/compromissos', 'planejamento/calendario', 'investimentos', 'configuracoes']) {
      await page.keyboard.press('Escape');
      await page.goto(`${base}#/${r}`); await page.waitForSelector('.page-head');
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert(over <= 1, `rolagem horizontal em ${r}: ${over}px`);
    }
    await noErrors(page);
    await context.close();
  });

  await test('3.1 — Cenário 22: assinatura institucional fixa, com a versão central, em todos os modos', async () => {
    const { context, page } = await newPage();
    const version = await page.evaluate(async () => (await import('./js/version.js')).APP_VERSION);
    eq(version, '3.1.0', 'versão');
    await waitText(page, '.sidebar .signature', `Desenvolvido por Filipe Santana FS v${version}`);
    assert(await page.locator('.sidebar .signature .sig-by').isVisible(), 'visível no desktop');
    await page.getByRole('button', { name: 'Personalizar' }).click();
    assert(await page.locator('.sidebar .signature').isVisible(), 'personalização não remove');
    await page.locator('.edit-bar').getByRole('button', { name: 'Concluir' }).click();
    await page.goto(`${base}#/configuracoes`);
    await page.locator('#cfg-personalizacao').getByRole('button', { name: 'Restaurar toda a aparência' }).click();
    await page.locator('.modal').getByRole('button', { name: 'Restaurar aparência' }).click();
    assert(await page.locator('.sidebar .signature .sig-by').isVisible(), 'restaurar aparência não remove');
    await waitText(page, () => page.locator('#cfg-sobre').textContent().then(norm), new RegExp(`Versão ${version.replace(/\./g, '\\.')}.*Desenvolvido por Filipe Santana`));
    await page.keyboard.press('[');
    assert(await page.locator('.sidebar .signature .sig-mono').isVisible(), 'menu recolhido mostra a marca discreta');
    await page.keyboard.press('[');
    const diag = await page.locator('#cfg-armazenamento').textContent();
    assert(diag.includes(version), 'diagnóstico usa a mesma versão');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}#/visao-geral`); await page.waitForSelector('[data-kpi]');
    assert(await page.locator('.signature-main').isVisible(), 'assinatura no celular');
    await noErrors(page);
    await context.close();
  });

  await test('3.1 — Cenário 23: README apresenta o produto, com o link do app e sem tutorial de publicação', async () => {
    const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
    assert(readme.includes('https://filipeesantana.github.io/Fluxo/'), 'link do aplicativo');
    for (const s of ['## O que é o Fluxo?', '## Como começar', '## Recorrências e planejamento', '## Privacidade e armazenamento', '## Backup e recuperação', 'Desenvolvido por **Filipe Santana**']) assert(readme.includes(s), `seção: ${s}`);
    for (const bad of [/git clone/i, /\bcommit/i, /Settings → Pages/i, /npm (run|test)/i, /branch/i]) assert(!bad.test(readme), `README não deveria ensinar publicação (${bad})`);
    const dev = await readFile(join(ROOT, 'docs', 'DEVELOPMENT.md'), 'utf8');
    assert(dev.includes('npm test'), 'informação técnica foi para docs/DEVELOPMENT.md');
  });

  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  await writeFile(join(ARTIFACTS, 'e2e-results.json'), JSON.stringify(results, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} testes de navegador aprovados`);
  process.exitCode = failed.length ? 1 : 0;
}

async function listFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p))); else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

run().catch(async (err) => { console.error(err); await browser?.close(); process.exit(1); });
