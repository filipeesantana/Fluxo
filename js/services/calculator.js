// Parser matemático seguro (descida recursiva). Nenhum eval/Function.
// Gramática:
//   expr   := term (('+' | '-') term)*
//   term   := unary (('*' | '/') unary)*
//   unary  := ('-' | '+') unary | postfix
//   postfix:= primary '%'?
//   primary:= number | '(' expr ')'
// Porcentagem no estilo de calculadora:
//   200 + 10% = 220   200 - 10% = 180   200 * 10% = 20   50% = 0,5

export class CalcError extends Error {}

const OPS = new Set(['+', '-', '*', '/', '(', ')', '%']);

export function tokenize(input) {
  const src = String(input).replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/\s+/g, '');
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (OPS.has(c)) { tokens.push({ t: c }); i++; continue; }
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

export function evaluate(input) {
  const tokens = tokenize(input);
  if (!tokens.length) throw new CalcError('Expressão vazia');
  let pos = 0;
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
    if (take('(')) {
      const e = expr();
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
  // Remove ruído de ponto flutuante (0,1 + 0,2 = 0,3).
  return Number(v.toPrecision(12));
}

export function formatResult(v) {
  return v.toLocaleString('pt-BR', { maximumFractionDigits: 10 });
}
