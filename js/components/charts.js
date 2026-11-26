import { h, s, put, prefersReducedMotion } from '../utils/dom.js';
import { formatMoney, formatPercent, formatCompact } from '../utils/money.js';

const lastWidths = new Map();

/**
 * Largura do sistema de coordenadas ≈ largura real em pixels, para que o
 * texto dos eixos tenha sempre ~11 px (sem ampliar em telas largas nem
 * encolher no celular). frac = fração da área de conteúdo ocupada.
 */
export function autoWidth(frac = 1) {
  const v = document.getElementById('view');
  const w = v ? v.clientWidth - 64 : 720;
  return Math.max(300, Math.min(1500, Math.round(w * frac)));
}

// ——— Tooltip compartilhado ———
function tooltip(wrap) {
  const tip = h('div', { class: 'chart-tip', role: 'presentation' });
  wrap.append(tip);
  return {
    show(ev, title, rows) {
      put(tip, h('strong', null, title), ...rows.map(([label, value, sw]) => h('div', { class: 'tip-row' }, h('span', null, sw ? h('i', { class: `sw ${sw}` }) : null, label), h('span', null, value))));
      const r = wrap.getBoundingClientRect();
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      tip.classList.add('is-on');
      const w = tip.offsetWidth, ht = tip.offsetHeight;
      tip.style.left = `${Math.max(0, Math.min(x + 14, r.width - w))}px`;
      tip.style.top = `${Math.max(0, y - ht - 12)}px`;
    },
    hide() { tip.classList.remove('is-on'); },
  };
}

/**
 * Barras horizontais: identificação, valor, percentual, barra proporcional ao
 * total e cor estável. A parte prevista aparece hachurada.
 */
