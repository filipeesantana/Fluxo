import { summarize, accountBalances } from './finance.js';
import { commitmentOf } from './commitments.js';
import { investmentValue } from './investments.js';
import { formatMonthShort, isMonth } from '../utils/dates.js';

/*
 * Referências estruturadas da calculadora ("Usar valores do Fluxo").
 * Uma referência é só { id: 'rN', kind, entityId?, month? } — nunca código.
 * Os valores vêm do mesmo motor financeiro da aplicação. Se a entidade
 * referenciada deixar de existir, a referência fica INDISPONÍVEL (com o
 * motivo) e o cálculo mostra isso, em vez de usar zero.
 * Referências apontam apenas para dados financeiros, nunca para outros
 * cálculos salvos: dependência circular é impossível por construção.
 */

export const REF_DEFS = {
  projectedSurplus: { label: 'Sobra projetada', month: true, get: (s) => s.projectedSurplus },
  availableToInvest: { label: 'Disponível para investir', month: true, get: (s) => s.availableToInvest },
  freeSurplus: { label: 'Sobra livre', month: true, get: (s) => s.freeSurplus },
  incomeReceived: { label: 'Receitas recebidas', month: true, get: (s) => s.incomeReceived },
  incomeExpected: { label: 'Receitas previstas', month: true, get: (s) => s.incomeExpected },
  incomeTotal: { label: 'Receitas do mês', month: true, get: (s) => s.incomeTotal },
  expenseDone: { label: 'Despesas realizadas', month: true, get: (s) => s.expenseDone },
  expensePending: { label: 'Compromissos pendentes', month: true, get: (s) => s.expensePending },
  expenseTotal: { label: 'Despesas do mês', month: true, get: (s) => s.expenseTotal },
  patrimony: { label: 'Patrimônio informado', month: false },
  category: { label: 'Total de uma categoria', month: true, entity: 'categories' },
  block: { label: 'Total de um bloco', month: true, entity: 'blocks' },
  source: { label: 'Total de uma fonte', month: true, entity: 'accounts' },
  accountBalance: { label: 'Saldo de uma conta', month: false, entity: 'accounts' },
  goalTarget: { label: 'Valor de uma meta', month: false, entity: 'goals' },
  goalRemaining: { label: 'Quanto falta para uma meta', month: false, entity: 'goals' },
  transaction: { label: 'Valor de um lançamento', month: false, entity: 'transactions' },
  commitmentLeft: { label: 'Restante de um compromisso', month: true, entity: 'recurrences' },
};

const ENTITY_WORD = { categories: 'Categoria', blocks: 'Bloco', accounts: 'Conta', goals: 'Meta', transactions: 'Lançamento', recurrences: 'Compromisso' };

/** Mês efetivo de uma referência ('current' · 'selected' · 'AAAA-MM'). */
export function refMonth(ref, { selectedMonth, currentMonth }) {
  if (!REF_DEFS[ref.kind]?.month) return null;
  if (ref.month === 'selected') return selectedMonth;
  if (isMonth(ref.month)) return ref.month;
  return currentMonth;
}

/**
 * Resolve uma referência. env: { ctx, get(store, id), list(store), selectedMonth, currentMonth, today }.
 * → { ok: true, value (centavos), label } | { ok: false, label, reason }
 */
export function resolveRef(ref, env) {
  const def = REF_DEFS[ref?.kind];
  if (!def) return { ok: false, label: 'Referência desconhecida', reason: 'tipo não suportado' };
  const month = refMonth(ref, env);
  const entity = def.entity ? env.get(def.entity, ref.entityId) : null;
  const name = entity ? (entity.name || entity.description) : null;
  const label = `${def.entity ? (name || ENTITY_WORD[def.entity]) : def.label}${def.entity ? ` · ${def.label.toLowerCase().replace(/ de uma? .*$/, '')}` : ''}${month ? ` · ${formatMonthShort(month)}` : ''}`;
  if (def.entity && !entity) return { ok: false, label: `${ENTITY_WORD[def.entity]} indisponível`, reason: `${ENTITY_WORD[def.entity].toLowerCase()} excluída ou inexistente` };
  try {
    let value;
    if (def.get) value = def.get(summarize(env.ctx, month));
    else if (ref.kind === 'patrimony') {
      const events = env.list('investmentEvents');
      value = env.list('investments').filter((i) => !i.archived).reduce((s, i) => s + investmentValue(i, events, env.today).informed, 0);
    } else if (ref.kind === 'category' || ref.kind === 'block' || ref.kind === 'source') {
      const s = summarize(env.ctx, month);
      const groups = { category: s.byCategory, block: s.byBlock, source: s.bySource }[ref.kind];
      value = groups.find((g) => g.key === ref.entityId)?.total || 0;
    } else if (ref.kind === 'accountBalance') value = accountBalances(env.ctx).get(ref.entityId) || 0;
    else if (ref.kind === 'goalTarget') value = entity.target;
    else if (ref.kind === 'goalRemaining') {
      const inv = entity.investmentId ? env.get('investments', entity.investmentId) : null;
      const current = inv ? investmentValue(inv, env.list('investmentEvents'), env.today).informed : entity.initial || 0;
      value = Math.max(0, entity.target - current);
    } else if (ref.kind === 'transaction') value = entity.amount;
    else if (ref.kind === 'commitmentLeft') {
      const c = commitmentOf(env.ctx, entity, month);
      value = c ? (c.forecast ? c.left : c.left) : 0;
    }
    if (!Number.isFinite(value)) return { ok: false, label, reason: 'valor indisponível' };
    return { ok: true, value, label: `${label}${entity?.archived ? ' (arquivada)' : ''}` };
  } catch (err) {
    return { ok: false, label, reason: String(err?.message || err) };
  }
}

/** Resolve uma lista de referências → { values: { r1: reais }, items: [...] }. */
export function resolveRefs(refs, env) {
  const values = {};
  const items = (refs || []).map((r) => {
    const res = resolveRef(r, env);
    if (res.ok) values[r.id] = res.value / 100;
    return { ...r, ...res };
  });
  return { values, items };
}
