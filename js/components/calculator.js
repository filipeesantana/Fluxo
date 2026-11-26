import { h, icon, put, uid } from '../utils/dom.js';
import { evaluate, formatResult, CalcError, TOOLS, average, parseInputNumber } from '../services/calculator.js';
import { REF_DEFS, resolveRefs, refMonth } from '../services/calc-refs.js';
import { toCents, formatMoneyInput, formatMoney } from '../utils/money.js';
import { currentMonth, today, formatMonth, formatMonthShort, isMonth } from '../utils/dates.js';
import * as repo from '../database/repository.js';
import { ui } from '../state.js';
import { toast, toastError } from './toast.js';
import { openModal, confirmDialog } from './modal.js';
import { openMenu } from './menu.js';

/*
 * Calculadora global e integrada.
 * - Continua sendo uma calculadora comum (teclado, histórico temporário, copiar, inserir no campo).
 * - "Valores do Fluxo" insere referências @1, @2… a dados reais (mês identificado).
 * - Ferramentas rápidas para porcentagens, divisões, médias e metas.
 * - Cálculos salvos no IndexedDB (entram no backup): ESTÁTICO guarda os valores
 *   do momento; DINÂMICO recalcula com os dados atuais e mostra os valores usados.
 * Nada aqui grava lançamentos: usar um resultado sempre passa por um formulário.
 */

const POS_KEY = 'gf.calc.pos';
const HIST_KEY = 'gf.calc.history';
const ALLOWED = /[0-9+\-*/().,%×÷−\s@de]/i;

let panel = null;
let state = { open: false, target: null, lastMoney: null, refs: [], view: 'calc' };

function readHistory() { try { const v = JSON.parse(sessionStorage.getItem(HIST_KEY)); return Array.isArray(v) ? v.filter((x) => x && typeof x.e === 'string' && Number.isFinite(x.v)) : []; } catch { return []; } }
function writeHistory(list) { try { sessionStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, 8))); } catch { /* opcional */ } }

const env = () => ({ ctx: repo.context(), get: repo.get, list: repo.list, selectedMonth: ui.month, currentMonth: currentMonth(), today: today() });

export function initCalculator() {
  document.addEventListener('focusin', (ev) => {
    if (ev.target.matches?.('[data-money]')) { state.lastMoney = ev.target; refreshTarget(); }
  });
  document.addEventListener('gf:calculator', (ev) => openCalculator(ev.detail?.target));
  // Dados mudaram: valores dinâmicos visíveis são recalculados (uma vez, sem laço).
  repo.subscribe(() => { if (state.open && panel) { panel.refs.preview(); if (state.view === 'saved') renderSaved(); } });
  window.addEventListener('resize', () => { if (panel && !panel.hidden) keepInView(panel); });
}

function liveTarget() {
  const t = state.target || state.lastMoney;
  return t && document.contains(t) && !t.disabled ? t : null;
}

function nextRefId() {
  for (let n = 1; n <= 12; n++) if (!state.refs.some((r) => r.id === `r${n}`)) return `r${n}`;
  return null;
}

