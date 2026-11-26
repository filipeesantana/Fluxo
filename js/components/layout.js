import { h, icon, put, prefersReducedMotion } from '../utils/dom.js';
import * as repo from '../database/repository.js';
import { openModal, confirmDialog } from './modal.js';
import { openMenu } from './menu.js';
import { toast, toastError } from './toast.js';

/*
 * Personalização modular
 * ----------------------
 * Cada seção declara um REGISTRO de componentes:
 *   { [type]: { title, description, size, sizes?, charts?, chart?, color?, hidden?, render(cfg, api) } }
 * O layout salvo (meta 'ui.layout' no IndexedDB, incluído nos backups) guarda
 * apenas preferências visuais por seção — nunca dados financeiros:
 *   { version: 1, sections: { [section]: { items: [{ id, type, size, chart?, color?, hidden? }], known: [type] } } }
 * Tudo que vem do armazenamento é NORMALIZADO: tipos desconhecidos são
 * descartados, valores inválidos voltam ao padrão, componentes novos de
 * versões futuras entram no fim. Uma configuração corrompida nunca impede a
 * abertura da aplicação — no pior caso, a seção volta ao padrão.
 */

export const LAYOUT_VERSION = 1;
export const SIZES = {
  s: { label: 'Pequeno', span: 3 },
  m: { label: 'Médio', span: 4 },
  l: { label: 'Metade', span: 6 },
  xl: { label: 'Grande', span: 8 },
  f: { label: 'Largura completa', span: 12 },
};
export const PALETTE = {
  auto: { label: 'Padrão' },
  blue: { label: 'Azul', hex: '#3355d1' },
  teal: { label: 'Verde-azulado', hex: '#0e7f78' },
  green: { label: 'Verde', hex: '#16804e' },
  amber: { label: 'Âmbar', hex: '#9c620c' },
  rose: { label: 'Rosa', hex: '#b3456b' },
  violet: { label: 'Violeta', hex: '#6d4fc2' },
  slate: { label: 'Grafite', hex: '#4f5868' },
};
export const CHART_LABELS = {
  bars: 'Barras horizontais', columns: 'Barras verticais', donut: 'Rosca', table: 'Tabela resumida',
  line: 'Linha', area: 'Área', list: 'Lista cronológica',
  day: 'Por dia (barras)', cum: 'Acumulado (linha)', ie: 'Receitas × despesas',
};

const META_KEY = 'ui.layout';
const editing = new Map();       // seção → em modo de personalização
const undoStacks = new Map();    // seção → layouts anteriores (memória)
let saveTimer = null;
let pending = null;

// ——— Cores ———

const hexOk = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
function mix(hex, toward, t) {
  const p = (x, i) => parseInt(x.slice(i, i + 2), 16);
  return `#${[1, 3, 5].map((i) => Math.round(p(hex, i) + (p(toward, i) - p(hex, i)) * t).toString(16).padStart(2, '0')).join('')}`;
}
/**
 * Garante contraste mínimo (3:1, elementos gráficos — WCAG 1.4.11) contra as
 * superfícies clara E escura. Escurece/clareia a cor o necessário.
 */
export function accessibleColor(hex) {
  if (!hexOk(hex)) return null;
  let c = hex.toLowerCase();
  const light = '#ffffff', dark = '#18191c';
  for (let i = 0; i < 20 && contrast(c, light) < 3; i++) c = mix(c, '#000000', 0.08);
  if (contrast(c, dark) < 3) {
    // Cor muito escura para o tema escuro: aceita somente se ainda funcionar no claro após clarear.
    let d = c;
    for (let i = 0; i < 20 && contrast(d, dark) < 3; i++) d = mix(d, '#ffffff', 0.08);
    if (contrast(d, light) >= 3) c = d;
  }
  return c;
}
export function colorCss(color) {
  if (!color || color === 'auto') return null;
  if (PALETTE[color]?.hex) return `var(--pal-${color})`;
  return hexOk(color) ? color : null;
}

// ——— Persistência e normalização ———

