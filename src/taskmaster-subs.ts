/**
 * TaskMaster のサブタスクの見積もり時間と進捗率（2026-11-12 開発部・Naoki「見積もり時間は読み書きできたほうがいいかもね」）。
 * 画面の taskmaster src/lib/util.js の subStats・subEstOf と同じ決まり。画面とずれたら画面が正本。
 *   - 見積もりはサブタスクの欄 est（分・正の整数）
 *   - 進捗率：全部のサブタスクに見積もりがあれば時間で（済んだ分 ÷ 合計）、1 件でも空なら件数で
 *   - サブタスクは古い形（文字だけ・text／name・completed）も読む
 */
type Item = Record<string, unknown>;

export const subEstOf = (v: unknown): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 && n <= 100000 ? n : 0;
};
const asObj = (s: unknown): Item => (s && typeof s === "object" ? (s as Item) : { title: String(s ?? ""), done: false });
export const subTitle = (s: unknown): string => {
  const o = asObj(s);
  for (const k of ["title", "text", "name"]) if (typeof o[k] === "string") return o[k] as string;
  return "";
};
export const subDone = (s: unknown): boolean => { const o = asObj(s); return !!(o.done ?? o.completed); };
export const subList = (t: Item): Item[] => (Array.isArray(t.subtasks) ? (t.subtasks as unknown[]).filter((s) => s != null).map(asObj) : []);

export type SubStats = { n: number; done: number; pct: number; by: "time" | "count"; est_total: number; est_left: number; missing: number };
export function subStats(t: Item): SubStats | null {
  const list = subList(t), n = list.length;
  if (!n) return null;
  const done = list.filter(subDone).length;
  const total = list.reduce((a, s) => a + subEstOf(s.est), 0);
  const left = list.filter((s) => !subDone(s)).reduce((a, s) => a + subEstOf(s.est), 0);
  const missing = list.filter((s) => !subEstOf(s.est)).length;
  const byTime = missing === 0 && total > 0;
  const pct = byTime ? Math.round(((total - left) / total) * 100) : Math.round((done / n) * 100);
  return { n, done, pct, by: byTime ? "time" : "count", est_total: total, est_left: left, missing };
}

/** Claude に見せるサブタスクの形（メモは頭の 200 字） */
export function subView(t: Item) {
  return subList(t).map((s, i) => {
    const est = subEstOf(s.est), memo = typeof s.memo === "string" ? s.memo : "";
    return {
      id: typeof s.id === "string" && s.id ? s.id : `#${i + 1}`,
      title: subTitle(s), done: subDone(s),
      ...(est ? { est } : {}),
      ...(memo.trim() ? { memo: memo.length > 200 ? memo.slice(0, 200) + "…" : memo } : {}),
    };
  });
}

export type EstInput = { subtask: string; minutes: number };
/**
 * 見積もりを入れる。subtask は id（subView の id。古い形で id が無いものは「#番号」）か名前（前後の空白は無視・同じ名前が 2 つあれば止める）。
 * minutes が 0 なら見積もりを消す。見つからない・決まらないものが 1 つでもあれば何も変えずに知らせる（一部だけ書かない）。
 */
export function applySubEst(t: Item, edits: EstInput[]): { ok: true; subtasks: Item[] } | { ok: false; error: string; detail: string[] } {
  const list = subList(t).map((s) => ({ ...s }));
  const bad: string[] = [];
  for (const e of edits) {
    const key = String(e?.subtask ?? "").trim();
    const m = Math.round(Number(e?.minutes));
    if (!Number.isFinite(m) || m < 0 || m > 100000) { bad.push(`「${key}」の minutes が数でない（0 で消す）`); continue; }
    let idx = -1;
    const num = /^#(\d+)$/.exec(key);
    if (num) idx = Number(num[1]) - 1 < list.length ? Number(num[1]) - 1 : -1;
    if (idx < 0) idx = list.findIndex((s) => s.id === key);
    if (idx < 0) {
      const hits = list.map((s, i) => (subTitle(s).trim() === key ? i : -1)).filter((i) => i >= 0);
      if (hits.length > 1) { bad.push(`「${key}」という名前が ${hits.length} つある（id で指定）`); continue; }
      idx = hits.length ? hits[0] : -1;
    }
    if (idx < 0) { bad.push(`「${key}」が見つからない`); continue; }
    if (m > 0) list[idx].est = m; else delete list[idx].est;
  }
  if (bad.length) return { ok: false, error: "subtask not found", detail: bad };
  return { ok: true, subtasks: list };
}

/** 足すサブタスク（add_task の subtasks）。名前の空なものは捨てる */
export function newSubs(input: unknown, newId: () => string): Item[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((s) => (typeof s === "string" ? { title: s } : (s as Item) || {}))
    .map((s) => ({ title: String(s.title ?? "").trim(), est: subEstOf(s.minutes ?? s.est) }))
    .filter((s) => s.title)
    .map((s) => ({ id: newId(), title: s.title, done: false, ...(s.est ? { est: s.est } : {}) }));
}