function build() {
  const expr = h('input', { class: 'calc-expr', type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Expressão', maxlength: 400 });
  const result = h('output', { class: 'calc-result num', 'aria-live': 'polite' }, '0');
  const error = h('div', { class: 'calc-error', role: 'alert' });
  const legend = h('div', { class: 'calc-refs' });
  const history = h('div', { class: 'calc-history' });
  const useBtn = h('button', { class: 'btn btn-primary btn-sm calc-use', type: 'button', title: 'Inserir no campo (Ctrl+Enter)' }, 'Usar no campo');
  const copyBtn = h('button', { class: 'btn btn-sm', type: 'button', title: 'Copiar resultado', 'aria-label': 'Copiar resultado' }, icon('copy', 'icon-sm'));
  const newBtn = h('button', { class: 'btn btn-sm', type: 'button', title: 'Criar um lançamento com este valor (você confirma no formulário)' }, icon('plus', 'icon-sm'), 'Lançamento');
  const saveBtn = h('button', { class: 'btn btn-sm', type: 'button', title: 'Salvar este cálculo' }, icon('download', 'icon-sm'), 'Salvar');
  const targetLabel = h('div', { class: 'calc-target faint xsmall' });
  const tabCalc = h('button', { class: 'calc-tab', type: 'button', role: 'tab', 'aria-selected': 'true', onclick: () => setView('calc') }, 'Calcular');
  const tabSaved = h('button', { class: 'calc-tab', type: 'button', role: 'tab', 'aria-selected': 'false', onclick: () => setView('saved') }, 'Salvos');
  const compact = h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': 'Modo compacto', title: 'Modo compacto', onclick: () => { el.classList.toggle('is-compact'); keepInView(el); } }, icon('layers', 'icon-sm'));
  const head = h('div', { class: 'calc-head' },
    h('span', { class: 'calc-grip', 'aria-hidden': 'true' }, icon('grip', 'icon-sm')),
    h('span', { class: 'calc-title', id: 'calc-title' }, 'Calculadora'),
    h('div', { class: 'calc-tabs', role: 'tablist', 'aria-label': 'Calculadora' }, tabCalc, tabSaved),
    compact,
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
    h('button', { class: `calc-key ${cls}`, type: 'button', tabindex: '-1', dataset: { v: val }, 'aria-label': val === 'back' ? 'Apagar' : val === 'clear' ? 'Limpar' : label, onclick: () => press(val) }, label)));
  const eq = h('button', { class: 'calc-key k-eq', type: 'button', tabindex: '-1', onclick: () => commitEval() }, '=');
  pad.append(eq);

  // Linha de recursos: valores do Fluxo, “de” (10% de 800) e ferramentas.
  const refsBtn = h('button', { class: 'btn btn-sm calc-flux', type: 'button', 'aria-haspopup': 'dialog' }, icon('database', 'icon-sm'), 'Usar valores do Fluxo');
  const deBtn = h('button', { class: 'btn btn-sm', type: 'button', title: 'Porcentagem de um valor: 10% de 800', onclick: () => press(' de ') }, '% de');
  const toolsBtn = h('button', { class: 'btn btn-sm', type: 'button', 'aria-expanded': 'false' }, icon('sliders', 'icon-sm'), 'Ferramentas');
  const tools = toolsPanel((v) => { expr.value = String(Number(v.toFixed(6))).replace('.', ','); preview(); expr.focus(); });
  tools.hidden = true;
  toolsBtn.addEventListener('click', () => { tools.hidden = !tools.hidden; toolsBtn.setAttribute('aria-expanded', String(!tools.hidden)); keepInView(el); });
  refsBtn.addEventListener('click', () => openRefPicker((ref) => {
    const id = nextRefId();
    if (!id) { toast('Use no máximo 12 valores do Fluxo por cálculo', { tone: 'error' }); return; }
    state.refs.push({ ...ref, id });
    const n = id.slice(1);
    const v = expr.value.trimEnd();
    expr.value = `${v}${v && !/[+\-*/×÷−(de]$/i.test(v) ? ' × ' : v ? ' ' : ''}@${n}`;
    preview(); expr.focus();
  }));
  const help = h('details', { class: 'calc-help' }, h('summary', null, 'Como a % funciona'),
    h('ul', null, h('li', null, '10% de 800 = 80'), h('li', null, '800 + 10% = 880 (acréscimo)'), h('li', null, '800 − 10% = 720 (desconto)'), h('li', null, '800 × 10% = 80'), h('li', null, 'Use as Ferramentas para “quanto % 200 é de 800”.')));

  const calcView = h('div', { class: 'calc-view' },
    h('div', { class: 'calc-screen' }, expr, result, error, legend), pad,
    h('div', { class: 'calc-tools-row' }, refsBtn, deBtn, toolsBtn), tools,
    h('div', { class: 'calc-foot' }, targetLabel, h('div', { class: 'row' }, copyBtn, saveBtn, newBtn, useBtn)), help, history);
  const savedView = h('div', { class: 'calc-view calc-saved', hidden: true });
  const el = h('section', { class: 'calc', role: 'dialog', 'aria-labelledby': 'calc-title', hidden: true }, head, calcView, savedView);

  let lastValue = null;
  function preview() {
    error.textContent = '';
    renderLegend();
    const src = expr.value.trim();
    if (!src) { result.textContent = '0'; lastValue = null; return; }
    try { lastValue = evaluate(src, { refs: resolveRefs(state.refs, env()).values }); result.textContent = formatResult(lastValue); result.classList.remove('is-pending'); }
    catch (e) { result.classList.add('is-pending'); lastValue = null; if (/indisponível|grande demais|longa|Parênteses demais/.test(e?.message || '')) error.textContent = e.message; }
  }
  function renderLegend() {
    const used = state.refs.filter((r) => new RegExp(`@${r.id.slice(1)}(?!\\d)`).test(expr.value));
    if (used.length !== state.refs.length) state.refs = used;
    const { items } = resolveRefs(state.refs, env());
    put(legend, ...items.map((r) => h('span', { class: `calc-ref${r.ok ? '' : ' is-bad'}`, title: r.ok ? '' : r.reason },
      h('b', null, `@${r.id.slice(1)}`), ` ${r.label} `, h('span', { class: 'num' }, r.ok ? `= ${formatMoney(r.value)}` : `— ${r.reason}`))));
    legend.hidden = !items.length;
  }
  function commitEval() {
    const src = expr.value.trim();
    if (!src) return null;
    try {
      const v = evaluate(src, { refs: resolveRefs(state.refs, env()).values });
      const hist = readHistory();
      hist.unshift({ e: src, v });
      writeHistory(hist);
      // Expressões com valores do Fluxo continuam visíveis (para salvar); simples viram o resultado.
      if (!state.refs.length) expr.value = formatResult(v).replace(/\./g, '');
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
    if (val === 'clear') { expr.value = ''; state.refs = []; }
    else if (val === 'back') expr.value = expr.value.slice(0, -1);
    else expr.value += val;
    preview();
    expr.focus();
  }
  function current() {
    try { return expr.value.trim() ? evaluate(expr.value, { refs: resolveRefs(state.refs, env()).values }) : lastValue; } catch { return null; }
  }
  function renderHistory() {
    const items = readHistory();
    put(history, items.length ? h('div', { class: 'calc-hist-title' }, 'Histórico desta sessão') : null, ...items.map((it) => h('button', { class: 'calc-hist-item', type: 'button', onclick: () => { expr.value = String(it.v).replace('.', ','); state.refs = []; preview(); expr.focus(); } },
      h('span', { class: 'faint truncate' }, it.e), h('span', { class: 'num' }, formatResult(it.v)))));
    history.hidden = !items.length;
  }
  async function copy() {
    const v = current();
    if (v == null) return;
    const text = formatResult(v);
    try { await navigator.clipboard.writeText(text); toast('Resultado copiado'); }
    catch { expr.select(); toast('Não foi possível copiar automaticamente; o texto foi selecionado.', { tone: 'error' }); }
  }
  function use() {
    const t = liveTarget();
    const v = current();
    if (!t || v == null) return;
    t.value = formatMoneyInput(toCents(v));
    t.dispatchEvent(new Event('input', { bubbles: true }));
    t.dispatchEvent(new Event('change', { bubbles: true }));
    closeCalculator({ focusTarget: true });
    t.classList.add('flash');
    setTimeout(() => t.classList.remove('flash'), 600);
  }
  async function newEntry() {
    const v = current();
    if (v == null || v <= 0) { toast('O resultado precisa ser maior que zero', { tone: 'error' }); return; }
    const { openEntryForm } = await import('./entry-form.js');
    openEntryForm({ defaults: { amount: toCents(v) } });
  }
  function save() {
    const v = current();
    if (v == null) { toast('Calcule algo antes de salvar', { tone: 'error' }); return; }
    openSaveDialog({ expr: expr.value.trim(), refs: state.refs.map((r) => ({ ...r })), value: v });
  }
  function setView(v) {
    state.view = v;
    tabCalc.setAttribute('aria-selected', String(v === 'calc'));
    tabSaved.setAttribute('aria-selected', String(v === 'saved'));
    calcView.hidden = v !== 'calc';
    savedView.hidden = v !== 'saved';
    if (v === 'saved') renderSaved();
    keepInView(el);
  }

  // Feedback visual da tecla correspondente ao digitar no teclado físico.
  const keyFor = { '*': '*', x: '*', X: '*', '/': '/', '+': '+', '-': '-', '%': '%', '(': '(', ')': ')', ',': ',', '.': ',', Backspace: 'back', Enter: '=' };
  expr.addEventListener('keydown', (ev) => {
    const v = /^[0-9]$/.test(ev.key) ? ev.key : keyFor[ev.key];
    if (!v) return;
    const btn = [...pad.querySelectorAll('.calc-key')].find((b) => (v === '=' ? b.classList.contains('k-eq') : b.dataset.v === v));
    if (!btn) return;
    btn.classList.add('is-pressed');
    setTimeout(() => btn.classList.remove('is-pressed'), 110);
  });
  expr.addEventListener('beforeinput', (ev) => {
    if (ev.data && [...ev.data].some((c) => !ALLOWED.test(c) && c.toLowerCase() !== 'x')) ev.preventDefault();
  });
  expr.addEventListener('input', () => {
    const v = expr.value.replace(/x/gi, '×');
    if (v !== expr.value) expr.value = v;
    preview();
  });
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { if (ev.target.closest('.menu')) return; ev.preventDefault(); ev.stopPropagation(); closeCalculator({ focusTarget: true }); }
    else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); use(); }
    else if (ev.key === 'Enter' && ev.target === expr) { ev.preventDefault(); commitEval(); }
  });
  copyBtn.addEventListener('click', copy);
  useBtn.addEventListener('click', use);
  newBtn.addEventListener('click', newEntry);
  saveBtn.addEventListener('click', save);
  setupDrag(el, head);
  renderHistory();
  el.refs = { expr, useBtn, targetLabel, preview, savedView, setView, load: (calc) => { setView('calc'); expr.value = calc.expr; state.refs = calc.mode === 'dynamic' ? calc.refs.map((r) => ({ ...r })) : []; if (calc.mode === 'static' && calc.refs.length) expr.value = staticExpr(calc); preview(); expr.focus(); } };
  document.body.append(el);
  return el;
}

