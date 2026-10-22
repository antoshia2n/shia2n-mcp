type Row = Record<string, any>;

/**
 * Naoki のメモ（2026-10-23 開発部・Naoki「ホームに僕のメモを追加できるように」）。
 * 案件の mtg の中の memo（文字）と memo_at（書いた時刻）。Naoki が案件くんのホームで書く。AI は書き換えない。
 */
export function memoOf(c: Row): { text: string; at: string | null } {
  const m = c?.mtg ?? {};
  return { text: typeof m.memo === "string" ? m.memo.trim() : "", at: typeof m.memo_at === "string" ? m.memo_at : null };
}
/** AI が事前メモ（mtg）を書き直すとき、Naoki のメモだけは前のまま残す */
export function keepMemo(prev: Row | null | undefined, next: Row): Row {
  const out: Row = { ...next };
  delete out.memo; delete out.memo_at;
  if (typeof prev?.memo === "string" && prev.memo.trim()) { out.memo = prev.memo; if (prev.memo_at) out.memo_at = prev.memo_at; }
  return out;
}
