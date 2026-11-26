import { h, s, icon, prefersReducedMotion } from '../utils/dom.js';
import { formatMoney, formatPercent } from '../utils/money.js';
import { addMonths, formatMonthShort, formatDateShort, today } from '../utils/dates.js';
import { summarize } from '../services/finance.js';
import { commitmentsFor, stateLabel } from '../services/commitments.js';
import { monthSignals } from '../services/signals.js';
import { progress } from '../components/charts.js';
import { panel, capitalize, categoryName } from './common.js';
import { openItem, toggleStatus } from './actions.js';

/*
 * Formatos adicionais da Visão geral (3.1). Tudo é calculado com summarize()
 * e commitmentsFor(), as mesmas funções dos indicadores e do Planejamento.
 */

// Direção "boa" de cada métrica: aumento de despesa não é favorável.
export const METRICS = {
  surplus: { label: 'Sobra projetada', get: (s) => s.projectedSurplus, up: 'good' },
  invest: { label: 'Disponível para investir', get: (s) => s.availableToInvest, up: 'good' },
  inRec: { label: 'Receitas recebidas', get: (s) => s.incomeReceived, up: 'good' },
  inExp: { label: 'Receitas previstas', get: (s) => s.incomeExpected, up: 'neutral' },
  exDone: { label: 'Despesas realizadas', get: (s) => s.expenseDone, up: 'bad' },
  exPend: { label: 'Compromissos pendentes', get: (s) => s.expensePending, up: 'neutral' },
};

/** Série dos últimos `n` meses de uma métrica (somente meses com atividade contam para a tendência). */
export function metricSeries(ctx, metric, month, n = 6) {
  return Array.from({ length: n }, (_, i) => {
    const m = addMonths(month, i - n + 1);
    const sm = summarize(ctx, m);
    return { month: m, value: METRICS[metric].get(sm), active: sm.incomeTotal !== 0 || sm.expenseTotal !== 0 };
  });
}

