import { h, icon, put } from '../utils/dom.js';
import { formatMoney, formatPercent } from '../utils/money.js';
import { formatMonth, formatDateShort, firstDay, lastDay, today } from '../utils/dates.js';
import * as repo from '../database/repository.js';
import { commitmentsFor, stateLabel } from '../services/commitments.js';
import { progress } from '../components/charts.js';
import { openEntryForm } from '../components/entry-form.js';
import { toast, toastError } from '../components/toast.js';
import { ui } from '../state.js';
import { panel, txRow, categoryName, accountName, capitalize, emptyState } from './common.js';
import { openItem, itemMenu, toggleStatus, openRecurrenceForm, closeForecast } from './actions.js';

const PILL = { done: 'pill-done', partial: 'pill-today', overdue: 'pill-overdue', pending: 'pill-today', planned: 'pill-planned', tbd: 'pill-planned', skipped: 'pill-muted', cancelled: 'pill-muted' };

function stateIcon(state) {
  if (state === 'done') return icon('check', 'icon-sm');
  if (state === 'overdue') return icon('alert', 'icon-sm');
  return icon('clock', 'icon-sm');
}

/** Linha de ocorrência: concluir, definir data (datas flexíveis) e abrir ações. */
function occurrenceRow(c, e) {
  const it = e.item;
  const type = c.rule.type;
  if (!it) {
    return h('div', { class: 'occ-row is-muted', role: 'listitem' }, h('span', { class: 'occ-check is-off', 'aria-hidden': 'true' }, icon('x', 'icon-sm')),
      h('span', { class: 'occ-when' }, e.date ? formatDateShort(e.date) : `${e.index}ª`), h('span', { class: 'occ-label grow' }, stateLabel(e.state, type)), h('span', { class: 'num faint' }, '—'), h('span'));
  }
  const done = e.state === 'done' || e.state === 'partial';
  const check = h('button', {
    class: `occ-check${done ? ' is-done' : ''}${e.state === 'overdue' ? ' is-overdue' : ''}`, type: 'button',
    'aria-label': done ? `Desfazer: ${it.description}` : `${type === 'income' ? 'Marcar como recebido' : 'Marcar como pago'}: ${it.description}${e.date ? `, ${formatDateShort(e.date)}` : ''}`,
    onclick: () => toggleStatus(it),
  }, icon('check', 'icon-sm'));
  const flex = c.mode === 'flex';
  let when;
  if (flex && it.status !== 'done') {
    const input = h('input', { class: 'input input-sm occ-date', type: 'date', value: it.date || '', min: firstDay(c.month), max: lastDay(c.month), 'aria-label': `Data da ${e.index}ª ocorrência de ${it.description}` });
    let saved = it.date || '';
    input.addEventListener('change', async () => {
      if (input.value === saved) return; // evento repetido: nada mudou
      if (input.value && (input.value < firstDay(c.month) || input.value > lastDay(c.month))) { toast('Escolha uma data dentro do mês do compromisso', { tone: 'error' }); input.value = saved; return; }
      saved = input.value;
      try { await repo.setOccurrenceDate(c.rule.id, e.key, input.value || null); toast(input.value ? `Data definida: ${formatDateShort(input.value)}` : 'Data removida (a definir)', { tone: 'success' }); } catch (err) { toastError(err); }
    });
    when = h('span', { class: 'occ-when' }, h('span', { class: 'occ-idx' }, `${e.index}ª`), input);
  } else when = h('span', { class: 'occ-when' }, flex ? h('span', { class: 'occ-idx' }, `${e.index}ª`) : null, e.date ? formatDateShort(e.date) : 'a definir');
  const rest = e.remainders.filter((r) => r.status !== 'done').reduce((s, r) => s + r.amount, 0);
  const more = h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': `Ações de ${it.description}`, 'aria-haspopup': 'menu', onclick: (ev) => { ev.stopPropagation(); itemMenu(it, ev.currentTarget); } }, icon('more'));
  return h('div', { class: `occ-row is-${e.state}`, role: 'listitem', dataset: { key: e.key || '' } },
    check, when,
    h('button', { class: 'occ-label grow link-plain', type: 'button', onclick: () => openItem(it) },
      h('span', { class: `pill ${PILL[e.state] || ''}` }, stateLabel(e.state, type)),
      it.sourceId ? h('span', { class: 'faint small' }, accountName(it.sourceId)) : it.status !== 'done' ? h('span', { class: 'faint small' }, 'fonte a definir') : null,
      rest ? h('span', { class: 'faint small' }, `restam ${formatMoney(rest)}`) : null),
    h('span', { class: `num occ-amount${type === 'income' ? ' pos' : ''}` }, formatMoney(e.amount)),
    more);
}

