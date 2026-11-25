import { h, icon, put } from '../utils/dom.js';
import { parseMoney, formatMoneyInput } from '../utils/money.js';

let fieldSeq = 0;
const nextId = (p) => `${p}-${++fieldSeq}`;

export function field(label, control, { hint, id, className = '', error } = {}) {
  const input = control.matches?.('input, select, textarea') ? control : control.querySelector?.('input, select, textarea');
  const fid = id || input?.id || nextId('f');
  if (input && !input.id) input.id = fid;
  const hintEl = hint ? h('div', { class: 'field-hint', id: `${fid}-hint` }, hint) : null;
  if (hintEl && input) input.setAttribute('aria-describedby', hintEl.id);
  const err = h('div', { class: 'field-error', role: 'alert', hidden: !error }, error || '');
  const wrap = h('div', { class: `field ${className}` }, h('label', { class: 'field-label', for: fid }, label), control, hintEl, err);
  wrap.setError = (msg) => {
    err.textContent = msg || ''; err.hidden = !msg;
    if (input) input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  };
  return wrap;
}

/** Campo monetário: aceita "129,90", "1.234,56", "1234.56". Valor em centavos. */
export function moneyInput({ value = null, name, placeholder = '0,00', allowZero = false, large = false, onChange } = {}) {
  const input = h('input', {
    class: `input money-input${large ? ' is-large' : ''}`, type: 'text', inputmode: 'decimal', autocomplete: 'off',
    name, placeholder, value: value != null ? formatMoneyInput(value) : '', 'data-money': '',
  });
  const wrap = h('div', { class: 'money-field' }, h('span', { class: 'money-prefix', 'aria-hidden': 'true' }, 'R$'), input,
    h('button', { class: 'money-calc', type: 'button', tabindex: '-1', title: 'Calcular (Alt+C)', 'aria-label': 'Abrir calculadora para este campo', onclick: () => {
      input.focus();
      document.dispatchEvent(new CustomEvent('gf:calculator', { detail: { target: input } }));
    } }, icon('calc', 'icon-sm')));
  input.addEventListener('blur', () => {
    const c = parseMoney(input.value);
    if (c != null) input.value = formatMoneyInput(c);
  });
  input.addEventListener('input', () => onChange?.(parseMoney(input.value)));
  wrap.input = input;
  wrap.getValue = () => {
    const c = parseMoney(input.value);
    if (c == null) return null;
    if (!allowZero && c === 0) return null;
    return c;
  };
  wrap.setValue = (c) => { input.value = c == null ? '' : formatMoneyInput(c); };
  return wrap;
}

/**
 * Select nativo com opção "+ Novo…". Ao escolher, troca por um campo de texto
 * inline; Enter cria o item sem sair do formulário.
 */
export function selectWithCreate({ options, value, placeholder, createLabel, onCreate, onChange, name, allowEmpty = true }) {
  const wrap = h('div', { class: 'select-create' });
  const select = h('select', { class: 'select', name });
  const input = h('input', { class: 'input', type: 'text', placeholder: createLabel, hidden: true, maxlength: 80 });
  const ok = h('button', { class: 'btn btn-sm', type: 'button', hidden: true }, 'Criar');
  const cancel = h('button', { class: 'btn btn-ghost btn-sm btn-icon', type: 'button', hidden: true, 'aria-label': 'Cancelar' }, icon('x', 'icon-sm'));
  let current = value || '';
  let opts = options;

  function render() {
    put(select);
    if (allowEmpty || !opts.length) select.append(h('option', { value: '' }, placeholder));
    let group = null, groupEl = null;
    for (const o of opts) {
      if (o.group && o.group !== group) { group = o.group; groupEl = h('optgroup', { label: group }); select.append(groupEl); }
      (o.group ? groupEl : select).append(h('option', { value: o.value }, o.label));
    }
    if (onCreate) select.append(h('option', { value: '__create__' }, `+ ${createLabel}`));
    select.value = current;
    if (select.value !== current) select.value = allowEmpty ? '' : (opts[0]?.value || '');
    current = select.value === '__create__' ? '' : select.value;
  }
  function editing(on) {
    select.hidden = on; input.hidden = !on; ok.hidden = !on; cancel.hidden = !on;
    if (on) { input.value = ''; input.focus(); } else select.focus();
  }
  async function create() {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    ok.disabled = true;
    try {
      const item = await onCreate(name);
      if (item) {
        if (!opts.some((o) => o.value === item.value)) opts = [...opts, item];
        current = item.value;
        render();
        onChange?.(current);
      }
      editing(false);
    } finally { ok.disabled = false; }
  }
  select.addEventListener('change', () => {
    if (select.value === '__create__') { select.value = current; editing(true); return; }
    current = select.value;
    onChange?.(current);
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); create(); }
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); editing(false); }
  });
  ok.addEventListener('click', create);
  cancel.addEventListener('click', () => editing(false));
  render();
  wrap.append(select, input, ok, cancel);
  wrap.select = select;
  wrap.getValue = () => current || null;
  wrap.setValue = (v) => { current = v || ''; render(); };
  wrap.setOptions = (o) => { opts = o; render(); };
  return wrap;
}

