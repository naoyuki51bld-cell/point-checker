// 集計ロジック（画面に依存しない純粋な関数）

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// 得点表の構造から、回・セット・分野ごとの問題リストを作る
export function indexWorkbook(wb) {
  const all = [];
  const rounds = new Map();
  const sets = new Map();
  const fields = new Map((wb.fields || []).map((f) => [f.id, []]));
  for (const set of wb.sets || []) {
    const setItems = [];
    for (const round of set.rounds || []) {
      const roundItems = [];
      for (const item of round.items || []) {
        const it = { ...item, roundId: round.id, setId: set.id, roundLabel: round.label };
        all.push(it);
        roundItems.push(it);
        setItems.push(it);
        if (fields.has(item.fieldId)) fields.get(item.fieldId).push(it);
      }
      rounds.set(round.id, roundItems);
    }
    sets.set(set.id, setItems);
  }
  return { all, rounds, sets, fields };
}

// 0〜満点の範囲にある点数だけを有効とみなす
export function validScore(item, scores) {
  const v = scores ? scores[item.id] : undefined;
  return isNum(v) && v >= 0 && v <= item.max ? v : null;
}

export function evalGroup(items, scores) {
  let sum = 0, max = 0, count = 0, enteredMax = 0;
  for (const it of items) {
    max += it.max;
    const v = validScore(it, scores);
    if (v !== null) { sum += v; count++; enteredMax += it.max; }
  }
  return {
    sum, max, count, total: items.length, enteredMax,
    complete: items.length > 0 && count === items.length,
    rate: enteredMax > 0 ? sum / enteredMax : null,
  };
}

export function describe(values) {
  const n = values.length;
  if (!n) return { n: 0, avg: null, sd: null, max: null };
  const avg = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - avg) ** 2, 0) / n);
  return { n, avg, sd, max: Math.max(...values) };
}

export const rankOf = (values, v) => 1 + values.filter((x) => x > v + 1e-9).length;

// allScores: { uid: { itemId: score } }（生徒全員分）
// 回・セットは「全問入力済み」の人どうしで合計点を比較。
// 分野・全体は「入力済みの問題の得点率」で比較（進み具合が違っても比べられるように）。
export function computeStats(wb, allScores, myUid) {
  const idx = indexWorkbook(wb);
  const uids = Object.keys(allScores);
  const out = { students: uids.length, items: {}, rounds: {}, sets: {}, fields: {}, overall: null };

  for (const it of idx.all) {
    const vals = uids.map((u) => validScore(it, allScores[u])).filter((v) => v !== null);
    out.items[it.id] = describe(vals);
  }

  const byComplete = (items) => {
    const vals = [];
    let mine = null;
    for (const u of uids) {
      const g = evalGroup(items, allScores[u]);
      if (g.complete) { vals.push(g.sum); if (u === myUid) mine = g.sum; }
    }
    const d = describe(vals);
    return { ...d, rank: mine !== null ? rankOf(vals, mine) : null };
  };
  const byRate = (items) => {
    const vals = [];
    let mine = null;
    for (const u of uids) {
      const g = evalGroup(items, allScores[u]);
      if (g.count > 0) { vals.push(g.rate); if (u === myUid) mine = g.rate; }
    }
    const d = describe(vals);
    return { ...d, rank: mine !== null ? rankOf(vals, mine) : null };
  };

  for (const [id, items] of idx.rounds) out.rounds[id] = byComplete(items);
  for (const [id, items] of idx.sets) out.sets[id] = byComplete(items);
  for (const [id, items] of idx.fields) out.fields[id] = byRate(items);
  out.overall = byRate(idx.all);
  return out;
}

export const deviation = (v, d) => (d && d.n > 1 && d.sd > 0 ? 50 + (10 * (v - d.avg)) / d.sd : 50);
