import { h, icon, isTypingTarget, put, prefersReducedMotion } from './utils/dom.js';
import * as repo from './database/repository.js';
import { ui, onUI, shiftMonth, goToday, readPref, writePref } from './state.js';
import { initTheme, applyTheme, currentThemePref, applyDensity, currentDensity } from './theme.js';
import { getSectionOptions, flushLayout } from './components/layout.js';
import { initCalculator, toggleCalculator, isCalculatorOpen } from './components/calculator.js';
import { openEntryForm } from './components/entry-form.js';
import { hasModal } from './components/modal.js';
import { toast } from './components/toast.js';
import { renderOverview } from './views/overview.js';
import { renderEntries } from './views/entries.js';
import { renderPlanning } from './views/planning.js';
import { renderInvestments } from './views/investments.js';
import { renderSettings } from './views/settings.js';

const ROUTES = [
  { id: 'overview', path: 'visao-geral', label: 'Visão geral', short: 'Visão', icon: 'overview', render: renderOverview },
  { id: 'entries', path: 'lancamentos', label: 'Lançamentos', short: 'Extrato', icon: 'list', render: renderEntries },
  { id: 'planning', path: 'planejamento', label: 'Planejamento', short: 'Planejar', icon: 'calendar', render: renderPlanning },
  { id: 'investments', path: 'investimentos', label: 'Investimentos', short: 'Investir', icon: 'trend', render: renderInvestments },
  { id: 'settings', path: 'configuracoes', label: 'Configurações', short: 'Ajustes', icon: 'settings', render: renderSettings },
];

const view = document.getElementById('view');
let lastRoute = null;
let renderQueued = false;

