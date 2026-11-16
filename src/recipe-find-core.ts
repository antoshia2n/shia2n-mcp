/**
 * 入口（2026-11-16 v1.110.0 開発部・スキルの棚の便 4・Naoki OK 08:50）：依頼の文から、合うレシピと補強のスキルを探す。計算だけ。
 * AI を呼ばない（MCP の口は速く・同じ答えを返したいため）。日本語は語の区切りが無いので、2 文字ずつの重なり（バイグラム）で近さを測る。
 * 英数字の語は語のまま数える。表示名・何に使うかを重く、流れ・使うスキルの説明を軽く見る。
 */
import type { FlowStep } from "./recipe-write-core.js";

export type FindSkill = { name: string; title: string | null; purpose: string | null; description: string; genre: string | null; category: string[]; media: string[]; conflicts: string[]; kind: string | null };
export type FindRecipe = { name: string; title: string | null; purpose: string | null; uses: Array<{ skill: string }>; flow: FlowStep[] };

const STOP = new Set(["する", "して", "ます", "です", "ため", "こと", "もの", "よう", "作る", "作っ", "って", "ほし", "たい", "ください", "てく", "くだ", "さい", "いて", "した", "から", "まで", "この", "その"]);

function norm(s: string): string {
  return String(s || "").normalize("NFKC").toLowerCase();
}

/** 依頼や説明を「重なりを測る単位」の集まりにする */
export function grams(s: string): Set<string> {
  const t = norm(s);
  const out = new Set<string>();
  for (const w of t.match(/[a-z0-9]{2,}/g) || []) out.add(w);
  // ひらがなは区切りとして扱う（「を作って」「のための」のような助詞・語尾が、どの説明にも当たってしまうため）。
  // 漢字・カタカナの並び（例：図解・スレッド・引用ポスト）だけを 2 文字ずつにする
  const ja = t.replace(/[a-z0-9]+/g, " ").replace(/[\u3041-\u309f\s、。・「」『』（）()【】［］\[\]!！?？:：,，.．\-—〜~／/×|]+/g, " ");
  for (const chunk of ja.split(" ")) {
    for (let i = 0; i + 1 < chunk.length; i++) {
      const g = chunk.slice(i, i + 2);
      if (!STOP.has(g)) out.add(g);
    }
  }
  // 1 文字の漢字の言葉（売れ・伸び・書く）は、漢字＋すぐ後のひらがな 1 文字で拾う（v1.113.1・「売れない」が何にも当たらなかったため）。
  // ひらがなで始まる 2 文字（を作・の図）は拾わない
  for (const m of t.matchAll(/(?<![\u4e00-\u9fff\u30a0-\u30ff])([\u4e00-\u9fff])([\u3041-\u309f])/g)) {
    const g = m[1] + m[2];
    if (!STOP.has(g) && !/^.[をにのがはでとへもや]$/.test(g)) out.add(g);
  }
  return out;
}

function overlap(q: Set<string>, text: string): string[] {
  const g = grams(text);
  return [...q].filter((x) => g.has(x));
}

/** 重なった単位から、人に見せる手がかりの語を作る（つながる 2 文字は 1 語にまとめる） */
function hints(words: string[]): string[] {
  const s = [...new Set(words)];
  const used = new Set<string>();
  const out: string[] = [];
  for (const w of s) {
    if (used.has(w)) continue;
    let cur = w;
    used.add(w);
    let grew = true;
    while (grew) {
      grew = false;
      for (const x of s) {
        if (used.has(x) || /^[a-z0-9]+$/.test(x)) continue;
        if (cur.slice(-1) === x[0]) { cur += x.slice(1); used.add(x); grew = true; }
      }
    }
    out.push(cur);
  }
  return out.sort((a, b) => b.length - a.length).slice(0, 5);
}

type Scored = { score: number; words: string[] };
function scoreFields(q: Set<string>, fields: Array<[string | null | undefined, number]>): Scored {
  let score = 0;
  const words: string[] = [];
  for (const [text, w] of fields) {
    if (!text) continue;
    const o = overlap(q, text);
    score += o.length * w;
    words.push(...o);
  }
  return { score, words };
}

export function scoreSkill(q: Set<string>, k: FindSkill): Scored {
  return scoreFields(q, [[k.title, 3], [k.purpose, 2], [k.genre, 1], [k.media.join(" "), 2], [k.description, 0.5]]);
}

export type FindResult = {
  依頼: string;
  おすすめ: Array<{ name: string; title: string | null; purpose: string | null; 点: number; 手がかり: string[]; 使うスキル: string[] }>;
  補強の候補: Array<{ name: string; title: string | null; category: string[]; 点: number; 手がかり: string[]; 理由: string }>;
  スキルだけ: Array<{ name: string; title: string | null; purpose: string | null; 点: number; 手がかり: string[] }>;
  聞き方: string;
};

