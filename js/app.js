import { h, icon, isTypingTarget, put } from './utils/dom.js';
import * as repo from './database/repository.js';
import { ui, onUI, shiftMonth, goToday } from './state.js';
import { initTheme } from './theme.js';
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
  { id: 'entries', path: 'lancamentos', label: 'Lançamentos', short: 'Lançamentos', icon: 'list', render: renderEntries },
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
  const nav = document.getElementById('nav');
  put(nav, ...ROUTES.map((r, i) => h('a', { class: 'nav-link', href: `#/${r.path}`, dataset: { route: r.id } }, icon(r.icon), h('span', null, r.label), h('kbd', null, String(i + 1)))));
  const tabbar = document.getElementById('tabbar');
  const tabs = ROUTES.map((r) => h('a', { class: 'tab', href: `#/${r.path}`, dataset: { route: r.id }, 'aria-label': r.label }, icon(r.icon), h('span', null, r.short)));
  tabs.splice(2, 0, h('button', { class: 'tab tab-add', type: 'button', 'aria-label': 'Novo lançamento', onclick: () => openEntryForm() }, icon('plus'), h('span', null, 'Lançar')));
  put(tabbar, ...tabs.slice(0, 6).filter((t) => t.dataset.route !== 'settings'), tabs.find((t) => t.dataset.route === 'settings'));
  tabbar.style.gridTemplateColumns = `repeat(${tabbar.children.length}, 1fr)`;
}

function render({ animate = false } = {}) {
  const { route, sub } = parseHash();
  ui.route = route.id;
  for (const a of document.querySelectorAll('[data-route]')) {
    if (a.dataset.route === route.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  document.title = `${route.label} · Guia Financeiro`;
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
  if (isTypingTarget(ev.target) || hasModal() || isCalculatorOpen() && ev.target.closest?.('.calc')) return;
  if (document.querySelector('.menu')) return;
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
  else if (/^[1-5]$/.test(k)) location.hash = `#/${ROUTES[Number(k) - 1].path}`;
}

async function boot() {
  initTheme();
  buildNav();
  initCalculator();
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest('[data-action]');
    if (!a) return;
    if (a.dataset.action === 'new-entry') openEntryForm();
    if (a.dataset.action === 'calculator') toggleCalculator();
  });
  try {
    await repo.init();
  } catch (err) {
    console.error(err);
    put(view, h('div', { class: 'empty fatal' },
      h('p', { class: 'empty-title' }, 'Não foi possível abrir o banco de dados local.'),
      h('p', { class: 'muted small' }, err.message || String(err)),
      h('p', { class: 'muted small' }, 'Verifique se o navegador permite armazenamento para este site (a navegação privada pode bloquear o IndexedDB).'),
      h('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, 'Tentar novamente')));
    return;
  }
  repo.subscribe((origin) => {
    if (origin === 'versionchange') {
      toast('O aplicativo foi atualizado em outra aba. Recarregue esta página.', { tone: 'error', timeout: 60000, action: { label: 'Recarregar', fn: () => location.reload() } });
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
  // Ao voltar para a aba em um novo dia, o mês atual e "hoje" são recalculados.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRender(); });
  lastRoute = parseHash().route.id;
  render({ animate: true });
  document.documentElement.classList.add('is-ready');
}

boot();
