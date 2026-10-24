/**
 * X分析くん（x-koryaku.shia2n.jp）の記録を読み書きするときの、表に触らない部分。
 * 2026-10-23 開発部。表に触るのは tools-xbunseki.ts。
 *
 * 表（画面 antoshia2n/x-koryaku の src/engine/data.js と同じ）
 *   xa_accounts … 見る相手（handle・name・is_self・archived・labels・info）
 *   xa_weeks    … 1 回（週）が 1 行（month・label・sort・policy・timeline・overall・metrics）
 *   xa_obs      … 1 回 × 1 人（week_id・account・score・ly・memo・ana・use_text）
 *   xa_items    … 戦略と計画の 1 項目（layer・kind・body・src・links・from_month・until_month・archived）
 *   xa_acts     … 行動の記録（2026-10-24・作業 33）。1 日 × 種類（quote・self・reply）× 相手で、押した数 n
 *   xa_weeks.act_goals … その回の 1 日の目標。空の回は前の回の目標を使う
 *
 * 決まり：分析は Naoki が手で書く。Claude は読む・呼び出す・数字を写すだけ（画面の「AI の使い方」と同じ）
 */

export type Row = Record<string, any>;

export const LAYERS: [string, string][] = [
  ["goal", "アカウントの目的・意図"], ["ostyle", "運用のスタイル"], ["ocont", "運用の内容"], ["pstyle", "投稿のスタイル"], ["pcont", "投稿の内容"],
];
export const KINDS: Record<string, string> = { an: "分析", hy: "仮説", st: "戦略", pl: "計画" };
export const METRICS: Record<string, string> = { imp: "平均インプ", fol: "フォロワー", kiji: "記事の本数", qt: "引用された数" };
export const layerName = (id: string) => (LAYERS.find(l => l[0] === id) || [id, id])[1];

/** 層の中身を「名前: 文」の形にする（空の層は出さない） */
export function layersOf(ly: Row | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, name] of LAYERS) { const v = String(ly?.[id] ?? "").trim(); if (v) out[name] = v; }
  return out;
}

/** 日本時間の今日から、画面と同じ「10月4週」の名前を作る */
export function currentWeekLabel(now = new Date()): { month: string; label: string } {
  const d = new Date(now.getTime() + 9 * 3600 * 1000);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, n = Math.ceil(d.getUTCDate() / 7);
  return { month: `${y}-${String(m).padStart(2, "0")}`, label: `${m}月${n}週` };
}

/**
 * 週の指定を 1 行に決める。id・「10月4週」・「2026-10 10月4週」・「今週」・省略（いちばん新しい回）を受ける。
 * 同じ名前が別の年にあるときは新しい方。
 */
export function pickWeek(weeks: Row[], want?: string, now = new Date()): Row | null {
  const list = [...weeks].sort((a, b) => (b.sort ?? 0) - (a.sort ?? 0));
  const w = String(want ?? "").trim();
  if (!w) return list[0] ?? null;
  if (w === "今週") { const c = currentWeekLabel(now); return list.find(x => x.month === c.month && x.label === c.label) ?? null; }
  const byId = list.find(x => x.id === w); if (byId) return byId;
  const m = w.match(/^(\d{4}-\d{2})\s+(.+)$/);
  if (m) return list.find(x => x.month === m[1] && x.label === m[2].trim()) ?? null;
  return list.find(x => x.label === w) ?? null;
}

/** 数字の写し：渡された欄だけを足し、空や数でないものは捨てる */
export function mergeMetrics(cur: Row | null | undefined, put: Record<string, unknown>): { next: Row; changed: string[] } {
  const next: Row = { ...(cur || {}) }; const changed: string[] = [];
  for (const k of Object.keys(METRICS)) {
    const v = put[k]; if (v === undefined || v === null || v === "") continue;
    const n = typeof v === "number" ? v : Number(String(v).replace(/[,，\s]/g, ""));
    if (!Number.isFinite(n) || n < 0) continue;
    if (next[k] !== n) changed.push(k);
    next[k] = Math.round(n);
  }
  return { next, changed };
}

/** 打ち手がその月に生きているか（画面の inMonth と同じ） */
export const inMonth = (i: Row, m: string) => String(i.from_month || "") <= m && (!i.until_month || m <= String(i.until_month));

/* ── 行動の記録（2026-10-24） ───────────────────────────── */
export const ACT_KINDS: Record<string, string> = { quote: "他人の引用", self: "セルフ引用", reply: "リプ" };

/** 「10月4週」の日：その月の (n-1)*7+1 日〜 n*7 日（月の終わりで切る）。画面の weekDays と同じ */
export function weekDays(month: string, label: string): string[] {
  const [y, m] = month.split("-").map(Number); const n = parseInt((String(label).match(/(\d+)週/) || [])[1] || "", 10);
  if (!y || !m || !n) return [];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate(), out: string[] = [];
  for (let d = n * 7 - 6; d <= Math.min(n * 7, last); d++) out.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  return out;
}

/** その回の目標：その回に無ければ前の回（sort が小さい方）から引き継ぐ。画面の goalsOf と同じ */
export function goalsFor(weeks: Row[], w: Row): Row {
  const list = [...weeks].filter(x => (x.sort ?? 0) <= (w.sort ?? 0)).sort((a, b) => (b.sort ?? 0) - (a.sort ?? 0));
  for (const x of list) { const g = x.act_goals; if (g && typeof g === "object" && Object.keys(g).length) return g; }
  return {};
}

/** 1 回分の行動のまとめ：種類ごとの目標・合計・達成（目標 × 過ぎた日数）・日ごと・相手ごと */
export function actsSummary(rows: Row[], days: string[], goals: Row, today: string, name: (h: string) => string) {
  const inWeek = rows.filter(r => days.includes(String(r.day)));
  const elapsed = days.filter(d => d <= today).length;
  const 種類 = Object.entries(ACT_KINDS).map(([k, l]) => {
    const mine = inWeek.filter(r => r.kind === k), sum = mine.reduce((s, r) => s + (r.n || 0), 0), goal = Number(goals[k]) || 0;
    return { 種類: l, "1日の目標": goal || null, この回: sum, 達成: goal && elapsed ? `${Math.round(sum / (goal * elapsed) * 100)}%` : null,
      日ごと: Object.fromEntries(days.filter(d => d <= today).map(d => [d, mine.filter(r => r.day === d).reduce((s, r) => s + (r.n || 0), 0)])) };
  });
  const by = new Map<string, Row>();
  for (const r of inWeek) { if (!r.n) continue; const key = String(r.account || "").toLowerCase(); const p = by.get(key) || { 相手: r.account ? name(r.account) : "相手なし", ...(r.account ? { "@": r.account } : {}) }; const l = ACT_KINDS[r.kind] || r.kind; p[l] = (p[l] || 0) + r.n; by.set(key, p); }
  return { 種類, 相手ごと: [...by.values()] };
}
