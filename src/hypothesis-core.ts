/**
 * シアニンの仮説（skills/<スキル>/references/hypotheses.md）を書き足す・状態を変える計算だけ（2026-11-15 v1.106.0 開発部）。
 * GitHub に触らない。hypotheses__add・hypotheses__update と、後で作るアプリの画面が同じ関数を使う。
 *
 * 形：見出し「## H番号 題」、行「- 中身（Naoki の言葉）：」「- 出所：」「- 状態：」、追記は「- 追記（日付）：」。
 * 言葉は言い換えない（受け取った文字のまま入れる）。
 */

export const HYPOTHESIS_STATUSES = ["仮説", "確かめ中", "確定", "やめた"] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];

export type HypothesisHead = { id: number; title: string; status: string | null };

const HEAD = /^## H(\d+)[ \t]+(.+)$/gm;

/** 見出しと状態の一覧 */
export function listHypotheses(md: string): HypothesisHead[] {
  const out: HypothesisHead[] = [];
  const heads = [...md.matchAll(HEAD)];
  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index! : md.length;
    const body = md.slice(h.index!, end);
    const st = /^- 状態：(.*)$/m.exec(body);
    out.push({ id: Number(h[1]), title: h[2].trim(), status: st ? st[1].trim() : null });
  });
  return out;
}

/** 見出しごとの本文（棚の画面で読むため・2026-11-16 v1.107.0）。本文は見出しの次の行から次の見出しの前まで */
export function hypothesisSections(md: string): Array<HypothesisHead & { body: string }> {
  const heads = [...md.matchAll(HEAD)];
  return listHypotheses(md).map((h, i) => {
    const start = heads[i].index! + heads[i][0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index! : md.length;
    return { ...h, body: md.slice(start, end).trim() };
  });
}

function oneLine(s: string): string {
  return s.replace(/\r?\n+/g, " ").trim();
}

/** 新しい仮説を末尾に足す。番号は今ある最大＋1 */
export function addHypothesis(md: string, a: { title: string; words: string; date: string; source?: string; target?: string }): { md: string; id: number } {
  const id = Math.max(0, ...listHypotheses(md).map((h) => h.id)) + 1;
  const lines = [
    `## H${id} ${oneLine(a.title)}`,
    "",
    `- 中身（Naoki の言葉）：${oneLine(a.words)}`,
    ...(a.target ? [`- 誰に当てるか（Naoki の言葉）：${oneLine(a.target)}`] : []),
    `- 出所：${oneLine(a.source || "Naoki")}（${a.date}）`,
    "- 状態：仮説",
  ];
  const base = md.replace(/\s+$/, "");
  return { md: `${base}\n\n${lines.join("\n")}\n`, id };
}

/** 状態を変える・追記を足す。見つからなければ null */
export function updateHypothesis(md: string, a: { id: number; date: string; status?: HypothesisStatus; note?: string }): string | null {
  const heads = [...md.matchAll(HEAD)];
  const i = heads.findIndex((h) => Number(h[1]) === a.id);
  if (i < 0) return null;
  const start = heads[i].index!;
  const end = i + 1 < heads.length ? heads[i + 1].index! : md.length;
  let body = md.slice(start, end);
  const tail = /\s*$/.exec(body)![0];
  body = body.slice(0, body.length - tail.length);
  if (a.status) {
    const st = /^- 状態：(.*)$/m.exec(body);
    if (st) {
      const prev = st[1].split(/。/)[0].trim();
      body = body.replace(st[0], `- 状態：${a.status}（${a.date}・前は ${prev}）`);
    } else {
      body += `\n- 状態：${a.status}（${a.date}）`;
    }
  }
  if (a.note) body += `\n- 追記（${a.date}）：${oneLine(a.note)}`;
  return md.slice(0, start) + body + (tail || "\n") + md.slice(end);
}