function readAll() {
  const v = repo.get('meta', META_KEY)?.value;
  return v && typeof v === 'object' && v.version === LAYOUT_VERSION && v.sections && typeof v.sections === 'object' ? v : { version: LAYOUT_VERSION, sections: {} };
}

export function defaultItems(registry) {
  return Object.entries(registry).map(([type, def]) => ({ id: type, type, size: def.size, chart: def.chart, color: 'auto', hidden: Boolean(def.hidden) }));
}

export function normalizeItems(saved, registry) {
  const known = new Set(Array.isArray(saved?.known) ? saved.known.filter((k) => typeof k === 'string') : []);
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(saved?.items) ? saved.items : []) {
    if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') continue;
    // Object.hasOwn: "__proto__", "constructor" etc. nunca resolvem para o protótipo do registro.
    const def = Object.hasOwn(registry, raw.type) ? registry[raw.type] : null;
    if (!def || seen.has(raw.type)) continue;          // tipo desconhecido ou duplicado
    seen.add(raw.type);
    const sizes = def.sizes || Object.keys(SIZES);
    const charts = def.charts || [];
    out.push({
      id: raw.type,
      type: raw.type,
      size: sizes.includes(raw.size) ? raw.size : def.size,
      chart: charts.length ? (charts.includes(raw.chart) ? raw.chart : def.chart) : undefined,
      color: def.color && (raw.color === 'auto' || PALETTE[raw.color] || hexOk(raw.color)) ? raw.color : 'auto',
      hidden: def.locked ? false : Boolean(raw.hidden),
    });
  }
  // Componentes novos (inexistentes quando o layout foi salvo) entram no fim.
  for (const item of defaultItems(registry)) if (!seen.has(item.type) && !known.has(item.type)) out.push(item);
  // Componentes que existem mas sumiram da lista salva voltam como ocultos.
  for (const item of defaultItems(registry)) if (!out.some((o) => o.type === item.type)) out.push({ ...item, hidden: !registry[item.type].locked });
  return out;
}

export function getSection(section, registry) {
  try {
    return normalizeItems(live().sections[section], registry);
  } catch {
    return defaultItems(registry);
  }
}

export function getSectionOptions(section) {
  const s = live().sections[section];
  return s && typeof s.options === 'object' && s.options ? s.options : {};
}

function queueSave(next) {
  pending = next;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushLayout, 350);
}
/** Grava o layout pendente (chamado também ao sair da página). */
export async function flushLayout() {
  clearTimeout(saveTimer);
  if (!pending) return;
  const value = pending;
  pending = null;
  try { await repo.setUiLayout(value); overrideBase = repo.get('meta', META_KEY) || null; } catch (err) { currentOverride = null; toastError(err); }
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.hidden) flushLayout(); });

function writeSection(section, patch, { undo = true } = {}) {
  const all = structuredClone(pending || readAll());
  const prev = all.sections[section] || {};
  if (undo) {
    const stack = undoStacks.get(section) || [];
    stack.push(structuredClone(prev));
    if (stack.length > 30) stack.shift();
    undoStacks.set(section, stack);
  }
  all.sections[section] = { ...prev, ...patch };
  queueSave(all);
  setOverride(all);
}
// Estado pendente (ainda não gravado) para leitura imediata. É descartado se o
// layout no banco mudar por outro caminho (outra aba, restauração de backup).
let currentOverride = null;
let overrideBase = null;
function setOverride(all) { currentOverride = all; overrideBase = repo.get('meta', META_KEY) || null; }
const live = () => {
  if (currentOverride && !pending && (repo.get('meta', META_KEY) || null) !== overrideBase) currentOverride = null;
  return currentOverride || readAll();
};
export function setSectionOptions(section, options, { undo = true } = {}) {
  writeSection(section, { options: { ...getSectionOptions(section), ...options } }, { undo });
}
function itemsOf(section, registry) {
  try { return normalizeItems(live().sections[section], registry); } catch { return defaultItems(registry); }
}
function saveItems(section, registry, items, opts) {
  writeSection(section, { items: items.map(({ id, type, size, chart, color, hidden }) => ({ id, type, size, chart, color, hidden })), known: Object.keys(registry) }, opts);
}

