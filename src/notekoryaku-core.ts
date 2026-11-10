/**
 * note攻略くんの「自分の記事」を note の数字から作る計算（2026-11-10 開発部・作業 72・Naoki「OK」20:55）。
 * 書く道具は src/tools-notekoryaku.ts。ここは計算だけ（試験は test/notekoryaku-core.test.ts）。
 *
 * スワイプ候補の決め：公開日の順に並べ、前後 5 本ずつ（端では片側だけ）の計 10 本のスキの真ん中（中央値）を「近い 10 本」とする。
 *   その記事のスキ ÷ 近い 10 本 が 1.2 倍以上なら候補。真ん中が 0 のときは 1 として割る（0 で割らない）。
 *   候補の印 pick = { r 倍率, base 真ん中, n 比べた本数, at 判定した日, st }。st は new（まだ見ていない）・sent（スワイプくんへ入れた）・skip（見送った）。
 *   判定し直すのは judge の範囲の記事だけ。範囲の外の印はそのまま残す。Naoki が決めた sent・skip は倍率だけ新しくし、st は残す。
 */

export type NoteIn = { key: string; title: string; published_at: string; price?: number; membership?: boolean; views?: number | null; likes?: number | null; comments?: number | null };
export type Snap = { v: number | null; l: number | null; c: number | null };
export type Pick = { r: number; base: number; n: number; at: string; st: "new" | "sent" | "skip" };
export type Old = { note_key: string; snaps?: Record<string, Snap> | null; pick?: Pick | null; sort?: number | null };

export const RATIO = 1.2;
export const SPAN = 5;
export const NOTE_URL = (key: string) => `https://note.com/shia2n/n/${key}`;

const jst = (iso: string) => new Date(Date.parse(iso) + 9 * 3600 * 1000).toISOString();
export const jstDay = (iso: string) => jst(iso).slice(0, 10);
export const jstMonth = (iso: string) => jst(iso).slice(0, 7);
export const prevMonthOf = (day: string) => { const [y, m] = day.slice(0, 7).split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; };

/** 種類：値段が付いていれば有料、メンシプにつながっていればメンシプ、ほかは無料 */
export const kindOf = (a: NoteIn) => ((+(a.price ?? 0) > 0) ? "paid" : a.membership ? "member" : "free");

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  if (!n) return 0;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** 記事ごとの倍率（公開日の順・前後 SPAN 本ずつ） */
export function ratios(arts: NoteIn[]): Map<string, { r: number; base: number; n: number }> {
  const a = [...arts].filter(x => num(x.likes) != null).sort((p, q) => p.published_at.localeCompare(q.published_at));
  const out = new Map<string, { r: number; base: number; n: number }>();
  a.forEach((x, i) => {
    const nb = [...a.slice(Math.max(0, i - SPAN), i), ...a.slice(i + 1, i + 1 + SPAN)];
    if (!nb.length) return;
    const base = median(nb.map(y => num(y.likes) as number));
    out.set(x.key, { r: Math.round(((num(x.likes) as number) / Math.max(base, 1)) * 100) / 100, base, n: nb.length });
  });
  return out;
}

/** 範囲：all（全部）か YYYY-MM（その月に公開した記事） */
export const inJudge = (judge: string, a: NoteIn) => judge === "all" || jstMonth(a.published_at) === judge;

export function nextPick(old: Pick | null | undefined, rr: { r: number; base: number; n: number } | undefined, judged: boolean, day: string): Pick | null {
  if (!judged) return old ?? null;
  const kept = old && (old.st === "sent" || old.st === "skip") ? old.st : null;
  if (!rr) return old ?? null;
  if (rr.r >= RATIO) return { r: rr.r, base: rr.base, n: rr.n, at: day, st: kept ?? "new" };
  return kept ? { r: rr.r, base: rr.base, n: rr.n, at: day, st: kept } : null; // 入れた・見送ったものは、倍率が下がっても印を消さない
}

/** 表に送る行（全部の行が同じ欄を持つ。PostgREST のまとめ送りの決まり） */
export function buildRows(owner: string, arts: NoteIn[], olds: Old[], day: string, judge: string) {
  const byKey = new Map(olds.map(o => [o.note_key, o]));
  const rr = ratios(arts);
  const sorted = [...arts].sort((p, q) => q.published_at.localeCompare(p.published_at));
  const rows = sorted.map((a, i) => {
    const o = byKey.get(a.key);
    const snap: Snap = { v: num(a.views), l: num(a.likes), c: num(a.comments) };
    return {
      user_id: owner, note_key: a.key, month: jstMonth(a.published_at), published_on: jstDay(a.published_at),
      title: String(a.title || "").slice(0, 300), url: NOTE_URL(a.key), kind: kindOf(a),
      views: snap.v, likes: snap.l, comments: snap.c, sort: o?.sort ?? (1000 + i),
      snaps: { ...(o?.snaps && typeof o.snaps === "object" ? o.snaps : {}), [day]: snap },
      pick: nextPick(o?.pick, rr.get(a.key), inJudge(judge, a), day),
      updated_at: new Date().toISOString(),
    };
  });
  return { rows, added: arts.filter(a => !byKey.has(a.key)).length };
}
