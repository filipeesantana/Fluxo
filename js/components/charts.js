import { h, s, prefersReducedMotion, put } from '../utils/dom.js';
import { formatMoney, formatPercent, formatCompact } from '../utils/money.js';

const lastWidths = new Map();

/**
 * Lista de barras horizontais: nome, valor, percentual e barra proporcional
 * ao total. A parte prevista aparece em tom mais claro.
 */
export function barList(groups, { id, labelOf, onSelect, limit = 6, empty = 'Sem gastos neste período.', showPlanned = true } = {}) {
  if (!groups.length) return h('p', { class: 'empty-line' }, empty);
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
      const row = h(onSelect ? 'button' : 'div', {
        class: 'bar-row', type: onSelect ? 'button' : null,
        title: onSelect ? `Ver movimentações de ${label}` : null,
        onclick: onSelect ? () => onSelect(g.key) : null,
      },
      h('span', { class: 'bar-name truncate' }, label),
      h('span', { class: 'bar-value num' }, formatMoney(g.total)),
      h('span', { class: 'bar-pct num' }, formatPercent(g.pct, g.pct >= 10 || g.pct === 0 ? 0 : 1)),
      h('span', { class: 'bar-track', 'aria-hidden': 'true' }, fill, showPlanned && plannedPct > 0.2 ? planned : null),
      );
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

/** Evolução diária: barras realizadas (sólidas) e futuras (claras) + média. */
export function dailyChart(days, { todayDay = null, onSelectDay } = {}) {
  const W = 720, H = 150, pad = { t: 10, r: 8, b: 20, l: 8 };
  const values = days.map((d) => Math.max(0, d.done) + Math.max(0, d.planned));
  const max = Math.max(...values, 1);
  const n = days.length;
  const bw = (W - pad.l - pad.r) / n;
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const total = values.reduce((a, b) => a + b, 0);
  const activeDays = values.filter((v) => v > 0).length;
  const avg = activeDays ? total / activeDays : 0;
  const svg = s('svg', { class: 'chart chart-daily', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Gastos por dia do mês' });
  for (const f of [0.5, 1]) svg.append(s('line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: y(max * f), y2: y(max * f) }));
  const info = h('div', { class: 'chart-info small' });
  const setInfo = (d) => {
    if (!d) {
      const top = days.reduce((a, b) => ((b.done + b.planned) > (a.done + a.planned) ? b : a), days[0]);
      put(info, 
        h('span', { class: 'legend' }, h('i', { class: 'sw sw-done' }), 'Realizado'),
        h('span', { class: 'legend' }, h('i', { class: 'sw sw-planned' }), 'Previsto'),
        total > 0 ? h('span', { class: 'faint' }, `Maior gasto: dia ${top.day} · ${formatMoney(top.done + top.planned)}`) : h('span', { class: 'faint' }, 'Sem gastos no mês'),
      );
      return;
    }
    put(info, h('strong', null, `Dia ${d.day}`), h('span', null, `Realizado ${formatMoney(d.done)}`), h('span', { class: 'faint' }, `Previsto ${formatMoney(d.planned)}`));
  };
  days.forEach((d, i) => {
    const x = pad.l + i * bw + bw * 0.18;
    const w = bw * 0.64;
    const g = s('g', { class: `day${todayDay === d.day ? ' is-today' : ''}${values[i] > avg * 1.8 && values[i] > 0 ? ' is-high' : ''}`, tabindex: onSelectDay ? '0' : null });
    const doneH = (H - pad.t - pad.b) * (Math.max(0, d.done) / max);
    const planH = (H - pad.t - pad.b) * (Math.max(0, d.planned) / max);
    const base = H - pad.b;
    g.append(s('rect', { class: 'hit', x: pad.l + i * bw, y: pad.t, width: bw, height: H - pad.t - pad.b }));
    if (planH > 0) g.append(s('rect', { class: 'b-planned', x, y: base - doneH - planH, width: w, height: planH, rx: 1.5 }));
    if (doneH > 0) g.append(s('rect', { class: 'b-done', x, y: base - doneH, width: w, height: doneH, rx: 1.5 }));
    if (d.day === 1 || d.day % 5 === 0 || d.day === n) g.append(s('text', { class: 'axis', x: x + w / 2, y: H - 5, 'text-anchor': 'middle' }, String(d.day)));
    g.append(s('title', null, `Dia ${d.day}: ${formatMoney(d.done)} realizado, ${formatMoney(d.planned)} previsto`));
    g.addEventListener('pointerenter', () => setInfo(d));
    g.addEventListener('focus', () => setInfo(d));
    if (onSelectDay) {
      g.addEventListener('click', () => onSelectDay(d.day));
      g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') onSelectDay(d.day); });
    }
    svg.append(g);
  });
  if (avg > 0) svg.append(s('line', { class: 'avg', x1: pad.l, x2: W - pad.r, y1: y(avg), y2: y(avg) }));
  svg.addEventListener('pointerleave', () => setInfo(null));
  setInfo(null);
  return h('div', { class: 'chart-wrap' }, svg, info);
}

/**
 * Gráfico de linha para evolução patrimonial.
 * series: [{ label, values: number[], cls }]; labels: string[] (eixo x)
 */
export function lineChart(series, labels, { target = null, height = 200, format = formatMoney } = {}) {
  const W = 720, H = height, pad = { t: 12, r: 12, b: 22, l: 56 };
  const all = series.flatMap((x) => x.values).concat(target != null ? [target] : []);
  const max = Math.max(...all, 1) * 1.05;
  const min = Math.min(0, ...all);
  const n = labels.length;
  const x = (i) => pad.l + (W - pad.l - pad.r) * (n <= 1 ? 0 : i / (n - 1));
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - min) / (max - min || 1));
  const svg = s('svg', { class: 'chart chart-line', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': series.map((x) => x.label).join(', ') });
  for (let k = 0; k <= 3; k++) {
    const v = min + ((max - min) * k) / 3;
    svg.append(s('line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
    svg.append(s('text', { class: 'axis', x: pad.l - 8, y: y(v) + 3, 'text-anchor': 'end' }, formatCompact(v)));
  }
  const step = Math.max(1, Math.ceil(n / 6));
  labels.forEach((l, i) => { if (i % step === 0 || i === n - 1) svg.append(s('text', { class: 'axis', x: x(i), y: H - 5, 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle' }, l)); });
  if (target != null) {
    svg.append(s('line', { class: 'target', x1: pad.l, x2: W - pad.r, y1: y(target), y2: y(target) }));
  }
  for (const sr of series) {
    const d = sr.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    if (sr.area) svg.append(s('path', { class: `area ${sr.cls}`, d: `${d}L${x(n - 1).toFixed(1)},${y(min)}L${x(0)},${y(min)}Z` }));
    svg.append(s('path', { class: `line ${sr.cls}`, d, pathLength: '1' }));
  }
  const cursor = s('line', { class: 'cursor', x1: 0, x2: 0, y1: pad.t, y2: H - pad.b, visibility: 'hidden' });
  svg.append(cursor);
  const info = h('div', { class: 'chart-info small' });
  const legend = () => put(info, ...series.map((sr) => h('span', { class: 'legend' }, h('i', { class: `sw ${sr.cls}` }), sr.label)), target != null ? h('span', { class: 'legend' }, h('i', { class: 'sw sw-target' }), 'Meta') : null);
  legend();
  svg.addEventListener('pointermove', (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (n - 1))));
    cursor.setAttribute('x1', x(i)); cursor.setAttribute('x2', x(i)); cursor.setAttribute('visibility', 'visible');
    put(info, h('strong', null, labels[i]), ...series.map((sr) => h('span', { class: 'legend' }, h('i', { class: `sw ${sr.cls}` }), `${sr.label}: ${format(sr.values[i])}`)));
  });
  svg.addEventListener('pointerleave', () => { cursor.setAttribute('visibility', 'hidden'); legend(); });
  return h('div', { class: 'chart-wrap' }, svg, info);
}

/** Barra de progresso simples (orçamentos, metas, parcelas). */
export function progress(ratio, { tone } = {}) {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  const t = tone || (ratio > 1 ? 'neg' : ratio > 0.85 ? 'warn' : 'ok');
  const fill = h('span', { class: `progress-fill is-${t}` });
  fill.style.width = `${pct}%`;
  return h('span', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)) }, fill);
}