export function undoSection(section) {
  const stack = undoStacks.get(section) || [];
  if (!stack.length) return false;
  const prev = stack.pop();
  const all = structuredClone(live());
  all.sections[section] = prev;
  queueSave(all);
  setOverride(all);
  return true;
}
export function canUndo(section) { return (undoStacks.get(section) || []).length > 0; }

export function resetSection(section) {
  const all = structuredClone(live());
  const stack = undoStacks.get(section) || [];
  stack.push(structuredClone(all.sections[section] || {}));
  undoStacks.set(section, stack);
  delete all.sections[section];
  queueSave(all);
  setOverride(all);
}

export async function resetAllAppearance() {
  pending = null;
  clearTimeout(saveTimer);
  undoStacks.clear();
  currentOverride = null;
  await repo.setUiLayout({ version: LAYOUT_VERSION, sections: {} });
}

export const isEditing = (section) => editing.get(section) === true;
export function setEditing(section, on) { editing.set(section, on); if (!on) flushLayout(); }

// Ao trocar os dados por um backup ou outra aba, o estado em memória volta a ser o do banco.
export function dropOverride() { currentOverride = null; pending = null; }

// ——— Renderização da grade ———

/**
 * Renderiza a grade de componentes de uma seção.
 * opts: { section, registry, rerender }
 */
export function widgetGrid({ section, registry, rerender }) {
  const items = itemsOf(section, registry);
  const edit = isEditing(section);
  const grid = h('div', { class: `wgrid${edit ? ' is-editing' : ''}`, dataset: { section } });
  const liveRegion = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  const state = { items, grid, registry, section, rerender, liveRegion };
  for (const it of items) {
    if (it.hidden && !edit) continue;
    // when(): componente sem conteúdo aplicável agora (ex.: faturas num mês sem cartão) some fora do modo de edição.
    const def = registry[it.type];
    if (!edit && def.when && !safeWhen(def)) continue;
    grid.append(widgetEl(it, state));
  }
  return h('div', { class: 'wgrid-wrap' }, edit ? editToolbar(state) : null, grid, liveRegion);
}

function safeWhen(def) { try { return def.when() !== false; } catch { return true; } }

function renderBody(it, def, state) {
  try {
    // api.update grava preferências do próprio componente (ex.: modo do gráfico) sem redesenhar a seção.
    const api = { update: (patch) => { state.items = state.items.map((x) => (x.id === it.id ? { ...x, ...patch } : x)); saveItems(state.section, state.registry, state.items, { undo: false }); } };
    return def.render({ ...it }, api) || h('div', { class: 'empty-block' }, 'Sem conteúdo.');
  } catch (err) {
    console.error(err);
    // Falha localizada: o componente mostra o erro; o restante da tela continua.
    return h('div', { class: 'widget-error', role: 'alert' }, icon('alert', 'icon-sm'), h('span', null, `Não foi possível exibir “${def.title}”. Seus dados não foram afetados.`),
      h('code', { class: 'xsmall' }, String(err?.message || err)));
  }
}

function widgetEl(it, state) {
  const def = state.registry[it.type];
  const edit = isEditing(state.section);
  const el = h('div', {
    class: `widget w-${it.size}${it.hidden ? ' is-hidden' : ''}`,
    dataset: { id: it.id, type: it.type, color: it.color && it.color !== 'auto' ? 'custom' : null },
    'aria-label': edit ? def.title : null,
  });
  const css = colorCss(it.color);
  if (css) el.style.setProperty('--w-accent', css);
  if (edit) el.append(widgetChrome(it, state, el));
  el.append(h('div', { class: 'widget-body', inert: edit && it.hidden ? true : null }, it.hidden ? h('div', { class: 'widget-hidden-note' }, 'Oculto — aparece só no modo de personalização') : renderBody(it, def, state)));
  return el;
}

