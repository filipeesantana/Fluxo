// Parser matemático seguro (descida recursiva). Nenhum eval/Function.
// Gramática:
//   expr   := term (('+' | '-') term)*
//   term   := unary (('*' | '/' | 'de') unary)*
//   unary  := ('-' | '+') unary | postfix
//   postfix:= primary '%'?
//   primary:= number | '@n' (valor do Fluxo) | '(' expr ')'
// Semântica de % (sempre a mesma, documentada na própria calculadora):
//   10% de 800 = 80        (porcentagem de um valor)
//   800 + 10%  = 880       (acréscimo: soma 10% DO VALOR À ESQUERDA)
//   800 − 10%  = 720       (desconto: subtrai 10% do valor à esquerda)
//   800 × 10%  = 80        (multiplica pela fração)
//   800 ÷ 10%  = 8000      (divide pela fração)
//   50%        = 0,5       (porcentagem isolada vira fração)
// Limites: 400 caracteres, 200 símbolos, 32 níveis de parênteses, |resultado| ≤ 1e15.

export class CalcError extends Error {}

const OPS = new Set(['+', '-', '*', '/', '(', ')', '%']);
export const MAX_EXPR = 400;
const MAX_TOKENS = 200;
const MAX_DEPTH = 32;
const MAX_ABS = 1e15;

export function tokenize(input) {
  const raw = String(input);
  if (raw.length > MAX_EXPR) throw new CalcError('Expressão longa demais');
  const src = raw.toLowerCase().replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/\s+/g, '');
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (tokens.length > MAX_TOKENS) throw new CalcError('Expressão longa demais');
    if (OPS.has(c)) { tokens.push({ t: c }); i++; continue; }
    if (c === 'd' && src[i + 1] === 'e') { tokens.push({ t: 'de' }); i += 2; continue; }
    if (c === '@') {
      let j = i + 1;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      if (j === i + 1 || j - i > 3) throw new CalcError('Referência inválida');
      tokens.push({ t: 'ref', id: `r${src.slice(i + 1, j)}` });
      i = j;
      continue;
    }
    if (/[0-9.,]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.,]/.test(src[j])) j++;
      tokens.push({ t: 'num', v: parseNumber(src.slice(i, j)) });
      i = j;
      continue;
    }
    throw new CalcError(`Caractere inválido: ${c}`);
  }
  return tokens;
}

function parseNumber(raw) {
  // Vírgula é decimal; ponto antes de vírgula é milhar ("1.234,5").
  let s = raw;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  if ((s.match(/\./g) || []).length > 1 || s === '.' || s.includes(',')) throw new CalcError('Número inválido');
  const v = Number(s);
  if (!Number.isFinite(v)) throw new CalcError('Número inválido');
  return v;
}

/**
 * Avalia a expressão. opts.refs: { r1: número, … } — valores do Fluxo já
 * resolvidos (em reais). Referência ausente ou inválida gera erro claro:
 * nunca vira zero silenciosamente.
 */
export function evaluate(input, { refs = {} } = {}) {
  const tokens = tokenize(input);
  if (!tokens.length) throw new CalcError('Expressão vazia');
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos];
  const take = (t) => (tokens[pos]?.t === t ? tokens[pos++] : null);

  function expr() {
    let left = term();
    for (;;) {
      if (take('+')) left = addPct(left, term(), 1);
      else if (take('-')) left = addPct(left, term(), -1);
      else return left;
    }
  }
  function addPct(left, right, sign) {
    const a = val(left);
    const b = right.pct ? a * right.v / 100 : right.v;
    return { v: a + sign * b };
  }
  function term() {
    let left = unary();
    for (;;) {
      if (take('*')) { const r = unary(); left = { v: val(left) * val(r) }; }
      else if (take('de')) { const r = unary(); if (!left.pct) throw new CalcError('Use “de” depois de uma porcentagem: 10% de 800'); left = { v: val(left) * val(r) }; }
      else if (take('/')) {
        const r = unary();
        const d = val(r);
        if (d === 0) throw new CalcError('Divisão por zero');
        left = { v: val(left) / d };
      } else return left;
    }
  }
  function unary() {
    if (take('-')) { const r = unary(); return { v: -r.v, pct: r.pct }; }
    if (take('+')) return unary();
    return postfix();
  }
  function postfix() {
    const p = primary();
    if (take('%')) return { v: p.v, pct: true };
    return p;
  }
  function primary() {
    const tk = peek();
    if (!tk) throw new CalcError('Expressão incompleta');
    if (tk.t === 'num') { pos++; return { v: tk.v }; }
    if (tk.t === 'ref') {
      pos++;
      const v = Object.hasOwn(refs, tk.id) ? refs[tk.id] : undefined;
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new CalcError(`Valor @${tk.id.slice(1)} indisponível`);
      return { v };
    }
    if (take('(')) {
      if (++depth > MAX_DEPTH) throw new CalcError('Parênteses demais');
      const e = expr();
      depth--;
      if (!take(')')) throw new CalcError('Parêntese não fechado');
      return { v: val(e) };
    }
    throw new CalcError('Expressão incompleta');
  }
  const val = (n) => (n.pct ? n.v / 100 : n.v);

  const result = expr();
  if (pos < tokens.length) throw new CalcError(tokens[pos].t === ')' ? 'Parêntese sem abertura' : 'Expressão inválida');
  const v = val(result);
  if (!Number.isFinite(v)) throw new CalcError('Resultado inválido');
  if (Math.abs(v) > MAX_ABS) throw new CalcError('Resultado grande demais');
  // Remove ruído de ponto flutuante (0,1 + 0,2 = 0,3).
  return Number(v.toPrecision(12));
}

