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
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(`console: ${m.text()}`); });
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
const evolutionHint = (page) => async () => norm(await page.locator('.col-section', { has: page.locator('h2', { hasText: 'Evolução do mês' }) }).locator('.hint').textContent());
async function barValue(page, section, name) {
  const row = page.locator('.col-section', { has: page.locator('h2', { hasText: section }) }).locator('.bar-row', { has: page.locator('.bar-name', { hasText: name }) });
  if (!(await row.count())) return null;
  return norm(await row.first().locator('.bar-value').textContent());
}

/** Executa código com o repositório do app dentro da página. */
function api(page, fn, arg) {
  return page.evaluate(async ([src, a]) => {
    const repo = await import('./js/database/repository.js');
    const f = new Function('repo', 'arg', `return (${src})(repo, arg);`);
    return f(repo, a);
  }, [fn.toString(), arg]);
}

async function openForm(page) {
  await page.locator('.page-head .btn-primary', { hasText: 'Novo lançamento' }).click();
  await page.waitForSelector('.entry-modal');
  return page.locator('.entry-modal');
}

async function pick(modal, name, label) {
  await modal.locator(`select[name=${name}]`).selectOption({ label });
}

async function createInline(modal, name, value, kind) {
  await modal.locator(`select[name=${name}]`).selectOption('__create__');
  if (kind) await modal.locator(`select[name=${name}] ~ select.select-inline`).selectOption(kind);
  const input = modal.locator(`select[name=${name}] ~ input.input`);
  await input.fill(value);
  await input.press('Enter');
  await modal.page().waitForFunction(([n, v]) => [...document.querySelector(`select[name=${n}]`).selectedOptions].some((o) => o.textContent === v), [name, value]);
}

async function save(modal) {
  await modal.locator('.modal-foot button[type=submit]').click();
  await modal.waitFor({ state: 'detached' });
}

async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: err.message });
    console.log(`  ✗ ${name}\n      ${err.message.split('\n')[0]}`);
  }
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
    await page.waitForSelector('.empty-title');
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
    await page.waitForSelector('.kpis');
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
    await m.getByText('Parcelar', { exact: true }).click();
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
      if (i === 6) { await page.reload(); await page.waitForSelector('.kpis'); for (let k = 0; k < 6; k++) await page.keyboard.press('ArrowRight'); }
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
    await page.getByRole('button', { name: 'Pagar fatura' }).click();
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
    const [dl] = await Promise.all([a.page.waitForEvent('download'), a.page.getByRole('button', { name: 'Exportar backup (JSON)' }).click()]);
    backupPath = join(ARTIFACTS, 'backup-teste.json');
    await dl.saveAs(backupPath);
    const original = await api(a.page, (repo) => JSON.stringify(repo.snapshot(), Object.keys(repo.snapshot()).sort()));
    const counts = await api(a.page, (repo) => Object.fromEntries(Object.entries(repo.snapshot()).map(([k, v]) => [k, v.length])));
    await a.context.close();

    const b = await newPage();
    await b.page.goto(`${base}#/configuracoes`);
    const [chooser] = await Promise.all([b.page.waitForEvent('filechooser'), b.page.getByRole('button', { name: 'Restaurar backup' }).click()]);
    await chooser.setFiles(backupPath);
    await b.page.waitForSelector('.modal', { hasText: 'Restaurar backup?' });
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
    const sim = page.locator('.section', { has: page.locator('h2', { hasText: 'Simulador de aportes' }) });
    const inputs = sim.locator('.sim-in input');
    await inputs.nth(0).fill('0'); await inputs.nth(1).fill('100'); await inputs.nth(2).fill('0'); await inputs.nth(3).fill('0'); await inputs.nth(4).fill('1');
    await waitText(page, () => sim.locator('.kv', { hasText: 'Patrimônio em 1 ano' }).locator('.kv-value').textContent().then(norm), 'R$ 1.200,00');
    // 12% a.a. efetivos, R$ 1.000/mês por 10 anos, aporte ao fim do mês: referência independente por iteração.
    await inputs.nth(1).fill('1000'); await inputs.nth(2).fill('12'); await inputs.nth(4).fill('10');
    const i = Math.pow(1.12, 1 / 12) - 1;
    let v = 0; for (let n = 0; n < 120; n++) v = v * (1 + i) + 100000;
    const expected = norm(new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Math.round(v) / 100));
    await waitText(page, () => sim.locator('.kv', { hasText: 'Patrimônio em 10 anos' }).locator('.kv-value').textContent().then(norm), expected);
    await waitText(page, () => sim.locator('.kv', { hasText: 'Taxa mensal equivalente' }).locator('.kv-value').textContent().then(norm), '0,9489%');
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
    const opts = await m.locator('select[name=category] option').allTextContents();
    assert(!opts.some((o) => o.startsWith('Hobby')), 'categoria arquivada não aparece para novos lançamentos');
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
    await page.waitForSelector('.kpis');
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
      assert(!/https?:\/\//.test(src.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')), `URL externa em ${f}`);
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
    await page.locator('.tab', { hasText: 'Lançamentos' }).click();
    await page.waitForSelector('#entries-search');
    await page.locator('#entries-search').fill('lanc');
    await waitText(page, '.list-summary span', '1 lançamento');
    await noErrors(page);
    await context.close();
  });

  await test('Cenário 19 — atualização do esquema v1 → v2 preserva o banco existente', async () => {
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
    await page.waitForSelector('.kpis');
    const info = await page.evaluate(async () => {
      const { DB_NAME } = await import('./js/database/schema.js');
      const repo = await import('./js/database/repository.js');
      const db = await new Promise((ok) => { const r = indexedDB.open(DB_NAME); r.onsuccess = () => ok(r.result); });
      const v = db.version;
      const idx = [...db.transaction('transactions').objectStore('transactions').indexNames];
      db.close();
      return { v, idx, ids: repo.list('transactions').map((t) => t.id).sort() };
    });
    eq(info.v, 2, 'versão do banco');
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
    assert(await page.locator('.kv', { hasText: 'Benefícios restritos livres' }).locator('.kv-value', { hasText: 'R$ 200,00' }).count(), 'benefício livre exibido separadamente');
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
    await save(m);
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
        for (let k = 0; k < 3 && (await page.locator('.modal, .menu, .calc.is-open').count()); k++) {
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
    await page.waitForSelector('.kpis');
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