function refreshWidget(state, id) {
  const it = state.items.find((x) => x.id === id);
  const old = state.grid.querySelector(`.widget[data-id="${CSS.escape(id)}"]`);
  if (!it || !old) return;
  const fresh = widgetEl(it, state);
  old.replaceWith(fresh);
  if (!prefersReducedMotion()) fresh.animate([{ opacity: 0.4, transform: 'scale(0.985)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
}

function syncUndo(state) { if (state.undoBtn) state.undoBtn.disabled = !canUndo(state.section); }

function update(state, id, patch, msg) {
  state.items = state.items.map((x) => (x.id === id ? { ...x, ...patch } : x));
  saveItems(state.section, state.registry, state.items);
  syncUndo(state);
  refreshWidget(state, id);
  if (msg) state.liveRegion.textContent = msg;
}

function widgetChrome(it, state, el) {
  const def = state.registry[it.type];
  const handle = h('button', { class: 'widget-handle', type: 'button', 'aria-label': `Mover ${def.title}. Use as setas para reposicionar.`, title: 'Arraste para mover (ou use as setas)' }, icon('grip'));
  handle.addEventListener('pointerdown', (ev) => startDrag(ev, el, state));
  handle.addEventListener('keydown', (ev) => {
    const d = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[ev.key];
    if (!d) return;
    ev.preventDefault();
    moveBy(state, it.id, d);
  });
  const sizes = def.sizes || Object.keys(SIZES);
  const sizeSel = h('select', { class: 'select select-sm', 'aria-label': `Tamanho de ${def.title}` }, ...sizes.map((k) => h('option', { value: k }, SIZES[k].label)));
  sizeSel.value = it.size;
  sizeSel.addEventListener('change', () => update(state, it.id, { size: sizeSel.value }, `${def.title}: ${SIZES[sizeSel.value].label}`));
  let chartSel = null;
  if (def.charts?.length > 1) {
    chartSel = h('select', { class: 'select select-sm', 'aria-label': `Tipo de visualização de ${def.title}` }, ...def.charts.map((k) => h('option', { value: k }, CHART_LABELS[k] || k)));
    chartSel.value = it.chart;
    chartSel.addEventListener('change', () => update(state, it.id, { chart: chartSel.value }, `${def.title}: ${CHART_LABELS[chartSel.value]}`));
  }
  const colorBtn = def.color ? h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': `Cor de ${def.title}`, title: 'Cor de destaque' }, h('span', { class: 'swatch', style: { '--sw': colorCss(it.color) || 'var(--accent)' } })) : null;
  colorBtn?.addEventListener('click', () => openColorMenu(colorBtn, it.color, (c) => update(state, it.id, { color: c }, `${def.title}: cor alterada`)));
  const hideBtn = def.locked ? null : h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': it.hidden ? `Mostrar ${def.title}` : `Ocultar ${def.title}`, title: it.hidden ? 'Mostrar' : 'Ocultar',
    onclick: () => {
      update(state, it.id, { hidden: !it.hidden }, it.hidden ? `${def.title} visível` : `${def.title} oculto`);
      toast(it.hidden ? `“${def.title}” voltou para a tela` : `“${def.title}” oculto`, { action: { label: 'Desfazer', fn: () => { undoSection(state.section); state.rerender(); } } });
    } }, icon(it.hidden ? 'plus' : 'x', 'icon-sm'));
  return h('div', { class: 'widget-chrome' }, handle, h('span', { class: 'widget-title truncate' }, def.title), colorBtn, hideBtn, h('span', { class: 'widget-controls' }, chartSel, sizeSel));
}

export function openColorMenu(anchor, current, onPick) {
  const custom = h('input', { type: 'color', class: 'color-input', 'aria-label': 'Cor personalizada', value: hexOk(current) ? current : '#3355d1' });
  const items = Object.entries(PALETTE).map(([k, p]) => ({ label: p.label, icon: null, swatch: k, onSelect: () => onPick(k) }));
  openMenu(anchor, [...items.map((x) => ({ ...x, label: `${x.label}${current === x.swatch ? ' ✓' : ''}` })), 'sep', { label: 'Cor personalizada…', icon: 'palette', onSelect: () => {
    custom.addEventListener('change', () => {
      const safe = accessibleColor(custom.value);
      if (!safe) return;
      if (safe !== custom.value.toLowerCase()) toast('A cor foi ajustada para manter contraste legível nos temas claro e escuro.');
      onPick(safe);
    }, { once: true });
    document.body.append(custom);
    custom.click();
    setTimeout(() => custom.remove(), 60000);
  } }], { align: 'end' });
}

function editToolbar(state) {
  const undoBtn = h('button', { class: 'btn btn-sm', type: 'button', disabled: !canUndo(state.section), onclick: () => { if (undoSection(state.section)) { state.rerender(); toast('Alteração desfeita'); } } }, icon('undo', 'icon-sm'), 'Desfazer');
  state.undoBtn = undoBtn;
  return h('div', { class: 'edit-bar', role: 'toolbar', 'aria-label': 'Personalização' },
    icon('sliders', 'icon-sm'),
    h('span', { class: 'small grow' }, h('strong', null, 'Personalizando'), ' · arraste pela alça ou use as setas. Só a aparência muda.'),
    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openLibrary(state) }, icon('plus', 'icon-sm'), 'Componentes'),
    undoBtn,
    h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => {
      if (!(await confirmDialog({ title: 'Restaurar o layout padrão desta seção?', message: 'Volta à organização original desta seção. Nenhum dado financeiro é alterado.', confirmLabel: 'Restaurar layout' }))) return;
      resetSection(state.section); state.rerender(); toast('Layout padrão restaurado', { action: { label: 'Desfazer', fn: () => { undoSection(state.section); state.rerender(); } } });
    } }, 'Restaurar padrão'),
    h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => { setEditing(state.section, false); state.rerender(); toast('Personalização salva', { tone: 'success' }); } }, icon('check', 'icon-sm'), 'Concluir'));
}