function commitmentCard(c) {
  const r = c.rule;
  const word = r.type === 'income' ? (c.doneCount === 1 ? 'recebida' : 'recebidas') : (c.doneCount === 1 ? 'paga' : 'pagas');
  const doneAll = c.state === 'done';
  const meta = [c.describe, r.categoryId ? categoryName(r.categoryId) : null, r.sourceId ? accountName(r.sourceId) : null].filter(Boolean).join(' · ');
  return h('article', { class: `commit${doneAll ? ' is-done' : ''}`, dataset: { rule: r.id } },
    h('header', { class: 'commit-head' },
      h('span', { class: `commit-icon s-${c.state}` }, stateIcon(c.state)),
      h('div', { class: 'grow commit-title' }, h('strong', { class: 'truncate' }, r.description), h('span', { class: 'faint small truncate' }, meta)),
      h('div', { class: 'right' }, h('div', { class: 'num strong' }, `${formatMoney(c.paid)} de ${formatMoney(c.total)}`), h('div', { class: 'faint small' }, doneAll ? (r.type === 'income' ? 'tudo recebido' : 'concluído') : `restam ${formatMoney(c.left)}`))),
    progress(c.ratio, { tone: doneAll ? 'ok' : c.state === 'overdue' ? 'warn' : undefined, small: true, label: `${r.description}: ${c.doneCount} de ${c.count} ${word}` }),
    h('p', { class: 'commit-progress small' }, `${c.doneCount} de ${c.count} ${word}`, c.count > 1 && !doneAll ? ` · ${formatPercent(c.ratio * 100, 0)} do valor` : ''),
    h('div', { class: 'occ-list', role: 'list' }, ...c.entries.map((e) => occurrenceRow(c, e))));
}

function forecastCard(c) {
  const r = c.rule;
  const warnAt = (repo.prefs().budgetWarnAt ?? 80) / 100;
  const tone = c.excess > 0 ? 'over' : c.ratio >= 1 ? 'full' : c.ratio >= warnAt ? 'warn' : 'ok';
  const status = c.closed ? 'Mês encerrado' : c.excess > 0 ? `${formatMoney(c.excess)} acima do previsto` : c.ratio >= 1 ? 'Previsão atingida' : c.ratio >= warnAt ? `Atenção: ${formatPercent(c.ratio * 100, 0)} usados` : 'Dentro do previsto';
  return h('article', { class: `commit is-forecast t-${tone}${c.closed ? ' is-done' : ''}`, dataset: { rule: r.id } },
    h('header', { class: 'commit-head' },
      h('span', { class: `commit-icon s-${tone === 'over' ? 'overdue' : tone === 'warn' ? 'partial' : 'planned'}` }, icon('target', 'icon-sm')),
      h('div', { class: 'grow commit-title' }, h('strong', { class: 'truncate' }, r.description), h('span', { class: 'faint small truncate' }, ['Previsão mensal', r.categoryId ? categoryName(r.categoryId) : null].filter(Boolean).join(' · '))),
      h('div', { class: 'right' }, h('div', { class: 'num strong' }, `${formatMoney(c.used)} de ${formatMoney(c.planned)}`), h('div', { class: `small ${tone === 'over' ? 'neg' : tone === 'warn' ? 'warn' : 'faint'}` }, status))),
    progress(Math.min(1, c.ratio), { tone: tone === 'over' ? 'neg' : tone === 'warn' ? 'warn' : undefined, small: true, label: `${r.description}: ${formatMoney(c.used)} de ${formatMoney(c.planned)}` }),
    h('div', { class: 'kvs kvs-inline small' },
      h('span', null, 'Realizado ', h('strong', { class: 'num' }, formatMoney(c.done))),
      c.used - c.done ? h('span', null, 'Agendado ', h('strong', { class: 'num' }, formatMoney(c.used - c.done))) : null,
      h('span', null, 'Restante planejado ', h('strong', { class: 'num' }, formatMoney(c.left))),
      c.excess ? h('span', { class: 'neg' }, 'Excedente ', h('strong', { class: 'num' }, formatMoney(c.excess))) : null),
    c.linked.length ? h('div', { class: 'tx-list', role: 'list' }, ...c.linked.map((t) => txRow(t, { onOpen: openItem, onMenu: itemMenu, onToggle: toggleStatus, showDate: true }))) : h('p', { class: 'faint small' }, 'Nenhum gasto registrado nesta previsão ainda.'),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openEntryForm({ defaults: { type: 'expense', status: 'done', forecastId: r.id, categoryId: r.categoryId, blockId: r.blockId, sourceId: r.sourceId, description: r.description, date: today() < firstDay(c.month) || today() > lastDay(c.month) ? firstDay(c.month) : today() } }) }, icon('plus', 'icon-sm'), 'Registrar gasto'),
      c.closed ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => closeForecast(r, c.month, false) }, 'Reabrir mês')
        : h('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: 'O que não foi usado deixa de contar e não vira despesa', onclick: () => closeForecast(r, c.month, true) }, icon('check', 'icon-sm'), 'Encerrar mês'),
      h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => openRecurrenceForm({ rule: r }) }, 'Editar previsão')));
}

