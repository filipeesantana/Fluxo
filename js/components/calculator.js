import { h, icon, put } from '../utils/dom.js';
import { evaluate, formatResult, CalcError } from '../services/calculator.js';
import { toCents, formatMoneyInput } from '../utils/money.js';
import { toast } from './toast.js';

const POS_KEY = 'gf.calc.pos';
const HIST_KEY = 'gf.calc.history';
const ALLOWED = /[0-9+\-*/().,%×÷−\s]/;

let panel = null;
let state = { open: false, target: null, lastMoney: null };

function readHistory() { try { return JSON.parse(sessionStorage.getItem(HIST_KEY)) || []; } catch { return []; } }
function writeHistory(h) { try { sessionStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, 6))); } catch { /* opcional */ } }

export function initCalculator() {
  document.addEventListener('focusin', (ev) => {
    if (ev.target.matches?.('[data-money]')) { state.lastMoney = ev.target; refreshTarget(); }
  });
  document.addEventListener('gf:calculator', (ev) => openCalculator(ev.detail?.target));
}

function liveTarget() {
  const t = state.target || state.lastMoney;
  return t && document.contains(t) && !t.disabled ? t : null;
}

function build() {
  const expr = h('input', { class: 'calc-expr', type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Expressão' });
  const result = h('output', { class: 'calc-result num', 'aria-live': 'polite' }, '0');
  const error = h('div', { class: 'calc-error', role: 'alert' });
  const history = h('div', { class: 'calc-history' });
  const useBtn = h('button', { class: 'btn btn-primary btn-sm calc-use', type: 'button', title: 'Inserir no campo (Ctrl+Enter)' }, 'Usar no campo');
  const copyBtn = h('button', { class: 'btn btn-sm', type: 'button', title: 'Copiar resultado' }, icon('copy', 'icon-sm'), 'Copiar');
  const targetLabel = h('div', { class: 'calc-target faint xsmall' });
  const head = h('div', { class: 'calc-head' },
    h('span', { class: 'calc-grip', 'aria-hidden': 'true' }, icon('grip', 'icon-sm')),
    h('span', { class: 'calc-title', id: 'calc-title' }, 'Calculadora'),
    h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': 'Fechar calculadora', onclick: () => closeCalculator() }, icon('x', 'icon-sm')),
  );
  const keys = [
    ['C', 'clear', 'k-fn'], ['(', '(', 'k-fn'], [')', ')', 'k-fn'], ['÷', '/', 'k-op'],
    ['7'], ['8'], ['9'], ['×', '*', 'k-op'],
    ['4'], ['5'], ['6'], ['−', '-', 'k-op'],
    ['1'], ['2'], ['3'], ['+', '+', 'k-op'],
    ['%', '%', 'k-fn'], ['0'], [',', ','], ['⌫', 'back', 'k-fn'],
  ];
  const pad = h('div', { class: 'calc-pad' }, ...keys.map(([label, val = label, cls = '']) =>
    h('button', { class: `calc-key ${cls}`, type: 'button', tabindex: '-1', 'aria-label': val === 'back' ? 'Apagar' : val === 'clear' ? 'Limpar' : label, onclick: () => press(val) }, label)));
  const eq = h('button', { class: 'calc-key k-eq', type: 'button', tabindex: '-1', onclick: () => commitEval() }, '=');
  pad.append(eq);

  const el = h('section', { class: 'calc', role: 'dialog', 'aria-labelledby': 'calc-title', hidden: true },
    head, h('div', { class: 'calc-screen' }, expr, result, error), pad,
    h('div', { class: 'calc-foot' }, targetLabel, h('div', { class: 'row' }, copyBtn, useBtn)), history);

  let lastValue = null;
  function preview() {
    error.textContent = '';
    const src = expr.value.trim();
    if (!src) { result.textContent = '0'; lastValue = null; return; }
    try { lastValue = evaluate(src); result.textContent = formatResult(lastValue); result.classList.remove('is-pending'); }
    catch { result.classList.add('is-pending'); lastValue = null; }
  }
  function commitEval() {
    const src = expr.value.trim();
    if (!src) return null;
    try {
      const v = evaluate(src);
      const hist = readHistory();
      hist.unshift({ e: src, v });
      writeHistory(hist);
      expr.value = formatResult(v).replace(/\./g, '');
      lastValue = v;
      result.textContent = formatResult(v);
      renderHistory();
      return v;
    } catch (e) {
      error.textContent = e instanceof CalcError ? e.message : 'Expressão inválida';
      return null;
    }
  }
  function press(val) {
    if (val === 'clear') expr.value = '';
    else if (val === 'back') expr.value = expr.value.slice(0, -1);
    else expr.value += val;
    preview();
    expr.focus();
  }
  function current() {
    if (lastValue != null && expr.value.trim()) {
      try { return evaluate(expr.value); } catch { return null; }
    }
    return lastValue;
  }
  function renderHistory() {
    const items = readHistory();
    put(history, ...items.map((it) => h('button', { class: 'calc-hist-item', type: 'button', onclick: () => { expr.value = String(it.v).replace('.', ','); preview(); expr.focus(); } },
      h('span', { class: 'faint truncate' }, it.e), h('span', { class: 'num' }, formatResult(it.v)))));
    history.hidden = !items.length;
  }
  async function copy() {
    const v = commitEval() ?? current();
    if (v == null) return;
    const text = formatResult(v);
    try { await navigator.clipboard.writeText(text); toast('Resultado copiado'); }
    catch { expr.select(); toast('Não foi possível copiar automaticamente', { tone: 'error' }); }
  }
  function use() {
    const t = liveTarget();
    const v = commitEval() ?? current();
    if (!t || v == null) return;
    t.value = formatMoneyInput(toCents(v));
    t.dispatchEvent(new Event('input', { bubbles: true }));
    t.dispatchEvent(new Event('change', { bubbles: true }));
    closeCalculator({ focusTarget: true });
    t.classList.add('flash');
    setTimeout(() => t.classList.remove('flash'), 600);
  }

  expr.addEventListener('beforeinput', (ev) => {
    if (ev.data && [...ev.data].some((c) => !ALLOWED.test(c) && c.toLowerCase() !== 'x')) ev.preventDefault();
  });
  expr.addEventListener('input', () => {
    const v = expr.value.replace(/x/gi, '×');
    if (v !== expr.value) expr.value = v;
    preview();
  });
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeCalculator({ focusTarget: true }); }
    else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); use(); }
    else if (ev.key === 'Enter' && ev.target === expr) { ev.preventDefault(); commitEval(); }
    else if (ev.key === 'Delete' && ev.target === expr && !expr.value) { ev.preventDefault(); }
  });
  copyBtn.addEventListener('click', copy);
  useBtn.addEventListener('click', use);
  setupDrag(el, head);
  renderHistory();
  el.refs = { expr, useBtn, targetLabel, preview };
  document.body.append(el);
  return el;
}