function openLibrary(state) {
  const rows = Object.entries(state.registry).map(([type, def]) => {
    const it = state.items.find((x) => x.type === type);
    const visible = it && !it.hidden;
    return h('div', { class: 'lib-row' },
      h('div', { class: 'grow' }, h('strong', null, def.title), def.description ? h('div', { class: 'faint small' }, def.description) : null),
      visible ? h('span', { class: 'pill pill-done' }, 'na tela') : h('button', { class: 'btn btn-sm', type: 'button', onclick: () => {
        update(state, type, { hidden: false }, `${def.title} adicionado`);
        m.close();
        const el = state.grid.querySelector(`.widget[data-id="${CSS.escape(type)}"]`);
        el?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
        el?.classList.add('is-added');
        setTimeout(() => el?.classList.remove('is-added'), 900);
      } }, icon('plus', 'icon-sm'), 'Adicionar'));
  });
  const m = openModal({ title: 'Componentes disponíveis', size: 'sm', drawer: true, body: h('div', { class: 'lib-list' }, ...rows),
    footer: [h('span', { class: 'faint small' }, 'Cada componente aparece uma vez por seção.'), h('span', { class: 'grow' }), h('button', { class: 'btn btn-primary', type: 'button', onclick: () => m.close() }, 'Fechar')] });
}

// ——— Reordenação (FLIP) ———

