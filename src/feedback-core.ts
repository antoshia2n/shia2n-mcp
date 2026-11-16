/**
 * 直しの記録（feedback/<スキル>.md）を書き足す・状態を変える計算だけ（2026-11-16 v1.116.0 開発部・Naoki OK 14:30）。
 * GitHub に触らない。skills__feedback_add・skills__feedback_list・skills__feedback_resolve・skills__save が同じ関数を使う。
 *
 * 置き場は正本 shia2n-skills の feedback/（skills/ の外）。スキルのフォルダに入れないのは、生徒の版（public の枝）や
 * GPT 用の zip にスキルのフォルダごと写すとき、内部の直しまで外へ出ないため。
 *
 * 1 行 1 件：「- F番号 日付 状態 ［レシピ 名前］ 直し（Naoki の言葉のまま）」。反映したら行末に「 → 反映済み 版（日付）」。
 * 言葉は言い換えない（受け取った文字のまま入れる・改行だけ 1 行にまとめる）。
 */

export const FEEDBACK_STATUSES = ["未反映", "反映済み", "見送り"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** 同じスキルに未反映の直しがこの数たまったら、改善案を出す目安（Naoki の合図があればいつでも出す） */
export const FEEDBACK_HINT = 2;

export type FeedbackItem = {
  id: number;
  date: string;
  status: FeedbackStatus;
  recipe: string | null;
  words: string;
  resolved: string | null; // 「反映済み 1.2（2026-11-17）」など
};

const LINE = /^- F(\d+) (\d{4}-\d{2}-\d{2}) (未反映|反映済み|見送り)(?: ［レシピ ([^］]+)］)? (.+?)(?: → ((?:反映済み|見送り).*))?$/;

export function feedbackPath(skill: string): string {
  return `feedback/${skill}.md`;
}

export function emptyFeedback(skill: string): string {
  return `# 直しの記録：${skill}\n\n作業中の Naoki の直しを、言葉のまま 1 行ずつためる。スキルを直したら「反映済み」にする。手で直してもよい（形は 1 行 1 件のまま）。\n\n`;
}

export function listFeedback(md: string): FeedbackItem[] {
  const out: FeedbackItem[] = [];
  for (const raw of md.split(/\r?\n/)) {
    const m = LINE.exec(raw.trim());
    if (!m) continue;
    out.push({ id: Number(m[1]), date: m[2], status: m[3] as FeedbackStatus, recipe: m[4] ?? null, words: m[5].trim(), resolved: m[6]?.trim() ?? null });
  }
  return out;
}

function oneLine(s: string): string {
  return s.replace(/\r?\n+/g, " ").replace(/\s+→\s+/g, " ⇒ ").trim();
}

/** 1 件足す。md が null なら新しく作る */
export function addFeedback(md: string | null, skill: string, o: { words: string; date: string; recipe?: string | null }): { md: string; id: number } {
  const base = md ?? emptyFeedback(skill);
  const id = listFeedback(base).reduce((a, f) => Math.max(a, f.id), 0) + 1;
  const recipe = o.recipe ? ` ［レシピ ${oneLine(o.recipe).replace(/[［］]/g, "")}］` : "";
  const line = `- F${id} ${o.date} 未反映${recipe} ${oneLine(o.words)}`;
  return { md: base.replace(/\s*$/, "\n") + line + "\n", id };
}

/** 未反映の行の状態を変える。見つからない番号・未反映でない番号は missing で返す（書き換えない） */
export function resolveFeedback(md: string, o: { ids: number[]; status: Exclude<FeedbackStatus, "未反映">; version?: string | null; date: string; note?: string | null }): { md: string; changed: number[]; missing: number[] } {
  const want = new Set(o.ids);
  const changed: number[] = [];
  const lines = md.split("\n").map((raw) => {
    const m = LINE.exec(raw.trim());
    if (!m || !want.has(Number(m[1])) || m[3] !== "未反映") return raw;
    const id = Number(m[1]);
    changed.push(id);
    const rest = raw.trim().replace(/^- F\d+ \d{4}-\d{2}-\d{2} 未反映/, `- F${id} ${m[2]} ${o.status}`);
    const tail = `${o.status}${o.version ? ` ${o.version}` : ""}（${o.date}）${o.note ? ` ${oneLine(o.note)}` : ""}`;
    return `${rest} → ${tail}`;
  });
  return { md: lines.join("\n"), changed, missing: o.ids.filter((i) => !changed.includes(i)) };
}

/** 一覧の見出し：スキルごとの未反映の数と、改善案の目安に届いたか */
export function feedbackSummary(skill: string, items: FeedbackItem[]): { skill: string; 未反映: number; 改善の目安: boolean } {
  const open = items.filter((f) => f.status === "未反映").length;
  return { skill, 未反映: open, 改善の目安: open >= FEEDBACK_HINT };
}

/** feedback/ のファイルの並びからスキル名を取る */
export function feedbackFiles(tree: Array<{ path: string; type: string }>): string[] {
  return tree.filter((t) => t.type === "blob").map((t) => /^feedback\/([a-z0-9][a-z0-9_-]*)\.md$/i.exec(t.path)?.[1]).filter((x): x is string => !!x).sort();
}

/** このスキルを使っているレシピ（保存のあとに版を上げるか聞くため） */
export function recipesUsing(skill: string, recipes: Array<{ name: string; title?: string | null; uses: Array<{ skill: string; version: string | null }> }>, newVersion: string | null): Array<{ recipe: string; title: string | null; 固定している版: string | null; 新しい版: string | null; 上げる必要: boolean }> {
  const out: Array<{ recipe: string; title: string | null; 固定している版: string | null; 新しい版: string | null; 上げる必要: boolean }> = [];
  for (const r of recipes) {
    const u = r.uses.find((x) => x.skill === skill);
    if (!u) continue;
    const latest = u.version === "最新" || u.version === "@最新";
    out.push({ recipe: r.name, title: r.title ?? null, 固定している版: u.version, 新しい版: newVersion, 上げる必要: !latest && !!newVersion && u.version !== newVersion });
  }
  return out;
}
