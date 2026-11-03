/** note の数字の、外に触らない部分（2026-11-03・試験は test/note-counts.test.ts） */

/** 中身のデータから、名前に member / circle を含む数の欄を拾う（2 段まで） */
export function memberHints(data: any): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (o: any, path: string, depth: number) => {
    if (!o || typeof o !== "object" || depth > 2) return;
    for (const [k, v] of Object.entries(o)) {
      const p = path ? `${path}.${k}` : k;
      if (typeof v === "number" && /member|circle/i.test(k)) out[p] = v;
      else if (v && typeof v === "object" && !Array.isArray(v)) walk(v, p, depth + 1);
    }
  };
  walk(data, "", 0);
  return out;
}
/** 拾った欄から、メンシプ人数らしい 1 つを選ぶ（人数を表す名前を先に） */
export function pickMembers(found: Record<string, number>): number | null {
  const keys = Object.keys(found);
  const k = keys.find((x) => /(member|members)_?count|membersCount|memberCount/i.test(x)) ?? keys.find((x) => /member/i.test(x) && !/is|has|plan|id/i.test(x.split(".").pop() || ""));
  return k != null ? found[k] : null;
}