function rects(grid) {
  const m = new Map();
  for (const el of grid.querySelectorAll('.widget, .widget-placeholder')) m.set(el, el.getBoundingClientRect());
  return m;
}
function flip(grid, before, skip) {
  if (prefersReducedMotion()) return;
  for (const el of grid.querySelectorAll('.widget, .widget-placeholder')) {
    if (el === skip) continue;
    const a = before.get(el);
    if (!a) continue;
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    el.getAnimations().forEach((an) => an.cancel());
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
}

function orderFromDom(state) {
  const ids = [...state.grid.querySelectorAll('.widget')].map((el) => el.dataset.id);
  const hidden = state.items.filter((x) => !ids.includes(x.id));
  state.items = [...ids.map((id) => state.items.find((x) => x.id === id)).filter(Boolean), ...hidden];
  saveItems(state.section, state.registry, state.items);
  syncUndo(state);
}

function moveBy(state, id, delta) {
  const els = [...state.grid.querySelectorAll('.widget')];
  const i = els.findIndex((el) => el.dataset.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= els.length) return;
  const before = rects(state.grid);
  if (delta < 0) els[j].before(els[i]); else els[j].after(els[i]);
  flip(state.grid, before);
  orderFromDom(state);
  els[i].querySelector('.widget-handle')?.focus();
  state.liveRegion.textContent = `${state.registry[els[i].dataset.type].title}: posição ${j + 1} de ${els.length}`;
}

function startDrag(ev, el, state) {
  if (ev.button !== 0 && ev.pointerType === 'mouse') return;
  ev.preventDefault();
  const grid = state.grid;
  const handle = ev.currentTarget;
  const r = el.getBoundingClientRect();
  const offX = ev.clientX - r.left, offY = ev.clientY - r.top;
  const origNext = el.nextSibling;
  const ph = h('div', { class: `widget-placeholder w-${state.items.find((x) => x.id === el.dataset.id)?.size || 'm'}` });
  ph.style.height = `${r.height}px`;
  el.before(ph);
  Object.assign(el.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, zIndex: 60, pointerEvents: 'none' });
  el.classList.add('is-dragging');
  document.body.classList.add('is-dragging-widget');
  try { handle.setPointerCapture(ev.pointerId); } catch { /* sem captura */ }
  let raf = 0, lastX = ev.clientX, lastY = ev.clientY, scrollRaf = 0;
  const place = () => {
    raf = 0;
    el.style.transform = `translate(${lastX - offX - r.left}px, ${lastY - offY - r.top}px) scale(1.015)`;
    const target = document.elementFromPoint(lastX, lastY)?.closest?.('.widget');
    if (!target || target === el || !grid.contains(target)) return;
    const tr = target.getBoundingClientRect();
    const sameRow = lastY > tr.top && lastY < tr.bottom;
    const after = sameRow ? lastX > tr.left + tr.width / 2 : lastY > tr.top + tr.height / 2;
    const ref = after ? target.nextSibling : target;
    if (ref === ph || (after && target.nextSibling === ph) || (!after && target.previousSibling === ph)) return;
    const before = rects(grid);
    grid.insertBefore(ph, ref);
    flip(grid, before, el);
  };
  const autoScroll = () => {
    const edge = 70;
    const dy = lastY < edge ? -12 : lastY > window.innerHeight - edge ? 12 : 0;
    if (dy) { window.scrollBy(0, dy); if (!raf) raf = requestAnimationFrame(place); }
    scrollRaf = requestAnimationFrame(autoScroll);
  };
  scrollRaf = requestAnimationFrame(autoScroll);
  const move = (e) => { lastX = e.clientX; lastY = e.clientY; if (!raf) raf = requestAnimationFrame(place); };
  const finish = (cancel) => {
    cancelAnimationFrame(raf); cancelAnimationFrame(scrollRaf);
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', cancelFn);
    document.removeEventListener('keydown', esc, true);
    if (cancel) { if (origNext && origNext.parentNode === grid) grid.insertBefore(ph, origNext); else ph.remove(), grid.append(ph); }
    const target = ph.getBoundingClientRect();
    const cur = el.getBoundingClientRect();
    const done = () => {
      el.getAnimations().forEach((an) => an.cancel());
      el.removeAttribute('style');
      const css = colorCss(state.items.find((x) => x.id === el.dataset.id)?.color);
      if (css) el.style.setProperty('--w-accent', css);
      el.classList.remove('is-dragging');
      document.body.classList.remove('is-dragging-widget');
      ph.replaceWith(el);
      if (!cancel) {
        orderFromDom(state);
        const pos = [...grid.querySelectorAll('.widget')].indexOf(el) + 1;
        state.liveRegion.textContent = `${state.registry[el.dataset.type].title}: posição ${pos}`;
      }
    };
    if (prefersReducedMotion()) { done(); return; }
    const an = el.animate([{ transform: el.style.transform || 'none' }, { transform: `translate(${target.left - r.left}px, ${target.top - r.top}px)` }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
    void cur;
    an.onfinish = done;
    an.oncancel = done;
  };
  const up = () => finish(false);
  const cancelFn = () => finish(true);
  const esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(true); } };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', cancelFn);
  document.addEventListener('keydown', esc, true);
}