/** Expressão estática: referências substituídas pelos valores guardados. */
function staticExpr(calc) {
  return calc.expr.replace(/@(\d{1,2})/g, (m, n) => { const v = calc.values?.[`r${n}`]; return Number.isFinite(v) ? String(v).replace('.', ',') : m; });
}

// ——— Ferramentas rápidas ———

function toolsPanel(onUse) {
  const sel = h('select', { class: 'select select-sm', 'aria-label': 'Ferramenta' }, ...Object.entries(TOOLS).map(([k, t]) => h('option', { value: k }, t.label)), h('option', { value: 'avg' }, 'Média de valores'));
  const a = h('input', { class: 'input input-sm', inputmode: 'decimal', 'aria-label': 'Primeiro valor' });
  const b = h('input', { class: 'input input-sm', inputmode: 'decimal', 'aria-label': 'Segundo valor' });
  const la = h('label', { class: 'xsmall faint' }), lb = h('label', { class: 'xsmall faint' });
  const out = h('div', { class: 'calc-tool-out', 'aria-live': 'polite' });
  let last = null;
  const useBtn = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { if (last != null) onUse(last); } }, 'Usar resultado');
  const run = () => {
    last = null;
    try {
      const k = sel.value;
      const r = k === 'avg' ? average(a.value) : TOOLS[k].run(parseInputNumber(a.value), parseInputNumber(b.value));
      last = r.value;
      put(out, h('strong', { class: 'num' }, r.unit === 'percent' ? `${formatResult(Number(r.value.toFixed(2)))}%` : formatMoney(Math.round(r.value * 100))), h('span', { class: 'faint xsmall' }, ` ${r.text}`));
    } catch (e) { put(out, h('span', { class: 'faint xsmall' }, e instanceof CalcError ? e.message : 'Preencha os valores')); }
  };
  const sync = () => {
    const k = sel.value;
    la.textContent = k === 'avg' ? 'Valores (separados por espaço ou ;)' : TOOLS[k].a;
    lb.textContent = k === 'avg' ? '' : TOOLS[k].b;
    b.hidden = lb.hidden = k === 'avg';
    run();
  };
  sel.addEventListener('change', sync);
  a.addEventListener('input', run); b.addEventListener('input', run);
  sync();
  return h('div', { class: 'calc-tools' }, sel, h('div', { class: 'calc-tool-grid' }, h('div', null, la, a), h('div', null, lb, b)), h('div', { class: 'row' }, out, h('span', { class: 'grow' }), useBtn));
}

