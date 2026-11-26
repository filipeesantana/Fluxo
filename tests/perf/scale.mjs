// Teste de escala com bases sintéticas (somente em contextos de navegador
// descartáveis; nunca toca a base real). Uso: node tests/perf/scale.mjs
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SIZES = (process.argv[2] || '100,1000,10000,50000').split(',').map(Number);
const frame = (p) => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

const { server, url } = await startServer();
const browser = await chromium.launch();
const results = [];
for (const N of SIZES) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  await context.clock.setFixedTime(new Date('2026-11-25T10:00:00-03:00'));
  const p = await context.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(url);
  await p.waitForSelector('.kpi-grid');
  // Base sintética: 5 anos de movimentações, contas, cartão, recorrências e parcelas.
  await p.evaluate(async (N) => {
    const db = await import('./js/database/db.js');
    const repo = await import('./js/database/repository.js');
    const cats = repo.list('categories');
    const acc = await repo.createNamed('accounts', { name: 'Conta', kind: 'checking' });
    const card = await repo.createNamed('accounts', { name: 'Cartão', kind: 'credit', closingDay: 3, dueDay: 10 });
    const blocks = [];
    for (const n of ['Pessoal', 'Casa', 'Moto', 'Faculdade']) blocks.push(await repo.createNamed('blocks', { name: n }));
    for (let r = 0; r < 12; r++) await repo.saveRecurrence({ type: r ? 'expense' : 'income', description: `Fixa ${r}`, amount: r ? 5000 + r * 100 : 500000, frequency: 'monthly', startDate: '2022-01-10', sourceId: acc.id });
    for (let k = 0; k < 6; k++) await repo.createInstallmentPlan({ description: `Parcelado ${k}`, total: 120000, count: 12, purchaseDate: `2026-0${k + 1}-05`, sourceId: k % 2 ? card.id : acc.id });
    for (let s = 0; s < N; s += 10000) {
      const ops = [];
      for (let i = s; i < Math.min(N, s + 10000); i++) {
        const y = 2022 + Math.floor((i % 60) / 12), m = 1 + (i % 12), d = 1 + (i % 28);
        const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        ops.push({ store: 'transactions', put: { id: `s${i}`, type: i % 9 ? 'expense' : 'income', status: 'done', description: `Item ${i % 997}`, amount: 500 + (i % 9000), date, month: date.slice(0, 7), categoryId: cats[i % cats.length].id, blockId: blocks[i % 4].id, sourceId: i % 3 ? acc.id : null, createdAt: i } });
      }
      await db.commit(ops);
    }
  }, N);
  const r = { N };
  let t = Date.now(); await p.reload(); await p.waitForSelector('.tx-row'); r.openMs = Date.now() - t;
  await p.evaluate(async () => (await import('./js/database/repository.js')).whenFullyLoaded()); r.fullHistoryMs = Date.now() - t;
  t = Date.now(); for (let i = 0; i < 10; i++) { await p.keyboard.press('ArrowLeft'); await frame(p); } r.monthNavMs = Math.round((Date.now() - t) / 10);
  await p.keyboard.press('t'); await frame(p);
  t = Date.now();
  await p.evaluate(async () => { const repo = await import('./js/database/repository.js'); await repo.saveTransaction({ id: 'perf-new', type: 'expense', status: 'done', amount: 1234, date: '2026-11-10', description: 'Novo' }); });
  await frame(p); r.createMs = Date.now() - t;
  t = Date.now();
  await p.evaluate(async () => { const repo = await import('./js/database/repository.js'); await repo.saveTransaction({ ...repo.get('transactions', 'perf-new'), amount: 4321 }); });
  await frame(p); r.editMs = Date.now() - t;
  await p.goto(`${url}#/lancamentos`); await p.waitForSelector('#entries-search');
  await p.locator('.segmented .seg', { hasText: 'Todos os meses' }).click(); await frame(p);
  t = Date.now(); await p.locator('#entries-search').fill('item 42'); await p.waitForFunction(() => /lançamento/.test(document.querySelector('.list-summary')?.textContent || '')); r.searchMs = Date.now() - t;
  t = Date.now(); await p.goto(`${url}#/planejamento/projecao`); await p.waitForSelector('.horizon');
  await p.locator('.horizon .seg', { hasText: '5 anos' }).click(); await p.waitForFunction(() => document.querySelectorAll('.table tbody tr').length === 60); r.projection60Ms = Date.now() - t;
  t = Date.now(); await p.goto(`${url}#/planejamento/calendario`); await p.waitForSelector('.cal-grid'); await frame(p); r.calendarMs = Date.now() - t;
  t = Date.now(); await p.goto(`${url}#/visao-geral`); await p.waitForSelector('.kpi-grid'); await frame(p); r.overviewMs = Date.now() - t;
  r.heapMB = await p.evaluate(() => { const m = performance.memory?.usedJSHeapSize; return Number.isFinite(m) ? Math.round(m / 1048576) : null; });
  r.errors = errors.length;
  results.push(r);
  console.log(`N=${String(N).padStart(6)} · abrir ${r.openMs} ms (histórico completo ${r.fullHistoryMs} ms) · trocar mês ${r.monthNavMs} ms · criar ${r.createMs} ms · editar ${r.editMs} ms · buscar ${r.searchMs} ms · projeção 60m ${r.projection60Ms} ms · calendário ${r.calendarMs} ms · visão geral ${r.overviewMs} ms · heap ${r.heapMB} MB · erros ${r.errors}`);
  await context.close();
}
await browser.close();
server.close();
await mkdir(join(ROOT, 'tests', '.artifacts'), { recursive: true });
await writeFile(join(ROOT, 'tests', '.artifacts', 'perf.json'), JSON.stringify(results, null, 2));
