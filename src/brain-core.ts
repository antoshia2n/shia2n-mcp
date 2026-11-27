/**
 * shia2n-mcp / src/brain-core.ts / 新設（2026-11-22 v1.130.0 開発部・ブレインくん 便B・Naoki OK 08:25）
 *
 * ブレインくん（brain.shia2n.jp）のノートを AI が読む・探す・整える候補を出すための、表に触らない決まりだけ。
 * 表は br_notes（ノート）・br_rels（意味のつながり）・br_settings（用途の名前）。書くことはしない。
 * AI は抜き出し・組み合わせの提案・評価をしない（Naoki の決め 11/21）。整える候補は「表記ゆれ・重複」の指摘だけ。
 */
export type BrLine = { id?: string; t: string; d?: string | null };
export type BrNote = { id: string; kind: string; use_id: string | null; title: string; folder: string; status: string; lines: BrLine[]; aliases: string[]; daily: string | null; touched_at: string; created_at: string };
export type BrRel = { id: string; from_id: string; to_id: string; label: string };

export const KIND_NAMES: Record<string, string> = { memo: "メモ", kw: "キーワード", pt: "パターン", idea: "アイデア", neta: "ネタ" };
export const kindName = (k: string): string => KIND_NAMES[k] ?? "メモ";
export const normName = (s: unknown): string => String(s ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();

/** 本文を読む形の文字に（[[題|表示]] は表示の言葉・** は外す・段落は改行） */
export const plainText = (lines: BrLine[] | null | undefined): string =>
  (lines || []).map(l => l.t).join("\n").replace(/\[\[([^\]|]+)\|([^\]]*)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1").replace(/\*\*/g, "");
/** 本文の [[ ]] の題 */
export const linksIn = (lines: BrLine[] | null | undefined): string[] =>
  [...new Set([...(lines || []).map(l => l.t).join("\n").matchAll(/\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g)].map(m => m[1].trim()))];

export type BrHit = { id: string; kind: string; title: string; use: string | null; status: string; in_title: boolean; snippet: string };
/** 題・エイリアス・本文から探す。題の当たりが上、あとは更新が新しい順 */
export function searchBrain(notes: BrNote[], q: string, opt: { kind?: string; uses?: Map<string, string>; limit?: number } = {}): BrHit[] {
  const nq = normName(q); const lq = String(q || "").trim().toLowerCase();
  const out: (BrHit & { touched: string })[] = [];
  for (const n of notes) {
    if (opt.kind && n.kind !== opt.kind) continue;
    const body = plainText(n.lines);
    const inTitle = !!nq && normName(n.title + " " + (n.aliases || []).join(" ")).includes(nq);
    const inBody = !!nq && normName(body).includes(nq);
    if (nq && !inTitle && !inBody) continue;
    const at = lq ? body.toLowerCase().indexOf(lq) : -1;
    const a = Math.max(0, at - 30);
    const snippet = at >= 0 ? (a ? "…" : "") + body.slice(a, at + lq.length + 60).replace(/\n/g, " ") + "…" : body.slice(0, 90).replace(/\n/g, " ");
    out.push({ id: n.id, kind: kindName(n.kind), title: n.title || (n.daily ? n.daily + " のデイリーノート" : "（無題）"), use: n.use_id ? opt.uses?.get(n.use_id) ?? null : null, status: n.status, in_title: inTitle, snippet, touched: n.touched_at });
  }
  return out.sort((x, y) => (Number(y.in_title) - Number(x.in_title)) || (y.touched > x.touched ? 1 : -1)).slice(0, opt.limit ?? 30).map(({ touched, ...h }) => h);
}

export type TidyItem = { reason: "重複" | "表記ゆれ"; kind: string; notes: { id: string; title: string }[] };
/**
 * 整える候補（キーワード・パターンの中だけ）。決めるのは Naoki。
 *   重複：題を全角半角・空白・大小をそろえると同じになるもの
 *   表記ゆれ：片方の題がもう片方に含まれ、長さの差が 3 字以内のもの（例：内向型／陽キャ・内向型 は差が大きいので出さない）
 */
export function tidyCandidates(notes: BrNote[], kind?: "kw" | "pt"): TidyItem[] {
  const pool = notes.filter(n => !n.daily && (n.kind === "kw" || n.kind === "pt") && (!kind || n.kind === kind) && normName(n.title));
  const out: TidyItem[] = []; const seen = new Set<string>();
  const groups = new Map<string, BrNote[]>();
  for (const n of pool) { const k = n.kind + "|" + normName(n.title); groups.set(k, [...(groups.get(k) ?? []), n]); }
  for (const g of groups.values()) if (g.length > 1) { out.push({ reason: "重複", kind: kindName(g[0].kind), notes: g.map(n => ({ id: n.id, title: n.title })) }); g.forEach(n => seen.add(n.id)); }
  for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
    const a = pool[i], b = pool[j]; if (a.kind !== b.kind || seen.has(a.id) && seen.has(b.id)) continue;
    const x = normName(a.title), y = normName(b.title); if (x === y) continue;
    const [s, l] = x.length <= y.length ? [x, y] : [y, x];
    if (s.length >= 2 && l.includes(s) && l.length - s.length <= 3) out.push({ reason: "表記ゆれ", kind: kindName(a.kind), notes: [{ id: a.id, title: a.title }, { id: b.id, title: b.title }] });
  }
  return out;
}

/* ── AI の候補（v1.152.0・2026-11-27 Naoki OK 12:57）：Claude が読んだ結果を br_ai に入れる前の確かめ ── */
export type AiKind = "kw" | "pt" | "task";
export type AiIn = { note_id?: string | null; kind: AiKind; title: string; use?: string | null; why?: string };
export type AiRow = { kind: string; title: string; state: string };
export type AiAdd = { note_id: string | null; kind: AiKind; title: string; use_id: string | null; why: string };
/**
 * 入れてよい候補だけを返す。外すのは：題が空・同じ回の中で重なる・候補箱に同じ種類で同じ題がある（捨てたものも含む＝一度捨てたものは出し直さない）・
 * キーワードとパターンは同じ題のノートがもうある・元のノートが見つからない。用途は名前で受け、設定の用途の id に置き換える（当たらなければ用途なし）
 */
export function planSuggestions(items: AiIn[], have: AiRow[], notes: Pick<BrNote, "id" | "title" | "daily">[], uses: Map<string, string>): { add: AiAdd[]; skipped: { title: string; reason: string }[] } {
  const seen = new Set(have.map(r => r.kind + ":" + normName(r.title)));
  const noteTitles = new Set(notes.filter(n => !n.daily).map(n => normName(n.title)));
  const ids = new Set(notes.map(n => n.id));
  const useId = new Map([...uses].map(([id, n]) => [normName(n), id]));
  const add: AiAdd[] = []; const skipped: { title: string; reason: string }[] = [];
  for (const it of items) {
    const title = String(it.title ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200);
    if (!title) { skipped.push({ title: "", reason: "題が空" }); continue; }
    const key = it.kind + ":" + normName(title);
    if (seen.has(key)) { skipped.push({ title, reason: "候補箱にもうある（捨てたものも含む）" }); continue; }
    if (it.kind !== "task" && noteTitles.has(normName(title))) { skipped.push({ title, reason: "同じ題のノートがもうある" }); continue; }
    if (it.note_id && !ids.has(it.note_id)) { skipped.push({ title, reason: "元のノートが見つからない" }); continue; }
    seen.add(key);
    add.push({ note_id: it.note_id || null, kind: it.kind, title, use_id: it.kind === "kw" && it.use ? useId.get(normName(it.use)) ?? null : null, why: String(it.why ?? "").trim().slice(0, 500) });
  }
  return { add, skipped };
}