/**
 * 依頼から、合うレシピ（多くて 3 つ）と、いちばん合うレシピに足せる補強のスキル（多くて 3 つ）を返す。
 * レシピが 1 つも当たらないときは、スキルだけの候補を返す。
 * 補強に出さないもの：そのレシピにもう入っているスキル・入っているスキルとぶつかるスキル・ガード（事故を防ぐ決まりは補強ではなく常に守るもの）
 */
export function findRecipes(task: string, recipes: FindRecipe[], skills: FindSkill[], opts: { media?: string | null } = {}): FindResult {
  const q = grams(task + (opts.media ? ` ${opts.media}` : ""));
  const byName = new Map(skills.map((k) => [k.name, k]));
  const recs = recipes.map((r) => {
    const used = r.uses.map((u) => byName.get(u.skill)).filter((x): x is FindSkill => !!x);
    const s = scoreFields(q, [
      [r.title, 3], [r.purpose, 3], [r.flow.map((f) => `${f.title} ${f.detail || ""}`).join(" "), 1],
      [used.map((k) => `${k.title || ""} ${k.purpose || ""}`).join(" "), 1], [used.flatMap((k) => k.media).join(" "), 2],
    ]);
    return { r, used, ...s };
  }).filter((x) => x.score >= 2).sort((a, b) => b.score - a.score).slice(0, 3);

  // スキル単体のほうが依頼に近ければ、レシピは勧めない（例：「スレッド投稿を作って」に図解のレシピを当てない）
  const soloAll = skills.map((k) => ({ k, ...scoreSkill(q, k) })).filter((x) => x.score >= 2).sort((a, b) => b.score - a.score);
  // 比べるのは「それだけで作れる」スキル（手順かスタイル）だけ。レビュー・コメントは補強なので、点が高くてもレシピを外さない
  const bestRecipe = recs[0];
  const mainSolo = soloAll.find((x) => x.k.category.some((c) => c === "手順" || c === "スタイル"));
  const top = bestRecipe && !(mainSolo && mainSolo.score > bestRecipe.score && !bestRecipe.used.some((k) => k.name === mainSolo.k.name)) ? bestRecipe : undefined;
  const inTop = new Set(top ? top.used.map((k) => k.name) : []);
  const conflict = new Set(top ? top.used.flatMap((k) => k.conflicts) : []);
  for (const k of skills) if (k.conflicts.some((c) => inTop.has(c))) conflict.add(k.name);
  // 補強に出すのは、レシピにまだ無いカテゴリのスキルだけ（選択スキルはカテゴリから 1 つ。スタイルを 2 つ重ねない）。
  // 手順（それ自体が作り方の流れ）とガード（いつも守る決まり）は補強にしない
  const haveCat = new Set(top ? top.used.flatMap((k) => k.category) : []);
  const extra = top ? soloAll.filter((x) => !inTop.has(x.k.name) && !conflict.has(x.k.name) && x.score >= 3
    && x.k.category.length > 0 && x.k.category.every((c) => c !== "手順" && c !== "ガード" && c !== "進め方" && !haveCat.has(c))).slice(0, 3) : [];
  const alone = top ? [] : soloAll.slice(0, 3);
  const title = (k: { title: string | null; name: string }) => k.title || k.name;
  const ask = top
    ? `「${title(top.r)}」のレシピを使います（${hints(top.words).slice(0, 3).join("・") || "依頼に近いため"}）。${extra.length ? `補強に「${extra.map((x) => title(x.k)).join("」「")}」も使いますか？` : ""}よければこのまま進めます。`
    : alone.length ? `合うレシピはまだありません。スキル「${title(alone[0].k)}」で進めますか？` : "合うレシピもスキルも見つかりませんでした。何を作るかをもう少し教えてください。";
  return {
    依頼: task,
    おすすめ: recs.map((x) => ({ name: x.r.name, title: x.r.title, purpose: x.r.purpose, 点: Math.round(x.score * 10) / 10, 手がかり: hints(x.words), 使うスキル: x.used.map((k) => title(k)) })),
    補強の候補: extra.map((x) => ({ name: x.k.name, title: x.k.title, category: x.k.category, 点: Math.round(x.score * 10) / 10, 手がかり: hints(x.words), 理由: `${x.k.category.join("・") || "スキル"}として足せる` })),
    スキルだけ: alone.map((x) => ({ name: x.k.name, title: x.k.title, purpose: x.k.purpose, 点: Math.round(x.score * 10) / 10, 手がかり: hints(x.words) })),
    聞き方: ask,
  };
}