/** Grupo segmentado (radiogroup) com navegação por setas. */
export function segmented({ options, value, onChange, label, size = '' }) {
  const group = h('div', { class: `segmented ${size}`, role: 'radiogroup', 'aria-label': label });
  const buttons = options.map((o) => h('button', {
    type: 'button', role: 'radio', class: 'seg', 'data-value': o.value, 'aria-checked': String(o.value === value), tabindex: o.value === value ? '0' : '-1',
    onclick: () => set(o.value, true),
  }, o.icon ? icon(o.icon, 'icon-sm') : null, o.label));
  group.append(...buttons);
  function set(v, emit) {
    value = v;
    for (const b of buttons) {
      const on = b.dataset.value === v;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (emit) onChange?.(v);
  }
  group.addEventListener('keydown', (ev) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(ev.key)) return;
    ev.preventDefault();
    const i = buttons.findIndex((b) => b.dataset.value === value);
    const n = buttons[(i + (ev.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length];
    set(n.dataset.value, true);
    n.focus();
  });
  group.getValue = () => value;
  group.setValue = (v) => set(v, false);
  return group;
}

/** Campo de texto com lista de sugestões (combobox ARIA). */
export function suggestInput({ value = '', placeholder, getSuggestions, renderItem, onPick, name, maxlength = 200 }) {
  const listId = nextId('sg');
  const input = h('input', { class: 'input', type: 'text', value, placeholder, name, maxlength, autocomplete: 'off', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId });
  const list = h('div', { class: 'suggest', role: 'listbox', id: listId, hidden: true });
  const wrap = h('div', { class: 'suggest-wrap' }, input, list);
  let items = [], active = -1, picking = false;

  function show() {
    items = getSuggestions(input.value);
    put(list, ...items.map((it, i) => {
      const opt = h('div', { class: 'suggest-item', role: 'option', id: `${listId}-${i}`, 'aria-selected': 'false' }, renderItem(it));
      opt.addEventListener('pointerdown', (ev) => { ev.preventDefault(); pick(i); });
      return opt;
    }));
    active = -1;
    const open = items.length > 0 && document.activeElement === input;
    list.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
  }
  function hide() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
  function highlight(i) {
    active = i;
    [...list.children].forEach((c, j) => c.setAttribute('aria-selected', String(j === i)));
    if (i >= 0) { input.setAttribute('aria-activedescendant', `${listId}-${i}`); list.children[i].scrollIntoView({ block: 'nearest' }); }
  }
  function pick(i) {
    const it = items[i];
    if (!it) return;
    picking = true;
    input.value = it.description;
    hide();
    onPick?.(it);
    picking = false;
  }
  input.addEventListener('input', () => { if (!picking) show(); });
  input.addEventListener('focus', () => { if (input.value) show(); });
  input.addEventListener('blur', () => setTimeout(hide, 80));
  input.addEventListener('keydown', (ev) => {
    if (list.hidden) return;
    if (ev.key === 'ArrowDown') { ev.preventDefault(); highlight(Math.min(items.length - 1, active + 1)); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); highlight(Math.max(-1, active - 1)); }
    else if (ev.key === 'Enter' && active >= 0) { ev.preventDefault(); ev.stopPropagation(); pick(active); }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); hide(); }
    else if (ev.key === 'Tab' && active >= 0) pick(active);
  });
  wrap.input = input;
  return wrap;
}

export function checkbox(label, { checked = false, onChange, name, hint } = {}) {
  const input = h('input', { type: 'checkbox', checked, name, onchange: () => onChange?.(input.checked) });
  const el = h('label', { class: 'check' }, input, h('span', null, label, hint ? h('span', { class: 'faint small' }, ` · ${hint}`) : null));
  el.input = input;
  return el;
}

export function intInput({ value, min, max, placeholder, name }) {
  return h('input', { class: 'input', type: 'number', inputmode: 'numeric', step: '1', min, max, value: value ?? '', placeholder, name });
}

export function readInt(input, { min = -Infinity, max = Infinity } = {}) {
  if (input.value === '') return null;
  const n = Number(input.value);
  return Number.isInteger(n) && n >= min && n <= max ? n : NaN;
}

/** Converte "10,5" ou "10.5" em número (percentuais). */
export function readDecimal(str) {
  const s = String(str).trim().replace('%', '').replace(',', '.');
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