export function barList(groups, { id, labelOf, colorOf, onSelect, limit = 6, empty = 'Sem gastos neste período.', emptyAction } = {}) {
  if (!groups.length) return h('div', { class: 'empty-block' }, empty, emptyAction || null);
  const wrap = h('div', { class: 'bars' });
  let expanded = false;
  const render = () => {
    put(wrap);
    const list = expanded ? groups : groups.slice(0, limit);
    for (const g of list) {
      const key = `${id}:${g.key}`;
      const pct = Math.max(0, Math.min(100, g.pct));
      const plannedPct = g.total > 0 ? (Math.max(0, g.planned) / g.total) * pct : 0;
      const fill = h('span', { class: 'bar-fill' });
      const planned = h('span', { class: 'bar-planned' });
      const from = lastWidths.get(key) ?? 0;
      fill.style.width = `${from}%`;
      const label = labelOf(g.key);
      const color = colorOf ? colorOf(g.key) : 'var(--c1)';
      const row = h(onSelect ? 'button' : 'div', {
        class: 'bar-row', type: onSelect ? 'button' : null, style: { '--bar-color': color },
        title: onSelect ? `Ver movimentações de ${label}` : null,
        'aria-label': `${label}: ${formatMoney(g.total)}, ${formatPercent(g.pct, 0)} do total${g.planned ? `, ${formatMoney(g.planned)} previstos` : ''}`,
        onclick: onSelect ? () => onSelect(g.key) : null,
      },
      h('span', { class: 'bar-dot' }),
      h('span', { class: 'bar-name truncate' }, label),
      h('span', { class: 'bar-value num' }, formatMoney(g.total)),
      h('span', { class: 'bar-pct num' }, formatPercent(g.pct, g.pct >= 10 || g.pct === 0 ? 0 : 1)),
      h('span', { class: 'bar-track', 'aria-hidden': 'true' }, fill, plannedPct > 0.2 ? planned : null));
      planned.style.width = `${plannedPct}%`;
      planned.style.left = `${pct - plannedPct}%`;
      wrap.append(row);
      lastWidths.set(key, pct);
      if (prefersReducedMotion() || from === pct) fill.style.width = `${pct}%`;
      else requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${pct}%`; }));
    }
    if (groups.length > limit) {
      wrap.append(h('button', { class: 'link-btn bars-more', type: 'button', onclick: () => { expanded = !expanded; render(); } },
        expanded ? 'Mostrar menos' : `Mostrar todos (${groups.length})`));
    }
  };
  render();
  return wrap;
}

const anim = () => !prefersReducedMotion();

/** Gastos por dia: realizado (sólido) e previsto (claro), com média e dia atual. */
export function dailyChart(days, { todayDay = null, onSelectDay, width } = {}) {
  const W = width || autoWidth(0.66), H = 190, pad = { t: 12, r: 8, b: 22, l: 46 };
  const values = days.map((d) => Math.max(0, d.done) + Math.max(0, d.planned));
  const total = values.reduce((a, b) => a + b, 0);
  const wrap = h('div', { class: 'chart-wrap' });
  if (!total) { wrap.append(h('div', { class: 'chart-empty' }, 'Nenhum gasto neste mês ainda. Os lançamentos aparecem aqui por dia.')); return wrap; }
  const max = Math.max(...values, 1);
  const n = days.length;
  const bw = (W - pad.l - pad.r) / n;
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const active = values.filter((v) => v > 0).length;
  const avg = active ? total / active : 0;
  const svg = s('svg', { class: 'chart chart-daily', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Gastos por dia: total ${formatMoney(total)}` });
  for (const f of [0, 0.5, 1]) {
    svg.append(s('line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: y(max * f), y2: y(max * f) }));
    svg.append(s('text', { class: 'axis', x: pad.l - 8, y: y(max * f) + 4, 'text-anchor': 'end' }, formatCompact(max * f)));
  }
  const tip = tooltip(wrap);
  days.forEach((d, i) => {
    const x = pad.l + i * bw + bw * 0.16, w = bw * 0.68;
    const g = s('g', { class: `day${todayDay === d.day ? ' is-today' : ''}`, tabindex: onSelectDay ? '0' : null, role: onSelectDay ? 'button' : null, 'aria-label': `Dia ${d.day}: ${formatMoney(d.done)} realizado, ${formatMoney(d.planned)} previsto` });
    const doneH = (H - pad.t - pad.b) * (Math.max(0, d.done) / max);
    const planH = (H - pad.t - pad.b) * (Math.max(0, d.planned) / max);
    const base = H - pad.b;
    g.append(s('rect', { class: 'hit', x: pad.l + i * bw, y: pad.t, width: bw, height: H - pad.t - pad.b, rx: 3 }));
    if (planH > 0) g.append(s('rect', { class: `b-planned${anim() ? ' bar-anim' : ''}`, x, y: base - doneH - planH, width: w, height: planH, rx: 2 }));
    if (doneH > 0) g.append(s('rect', { class: `b-done${anim() ? ' bar-anim' : ''}`, x, y: base - doneH, width: w, height: doneH, rx: 2, style: anim() ? `animation-delay:${i * 8}ms` : null }));
    if (d.day === 1 || d.day % 5 === 0 || d.day === n) g.append(s('text', { class: 'axis', x: x + w / 2, y: H - 6, 'text-anchor': 'middle' }, String(d.day)));
    g.addEventListener('pointermove', (ev) => tip.show(ev, `Dia ${d.day}`, [['Realizado', formatMoney(d.done), 'sw-done'], ['Previsto', formatMoney(d.planned), 'sw-planned']]));
    g.addEventListener('pointerleave', () => tip.hide());
    if (onSelectDay) {
      g.addEventListener('click', () => onSelectDay(d.day));
      g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') onSelectDay(d.day); });
    }
    svg.append(g);
  });
  if (avg > 0) svg.append(s('line', { class: 'avg', x1: pad.l, x2: W - pad.r, y1: y(avg), y2: y(avg) }));
  const top = days.reduce((a, b) => ((b.done + b.planned) > (a.done + a.planned) ? b : a), days[0]);
  wrap.prepend(svg);
  wrap.append(h('div', { class: 'chart-legend' },
    h('span', { class: 'legend' }, h('i', { class: 'sw sw-done' }), 'Realizado'),
    h('span', { class: 'legend' }, h('i', { class: 'sw sw-planned' }), 'Previsto'),
    h('span', { class: 'legend' }, h('i', { class: 'sw sw-line s-prev is-dashed' }), `Média ${formatMoney(Math.round(avg))}/dia com gasto`),
    h('span', { class: 'faint' }, `Maior: dia ${top.day} · ${formatMoney(top.done + top.planned)}`)));
  return wrap;
}

/**
 * Gráfico de linhas genérico. series: [{ label, values, cls, area?, projectedFrom? }]
 * projectedFrom: índice a partir do qual a linha é tracejada (projeção).
 */
export function lineChart(series, labels, { target = null, height = 220, format = formatMoney, markIndex = null, empty, width, frac = 1 } = {}) {
  const wrap = h('div', { class: 'chart-wrap' });
  const all = series.flatMap((x) => x.values).concat(target != null ? [target] : []);
  if (empty && !all.some((v) => v)) { wrap.append(h('div', { class: 'chart-empty' }, empty)); return wrap; }
  const W = width || autoWidth(frac), H = height, pad = { t: 14, r: 14, b: 24, l: 58 };
  const max = Math.max(...all, 1) * 1.06;
  const min = Math.min(0, ...all) * 1.06;
  const n = labels.length;
  const x = (i) => pad.l + (W - pad.l - pad.r) * (n <= 1 ? 0 : i / (n - 1));
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - min) / (max - min || 1));
  const svg = s('svg', { class: 'chart chart-line', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': series.map((x) => x.label).join(', ') });
  for (let k = 0; k <= 4; k++) {
    const v = min + ((max - min) * k) / 4;
    svg.append(s('line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
    svg.append(s('text', { class: 'axis', x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, formatCompact(v)));
  }
  if (min < 0) svg.append(s('line', { class: 'zero', x1: pad.l, x2: W - pad.r, y1: y(0), y2: y(0) }));
  const step = Math.max(1, Math.ceil(n / 7));
  labels.forEach((l, i) => { if (i % step === 0 || i === n - 1) svg.append(s('text', { class: 'axis', x: x(i), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle' }, l)); });
  if (target != null) svg.append(s('line', { class: 'target', x1: pad.l, x2: W - pad.r, y1: y(target), y2: y(target) }));
  if (markIndex != null && markIndex >= 0 && markIndex < n) svg.append(s('line', { class: 'today-line', x1: x(markIndex), x2: x(markIndex), y1: pad.t, y2: H - pad.b }));
  const path = (vals, from, to) => vals.slice(from, to + 1).map((v, k) => `${k ? 'L' : 'M'}${x(from + k).toFixed(1)},${y(v).toFixed(1)}`).join('');
  for (const sr of series) {
    const last = sr.values.length - 1;
    const pf = sr.projectedFrom ?? null;
    if (sr.area) svg.append(s('path', { class: `area ${sr.cls}`, d: `${path(sr.values, 0, last)}L${x(last).toFixed(1)},${y(Math.max(min, 0))}L${x(0)},${y(Math.max(min, 0))}Z` }));
    if (pf == null || pf > last) svg.append(s('path', { class: `line ${sr.cls}${anim() ? ' line-anim' : ''}`, d: path(sr.values, 0, last), pathLength: '1' }));
    else {
      if (pf > 0) svg.append(s('path', { class: `line ${sr.cls}${anim() ? ' line-anim' : ''}`, d: path(sr.values, 0, pf), pathLength: '1' }));
      svg.append(s('path', { class: `line is-projection ${sr.cls}`, d: path(sr.values, Math.max(0, pf), last) }));
    }
  }
  const cursor = s('line', { class: 'cursor', x1: 0, x2: 0, y1: pad.t, y2: H - pad.b, visibility: 'hidden' });
  const dots = series.map((sr) => s('circle', { class: `dot ${sr.cls}`, r: 4, visibility: 'hidden' }));
  svg.append(cursor, ...dots);
  wrap.append(svg);
  const tip = tooltip(wrap);
  svg.addEventListener('pointermove', (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (n - 1))));
    cursor.setAttribute('x1', x(i)); cursor.setAttribute('x2', x(i)); cursor.setAttribute('visibility', 'visible');
    series.forEach((sr, k) => { dots[k].setAttribute('cx', x(i)); dots[k].setAttribute('cy', y(sr.values[i])); dots[k].setAttribute('visibility', sr.values[i] == null ? 'hidden' : 'visible'); });
    tip.show(ev, labels[i], series.map((sr) => [`${sr.label}${sr.projectedFrom != null && i >= sr.projectedFrom && i > 0 ? ' (projeção)' : ''}`, format(sr.values[i]), `sw-line ${sr.cls}`]));
  });
  svg.addEventListener('pointerleave', () => { cursor.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); tip.hide(); });
  wrap.append(h('div', { class: 'chart-legend' },
    ...series.map((sr) => h('span', { class: 'legend' }, h('i', { class: `sw sw-line ${sr.cls}` }), sr.label)),
    series.some((sr) => sr.projectedFrom != null) ? h('span', { class: 'legend' }, h('i', { class: 'sw sw-line is-dashed' }), 'Projeção') : null,
    target != null ? h('span', { class: 'legend' }, h('i', { class: 'sw sw-target' }), 'Meta') : null));
  return wrap;
}

/** Receitas × despesas por mês (meses futuros com opacidade reduzida). */
export function incomeExpenseChart(rows, { currentIndex = null, labelOf, onSelect, width } = {}) {
  const wrap = h('div', { class: 'chart-wrap' });
  if (!rows.some((r) => r.income || r.expense)) { wrap.append(h('div', { class: 'chart-empty' }, 'Ainda não há receitas ou despesas para comparar.')); return wrap; }
  const W = width || autoWidth(0.66), H = 210, pad = { t: 14, r: 8, b: 24, l: 58 };
  const max = Math.max(...rows.flatMap((r) => [r.income, r.expense]), 1) * 1.08;
  const n = rows.length;
  const gw = (W - pad.l - pad.r) / n;
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const svg = s('svg', { class: 'chart chart-ie', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Receitas e despesas por mês' });
  for (let k = 0; k <= 4; k++) {
    const v = (max * k) / 4;
    svg.append(s('line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
    svg.append(s('text', { class: 'axis', x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, formatCompact(v)));
  }
  const tip = tooltip(wrap);
  rows.forEach((r, i) => {
    const x0 = pad.l + i * gw;
    const bw = Math.min(26, gw * 0.3);
    const future = currentIndex != null && i > currentIndex;
    const g = s('g', { class: `month${future ? ' is-future' : ''}`, tabindex: onSelect ? '0' : null, role: onSelect ? 'button' : null, 'aria-label': `${labelOf(r.month)}: receitas ${formatMoney(r.income)}, despesas ${formatMoney(r.expense)}` });
    g.append(s('rect', { class: 'hit', x: x0, y: pad.t, width: gw, height: H - pad.t - pad.b, rx: 4 }));
    const base = H - pad.b;
    const ih = base - y(r.income), eh = base - y(r.expense);
    if (ih > 0) g.append(s('rect', { class: `b-income${anim() ? ' bar-anim' : ''}`, x: x0 + gw / 2 - bw - 2, y: base - ih, width: bw, height: ih, rx: 3 }));
    if (eh > 0) g.append(s('rect', { class: `b-expense${anim() ? ' bar-anim' : ''}`, x: x0 + gw / 2 + 2, y: base - eh, width: bw, height: eh, rx: 3 }));
    g.append(s('text', { class: 'axis', x: x0 + gw / 2, y: H - 6, 'text-anchor': 'middle', 'font-weight': i === currentIndex ? '650' : null }, labelOf(r.month)));
    g.addEventListener('pointermove', (ev) => tip.show(ev, `${labelOf(r.month)}${future ? ' · projeção' : ''}`, [['Receitas', formatMoney(r.income), 'sw-income'], ['Despesas', formatMoney(r.expense), 'sw-expense'], ['Sobra', formatMoney(r.income - r.expense), null]]));
    g.addEventListener('pointerleave', () => tip.hide());
    if (onSelect) { g.addEventListener('click', () => onSelect(r.month)); g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') onSelect(r.month); }); }
    svg.append(g);
  });
  wrap.prepend(svg);
  wrap.append(h('div', { class: 'chart-legend' },
    h('span', { class: 'legend' }, h('i', { class: 'sw sw-income' }), 'Receitas'),
    h('span', { class: 'legend' }, h('i', { class: 'sw sw-expense' }), 'Despesas'),
    currentIndex != null && currentIndex < n - 1 ? h('span', { class: 'faint' }, 'Meses seguintes em tom claro: projeção') : null));
  return wrap;
}

/** Barras de sobra mensal (positivas/negativas) para projeções longas. */
export function surplusBars(rows, { labelOf, compare = null, width, frac = 1 } = {}) {
  const wrap = h('div', { class: 'chart-wrap' });
  const W = width || autoWidth(frac), H = 200, pad = { t: 12, r: 8, b: 24, l: 58 };
  const vals = rows.map((r) => r.surplus).concat(compare ? compare.map((r) => r.surplus) : []);
  const max = Math.max(0, ...vals) * 1.1 || 1, min = Math.min(0, ...vals) * 1.1;
  const n = rows.length;
  const gw = (W - pad.l - pad.r) / n;
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - min) / (max - min || 1));
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Sobra mensal projetada' });
  for (let k = 0; k <= 4; k++) {
    const v = min + ((max - min) * k) / 4;
    svg.append(s('line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
    svg.append(s('text', { class: 'axis', x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, formatCompact(v)));
  }
  svg.append(s('line', { class: 'zero', x1: pad.l, x2: W - pad.r, y1: y(0), y2: y(0) }));
  const tip = tooltip(wrap);
  const step = Math.max(1, Math.ceil(n / 12));
  rows.forEach((r, i) => {
    const x0 = pad.l + i * gw;
    const bw = Math.max(2, Math.min(compare ? 12 : 22, gw * (compare ? 0.36 : 0.62)));
    const g = s('g');
    g.append(s('rect', { class: 'hit', x: x0, y: pad.t, width: gw, height: H - pad.t - pad.b }));
    const bar = (v, dx, cls) => { const top = y(Math.max(0, v)), hh = Math.abs(y(v) - y(0)); if (hh > 0) g.append(s('rect', { class: `${cls}${anim() ? ' bar-anim' : ''}`, x: dx, y: top, width: bw, height: hh, rx: 2 })); };
    if (compare) { bar(r.surplus, x0 + gw / 2 - bw - 1, r.surplus < 0 ? 'b-expense' : 'b-done'); bar(compare[i].surplus, x0 + gw / 2 + 1, 'b-sim'); }
    else bar(r.surplus, x0 + (gw - bw) / 2, r.surplus < 0 ? 'b-expense' : 'b-income');
    if (i % step === 0 || i === n - 1) g.append(s('text', { class: 'axis', x: x0 + gw / 2, y: H - 6, 'text-anchor': 'middle' }, labelOf(r.month)));
    g.addEventListener('pointermove', (ev) => tip.show(ev, labelOf(r.month), compare
      ? [['Atual', formatMoney(r.surplus), 'sw-done'], ['Cenário', formatMoney(compare[i].surplus), 'sw-sim'], ['Diferença', formatMoney(compare[i].surplus - r.surplus), null]]
      : [['Receitas', formatMoney(r.income), 'sw-income'], ['Despesas', formatMoney(r.expense), 'sw-expense'], ['Sobra', formatMoney(r.surplus), null], ['Acumulado', formatMoney(r.cumulative), null]]));
    g.addEventListener('pointerleave', () => tip.hide());
    svg.append(g);
  });
  wrap.prepend(svg);
  return wrap;
}

/** Barra de progresso simples (orçamentos, metas, parcelas). */
export function progress(ratio, { tone, small = false, label } = {}) {
  const r = Number.isFinite(ratio) ? ratio : 0;
  const pct = Math.max(0, Math.min(1, r)) * 100;
  const t = tone || (r > 1 ? 'neg' : r > 0.85 ? 'warn' : 'ok');
  const fill = h('span', { class: `progress-fill is-${t}` });
  const from = 0;
  fill.style.width = prefersReducedMotion() ? `${pct}%` : `${from}%`;
  if (!prefersReducedMotion()) requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${pct}%`; }));
  return h('span', { class: `progress${small ? ' progress-sm' : ''}`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)), 'aria-label': label || null }, fill);
}