// ——— "Usar valores do Fluxo" ———

function openRefPicker(onPick) {
  const kind = h('select', { class: 'select', 'aria-label': 'Informação' },
    h('optgroup', { label: 'Resumo do mês' }, ...['projectedSurplus', 'availableToInvest', 'freeSurplus', 'incomeReceived', 'incomeExpected', 'incomeTotal', 'expenseDone', 'expensePending', 'expenseTotal'].map((k) => h('option', { value: k }, REF_DEFS[k].label))),
    h('optgroup', { label: 'Totais e registros' }, ...['category', 'block', 'source', 'accountBalance', 'patrimony', 'goalTarget', 'goalRemaining', 'commitmentLeft', 'transaction'].map((k) => h('option', { value: k }, REF_DEFS[k].label))));
  const entity = h('select', { class: 'select', 'aria-label': 'Qual' });
  const monthMode = h('select', { class: 'select', 'aria-label': 'Período' }, h('option', { value: 'selected' }, `Mês selecionado (${formatMonthShort(ui.month)})`), h('option', { value: 'current' }, `Mês atual (${formatMonthShort(currentMonth())})`), h('option', { value: 'fixed' }, 'Um mês específico…'));
  const fixed = h('input', { class: 'input', type: 'month', value: ui.month, 'aria-label': 'Mês' });
  const preview = h('p', { class: 'calc-ref-preview' });
  const fEntity = h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Qual'), entity);
  const fMonth = h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Período'), monthMode, fixed);
  const ref = () => ({ kind: kind.value, entityId: REF_DEFS[kind.value].entity ? entity.value || null : null, month: !REF_DEFS[kind.value].month ? null : monthMode.value === 'fixed' ? fixed.value : monthMode.value });
  const fillEntity = () => {
    const def = REF_DEFS[kind.value];
    fEntity.hidden = !def.entity;
    fMonth.hidden = !def.month;
    fixed.hidden = monthMode.value !== 'fixed';
    if (def.entity) {
      let rows = repo.list(def.entity).filter((x) => !x.archived);
      if (def.entity === 'categories') rows = rows.filter((c) => c.type === 'expense');
      if (def.entity === 'transactions') rows = rows.filter((t) => t.month === ui.month).sort((x, y) => y.amount - x.amount).slice(0, 80);
      put(entity, ...rows.map((x) => h('option', { value: x.id }, def.entity === 'transactions' ? `${x.description} · ${formatMoney(x.amount)}` : x.name || x.description)));
      if (!rows.length) put(entity, h('option', { value: '' }, 'Nenhum item disponível'));
    }
    updatePreview();
  };
  const updatePreview = () => {
    const r = resolveRefs([{ ...ref(), id: 'r1' }], env()).items[0];
    preview.textContent = r.ok ? `${r.label} = ${formatMoney(r.value)}` : `${r.label}: ${r.reason}`;
    preview.classList.toggle('is-bad', !r.ok);
  };
  kind.addEventListener('change', fillEntity); entity.addEventListener('change', updatePreview); monthMode.addEventListener('change', fillEntity); fixed.addEventListener('change', updatePreview);
  fillEntity();
  const go = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => {
    const r = ref();
    if (REF_DEFS[r.kind].entity && !r.entityId) { toast('Escolha um item', { tone: 'error' }); return; }
    if (r.month && r.month !== 'current' && r.month !== 'selected' && !isMonth(r.month)) { toast('Escolha um mês válido', { tone: 'error' }); return; }
    m.close(); onPick(r);
  } }, 'Inserir');
  const m = openModal({ title: 'Usar valores do Fluxo', size: 'sm', className: 'calc-ref-modal', body: h('div', { class: 'stack' },
    h('p', { class: 'faint small' }, 'O valor entra no cálculo como @1, @2… com o mês identificado. Nada é alterado nos seus registros.'),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Informação'), kind), fEntity, fMonth, preview),
  footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), go] });
}