function parseHash() {
  const [path = '', sub = ''] = location.hash.replace(/^#\/?/, '').split('/');
  const route = ROUTES.find((r) => r.path === path) || ROUTES[0];
  return { route, sub };
}

function buildNav() {
  put(document.getElementById('nav'), ...ROUTES.map((r, i) => h('a', {
    class: 'nav-link', href: `#/${r.path}`, dataset: { route: r.id, tip: r.label }, 'aria-label': r.label,
  }, icon(r.icon), h('span', { class: 'nav-text' }, r.label), h('kbd', null, String(i + 1)))));
  const tabbar = document.getElementById('tabbar');
  const tab = (r) => h('a', { class: 'tab', href: `#/${r.path}`, dataset: { route: r.id }, 'aria-label': r.label }, icon(r.icon), h('span', null, r.short));
  const add = h('button', { class: 'tab tab-add', type: 'button', 'aria-label': 'Novo lançamento', onclick: () => openEntryForm() }, h('span', { class: 'tab-add-circle' }, icon('plus')), h('span', null, 'Lançar'));
  put(tabbar, tab(ROUTES[0]), tab(ROUTES[1]), add, tab(ROUTES[2]), tab(ROUTES[3]), tab(ROUTES[4]));
  tabbar.style.gridTemplateColumns = 'repeat(6, minmax(0, 1fr))';
}

// ——— Menu recolhível ———
function setCollapsed(on, persist = true) {
  document.documentElement.classList.toggle('sidebar-collapsed', on);
  const btn = document.querySelector('[data-action="collapse"]');
  if (btn) {
    btn.setAttribute('aria-expanded', String(!on));
    btn.setAttribute('aria-label', on ? 'Expandir menu' : 'Recolher menu');
    btn.dataset.tip = on ? 'Expandir menu' : 'Recolher menu';
  }
  if (persist) writePref('sidebar', on ? 'collapsed' : 'expanded');
  hideTip();
}

// Dicas acessíveis no menu recolhido (aria-label já descreve cada ação).
let tipEl = null;
function showTip(target) {
  if (!document.documentElement.classList.contains('sidebar-collapsed') || window.innerWidth <= 760) return;
  hideTip();
  const r = target.getBoundingClientRect();
  tipEl = h('div', { class: 'tooltip', role: 'tooltip' }, target.dataset.tip);
  document.body.append(tipEl);
  tipEl.style.left = `${r.right + 10}px`;
  tipEl.style.top = `${r.top + r.height / 2 - tipEl.offsetHeight / 2}px`;
}
function hideTip() { tipEl?.remove(); tipEl = null; }

function syncThemeButton() {
  const btn = document.querySelector('[data-action="theme"]');
  if (!btn) return;
  const dark = document.documentElement.dataset.theme === 'dark';
  btn.querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  btn.querySelector('.nav-text').textContent = dark ? 'Tema claro' : 'Tema escuro';
  btn.dataset.tip = dark ? 'Usar tema claro' : 'Usar tema escuro';
}

function render({ animate = false } = {}) {
  const { route, sub } = parseHash();
  ui.route = route.id;
  for (const a of document.querySelectorAll('[data-route]')) {
    if (a.dataset.route === route.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  document.title = `${route.label} · Fluxo`;
  const scroll = window.scrollY;
  try {
    route.render(view, sub);
  } catch (err) {
    console.error(err);
    put(view, h('div', { class: 'empty' }, h('p', { class: 'empty-title' }, 'Não foi possível exibir esta seção.'), h('p', { class: 'muted small' }, err.message)));
  }
  if (animate) {
    view.classList.remove('is-entering');
    void view.offsetWidth;
    view.classList.add('is-entering');
    window.scrollTo(0, 0);
  } else window.scrollTo(0, scroll);
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function onKey(ev) {
  if (ev.defaultPrevented) return;
  if (ev.altKey && (ev.key === 'c' || ev.key === 'C' || ev.code === 'KeyC')) {
    ev.preventDefault();
    toggleCalculator(document.activeElement?.matches?.('[data-money]') ? document.activeElement : null);
    return;
  }
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (isTypingTarget(ev.target) || hasModal() || (isCalculatorOpen() && ev.target.closest?.('.calc'))) return;
  if (document.querySelector('.menu, .picker-pop')) return;
  const k = ev.key;
  if (k === 'n' || k === 'N') { ev.preventDefault(); openEntryForm(); }
  else if (k === 'c' || k === 'C') { ev.preventDefault(); toggleCalculator(); }
  else if (k === '/') {
    ev.preventDefault();
    if (ui.route !== 'entries') location.hash = '#/lancamentos';
    requestAnimationFrame(() => document.getElementById('entries-search')?.focus());
  } else if (k === 'ArrowLeft' && ['overview', 'entries', 'planning'].includes(ui.route)) shiftMonth(-1);
  else if (k === 'ArrowRight' && ['overview', 'entries', 'planning'].includes(ui.route)) shiftMonth(1);
  else if (k === 't' || k === 'T') goToday();
  else if (k === '[') setCollapsed(!document.documentElement.classList.contains('sidebar-collapsed'));
  else if (/^[1-5]$/.test(k)) location.hash = `#/${ROUTES[Number(k) - 1].path}`;
}

async function boot() {
  initTheme();
  buildNav();
  initCalculator();
  setCollapsed(readPref('sidebar', 'expanded') === 'collapsed', false);
  syncThemeButton();
  document.addEventListener('gf:theme', syncThemeButton);
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest('[data-action]');
    if (!a) return;
    const act = a.dataset.action;
    if (act === 'new-entry') openEntryForm();
    else if (act === 'calculator') toggleCalculator();
    else if (act === 'collapse') setCollapsed(!document.documentElement.classList.contains('sidebar-collapsed'));
    else if (act === 'theme') {
      const go = () => { applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); syncThemeButton(); };
      if (document.startViewTransition && !prefersReducedMotion()) document.startViewTransition(go); else go();
    }
  });
  const sidebar = document.querySelector('.sidebar');
  sidebar.addEventListener('pointerover', (ev) => { const t = ev.target.closest('[data-tip]'); if (t) showTip(t); });
  sidebar.addEventListener('pointerout', (ev) => { if (!ev.relatedTarget || !sidebar.contains(ev.relatedTarget) || !ev.relatedTarget.closest('[data-tip]')) hideTip(); });
  sidebar.addEventListener('focusin', (ev) => { const t = ev.target.closest('[data-tip]'); if (t) showTip(t); });
  sidebar.addEventListener('focusout', hideTip);
  try {
    await repo.init();
  } catch (err) {
    console.error(err);
    put(view, h('div', { class: 'empty fatal' },
      h('p', { class: 'empty-title' }, 'Não foi possível abrir o banco de dados local.'),
      h('p', { class: 'muted small' }, err.message || String(err)),
      h('p', { class: 'muted small' }, 'Verifique se o navegador permite armazenamento para este site (a navegação privada pode bloquear o IndexedDB). Nenhum dado foi apagado.'),
      h('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, 'Tentar novamente')));
    return;
  }
  // Densidade salva no layout (ex.: vinda de um backup restaurado) prevalece sobre a do navegador.
  const syncDensity = () => { const d = getSectionOptions('global').density; if (d && d !== currentDensity()) applyDensity(d); };
  syncDensity();
  window.addEventListener('pagehide', () => { flushLayout(); });
  repo.subscribe((origin) => {
    syncDensity();
    if (origin === 'versionchange') {
      toast('O Fluxo foi atualizado em outra aba. Recarregue esta página para continuar com segurança.', { tone: 'error', timeout: 60000, action: { label: 'Recarregar', fn: () => location.reload() } });
      return;
    }
    scheduleRender();
  });
  onUI(scheduleRender);
  window.addEventListener('hashchange', () => {
    const { route } = parseHash();
    render({ animate: route.id !== lastRoute });
    lastRoute = route.id;
  });
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRender(); });
  // Gráficos usam a largura real: refaz a tela quando a largura muda de forma relevante.
  let lastW = window.innerWidth, resizeT;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (Math.abs(window.innerWidth - lastW) > 80) { lastW = window.innerWidth; scheduleRender(); } }, 200);
  });
  lastRoute = parseHash().route.id;
  render({ animate: true });
  document.documentElement.classList.add('is-ready');
}

boot();

export { currentThemePref };
