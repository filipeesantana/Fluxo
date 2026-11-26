import { h, icon, put } from '../utils/dom.js';
import { fold } from '../services/suggest.js';

let openPicker = null;
let seq = 0;

/**
 * Seletor pesquisável (listbox ARIA) com recentes e criação inline.
 * options: [{ value, label, group?, color?, sub? }]
 * onCreate(name, kind?) → Promise<option>; createKinds: [{ value, label }] pede o tipo antes de criar.
 */
export function picker({ name, options, value = null, placeholder = 'Selecionar', emptyLabel = null, recent = [], onCreate, createKinds, createLabel = 'Criar', onChange, ariaLabel }) {
  const id = `pk-${++seq}`;
  let opts = options;
  let current = value || null;
  const wrap = h('div', { class: 'picker', dataset: { picker: name } });
  const valueEl = h('span', { class: 'picker-value' });
  const dot = h('span', { class: 'picker-dot', hidden: true });
  const btn = h('button', { class: 'picker-btn', type: 'button', id, 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': ariaLabel || null }, dot, valueEl, icon('chev-down', 'icon-sm'));
  wrap.append(btn);

  function labelOf(v) { return opts.find((o) => o.value === v)?.label; }
  function renderValue() {
    const o = opts.find((x) => x.value === current);
    valueEl.textContent = o ? o.label : (emptyLabel || placeholder);
    valueEl.classList.toggle('is-empty', !o);
    dot.hidden = !o?.color;
    if (o?.color) dot.style.setProperty('--bar-color', o.color);
  }

  function set(v, emit = true) {
    current = v || null;
    renderValue();
    if (emit) onChange?.(current);
  }

  function open(initial = '') {
    if (openPicker) openPicker.close();
    const pop = h('div', { class: 'picker-pop', role: 'dialog', 'aria-label': ariaLabel || placeholder });
    const search = h('input', { class: 'input', type: 'text', placeholder: onCreate ? 'Pesquisar ou criar…' : 'Pesquisar…', autocomplete: 'off', 'aria-controls': `${id}-list`, 'aria-autocomplete': 'list', role: 'combobox', 'aria-expanded': 'true' });
    const list = h('div', { class: 'picker-list', role: 'listbox', id: `${id}-list` });
    const kinds = h('div', { class: 'picker-kinds', hidden: true });
    pop.append(h('div', { class: 'picker-search' }, search), list, kinds);
    document.body.append(pop);
    let items = [];
    let active = 0;

    function build() {
      const q = fold(search.value);
      items = [];
      const groups = [];
      const add = (group, o) => { let g = groups.find((x) => x.name === group); if (!g) { g = { name: group, items: [] }; groups.push(g); } g.items.push(o); };
      if (!q && emptyLabel) add('', { value: null, label: emptyLabel, isNone: true });
      if (!q && recent.length) for (const r of recent) { const o = opts.find((x) => x.value === r); if (o) add('Recentes', o); }
      for (const o of opts) if (!q || fold(o.label).includes(q)) add(q ? '' : (o.group || (recent.length ? 'Todos' : '')), o);
      const exact = opts.some((o) => fold(o.label) === q);
      if (q && onCreate && !exact) add('', { value: '__create__', label: `${createLabel} “${search.value.trim()}”`, isCreate: true });
      const nodes = [];
      for (const g of groups) {
        if (g.name) nodes.push(h('div', { class: 'picker-group', role: 'presentation' }, g.name));
        for (const o of g.items) {
          const idx = items.length;
          items.push(o);
          const opt = h('button', {
            type: 'button', role: 'option', id: `${id}-o${idx}`, tabindex: '-1',
            class: `picker-opt${o.isCreate ? ' is-create' : ''}${o.value === current && !o.isCreate ? ' is-current' : ''}`,
            'aria-selected': 'false',
            onclick: () => choose(idx),
          }, o.isCreate ? icon('plus', 'icon-sm') : o.color ? h('span', { class: 'picker-dot', style: { '--bar-color': o.color } }) : null,
          h('span', { class: 'truncate' }, o.label), o.sub ? h('span', { class: 'opt-sub' }, o.sub) : null);
          opt.addEventListener('pointermove', () => highlight(idx));
          nodes.push(opt);
        }
      }
      if (!items.length) nodes.push(h('div', { class: 'picker-empty' }, 'Nada encontrado'));
      put(list, ...nodes);
      const cur = items.findIndex((o) => o.value === current && !o.isCreate);
      highlight(q ? 0 : Math.max(0, cur));
    }
    function highlight(i) {
      active = Math.max(0, Math.min(items.length - 1, i));
      list.querySelectorAll('.picker-opt').forEach((el, j) => {
        const on = j === active;
        el.classList.toggle('is-active', on);
        el.setAttribute('aria-selected', String(on));
        if (on) { search.setAttribute('aria-activedescendant', el.id); el.scrollIntoView({ block: 'nearest' }); }
      });
    }
    async function choose(i) {
      const o = items[i];
      if (!o) return;
      if (o.isCreate) {
        const nameText = search.value.trim();
        if (createKinds?.length) {
          put(kinds, h('span', { class: 'faint xsmall', style: { width: '100%' } }, `“${nameText}” é:`), ...createKinds.map((k, j) => h('button', { class: 'chip', type: 'button', dataset: { kind: k.value }, onclick: () => doCreate(nameText, k.value) }, k.label)));
          kinds.hidden = false;
          kinds.querySelector('.chip').focus();
          return;
        }
        return doCreate(nameText);
      }
      close();
      set(o.isNone ? null : o.value);
      btn.focus();
    }
    async function doCreate(nameText, kind) {
      try {
        const created = await onCreate(nameText, kind);
        if (!created) return;
        if (!opts.some((o) => o.value === created.value)) opts = [...opts, created];
        close();
        set(created.value);
        btn.focus();
      } catch (err) {
        put(kinds, h('span', { class: 'neg xsmall' }, err.message || 'Não foi possível criar'));
        kinds.hidden = false;
      }
    }
    function place() {
      const r = btn.getBoundingClientRect();
      const w = Math.max(r.width, 240);
      pop.style.width = `${w}px`;
      pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
      const below = window.innerHeight - r.bottom;
      const ph = Math.min(340, pop.offsetHeight || 300);
      if (below < ph + 12 && r.top > below) { pop.style.top = `${Math.max(8, r.top - ph - 4)}px`; pop.classList.add('is-up'); }
      else pop.style.top = `${r.bottom + 4}px`;
    }
    search.addEventListener('input', () => { kinds.hidden = true; build(); });
    search.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); highlight(active + 1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); highlight(active - 1); }
      else if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); choose(active); }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); btn.focus(); }
      else if (ev.key === 'Tab') close();
    });
    kinds.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); kinds.hidden = true; search.focus(); } });
    const onDown = (ev) => { if (!pop.contains(ev.target) && !btn.contains(ev.target)) close(); };
    const onScroll = (ev) => { if (!pop.contains(ev.target)) place(); };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', onScroll, true);
    function close() {
      if (openPicker?.pop !== pop) return;
      openPicker = null;
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', onScroll, true);
      wrap.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
      pop.classList.remove('is-open');
      setTimeout(() => pop.remove(), 140);
    }
    openPicker = { pop, close };
    wrap.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');
    search.value = initial;
    build();
    place();
    requestAnimationFrame(() => { pop.classList.add('is-open'); search.focus(); });
  }

  btn.addEventListener('click', () => (openPicker && wrap.classList.contains('is-open') ? openPicker.close() : open()));
  btn.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); open(); }
    else if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key !== ' ') { ev.preventDefault(); open(ev.key); }
  });

  renderValue();
  wrap.button = btn;
  wrap.getValue = () => current;
  wrap.setValue = (v) => set(v, false);
  wrap.choose = (v) => set(v, true);
  wrap.setOptions = (o) => { opts = o; if (current && !opts.some((x) => x.value === current)) current = null; renderValue(); };
  wrap.setRecent = (r) => { recent = r; };
  wrap.labelOf = labelOf;
  wrap.focus = () => btn.focus();
  return wrap;
}

export function closeOpenPicker() { openPicker?.close(); }
