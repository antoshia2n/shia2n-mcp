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
 *   xa_weeks.act_goals … その回の行動の項目と 1 日の目標 { items: [{ k, l, goal, hy }] }。空の回は前の回のものを使う。前の形 { quote, self, reply } も読む
 *   xa_items.memo       … 戦略と仮説のメモ（作業 34）
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

/**
 * 施策の特徴（2026-10-26 v1.47.0）：画面の書く窓の 1 段目と同じ文。
 * memo（施策の特徴）があればそのまま。無い回は、層ごとに書いた分を「層の名前：文」で並べる（書いたまま・要約しない）
 */
export function featOf(o: Row | null | undefined): string {
  const memo = String(o?.memo ?? "").trim();
  if (memo) return String(o?.memo);
  return Object.entries(layersOf(o?.ly)).map(([k, v]) => `${k}：${v}`).join("\n");
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

/** act_goals を項目の並びにする。前の形（種類ごとの目標だけ）も読む。どちらでもなければ null */
export function normItems(g: Row | null | undefined): Row[] | null {
  if (g && Array.isArray(g.items)) return g.items.filter((x: Row) => x && x.k).map((x: Row) => ({ k: String(x.k), l: String(x.l || ""), goal: Number(x.goal) || 0, hy: x.hy || "" }));
  if (g && typeof g === "object" && Object.keys(g).length) return Object.entries(ACT_KINDS).map(([k, l]) => ({ k, l, goal: Number(g[k]) || 0, hy: "" }));
  return null;
}

/** その回の項目：その回に無ければ前の回（sort が小さい方）から引き継ぐ。どこにも無ければ最初の 3 つ。画面の itemsOf と同じ */
export function itemsFor(weeks: Row[], w: Row): Row[] {
  const list = [...weeks].filter(x => (x.sort ?? 0) <= (w.sort ?? 0)).sort((a, b) => (b.sort ?? 0) - (a.sort ?? 0));
  for (const x of list) { const it = normItems(x.act_goals); if (it) return it; }
  return Object.entries(ACT_KINDS).map(([k, l]) => ({ k, l, goal: 0, hy: "" }));
}

/** 1 回分の行動のまとめ：項目ごとの目標・合計・達成（目標 × 過ぎた日数）・日ごと・確かめる仮説・相手ごと。項目に無い記録は名前の代わりに印のまま出す */
export function actsSummary(rows: Row[], days: string[], items: Row[], today: string, name: (h: string) => string, hyText: (id: string) => string = () => "") {
  const inWeek = rows.filter(r => days.includes(String(r.day)));
  const elapsed = days.filter(d => d <= today).length;
  const label = (k: string) => items.find(x => x.k === k)?.l || ACT_KINDS[k] || k;
  const keys = [...items.map(x => x.k), ...[...new Set(inWeek.map(r => String(r.kind)))].filter(k => !items.some(x => x.k === k))];
  const 項目 = keys.map(k => {
    const it = items.find(x => x.k === k), mine = inWeek.filter(r => r.kind === k), sum = mine.reduce((s, r) => s + (r.n || 0), 0), goal = Number(it?.goal) || 0;
    return { 項目: label(k), "1日の目標": goal || null, この回: sum, 達成: goal && elapsed ? `${Math.round(sum / (goal * elapsed) * 100)}%` : null,
      ...(it?.hy && hyText(it.hy) ? { 確かめる仮説: hyText(it.hy) } : {}), ...(it ? {} : { この回の項目にない: true }),
      日ごと: Object.fromEntries(days.filter(d => d <= today).map(d => [d, mine.filter(r => r.day === d).reduce((s, r) => s + (r.n || 0), 0)])) };
  });
  const by = new Map<string, Row>();
  for (const r of inWeek) { if (!r.n) continue; const key = String(r.account || "").toLowerCase(); const p = by.get(key) || { 相手: r.account ? name(r.account) : "相手なし", ...(r.account ? { "@": r.account } : {}) }; const l = label(String(r.kind)); p[l] = (p[l] || 0) + r.n; by.set(key, p); }
  return { 項目, 相手ごと: [...by.values()] };
}

/* ── 打ち手ごとの材料（2026-11-12 X攻略くん・お手本と出した投稿）──────────────
 * 画面の③戦略の打ち手（kind st・目的以外）を、状態・本数・仮説・お手本（スワイプくん）・今週の評価（ladder.ev）・今週コンテンツくんで出した投稿にまとめる。
 * 出した投稿は、打ち手の本数の種類（src の per.pt）と同じ種類で、その週の日に予約・公開したもの。種類の無い打ち手は空 */
export const PT_NAME: Record<string, string> = { x_post: "Xポスト", x_quote: "X引用", x_article: "X記事", note: "note", membership: "メンシプ" };
export const EV_NAME: Record<number, string> = { 5: "最高", 4: "良い", 3: "普通", 2: "悪い", 1: "最悪" };
export function movesOf(items: Row[], month: string, week: Row | null, ladder: Row | null, posts: Row[]): Row[] {
  const days = week ? weekDays(week.month, week.label) : [], ds = new Set(days);
  const ev: Row = (week && ladder?.ev?.[week.id]) || {};
  const per = (i: Row) => (i.src || []).find((s: Row) => s && s.per && typeof s.per === "object")?.per || null;
  const st = (i: Row) => (i.src || []).find((s: Row) => s && s.state)?.state || "";
  return items.filter(i => i.kind === "st" && i.layer !== "goal" && inMonth(i, month) && (!i.archived || String(i.until_month || "") >= month)).map(i => {
    const p = per(i), pt = p ? String(p.pt || "") : "";
    const hy = (i.links || []).map((id: string) => items.find(x => x.id === id && x.kind === "hy")?.body).filter(Boolean);
    const refs = (i.src || []).filter((s: Row) => s && s.ref).map((s: Row) => ({ 題: s.ref.title || "", 種類: s.ref.shu || "", 投稿者: s.ref.author || "", URL: s.ref.url || "", 画像: s.ref.shot || "" }));
    const outs = pt ? posts.filter(o => (o.post_type || "x_post") === pt && ds.has(String(o.datetime || "").slice(0, 10))).map(o => ({ 日: String(o.datetime).slice(0, 10), 題: o.title || "", 状態: o.status === "published" ? "公開" : "予約", ...(o.score ? { 評価: o.score } : {}), ...(o.x_url ? { URL: o.x_url } : {}) })) : [];
    return { id: i.id, 中身: i.body || "", 層: layerName(i.layer), 状態: i.archived ? "停止" : st(i) === "wait" ? "控え" : "今週オン",
      ...(p && +p.n ? { 本数: `${+p.n} 本／${p.u === "週" ? "週" : "日"}${pt ? "・" + (PT_NAME[pt] || pt) : ""}` } : {}),
      ...(hy.length ? { 仮説: hy } : {}), お手本: refs, ...(ev[i.id] ? { 今週の評価: EV_NAME[ev[i.id]] } : {}), 今週出した投稿: outs };
  });
}

/* ── 仮説とノウハウのストック（2026-11-13・X攻略くん 便4・note攻略くんから逆輸入）──
 * 画面と同じ形：仮説 kind hy・ノウハウ kind kn。評価は grade（C・B・A・S）、フォルダ・評価の変化・リンクは src の { sk: { folder, grades, links } }。
 * 仮説・ノウハウ → 立ち回り（kind st）の結びは、仮説・ノウハウの側の links に立ち回りの id */
export const STOCK_KIND: Record<string, string> = { 仮説: "hy", ノウハウ: "kn" };
const GR_ORD: Record<string, number> = { S: 4, A: 3, B: 2, C: 1, "": 0 };
const skOf = (i: Row): Row => { const k = (Array.isArray(i.src) ? i.src : []).find((s: Row) => s && s.sk && typeof s.sk === "object")?.sk || {}; return { folder: String(k.folder || ""), grades: Array.isArray(k.grades) ? k.grades : [], links: Array.isArray(k.links) ? k.links : [] }; };
export const layerIdOf = (name?: string) => (LAYERS.find(l => l[1] === name || l[0] === name) || LAYERS[2])[0];
export function xbStockOf(items: Row[], weeks: Row[], accounts: Row[], kind?: string, folder?: string): Row[] {
  const sts = items.filter(i => i.kind === "st" && !i.archived);
  return items.filter(i => (i.kind === "hy" || i.kind === "kn") && !i.archived && (!kind || i.kind === kind) && (folder == null || skOf(i).folder === folder))
    .sort((a, b) => (GR_ORD[b.grade || ""] - GR_ORD[a.grade || ""]) || String(b.created_at || "").localeCompare(String(a.created_at || "")))
    .map(i => { const sk = skOf(i); let down = ""; for (let n = 1; n < sk.grades.length; n++) if ((GR_ORD[sk.grades[n].g] || 0) < (GR_ORD[sk.grades[n - 1].g] || 0)) down = `${sk.grades[n].at} に ${sk.grades[n - 1].g}→${sk.grades[n].g}`;
      const src = [...new Set((Array.isArray(i.src) ? i.src : []).filter((s: Row) => s && (s.week_id || s.account)).map((s: Row) => `${accounts.find(a => a.handle === s.account)?.name || s.account || ""}（${weeks.find(w => w.id === s.week_id)?.label || ""}の分析）`))];
      const used = sts.filter(s => (i.links || []).includes(s.id)).map(s => s.body || "");
      return { id: i.id, 種類: i.kind === "kn" ? "ノウハウ" : "仮説", 文: i.body || "", 評価: i.grade || "なし", 層: layerName(i.layer), フォルダ: sk.folder || "未分類", 登録日: String(i.created_at || "").slice(0, 10),
        ...(sk.grades.length ? { 評価の変化: sk.grades.map((g: Row) => `${g.g} ${g.at}`).join(" → ") } : {}), ...(down ? { ここまで通用: down } : {}),
        ...(src.length ? { 出どころ: src } : {}), ...(sk.links.length ? { リンク: sk.links.map((l: Row) => ({ 題: l.t || "", URL: l.url })) } : {}),
        ...(String(i.memo || "").trim() ? { メモ: i.memo } : {}), ...(used.length ? { 使っている立ち回り: used } : {}) }; });
}
/** 足す 1 行。同じ種類で同じ文（前後の空白を除く）がもうあれば null */
export function xbStockRow(x: Row, owner: string, today: string, items: Row[]): Row | null {
  const kind = STOCK_KIND[x.kind]; const body = String(x.text || "").trim(); if (!kind || !body) return null;
  if (items.some(i => i.kind === kind && !i.archived && String(i.body || "").trim() === body)) return null;
  const links = [...(x.map_url ? [{ t: "思考整理くんのマップ", url: String(x.map_url) }] : []), ...((x.links || []) as Row[]).map(l => ({ t: String(l.title || ""), url: String(l.url || "") }))].filter(l => /^https?:\/\//i.test(l.url)).slice(0, 6);
  return { user_id: owner, layer: layerIdOf(x.layer), kind, body: body.slice(0, 500), memo: String(x.note || "").slice(0, 4000), grade: "C", src: [{ sk: { folder: String(x.folder || "").trim().slice(0, 30), grades: [{ g: "C", at: today }], links } }], links: [], from_month: today.slice(0, 7), archived: false, tm: false, sort: 9999 };
}