export function formatResult(v) {
  return v.toLocaleString('pt-BR', { maximumFractionDigits: 10 });
}

// ——— Ferramentas rápidas (funções puras; valores em reais) ———
// Cada uma devolve { value, unit: 'money' | 'percent' | 'number', text } ou lança CalcError.
const need = (...xs) => { for (const x of xs) if (!Number.isFinite(x)) throw new CalcError('Preencha os valores'); };
export const TOOLS = {
  pctOf: { label: 'Porcentagem de um valor', a: 'Porcentagem (%)', b: 'Valor', run: (p, v) => { need(p, v); return { value: (v * p) / 100, unit: 'money', text: `${fmtN(p)}% de ${fmtM(v)}` }; } },
  addPct: { label: 'Acréscimo percentual', a: 'Valor', b: 'Acréscimo (%)', run: (v, p) => { need(v, p); return { value: v * (1 + p / 100), unit: 'money', text: `${fmtM(v)} + ${fmtN(p)}%` }; } },
  subPct: { label: 'Desconto percentual', a: 'Valor', b: 'Desconto (%)', run: (v, p) => { need(v, p); return { value: v * (1 - p / 100), unit: 'money', text: `${fmtM(v)} − ${fmtN(p)}%` }; } },
  share: { label: 'Quanto % um valor representa', a: 'Parte', b: 'Total', run: (a, b) => { need(a, b); if (b === 0) throw new CalcError('O total não pode ser zero'); return { value: (a / b) * 100, unit: 'percent', text: `${fmtM(a)} de ${fmtM(b)}` }; } },
  variation: { label: 'Variação percentual', a: 'Valor anterior', b: 'Valor novo', run: (a, b) => { need(a, b); if (a === 0) throw new CalcError('O valor anterior não pode ser zero'); return { value: ((b - a) / Math.abs(a)) * 100, unit: 'percent', text: `de ${fmtM(a)} para ${fmtM(b)}` }; } },
  split: { label: 'Dividir despesa entre pessoas', a: 'Valor', b: 'Pessoas', run: (v, n) => { need(v, n); if (!(n >= 1) || !Number.isInteger(n)) throw new CalcError('Informe um número inteiro de pessoas'); return { value: v / n, unit: 'money', text: `${fmtM(v)} ÷ ${n}` }; } },
  perInstallment: { label: 'Valor por parcela', a: 'Total', b: 'Parcelas', run: (v, n) => { need(v, n); if (!(n >= 1) || !Number.isInteger(n) || n > 600) throw new CalcError('Parcelas: de 1 a 600'); return { value: v / n, unit: 'money', text: `${fmtM(v)} em ${n}×` }; } },
  incomeShare: { label: 'Renda comprometida', a: 'Despesas', b: 'Renda', run: (a, b) => { need(a, b); if (b === 0) throw new CalcError('A renda não pode ser zero'); return { value: (a / b) * 100, unit: 'percent', text: `${fmtM(a)} de ${fmtM(b)} de renda` }; } },
  saving: { label: 'Quanto guardar por mês', a: 'Objetivo', b: 'Meses', run: (v, n) => { need(v, n); if (!(n >= 1) || !Number.isInteger(n) || n > 600) throw new CalcError('Meses: de 1 a 600'); return { value: v / n, unit: 'money', text: `${fmtM(v)} em ${n} meses` }; } },
  pctOfIncome: { label: 'Guardar % da renda', a: 'Renda mensal', b: 'Percentual (%)', run: (v, p) => { need(v, p); return { value: (v * p) / 100, unit: 'money', text: `${fmtN(p)}% de ${fmtM(v)}` }; } },
};

/** Média de uma lista "100; 80; 120" ou "100, 80, 120" (vírgula decimal aceita com ';'). */
export function average(list) {
  const parts = String(list).includes(';') ? String(list).split(';') : String(list).split(/\s+/);
  const nums = parts.map((x) => x.trim()).filter(Boolean).map((x) => parseNumber(x));
  if (!nums.length) throw new CalcError('Informe os valores separados por espaço ou ponto e vírgula');
  return { value: nums.reduce((a, b) => a + b, 0) / nums.length, unit: 'money', text: `média de ${nums.length} valores` };
}

export function parseInputNumber(s) {
  const v = String(s ?? '').trim();
  if (!v) return NaN;
  try { return parseNumber(v.replace(/[^0-9.,-]/g, '')); } catch { return NaN; }
}

const fmtN = (n) => n.toLocaleString('pt-BR', { maximumFractionDigits: 4 });
const fmtM = (n) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
