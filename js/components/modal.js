import { h, icon, FOCUSABLE, focusFirst, prefersReducedMotion } from '../utils/dom.js';

const stack = [];
const layer = () => document.getElementById('layer');

function setBackgroundInert(on) {
  for (const id of ['app', 'tabbar']) {
    const el = document.getElementById(id);
    if (el) el.inert = on;
  }
}

/**
 * Abre um diálogo modal acessível. A calculadora global fica fora da área
 * inerte para poder ser usada durante o preenchimento.
 */
export function openModal({ title, body, footer = [], size = 'md', onClose, closeOnScrim = true, className = '', drawer = false }) {
  const opener = document.activeElement;
  const titleId = `m-${Math.random().toString(36).slice(2, 8)}`;
  const closeBtn = h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': 'Fechar', onclick: () => close() }, icon('x'));
  const dialog = h('div', { class: `modal modal-${size} ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('header', { class: 'modal-head' }, h('h2', { id: titleId }, title), closeBtn),
    h('div', { class: 'modal-body' }, body),
    footer.length ? h('footer', { class: 'modal-foot' }, footer) : null,
  );
  const scrim = h('div', { class: 'modal-scrim' });
  const root = h('div', { class: `modal-root${drawer ? ' is-drawer' : ''}` }, scrim, dialog);
  if (closeOnScrim) scrim.addEventListener('pointerdown', () => close());

  let closed = false;
  const api = { el: dialog, root, body: dialog.querySelector('.modal-body'), close, setTitle: (t) => { dialog.querySelector('h2').textContent = t; } };

  function onKey(ev) {
    if (stack[stack.length - 1] !== api) return;
    if (ev.target.closest?.('.calc, .picker-pop, .menu')) return;
    if (ev.key === 'Escape' && document.querySelector('.picker-pop, .menu')) return;
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); }
    if (ev.key === 'Tab') {
      const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    }
  }

  function close(result) {
    if (closed) return;
    if (api.beforeClose && api.beforeClose() === false) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    const i = stack.indexOf(api);
    if (i >= 0) stack.splice(i, 1);
    if (!stack.length) setBackgroundInert(false);
    root.classList.remove('is-open');
    const done = () => { root.remove(); onClose?.(result); };
    if (prefersReducedMotion()) done(); else setTimeout(done, 220);
    if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
  }

  stack.push(api);
  layer().append(root);
  setBackgroundInert(true);
  document.addEventListener('keydown', onKey, true);
  requestAnimationFrame(() => { root.classList.add('is-open'); focusFirst(api.body); });
  return api;
}

export function confirmDialog({ title, message, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = false, details }) {
  return new Promise((resolve) => {
    let answered = false;
    const ok = h('button', { class: `btn ${danger ? 'btn-danger btn-solid' : 'btn-primary'}`, type: 'button', onclick: () => { answered = true; m.close(true); } }, confirmLabel);
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => m.close(false) }, cancelLabel);
    const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, message), details || null);
    const m = openModal({ title, body, footer: [h('span', { class: 'grow' }), cancel, ok], size: 'sm', onClose: () => resolve(answered) });
    requestAnimationFrame(() => (danger ? cancel : ok).focus());
  });
}

export function topModal() { return stack[stack.length - 1] || null; }
export function hasModal() { return stack.length > 0; }
