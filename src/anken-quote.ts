/**
 * 案件くんの「根拠の言葉」を選ぶ（2026-10-22 開発部・10/21 からの残り）。
 *
 * 議事録は 1 回分が 1 つの発言なので、根拠の言葉を発言の先頭 120 字や、その発言で最初に拾った出来事の言葉にすると、
 * やることと関係のない行（例：「②を採用」）が根拠に出る。
 * ここでは、渡された言葉があればそれを使い、無ければ「その発言で拾った出来事の言葉」と「発言の各行」の中から、
 * やることの名前と文字の重なりがいちばん多いものを選ぶ。1 行だけの発言（LINE）はこれまでどおり。
 */

const bigrams = (s: string): Set<string> => {
  const t = String(s).replace(/[\s「」『』（）()・、。，．,.!！?？:：\-—〜~]/g, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
};

const overlap = (a: Set<string>, b: Set<string>): number => {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
};

export function pickQuote({ body, title, given, tagQuotes = [] }: { body: string; title: string; given?: string; tagQuotes?: string[] }): string {
  if (given && given.trim()) return given.trim();
  const lines = String(body ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const tags = tagQuotes.map((q) => String(q ?? "").trim()).filter(Boolean);
  if (lines.length <= 1) return tags[0] || String(body ?? "").slice(0, 120);
  const want = bigrams(title);
  let best = "", score = 0;
  for (const c of [...tags, ...lines]) {
    const s = overlap(want, bigrams(c));
    if (s > score) { best = c; score = s; }
  }
  return best || tags[0] || lines[0];
}