export function sparkline(values, { width = 140, height = 34, label } = {}) {
  const v = values.map((x) => (Number.isFinite(x) ? x : 0));
  const min = Math.min(0, ...v), max = Math.max(...v, 1);
  const x = (i) => (v.length < 2 ? width / 2 : (i / (v.length - 1)) * (width - 4) + 2);
  const y = (val) => height - 3 - ((val - min) / (max - min || 1)) * (height - 6);
  const pts = v.map((val, i) => `${x(i).toFixed(1)},${y(val).toFixed(1)}`).join(' ');
  const svg = s('svg', { class: 'spark', viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': label || 'Tendência' });
  if (min < 0) svg.append(s('line', { x1: 0, x2: width, y1: y(0), y2: y(0), class: 'spark-zero' }));
  svg.append(s('polyline', { points: pts, class: 'spark-line' }));
  if (v.length) svg.append(s('circle', { cx: x(v.length - 1), cy: y(v[v.length - 1]), r: 2.6, class: 'spark-dot' }));
  return svg;
}

/** Conteúdo extra de um indicador conforme o formato escolhido. */
export function kpiFormat(kind, fmt, ctx, month, detail = []) {
  if (fmt === 'detail' && detail.length) {
    return h('span', { class: 'kpi-detail' }, ...detail.filter(Boolean).map(([l, v, cls]) => h('span', { class: 'kpi-line' }, h('span', null, l), h('strong', { class: `num ${cls || ''}` }, v))));
  }
  if (fmt === 'trend') {
    const series = metricSeries(ctx, kind, month);
    const active = series.filter((x) => x.active).length;
    if (active < 2) return h('span', { class: 'kpi-sub' }, 'A evolução aparece quando houver pelo menos dois meses com movimentações.');
    return h('span', { class: 'kpi-trend' }, sparkline(series.map((x) => x.value), { label: `${METRICS[kind].label}: últimos 6 meses` }),
      h('span', { class: 'faint xsmall' }, `${capitalize(formatMonthShort(series[0].month))} → ${capitalize(formatMonthShort(month))}`));
  }
  if (fmt === 'compare') {
    const cur = METRICS[kind].get(summarize(ctx, month));
    const prevS = summarize(ctx, addMonths(month, -1));
    if (prevS.incomeTotal === 0 && prevS.expenseTotal === 0) return h('span', { class: 'kpi-sub' }, 'Sem dados do mês anterior para comparar.');
    const prev = METRICS[kind].get(prevS);
    const diff = cur - prev;
    const dir = diff === 0 ? 'flat' : diff > 0 ? 'up' : 'down';
    const good = METRICS[kind].up === 'neutral' || dir === 'flat' ? 'neutral' : (dir === 'up') === (METRICS[kind].up === 'good') ? 'good' : 'bad';
    const pct = prev !== 0 ? ` (${diff > 0 ? '+' : ''}${formatPercent((diff / Math.abs(prev)) * 100, 0)})` : '';
    return h('span', { class: `kpi-compare is-${good}` }, icon(dir === 'up' ? 'trend' : dir === 'down' ? 'out' : 'swap', 'icon-sm'),
      h('span', null, diff === 0 ? 'Igual ao mês anterior' : `${diff > 0 ? '+' : '−'}${formatMoney(Math.abs(diff))}${pct} vs. ${formatMonthShort(addMonths(month, -1))}`));
  }
  return null;
}

// ——— Compromissos do mês (componente multifuncional) ———

export function commitmentsWidget(ctx, month, cfg) {
  const res = commitmentsFor(ctx, month);
  const t = res.totals;
  const open = [];
  for (const c of res.recurring) for (const e of c.entries) if (e.item && e.state !== 'done' && c.rule.type === 'expense') open.push({ c, e });
  for (const o of res.oneOff) if (o.item.type !== 'income') open.push({ c: null, e: { item: o.item, state: o.state, amount: o.item.amount, date: o.item.date } });
  open.sort((a, b) => ((a.e.date || '9') < (b.e.date || '9') ? -1 : 1));
  const next = open.find((x) => x.e.date && x.e.date >= today());
  const pendingAll = t.left + res.oneOff.filter((o) => o.item.type !== 'income').reduce((a, o) => a + o.item.amount, 0);
  const head = { actions: h('a', { class: 'btn btn-ghost btn-sm', href: '#/planejamento/compromissos' }, 'Abrir') };
  if (!t.count && !res.oneOff.length) return panel('Compromissos do mês', head, h('div', { class: 'empty-block' }, 'Nenhuma conta prevista neste mês.', h('a', { class: 'btn btn-sm', href: '#/planejamento/compromissos' }, 'Ver compromissos')));
  if (cfg.chart === 'list') {
    return panel('Compromissos do mês', { ...head, hint: `${open.length} em aberto` },
      open.length ? h('div', { class: 'mini-occ', role: 'list' }, ...open.slice(0, 7).map(({ c, e }) => h('div', { class: 'mini-occ-row', role: 'listitem' },
        h('button', { class: 'occ-check', type: 'button', 'aria-label': `Marcar como pago: ${e.item.description}`, onclick: () => toggleStatus(e.item) }, icon('check', 'icon-sm')),
        h('button', { class: 'link-plain grow truncate', type: 'button', onclick: () => openItem(e.item) }, e.item.description, c?.mode === 'flex' && e.item.slot ? h('span', { class: 'faint' }, ` · ${e.item.slot}ª`) : null),
        h('span', { class: `small ${e.state === 'overdue' ? 'neg' : 'faint'}` }, e.date ? formatDateShort(e.date) : 'a definir'),
        h('span', { class: 'num strong small' }, formatMoney(e.amount))))) : h('div', { class: 'empty-block' }, 'Tudo pago neste mês.'));
  }
  if (cfg.chart === 'progress') {
    return panel('Compromissos do mês', { ...head, hint: `${t.doneCount} de ${t.count} concluídas` },
      h('div', { class: 'budgets' }, ...res.recurring.filter((c) => c.rule.type === 'expense').slice(0, 6).map((c) => h('div', { class: 'budget' },
        h('div', { class: 'budget-top' }, h('span', { class: 'truncate' }, c.rule.description), h('span', { class: 'num small faint' }, `${c.doneCount}/${c.count}`)),
        progress(c.ratio, { tone: c.state === 'done' ? 'ok' : c.state === 'overdue' ? 'warn' : 'accent', small: true, label: `${c.rule.description}: ${c.doneCount} de ${c.count}` }),
        h('div', { class: 'faint xsmall num' }, `${formatMoney(c.paid)} de ${formatMoney(c.total)}`)))));
  }
  // Resumo: pendente, próximo vencimento, contas restantes e % pago num só lugar.
  return panel('Compromissos do mês', head,
    h('div', { class: 'commit-mini' },
      h('div', null, h('span', { class: 'faint small' }, 'Pendente'), h('strong', { class: `num commit-mini-value ${pendingAll ? 'warn' : ''}` }, formatMoney(pendingAll))),
      h('div', null, h('span', { class: 'faint small' }, 'Próximo'), h('strong', { class: 'small' }, next ? `${next.e.item.description} · ${formatDateShort(next.e.date)}` : open.length ? 'datas a definir' : '—')),
      h('div', null, h('span', { class: 'faint small' }, 'Restantes'), h('strong', { class: 'num small' }, `${open.length} ${open.length === 1 ? 'conta' : 'contas'}`))),
    progress(t.total ? t.paid / t.total : 1, { tone: 'ok', label: `${formatPercent(t.total ? (t.paid / t.total) * 100 : 100, 0)} pago` }),
    h('p', { class: 'faint small' }, t.total ? `${formatMoney(t.paid)} de ${formatMoney(t.total)} pagos (${formatPercent((t.paid / t.total) * 100, 0)}) · ${t.doneCount} de ${t.count} ocorrências` : 'Sem contas recorrentes neste mês.'));
}

// ——— Avisos do mês ———

export function signalsWidget(ctx, month, prefs, goals) {
  const list = monthSignals(ctx, month, prefs, goals);
  return panel('Atenção', { hint: list.length ? `${list.length} ${list.length === 1 ? 'ponto' : 'pontos'}` : null },
    list.length ? h('div', { class: 'signals', role: 'list' }, ...list.map((x) => h(x.href ? 'a' : 'div', { class: `signal t-${x.tone}`, role: 'listitem', href: x.href || null },
      h('span', { class: 'signal-icon' }, icon(x.icon, 'icon-sm')), h('span', { class: 'grow' }, h('strong', { class: 'small' }, x.title), h('span', { class: 'faint xsmall signal-detail' }, x.detail)))))
      : h('div', { class: 'signal t-ok' }, h('span', { class: 'signal-icon' }, icon('check', 'icon-sm')), h('span', null, h('strong', { class: 'small' }, 'Tudo em ordem'), h('span', { class: 'faint xsmall signal-detail' }, 'Nenhum orçamento perto do limite, nada atrasado.'))));
}

// ——— Destaques alternados (opcional) ———

/**
 * Alterna entre informações relacionadas. Alternância automática só quando
 * escolhida, lenta (9 s), pausável, e desligada com movimento reduzido ou aba
 * em segundo plano. Indicadores críticos continuam também nos seus próprios cards.
 */
export function highlightsWidget(ctx, month, cfg) {
  const s0 = summarize(ctx, month);
  const prev = summarize(ctx, addMonths(month, -1));
  const hasPrev = prev.expenseTotal > 0;
  const slides = [
    { label: 'Sobra projetada', value: formatMoney(s0.projectedSurplus), cls: s0.projectedSurplus < 0 ? 'neg' : '', sub: 'receitas − despesas do mês' },
    hasPrev ? { label: prev.expenseTotal >= s0.expenseTotal ? 'Economia vs. mês anterior' : 'Gasto acima do mês anterior', value: formatMoney(Math.abs(prev.expenseTotal - s0.expenseTotal)), cls: prev.expenseTotal >= s0.expenseTotal ? 'pos' : 'neg', sub: `despesas de ${formatMonthShort(prev.month)}: ${formatMoney(prev.expenseTotal)}` } : null,
    { label: 'Disponível para investir', value: formatMoney(s0.availableToInvest), cls: 'invest', sub: 'após margem e aportes do mês' },
  ].filter(Boolean);
  let i = 0;
  let paused = cfg.chart !== 'auto';
  const valueEl = h('div', { class: 'hl-slide', 'aria-live': 'polite' });
  const dots = h('div', { class: 'hl-dots' });
  const draw = (dir = 0) => {
    const sl = slides[i];
    valueEl.replaceChildren(h('span', { class: 'kpi-label' }, sl.label), h('strong', { class: `kpi-value num ${sl.cls}` }, sl.value), h('span', { class: 'faint small' }, sl.sub));
    dots.replaceChildren(...slides.map((_, k) => h('button', { class: `hl-dot${k === i ? ' is-on' : ''}`, type: 'button', 'aria-label': `Mostrar ${slides[k].label}`, 'aria-pressed': String(k === i), onclick: () => { i = k; draw(); } })));
    if (dir && !prefersReducedMotion()) valueEl.animate([{ opacity: 0, transform: `translateX(${dir * 8}px)` }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
  };
  const go = (d) => { i = (i + d + slides.length) % slides.length; draw(d); };
  const pauseBtn = h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': paused ? 'Retomar alternância' : 'Pausar alternância', onclick: () => { paused = !paused; pauseBtn.setAttribute('aria-label', paused ? 'Retomar alternância' : 'Pausar alternância'); pauseBtn.replaceChildren(icon(paused ? 'chev-right' : 'clock', 'icon-sm')); } }, icon(paused ? 'chev-right' : 'clock', 'icon-sm'));
  const wrap = h('div', { class: 'highlights' }, valueEl,
    h('div', { class: 'hl-nav' }, h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': 'Anterior', onclick: () => go(-1) }, icon('chev-left', 'icon-sm')), dots,
      h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': 'Próximo', onclick: () => go(1) }, icon('chev-right', 'icon-sm')), cfg.chart === 'auto' ? pauseBtn : null));
  wrap.addEventListener('pointerenter', () => { wrap.dataset.hover = '1'; });
  wrap.addEventListener('pointerleave', () => { delete wrap.dataset.hover; });
  draw();
  if (cfg.chart === 'auto' && slides.length > 1) {
    const timer = setInterval(() => {
      if (!wrap.isConnected) { clearInterval(timer); return; }   // componente removido: libera o timer
      if (paused || document.hidden || prefersReducedMotion() || wrap.dataset.hover || wrap.contains(document.activeElement)) return;
      go(1);
    }, 9000);
  }
  return panel('Destaques', { hint: cfg.chart === 'auto' ? 'alterna a cada 9 s' : null }, wrap);
}

/** Resumo dos maiores itens de uma distribuição (formato "Maiores gastos"). */
export function topSummary(groups, labelOf, onSelect) {
  if (!groups.length) return h('div', { class: 'empty-block' }, 'Sem gastos neste mês.');
  return h('ol', { class: 'top-list' }, ...groups.slice(0, 5).map((g, k) => h('li', null,
    h('button', { class: 'link-plain top-row', type: 'button', onclick: () => onSelect(g.key) }, h('span', { class: 'top-rank num' }, String(k + 1)), h('span', { class: 'grow truncate' }, labelOf(g.key)),
      h('strong', { class: 'num' }, formatMoney(g.total)), h('span', { class: 'faint small num' }, formatPercent(g.pct, 0))))));
}

export { stateLabel, categoryName };