// ——— Cálculos salvos ———

function openSaveDialog({ expr, refs, value, existing = null }) {
  const name = h('input', { class: 'input', maxlength: 80, value: existing?.name || '', placeholder: 'Ex.: Reserva mensal para a moto', name: 'calcName' });
  let mode = existing?.mode || (refs.length ? 'dynamic' : 'static');
  const modeSel = h('div', { class: 'scope-list' },
    ...[['dynamic', 'Dinâmico', 'Recalcula com os dados atuais do Fluxo (ex.: 70% da sobra do mês).'], ['static', 'Estático', 'Guarda os valores de agora como referência histórica.']].map(([v, l, d]) => {
      const b = h('button', { class: 'scope-opt', type: 'button', role: 'radio', 'aria-checked': String(mode === v), disabled: v === 'dynamic' && !refs.length, dataset: { mode: v }, onclick: () => { mode = v; modeSel.querySelectorAll('.scope-opt').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.mode === v))); } }, h('strong', null, l), h('span', null, v === 'dynamic' && !refs.length ? 'Disponível quando o cálculo usa valores do Fluxo.' : d));
      return b;
    }));
  const fav = h('input', { type: 'checkbox', checked: Boolean(existing?.favorite) });
  const go = h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
    if (!name.value.trim()) { toast('Dê um nome ao cálculo', { tone: 'error' }); name.focus(); return; }
    go.classList.add('is-busy'); go.disabled = true;
    try {
      const res = resolveRefs(refs, env());
      const row = {
        id: existing?.id, name: name.value.trim(), expr, refs, mode, favorite: fav.checked,
        value: Number.isFinite(value) ? value : null,
        values: mode === 'static' ? res.values : undefined,
        unit: 'money',
        refMonth: refs.map((r) => refMonth(r, env())).find(Boolean) || null,
      };
      if (!row.refMonth) delete row.refMonth;
      await repo.saveCalculation(row);
      m.close();
      toast(existing ? 'Cálculo atualizado' : `Cálculo “${row.name}” salvo`, { tone: 'success' });
      if (panel) panel.refs.setView('saved');
    } catch (err) { toastError(err); go.disabled = false; } finally { go.classList.remove('is-busy'); }
  } }, 'Salvar');
  const m = openModal({ title: existing ? 'Editar cálculo' : 'Salvar cálculo', size: 'sm', body: h('div', { class: 'stack' },
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Nome'), name),
    h('p', { class: 'faint small' }, `Expressão: ${expr || '—'} · resultado agora: ${Number.isFinite(value) ? formatResult(value) : '—'}`),
    modeSel, h('label', { class: 'check' }, fav, h('span', null, 'Favorito (aparece primeiro)'))),
  footer: [h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), go] });
}

