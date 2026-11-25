// Sugestões determinísticas baseadas no histórico: mesma entrada → mesma saída.

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * Agrupa lançamentos anteriores por descrição e devolve os mais relevantes
 * para o texto digitado, com a classificação mais usada em cada um.
 */
export function descriptionSuggestions(query, transactions, { type, limit = 6 } = {}) {
  const q = fold(query);
  if (q.length < 1) return [];
  const groups = new Map();
  for (const t of transactions) {
    if (type && t.type !== type) continue;
    if (t.type === 'transfer' || !t.description) continue;
    const key = fold(t.description);
    if (!key.includes(q)) continue;
    let g = groups.get(key);
    if (!g) { g = { description: t.description, count: 0, last: '', starts: key.startsWith(q), latest: null }; groups.set(key, g); }
    g.count++;
    const stamp = `${t.date}|${t.createdAt || 0}`;
    if (stamp > g.last) { g.last = stamp; g.latest = t; g.description = t.description; }
  }
  return [...groups.values()]
    .sort((a, b) => (b.starts - a.starts) || (b.count - a.count) || (a.last < b.last ? 1 : -1))
    .slice(0, limit)
    .map((g) => ({
      description: g.description,
      count: g.count,
      categoryId: g.latest.categoryId,
      blockId: g.latest.blockId,
      sourceId: g.latest.sourceId,
      amount: g.latest.amount,
      type: g.latest.type,
    }));
}

/** Fontes ordenadas por uso recente (últimos 60 lançamentos). */
export function recentSources(transactions, limit = 60) {
  const recent = [...transactions]
    .filter((t) => t.sourceId && t.type !== 'transfer')
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, limit);
  const score = new Map();
  recent.forEach((t, i) => score.set(t.sourceId, (score.get(t.sourceId) || 0) + (limit - i)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

export function matches(query, ...fields) {
  const q = fold(query);
  if (!q) return true;
  return fields.some((f) => fold(f).includes(q));
}

export { fold };
