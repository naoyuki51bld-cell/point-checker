// 集計ロジック（画面に依存しない純粋な関数）

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// 0〜満点の範囲にある点数だけを有効とみなす
export function validScore(item, scores) {
  const v = scores ? scores[item.id] : undefined;
  return isNum(v) && v >= 0 && v <= item.max ? v : null;
}

// 問題の集まり（テスト1回分、セット全体、ある分野だけ…）について、ある生徒の得点をまとめる
//
// 選択問題: item.cg（選択グループのキー）・item.block（大問）・item.pick（選ぶ数）を持つ問題は、
// グループの中から pick 個の大問だけを解く。
// - 満点   : 必答の満点 ＋ 各グループで満点の大きい順に pick 個の大問の満点
// - 全問記入: 必答をすべて記入し、各グループでちょうど pick 個の大問をすべて記入している
export function evalGroup(items, scores) {
  let sum = 0, count = 0, enteredMax = 0;
  let reqMax = 0, reqTotal = 0, reqCount = 0;
  const groups = new Map();
  for (const it of items) {
    const v = validScore(it, scores);
    if (v !== null) { sum += v; count++; enteredMax += it.max; }
    if (it.cg) {
      let g = groups.get(it.cg);
      if (!g) groups.set(it.cg, (g = { pick: it.pick || 1, blocks: new Map() }));
      let b = g.blocks.get(it.block);
      if (!b) g.blocks.set(it.block, (b = { max: 0, total: 0, count: 0 }));
      b.max += it.max; b.total++; if (v !== null) b.count++;
    } else {
      reqMax += it.max; reqTotal++; if (v !== null) reqCount++;
    }
  }
  let max = reqMax, total = reqTotal;
  let complete = items.length > 0 && reqCount === reqTotal;
  for (const g of groups.values()) {
    const bl = [...g.blocks.values()];
    const pick = Math.min(g.pick, bl.length);
    const top = [...bl].sort((a, b) => b.max - a.max).slice(0, pick);
    max += top.reduce((a, b) => a + b.max, 0);
    total += top.reduce((a, b) => a + b.total, 0);
    const full = bl.filter((b) => b.count === b.total).length;
    const touched = bl.filter((b) => b.count > 0).length;
    if (!(full === pick && touched === pick)) complete = false;
  }
  return {
    sum, max, count, total, enteredMax, complete,
    rate: enteredMax > 0 ? sum / enteredMax : null,
  };
}

// 問題番号から大問を決める（「4-1」「4-2」→「4」、「4」→「4」）
export const blockOf = (q) => (q.block || String(q.label || '').split(/[-－ー‐−(（]/)[0].trim() || q.id);

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

// 選ばなかった選択問題（その選択グループで1つ以上の大問に記入しているのに、記入していない大問の問題）。
// 分野ごとに切り出す前の、テスト／セット全体の問題で判定する。まだどれも選んでいないグループは対象外。
export function unchosenIds(items, scores) {
  const groups = new Map();
  for (const it of items) {
    if (!it.cg) continue;
    let g = groups.get(it.cg);
    if (!g) groups.set(it.cg, (g = new Map()));
    let b = g.get(it.block);
    if (!b) g.set(it.block, (b = { items: [], touched: false }));
    b.items.push(it);
    if (validScore(it, scores) !== null) b.touched = true;
  }
  const out = new Set();
  for (const g of groups.values()) {
    const bl = [...g.values()];
    if (!bl.some((b) => b.touched)) continue;
    for (const b of bl) if (!b.touched) for (const it of b.items) out.add(it.id);
  }
  return out;
}