/** Valor de um cálculo salvo: dinâmico usa os dados atuais; estático, os valores guardados. */
export function calcValue(calc) {
  try {
    if (calc.mode === 'static') return { ok: true, value: evaluate(calc.expr, { refs: calc.values || {} }), items: [] };
    const { values, items } = resolveRefs(calc.refs, env());
    const bad = items.find((i) => !i.ok);
    if (bad) return { ok: false, reason: `${bad.label}: ${bad.reason}`, items };
    return { ok: true, value: evaluate(calc.expr, { refs: values }), items };
  } catch (err) { return { ok: false, reason: err instanceof CalcError ? err.message : 'Cálculo inválido', items: [] }; }
}

function renderSaved() {
  if (!panel) return;
  const box = panel.refs.savedView;
  const list = repo.list('calculations').sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!list.length) { put(box, h('div', { class: 'empty-block' }, 'Nenhum cálculo salvo. Calcule algo e toque em “Salvar”.')); return; }
  put(box, ...list.map((c) => {
    const r = calcValue(c);
    const more = h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': `Ações de ${c.name}`, 'aria-haspopup': 'menu' }, icon('more', 'icon-sm'));
    more.addEventListener('click', () => openMenu(more, [
      { label: 'Reutilizar na calculadora', icon: 'calc', onSelect: () => panel.refs.load(c) },
      r.ok ? { label: 'Copiar resultado', icon: 'copy', onSelect: () => navigator.clipboard?.writeText(formatResult(r.value)).then(() => toast('Resultado copiado')).catch(() => toast('Não foi possível copiar', { tone: 'error' })) } : null,
      r.ok ? { label: 'Usar em novo lançamento', icon: 'plus', onSelect: async () => { const { openEntryForm } = await import('./entry-form.js'); openEntryForm({ defaults: { amount: toCents(r.value) } }); } } : null,
      { label: 'Editar nome e tipo', icon: 'edit', onSelect: () => openSaveDialog({ expr: c.expr, refs: c.refs, value: r.ok ? r.value : c.value, existing: c }) },
      { label: 'Duplicar', icon: 'copy', onSelect: () => repo.saveCalculation({ ...c, id: undefined, name: `${c.name} (cópia)`.slice(0, 80), createdAt: undefined }).then(() => toast('Cálculo duplicado')).catch(toastError) },
      { label: c.favorite ? 'Remover dos favoritos' : 'Favoritar', icon: 'sparkle', onSelect: () => repo.saveCalculation({ ...c, favorite: !c.favorite }).catch(toastError) },
      'sep',
      { label: 'Excluir', icon: 'trash', danger: true, onSelect: async () => {
        if (!(await confirmDialog({ title: 'Excluir cálculo?', message: `“${c.name}” será removido. Nenhum lançamento é afetado.`, confirmLabel: 'Excluir', danger: true }))) return;
        try { const removed = await repo.deleteCalculation(c.id); toast('Cálculo excluído', { action: { label: 'Desfazer', fn: () => repo.saveCalculation(removed).catch(toastError) } }); } catch (err) { toastError(err); }
      } },
    ]));
    return h('div', { class: `calc-saved-row${r.ok ? '' : ' is-bad'}`, dataset: { id: c.id } },
      h('div', { class: 'grow' },
        h('div', { class: 'row' }, c.favorite ? icon('sparkle', 'icon-sm calc-fav') : null, h('strong', { class: 'small truncate' }, c.name), h('span', { class: `tag ${c.mode === 'dynamic' ? 'tag-soft' : ''}` }, c.mode === 'dynamic' ? 'dinâmico' : 'estático')),
        h('div', { class: 'faint xsmall truncate' }, c.mode === 'static' ? staticExpr(c) : c.expr, c.refMonth ? ` · ${formatMonth(c.refMonth)}` : ''),
        r.ok && r.items.length ? h('div', { class: 'faint xsmall' }, r.items.map((i) => `@${i.id.slice(1)} ${i.label} = ${formatMoney(i.value)}`).join(' · ')) : null,
        r.ok ? null : h('div', { class: 'warn xsmall' }, icon('alert', 'icon-sm'), ` Indisponível: ${r.reason}. Nenhum valor foi substituído por zero.`)),
      h('strong', { class: 'num calc-saved-value' }, r.ok ? formatResult(Number(r.value.toFixed(2))) : '—'), more);
  }));
}