/** Lista ordenável simples (abas, grupos, colunas): mesma lógica, uma dimensão. */
export function sortableList({ items, label, onChange, render }) {
  const list = h('div', { class: 'sortable', role: 'list', 'aria-label': label });
  const draw = () => put(list, ...items.map((it, i) => {
    const up = h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', disabled: i === 0, 'aria-label': `Mover ${it.label} para cima`, onclick: () => move(i, -1) }, icon('chev-left', 'icon-sm rot-90'));
    const down = h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', disabled: i === items.length - 1, 'aria-label': `Mover ${it.label} para baixo`, onclick: () => move(i, 1) }, icon('chev-right', 'icon-sm rot-90'));
    return h('div', { class: 'sortable-row', role: 'listitem', dataset: { id: it.id } }, icon('grip', 'icon-sm faint'), h('span', { class: 'grow' }, render ? render(it) : it.label), up, down);
  }));
  const move = (i, d) => {
    const before = new Map([...list.children].map((c) => [c.dataset.id, c.getBoundingClientRect()]));
    const next = items.slice();
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x);
    items = next;
    draw();
    if (!prefersReducedMotion()) for (const c of list.children) { const a = before.get(c.dataset.id); const b = c.getBoundingClientRect(); if (a && Math.abs(a.top - b.top) > 1) c.animate([{ transform: `translateY(${a.top - b.top}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' }); }
    list.querySelector(`[data-id="${CSS.escape(x.id)}"] button:not([disabled])`)?.focus();
    onChange(items);
  };
  draw();
  return list;
}

/**
 * Ordem e visibilidade de uma lista simples (abas, grupos, colunas).
 * Guardado em sections[section].options[key] = [{ id, hidden }].
 * Itens desconhecidos são descartados; itens novos entram no fim, visíveis.
 */
export function arrangedList(section, key, defs) {
  const ids = defs.map((d) => d.id);
  const saved = getSectionOptions(section)[key];
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(saved) ? saved : []) {
    if (!raw || typeof raw !== 'object' || !ids.includes(raw.id) || seen.has(raw.id)) continue;
    seen.add(raw.id);
    const def = defs.find((d) => d.id === raw.id);
    out.push({ ...def, hidden: def.locked ? false : Boolean(raw.hidden) });
  }
  for (const d of defs) if (!seen.has(d.id)) out.push({ ...d, hidden: false });
  if (out.every((x) => x.hidden)) out[0].hidden = false; // nunca uma lista vazia
  return out;
}

/** Diálogo para reordenar e ocultar itens; não altera dados financeiros. */
export function openArrangeDialog({ section, key, defs, title, note, onDone }) {
  let items = arrangedList(section, key, defs);
  const render = (it) => {
    const cb = h('input', { type: 'checkbox', checked: !it.hidden, disabled: it.locked, 'aria-label': `Mostrar ${it.label}` });
    cb.addEventListener('change', () => {
      const next = items.map((x) => (x.id === it.id ? { ...x, hidden: !cb.checked } : x));
      if (next.every((x) => x.hidden)) { cb.checked = true; toast('Mantenha pelo menos um item visível.'); return; }
      items = next;
    });
    return h('label', { class: 'row arrange-row' }, cb, h('span', null, it.label), it.locked ? h('span', { class: 'faint xsmall' }, 'sempre visível') : null);
  };
  const list = sortableList({ items, label: title, render, onChange: (next) => { items = next.map((n) => items.find((x) => x.id === n.id) || n); } });
  const m = openModal({ title, size: 'sm', body: h('div', { class: 'stack' }, note ? h('p', { class: 'faint small' }, note) : null, list),
    footer: [
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { setSectionOptions(section, { [key]: null }); m.close(); onDone?.(); toast('Ordem padrão restaurada', { action: { label: 'Desfazer', fn: () => { undoSection(section); onDone?.(); } } }); } }, 'Restaurar padrão'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { setSectionOptions(section, { [key]: items.map(({ id, hidden }) => ({ id, hidden: Boolean(hidden) })) }); flushLayout(); m.close(); onDone?.(); toast('Organização salva', { tone: 'success' }); } }, 'Salvar'),
    ] });
}
