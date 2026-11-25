// Valores monetários são sempre inteiros em centavos.
// Regra de arredondamento: meio centavo é arredondado para longe do zero
// (0,005 → 0,01; −0,005 → −0,01), aplicado apenas na conversão para centavos.

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const plain = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });

export function roundHalfAway(x) {
  if (!Number.isFinite(x)) return NaN;
  const s = Math.sign(x);
  // Correção de ponto flutuante: 1.005 * 100 = 100.49999999999999
  return s * Math.round(Math.abs(x) + 1e-9);
}

/** Converte reais (number) em centavos inteiros. */
export function toCents(reais) {
  return roundHalfAway(reais * 100);
}

/** Converte centavos em reais (apenas para cálculos de projeção). */
export function fromCents(cents) {
  return cents / 100;
}

/**
 * Interpreta texto monetário brasileiro ou internacional.
 * "129,90" "1.234,56" "1234.56" "R$ 1.234" "-50" "1,5" → centavos.
 * Retorna null quando não é um valor válido.
 */
export function parseMoney(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? toCents(input) : null;
  if (typeof input !== 'string') return null;
  let s = input.trim().replace(/\s|R\$| /gi, '');
  if (!s) return null;
  let negative = false;
  if (s.startsWith('-') || s.startsWith('−')) { negative = true; s = s.slice(1); }
  if (!/^[0-9.,]+$/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let intPart, fracPart = '';
  if (lastComma >= 0 && lastDot >= 0) {
    const dec = lastComma > lastDot ? ',' : '.';
    const thou = dec === ',' ? '.' : ',';
    const idx = s.lastIndexOf(dec);
    intPart = s.slice(0, idx).split(thou).join('');
    fracPart = s.slice(idx + 1);
    if (intPart.includes(dec)) return null;
  } else if (lastComma >= 0) {
    const parts = s.split(',');
    if (parts.length > 2) return null;
    [intPart, fracPart] = parts;
  } else if (lastDot >= 0) {
    const parts = s.split('.');
    const tail = parts[parts.length - 1];
    if (parts.length === 2 && tail.length !== 3) {
      [intPart, fracPart] = parts; // 1234.5 ou 12.34 → decimal
    } else {
      // "1.234" ou "1.234.567" → separador de milhar (padrão brasileiro)
      if (parts.slice(1).some((p) => p.length !== 3)) return null;
      intPart = parts.join('');
    }
  } else {
    intPart = s;
  }
  if (intPart === '' && fracPart === '') return null;
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart)) return null;
  const value = Number(`${intPart || '0'}.${fracPart || '0'}`);
  if (!Number.isFinite(value)) return null;
  const cents = toCents(value);
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

export function formatMoney(cents, { signed = false } = {}) {
  if (!Number.isFinite(cents)) return '—';
  const text = brl.format(cents / 100);
  if (signed && cents > 0) return `+${text}`;
  return text;
}

/** Formato para campos de edição: "1.234,56". */
export function formatMoneyInput(cents) {
  if (!Number.isFinite(cents)) return '';
  return plain.format(cents / 100);
}

export function formatCompact(cents) {
  return `R$ ${compact.format(cents / 100)}`;
}

/**
 * Divide um total em n partes inteiras cuja soma é exatamente o total.
 * Os centavos excedentes vão para as primeiras parcelas:
 * 100000 / 3 → [33334, 33333, 33333].
 */
export function splitCents(total, n) {
  if (!Number.isSafeInteger(total) || !Number.isInteger(n) || n < 1) throw new Error('Divisão inválida');
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const base = Math.floor(abs / n);
  const rest = abs - base * n;
  return Array.from({ length: n }, (_, i) => sign * (base + (i < rest ? 1 : 0)));
}

export function sum(values) {
  let t = 0;
  for (const v of values) t += v;
  return t;
}

export function percent(part, whole) {
  if (!whole) return 0;
  return (part / whole) * 100;
}

export function formatPercent(p, digits = 1) {
  if (!Number.isFinite(p)) return '—';
  return `${p.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}