export function renderCommitments(container) {
  const ctx = repo.context();
  const m = ui.month;
  const res = commitmentsFor(ctx, m);
  const t = res.totals;
  const open = res.recurring.filter((c) => c.state !== 'done' && c.state !== 'skipped');
  const closed = res.recurring.filter((c) => c.state === 'done' || c.state === 'skipped');
  if (!res.recurring.length && !res.forecasts.length && !res.oneOff.length) {
    put(container, h('section', { class: 'panel' }, emptyState('Nenhum compromisso neste mês',
      'Ao registrar uma despesa ou receita, escolha “Repetir”: contas com dia fixo, vários dias no mês, consultas com datas flexíveis ou uma previsão mensal (como combustível).',
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openRecurrenceForm() }, icon('plus', 'icon-sm'), 'Nova recorrência'))));
    return;
  }
  const summary = h('div', { class: 'commit-summary' },
    h('div', { class: 'cal-stat' }, h('b', { class: 'num' }, formatMoney(t.total)), h('span', null, 'previsto em contas do mês')),
    h('div', { class: 'cal-stat' }, h('b', { class: 'num pos' }, formatMoney(t.paid)), h('span', null, 'já pago')),
    h('div', { class: 'cal-stat' }, h('b', { class: `num ${t.left ? 'warn' : ''}` }, formatMoney(t.left)), h('span', null, 'restante')),
    h('div', { class: 'cal-stat' }, h('b', { class: 'num' }, `${t.doneCount} de ${t.count}`), h('span', null, 'ocorrências concluídas')),
    res.forecasts.length ? h('div', { class: 'cal-stat' }, h('b', { class: 'num' }, `${formatMoney(t.forecastUsed)} de ${formatMoney(t.forecastPlanned)}`), h('span', null, 'usado nas previsões')) : null);
  const blocks = [panel(`Compromissos de ${formatMonth(m)}`, { hint: 'cada mês tem seu próprio estado' }, summary)];
  if (open.length) blocks.push(h('div', { class: 'commit-grid' }, ...open.map(commitmentCard)));
  if (res.forecasts.length) blocks.push(h('section', { class: 'stack' }, h('h2', { class: 'section-title' }, 'Previsões do mês'), h('div', { class: 'commit-grid' }, ...res.forecasts.map(forecastCard))));
  if (res.oneOff.length) blocks.push(panel('Outros compromissos previstos', { hint: 'lançamentos avulsos ainda não pagos' }, h('div', { class: 'tx-list', role: 'list' }, ...res.oneOff.map(({ item }) => txRow(item, { onOpen: openItem, onMenu: itemMenu, onToggle: toggleStatus, showDate: true })))));
  if (closed.length) blocks.push(h('details', { class: 'commit-done' }, h('summary', null, icon('chev-right', 'icon-sm'), `Concluídos neste mês (${closed.length})`), h('div', { class: 'commit-grid' }, ...closed.map(commitmentCard))));
  put(container, ...blocks);
  return capitalize;
}
