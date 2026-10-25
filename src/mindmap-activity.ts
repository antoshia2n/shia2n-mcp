/**
 * shia2n-mcp / src/mindmap-activity.ts / 新設（2026-10-25 v1.43.0 開発部・週間レポートの口 便 2）
 *
 * 思考整理くんで「その日に足した枝・直した枝」を数える計算だけの部品（外に触らない・試験で回す）。
 * 依頼：https://app.notion.com/p/4049c6c1c439810e9935de14c976bf39
 *
 *   ・枝には作った時刻・直した時刻が無い（マップ 1 枚 1 行・nodes の JSON）。そこで毎朝の控え（保管庫の
 *     backup/日付/supabase/mm_maps.json）を隣の日と比べる。1 日の区切りは控えを取った時刻（毎朝 4〜6 時台）
 *   ・足した＝後の控えにだけある枝。直した＝両方にあって、文字・メモ・チェック・リンクのどれかが変わった枝。
 *     消した＝前の控えにだけある枝。マップの名前の枝（root）は数えない。同じ日に何度直しても 1 と数える
 *   ・テンプレと、Naoki 以外の行は数えない
 */

type Row = Record<string, any>;
/** マップ 1 枚を、枝の id → 中身の印 に縮めたもの（大きな控えを何日分も抱えないため） */
export type MapSig = { title: string; nodes: Map<string, string> };
export type Snap = Map<string, MapSig>;
export type MapDiff = { id: string; title: string; added: number; edited: number; removed: number; created: boolean; deleted: boolean };

const sigOf = (n: Row) => JSON.stringify([String(n?.text ?? ""), String(n?.memo ?? ""), String(n?.check ?? ""), String(n?.link ?? "")]);

/** 控えか今の表の行を縮める */
export function reduceRows(rows: Row[], owner: string): Snap {
  const out: Snap = new Map();
  for (const r of rows) {
    if (!r || r.user_id !== owner || r.is_template === true || typeof r.id !== "string") continue;
    const nodes = new Map<string, string>();
    const raw = r.nodes && typeof r.nodes === "object" ? (r.nodes as Record<string, Row>) : {};
    for (const [id, n] of Object.entries(raw)) if (id !== r.root) nodes.set(id, sigOf(n));
    out.set(r.id, { title: String(r.title || raw[r.root]?.text || "無題"), nodes });
  }
  return out;
}

/** 前と後の控えを比べ、変わったマップだけを返す */
export function diffSnaps(a: Snap, b: Snap): MapDiff[] {
  const out: MapDiff[] = [];
  for (const [id, m] of b) {
    const p = a.get(id);
    let added = 0, edited = 0, removed = 0;
    for (const [nid, s] of m.nodes) { const q = p?.nodes.get(nid); if (q === undefined) added++; else if (q !== s) edited++; }
    if (p) for (const nid of p.nodes.keys()) if (!m.nodes.has(nid)) removed++;
    if (added || edited || removed || !p) out.push({ id, title: m.title, added, edited, removed, created: !p, deleted: false });
  }
  for (const [id, p] of a) if (!b.has(id)) out.push({ id, title: p.title, added: 0, edited: 0, removed: p.nodes.size, created: false, deleted: true });
  return out.sort((x, y) => y.added + y.edited - (x.added + x.edited) || x.title.localeCompare(y.title, "ja"));
}

/** from〜to の日付の並び（YYYY-MM-DD） */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(from + "T00:00:00Z"); t <= Date.parse(to + "T00:00:00Z"); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
export const nextDate = (d: string) => new Date(Date.parse(d + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);

export type DayCount = { day: string; from: string; to: string; maps: MapDiff[] } | { day: string; missing: string };

/**
 * 日ごとの数。snaps は日付 → 控え（無い日は入れない）、live は今の表（今日の分と、今朝の控えがまだ無い昨日の分の終わりに使う）。
 * at は控え・今の表を取った時刻の見せ方
 */
export function countDays(days: string[], today: string, snaps: Map<string, Snap>, at: Map<string, string>, live: Snap | null, liveAt: string): DayCount[] {
  return days.map(day => {
    const a = snaps.get(day);
    if (!a) return { day, missing: `${day} の朝の控えが無い` };
    const nd = nextDate(day);
    let b = snaps.get(nd), bAt = at.get(nd) ?? "";
    if (!b && nd >= today && live) { b = live; bAt = liveAt + "（今の中身）"; }
    if (!b) return { day, missing: `${nd} の朝の控えが無い` };
    return { day, from: at.get(day) ?? "", to: bAt, maps: diffSnaps(a, b) };
  });
}