function refreshTarget() {
  if (!panel) return;
  const t = liveTarget();
  panel.refs.useBtn.disabled = !t;
  panel.refs.useBtn.hidden = !t;
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
}

function place(el, left, top) {
  const w = el.offsetWidth, hgt = el.offsetHeight;
  el.style.left = `${Math.max(8, Math.min(left, window.innerWidth - w - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(top, window.innerHeight - hgt - 8))}px`;
  el.style.right = 'auto'; el.style.bottom = 'auto';
}

/** Mantém a calculadora inteira na tela após mudanças de tamanho (nunca fica presa fora da viewport). */
function keepInView(el) {
  if (window.innerWidth <= 760) { el.style.left = el.style.top = el.style.right = el.style.bottom = ''; return; }
  requestAnimationFrame(() => place(el, el.offsetLeft, el.offsetTop));
}

export function openCalculator(target) {
  if (!panel) panel = build();
  state.target = target && target.matches?.('[data-money]') ? target : (document.activeElement?.matches?.('[data-money]') ? document.activeElement : null);
  if (state.target) state.lastMoney = state.target;
  panel.hidden = false;
  if (window.innerWidth > 760) {
    let pos = null;
    try { pos = JSON.parse(localStorage.getItem(POS_KEY)); } catch { /* opcional */ }
    if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) place(panel, pos.left, pos.top);
    else place(panel, window.innerWidth - panel.offsetWidth - 24, window.innerHeight - panel.offsetHeight - 24);
  } else { panel.style.left = panel.style.top = panel.style.right = panel.style.bottom = ''; }
  const t = liveTarget();
  if (t && t.value && !panel.refs.expr.value) panel.refs.expr.value = t.value.replace(/\./g, '');
  panel.refs.preview();
  refreshTarget();
  requestAnimationFrame(() => { panel.classList.add('is-open'); panel.refs.expr.focus(); panel.refs.expr.select(); });
  state.open = true;
}

/** Abre já com um valor (ex.: "Calcular com este valor" em um lançamento). */
export function openCalculatorWith(cents, label) {
  openCalculator(null);
  panel.refs.setView('calc');
  state.refs = [];
  panel.refs.expr.value = (cents / 100).toFixed(2).replace('.', ',');
  panel.refs.preview();
  if (label) toast(`Valor de “${label}” na calculadora`);
}

/** Abre com uma referência dinâmica (ex.: "Usar na calculadora" em um indicador). */
export function openCalculatorWithRef(ref) {
  openCalculator(null);
  panel.refs.setView('calc');
  state.refs = [{ ...ref, id: 'r1' }];
  panel.refs.expr.value = '@1';
  panel.refs.preview();
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
export { uid };
