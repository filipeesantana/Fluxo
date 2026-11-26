import { h, icon } from '../utils/dom.js';

let current = null;

/** Menu suspenso acessível ancorado a um botão. items: [{label, icon, onSelect, danger, disabled} | 'sep'] */
export function openMenu(anchor, items, { align = 'end' } = {}) {
  closeMenu();
  const list = h('div', { class: 'menu', role: 'menu' });
  const buttons = [];
  for (const it of items) {
    if (it === 'sep') { if (list.lastChild && !list.lastChild.classList.contains('menu-sep')) list.append(h('div', { class: 'menu-sep', role: 'separator' })); continue; }
    if (!it) continue;
    if (it.header) { list.append(h('div', { class: 'menu-header', role: 'presentation' }, it.header)); continue; }
    const checkable = typeof it.checked === 'boolean';
    const b = h('button', {
      class: `menu-item${it.danger ? ' is-danger' : ''}${it.checked ? ' is-checked' : ''}`, type: 'button', role: checkable ? 'menuitemradio' : 'menuitem', 'aria-checked': checkable ? String(it.checked) : null, disabled: it.disabled,
      onclick: (ev) => { ev.stopPropagation(); closeMenu(); it.onSelect(); },
    }, it.swatch ? h('span', { class: 'swatch', style: { '--sw': it.swatch === 'auto' ? 'var(--accent)' : `var(--pal-${it.swatch})` } }) : checkable ? (it.checked ? icon('check', 'icon-sm') : h('span', { class: 'icon-sm' })) : it.icon ? icon(it.icon, 'icon-sm') : h('span', { class: 'icon-sm' }), h('span', null, it.label));
    buttons.push(b);
    list.append(b);
  }
  if (list.lastChild?.classList.contains('menu-sep')) list.lastChild.remove();
  document.body.append(list);
  const r = anchor.getBoundingClientRect();
  const mw = list.offsetWidth, mh = list.offsetHeight;
  let left = align === 'end' ? r.right - mw : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  list.style.left = `${left}px`;
  list.style.top = `${top}px`;
  anchor.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => { list.classList.add('is-open'); buttons.find((b) => !b.disabled)?.focus(); });

  const onKey = (ev) => {
    const i = buttons.indexOf(document.activeElement);
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeMenu(); anchor.focus(); }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); buttons[(i + 1) % buttons.length].focus(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length].focus(); }
    else if (ev.key === 'Tab') closeMenu();
  };
  const onDown = (ev) => { if (!list.contains(ev.target) && ev.target !== anchor) closeMenu(); };
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => document.addEventListener('pointerdown', onDown, true));
  window.addEventListener('resize', closeMenu, { once: true });
  current = { list, anchor, cleanup: () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', onDown, true); } };
}

export function closeMenu() {
  if (!current) return;
  const { list, anchor, cleanup } = current;
  current = null;
  cleanup();
  anchor.setAttribute('aria-expanded', 'false');
  list.remove();
}