function refreshTarget() {
  if (!panel) return;
  const t = liveTarget();
  panel.refs.useBtn.disabled = !t;
  const label = t?.closest('.field')?.querySelector('.field-label')?.textContent;
  panel.refs.targetLabel.textContent = t ? `Campo: ${label || 'valor'}` : 'Abra a partir de um campo de valor para inserir o resultado';
}

function setupDrag(el, handle) {
  let start = null;
  handle.addEventListener('pointerdown', (ev) => {
    if (ev.target.closest('button') || window.innerWidth <= 760) return;
    const r = el.getBoundingClientRect();
    start = { x: ev.clientX, y: ev.clientY, left: r.left, top: r.top };
    handle.setPointerCapture(ev.pointerId);
    el.classList.add('is-dragging');
  });
  handle.addEventListener('pointermove', (ev) => {
    if (!start) return;
    place(el, start.left + ev.clientX - start.x, start.top + ev.clientY - start.y);
  });
  const end = () => {
    if (!start) return;
    start = null;
    el.classList.remove('is-dragging');
    try { localStorage.setItem(POS_KEY, JSON.stringify({ left: el.offsetLeft, top: el.offsetTop })); } catch { /* opcional */ }
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  window.addEventListener('resize', () => { if (!el.hidden && window.innerWidth > 760) place(el, el.offsetLeft, el.offsetTop); });
}

function place(el, left, top) {
  const w = el.offsetWidth, hgt = el.offsetHeight;
  el.style.left = `${Math.max(8, Math.min(left, window.innerWidth - w - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(top, window.innerHeight - hgt - 8))}px`;
  el.style.right = 'auto'; el.style.bottom = 'auto';
}

export function openCalculator(target) {
  if (!panel) panel = build();
  state.target = target && target.matches?.('[data-money]') ? target : (document.activeElement?.matches?.('[data-money]') ? document.activeElement : null);
  if (state.target) state.lastMoney = state.target;
  panel.hidden = false;
  if (window.innerWidth > 760) {
    let pos = null;
    try { pos = JSON.parse(localStorage.getItem(POS_KEY)); } catch { /* opcional */ }
    if (pos) place(panel, pos.left, pos.top);
    else place(panel, window.innerWidth - panel.offsetWidth - 24, window.innerHeight - panel.offsetHeight - 24);
  } else { panel.style.left = panel.style.top = panel.style.right = panel.style.bottom = ''; }
  const t = liveTarget();
  if (t && t.value && !panel.refs.expr.value) panel.refs.expr.value = t.value.replace(/\./g, '');
  panel.refs.preview();
  refreshTarget();
  requestAnimationFrame(() => { panel.classList.add('is-open'); panel.refs.expr.focus(); panel.refs.expr.select(); });
  state.open = true;
}

export function closeCalculator({ focusTarget = false } = {}) {
  if (!panel || panel.hidden) return;
  panel.classList.remove('is-open');
  state.open = false;
  const t = liveTarget();
  setTimeout(() => { if (!state.open) panel.hidden = true; }, 140);
  if (focusTarget && t) t.focus();
  state.target = null;
}

export function toggleCalculator(target) {
  if (state.open) closeCalculator({ focusTarget: true }); else openCalculator(target);
}

export function isCalculatorOpen() { return state.open; }
