/**
 * レシピ（recipes/<名前>/RECIPE.md）を書き直す計算だけ（2026-11-16 v1.107.0 開発部・スキルの棚の便 1）。
 * GitHub に触らない。マーケくんの管理画面「スキル」の棚が SkillsReader.saveRecipe を通してここを使う。
 *
 * 決め（Decisions 2026-11-16）：選択スキルは版で固定（スキル名@版#コミット）。外に合わせて動く基本スキル
 * （BASE_LATEST に並べたもの・いまは shia2n-x-review だけ）だけ @最新 を選べる。
 * 書き直すのは頭の version・purpose・updated と skills: の並びだけ。本文（流れ・ぶつかったとき）は残す。
 */

/** @最新 を選べる基本スキル（決め 2026-11-16）。ここに無いスキルは @最新 にできない */
export const BASE_LATEST = ["shia2n-x-review"] as const;
export const STRENGTHS = ["標準", "強", "弱", "無"] as const;

export type RecipeUseInput = {
  skill: string;
  /** "keep"＝今の固定のまま／"now"＝いまの main の版で固定し直す／"latest"＝@最新（基本スキルだけ） */
  pin: "keep" | "now" | "latest";
  strength?: string | null;
};
export type RecipeSaveInput = { name: string; purpose?: string | null; uses: RecipeUseInput[] };
/** 今の正本のスキル（版を決めるのに使う）と、いまのレシピの行（keep のとき使う） */
export type RecipeWriteContext = {
  skills: Map<string, string | null>; // スキル名 → main の今の版
  current: Map<string, { version: string; commit: string | null }>; // いまのレシピの行
  head: string; // main の今のコミット（40 桁）
  date: string; // YYYY-MM-DD（日本時間）
};

export type RecipeWriteResult = { ok: true; text: string; version: string } | { ok: false; error: string };

const NAME = /^[a-z0-9][a-z0-9_-]{1,79}$/i;
const oneLine = (s: string) => s.replace(/[\r\n"]+/g, " ").trim();

/** "1.4" → "1.5"。形が違えば "1.0" */
export function bumpVersion(v: string | null | undefined): string {
  const m = /^(\d+)\.(\d+)$/.exec(String(v || "").trim());
  return m ? `${m[1]}.${Number(m[2]) + 1}` : "1.0";
}

/** skills: の 1 行を作る。作れなければ理由 */
function useLine(u: RecipeUseInput, i: number, c: RecipeWriteContext): string | { error: string } {
  const skill = String(u.skill || "").trim();
  if (!NAME.test(skill)) return { error: `bad_skill:${skill}` };
  if (!c.skills.has(skill)) return { error: `no_skill:${skill}` };
  const strength = u.strength ? oneLine(String(u.strength)).slice(0, 10) : "標準";
  const tail = ` | 優先 ${i + 1} | 強さ ${strength}`;
  if (u.pin === "latest") {
    if (!(BASE_LATEST as readonly string[]).includes(skill)) return { error: `latest_not_allowed:${skill}` };
    return `  - ${skill}@最新${tail}`;
  }
  if (u.pin === "keep") {
    const cur = c.current.get(skill);
    if (cur && cur.commit) return `  - ${skill}@${cur.version}#${cur.commit}${tail}`;
    if (cur && !cur.commit) return `  - ${skill}@最新${tail}`; // いまが @最新 のまま
    // いまのレシピに無いスキルの keep は、いまの版で固定する
  }
  const ver = c.skills.get(skill);
  if (!ver) return { error: `no_version:${skill}` };
  if (!/^[0-9a-f]{40}$/.test(c.head)) return { error: "no_head" };
  return `  - ${skill}@${ver}#${c.head}${tail}`;
}

/**
 * 今の RECIPE.md（新規なら null）を、入力どおりの頭に書き直す。
 * 版は 1 つ上げる（新規は 1.0）。updated は今日。見せる相手・使う場所・担当は新規のときだけ既定値を入れ、あとは今のまま。
 */
export function writeRecipeText(text: string | null, input: RecipeSaveInput, c: RecipeWriteContext): RecipeWriteResult {
  const name = String(input.name || "").trim();
  if (!NAME.test(name)) return { ok: false, error: "bad_name" };
  const uses = Array.isArray(input.uses) ? input.uses : [];
  if (!uses.length) return { ok: false, error: "no_skills" };
  if (uses.length > 12) return { ok: false, error: "too_many" };
  const seen = new Set<string>();
  const lines: string[] = [];
  for (let i = 0; i < uses.length; i++) {
    const s = String(uses[i].skill || "").trim();
    if (seen.has(s)) return { ok: false, error: `dup_skill:${s}` };
    seen.add(s);
    const l = useLine(uses[i], i, c);
    if (typeof l !== "string") return { ok: false, error: l.error };
    lines.push(l);
  }
  const purpose = input.purpose != null ? oneLine(String(input.purpose)).slice(0, 120) : null;

  if (text === null) {
    if (!purpose) return { ok: false, error: "need_purpose" };
    const version = "1.0";
    const head = [
      "---", `name: ${name}`, "metadata:", `  version: "${version}"`, `  purpose: "${purpose}"`,
      `  where: "claude.ai, Claude Code, GPT"`, `  audience: "本人, 事業部"`, `  owner: "コンテンツ制作"`, `  updated: "${c.date}"`,
      "skills:", ...lines, "---",
    ].join("\n");
    const body = [
      "", `# レシピ：${purpose}`, "", "マーケくんの管理画面「スキル」の棚で作ったレシピ。流れは使いながら書き足す。", "",
      "## 流れ", "", ...uses.map((u, i) => `${i + 1}. ${u.skill} の手順で進める`), "",
      "## ぶつかったとき", "", "- 優先の順（上の行ほど優先）に従う", "",
    ].join("\n");
    return { ok: true, text: head + "\n" + body, version };
  }

  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (!m) return { ok: false, error: "no_head" };
  let fm = m[1];
  const verM = /^([ \t]+version:\s*)"?([^"\r\n]*)"?\s*$/m.exec(fm);
  const version = bumpVersion(verM ? verM[2] : null);
  const setMeta = (key: string, val: string) => {
    const re = new RegExp(`^([ \\t]+${key}:\\s*).*$`, "m");
    if (re.test(fm)) fm = fm.replace(re, `$1"${val}"`);
    else fm = fm.replace(/^metadata:\s*$/m, `metadata:\n  ${key}: "${val}"`);
  };
  setMeta("version", version);
  setMeta("updated", c.date);
  if (purpose) setMeta("purpose", purpose);
  const block = /^skills:\s*\r?\n(?:[ \t]+.*(?:\r?\n|$))*/m;
  const newBlock = ["skills:", ...lines].join("\n");
  fm = block.test(fm) ? fm.replace(block, newBlock + "\n").replace(/\n+$/, "") : `${fm}\n${newBlock}`;
  return { ok: true, text: `---\n${fm}\n---${m[2] || "\n"}${text.slice(m[0].length)}`, version };
}
