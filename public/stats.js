// 集計ロジック（画面に依存しない純粋な関数）

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// 0〜満点の範囲にある点数だけを有効とみなす
export function validScore(item, scores) {
  const v = scores ? scores[item.id] : undefined;
  return isNum(v) && v >= 0 && v <= item.max ? v : null;
}

// 問題の集まり（テスト1回分、セット全体、ある分野だけ…）について、ある生徒の得点をまとめる
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
  if (!n) return { n: 0, avg: null, sd: null, max: null, min: null };
  const avg = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - avg) ** 2, 0) / n);
  return { n, avg, sd, max: Math.max(...values), min: Math.min(...values) };
}

export const rankOf = (values, v) => 1 + values.filter((x) => x > v + 1e-9).length;

export const deviation = (v, d) => (d && d.n > 1 && d.sd > 0 ? 50 + (10 * (v - d.avg)) / d.sd : 50);

// allScores: { uid: { itemId: score } }
// mode 'complete': 全問記入した人どうしで合計点を比べる（テスト1回分の比較に使う）
// mode 'rate'    : 1問以上記入した人どうしで、記入済みの問題の得点率を比べる（分野・セットの比較に使う）
export function compare(items, allScores, myUid, mode = 'complete') {
  const values = [];
  let mine = null;
  for (const [uid, scores] of Object.entries(allScores)) {
    const g = evalGroup(items, scores);
    const ok = mode === 'complete' ? g.complete : g.count > 0;
    if (!ok) continue;
    const v = mode === 'complete' ? g.sum : g.rate;
    values.push(v);
    if (uid === myUid) mine = v;
  }
  const d = describe(values);
  return { ...d, values, mine, rank: mine !== null ? rankOf(values, mine) : null };
}

// 得点分布: 0〜max を bins 個の区間に分けて人数を数える（最後の区間は満点を含む）
export function histogram(values, max, bins = 10) {
  const width = max / bins;
  const out = Array.from({ length: bins }, (_, i) => ({ lo: i * width, hi: (i + 1) * width, count: 0 }));
  for (const v of values) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor(v / width + 1e-9)));
    out[i].count++;
  }
  return out;
}
export const binOf = (v, max, bins = 10) => Math.min(bins - 1, Math.max(0, Math.floor(v / (max / bins) + 1e-9)));
