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
export type RecipeSaveInput = { name: string; purpose?: string | null; title?: string | null; uses: RecipeUseInput[]; flow?: FlowStep[] | null };
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
  const title = input.title != null ? oneLine(String(input.title)).slice(0, 60) : null;
  let flowText: string | null = null;
  if (input.flow != null) {
    const f = renderFlow(input.flow, new Set(uses.map((u) => String(u.skill || "").trim())));
    if (!f.ok) return { ok: false, error: f.error };
    flowText = f.text;
  }

  if (text === null) {
    if (!purpose) return { ok: false, error: "need_purpose" };
    const version = "1.0";
    const head = [
      "---", `name: ${name}`, "metadata:", ...(title ? [`  title: "${title}"`] : []), `  version: "${version}"`, `  purpose: "${purpose}"`,
      `  where: "claude.ai, Claude Code, GPT"`, `  audience: "本人, 事業部"`, `  owner: "コンテンツ制作"`, `  updated: "${c.date}"`,
      "skills:", ...lines, "---",
    ].join("\n");
    const body = [
      "", `# レシピ：${title || purpose}`, "", "マーケくんの管理画面「スキル」の棚で作ったレシピ。流れは使いながら書き足す。", "",
      "## 流れ", "", ...uses.map((u, i) => `${i + 1}. ${u.skill} の手順で進める`), "",
      "## ぶつかったとき", "", "- 優先の順（上の行ほど優先）に従う", "",
    ].join("\n");
    const full = head + "\n" + body;
    return { ok: true, text: flowText != null ? replaceFlow(full, flowText) : full, version };
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
  if (title) setMeta("title", title);
  const block = /^skills:\s*\r?\n(?:[ \t]+.*(?:\r?\n|$))*/m;
  const newBlock = ["skills:", ...lines].join("\n");
  fm = block.test(fm) ? fm.replace(block, newBlock + "\n").replace(/\n+$/, "") : `${fm}\n${newBlock}`;
  const out = `---\n${fm}\n---${m[2] || "\n"}${text.slice(m[0].length)}`;
  return { ok: true, text: flowText != null ? replaceFlow(out, flowText) : out, version };
}

/* ---------- 便 3（2026-11-16 Naoki OK 08:28）：レシピの「流れ」をワークフローにする ----------
 * 本文の「## 流れ」を手順の並びとして読む・書く。手順 1 つ＝ 題・説明・使うスキル・人の確認・プロンプト。
 * 書き方（AI がそのまま読める Markdown のまま）：
 *   ### 1. 題
 *   説明の文（何行でも）
 *   - スキル：shia2n-koboke
 *   - 確認：シアニンが 3〜5 案から選ぶ
 *
 *   ```プロンプト
 *   （そのまま AI に渡す文）
 *   ```
 * 前の書き方（「1. 〜」の番号つきの 1 行ずつ）も読める。そのときは 1 行が 1 手順の題になる。
 */
export type FlowStep = { title: string; detail?: string | null; skill?: string | null; check?: string | null; prompt?: string | null };
export const FLOW_HEAD = "## 流れ";
const FENCE = "```";

/** 本文から「## 流れ」の節（見出しの次から次の「## 」の前まで）を取り出す。無ければ null */
function flowSection(body: string): { start: number; end: number; text: string } | null {
  // 「## 流れ」ちょうどの見出しだけを取る（v1.115.1：「## 流れの決まり」を流れと取り違えたため）。後ろの括弧書きは許す
  const m = /^## 流れ[ \t]*(?:[（(][^\n]*[）)])?[ \t]*\n/m.exec(body);
  if (!m) return null;
  const start = m.index, from = m.index + m[0].length;
  const next = /^## /m.exec(body.slice(from));
  const end = next ? from + next.index : body.length;
  return { start, end, text: body.slice(from, end) };
}

export function parseFlow(text: string): FlowStep[] {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const sec = flowSection(body);
  if (!sec) return [];
  const t = sec.text.replace(/\r\n/g, "\n");
  if (/^### /m.test(t)) {
    const parts = t.split(/^### /m).slice(1);
    return parts.map((p) => {
      const lines = p.split("\n");
      const title = lines.shift()!.replace(/^\d+\.\s*/, "").trim();
      const rest = lines.join("\n");
      let prompt: string | null = null;
      const pm = new RegExp(`^${FENCE}プロンプト\\s*\\n([\\s\\S]*?)\\n${FENCE}\\s*$`, "m").exec(rest);
      let restNoPrompt = rest;
      if (pm) { prompt = pm[1]; restNoPrompt = rest.slice(0, pm.index) + rest.slice(pm.index + pm[0].length); }
      const skill = /^- スキル[：:]\s*(.+)$/m.exec(restNoPrompt)?.[1].trim() || null;
      const check = /^- 確認[：:]\s*(.+)$/m.exec(restNoPrompt)?.[1].trim() || null;
      const detail = restNoPrompt.split("\n").filter((l) => !/^- (スキル|確認)[：:]/.test(l)).join("\n").trim() || null;
      return { title, detail, skill, check, prompt };
    }).filter((s) => s.title);
  }
  return t.split("\n").map((l) => /^\s*\d+\.\s+(.+)$/.exec(l)?.[1].trim()).filter((x): x is string => !!x).map((title) => ({ title }));
}

const clean1 = (s: unknown, n: number) => String(s ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, n);
const cleanN = (s: unknown, n: number) => String(s ?? "").replace(/\r\n/g, "\n").trim().slice(0, n);

/** 手順の並びを「## 流れ」の節の文にする。形が変なら理由 */
export function renderFlow(steps: FlowStep[], skills?: Set<string>): { ok: true; text: string } | { ok: false; error: string } {
  if (!Array.isArray(steps)) return { ok: false, error: "bad_flow" };
  if (steps.length > 20) return { ok: false, error: "too_many_steps" };
  const out: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] || ({} as FlowStep);
    const title = clean1(s.title, 80);
    if (!title) return { ok: false, error: `step_no_title:${i + 1}` };
    const detail = cleanN(s.detail, 1000).replace(/^### /gm, "").replace(/^## /gm, "");
    const skill = clean1(s.skill, 80);
    if (skill && skills && !skills.has(skill)) return { ok: false, error: `step_skill_not_in_recipe:${skill}` };
    const check = clean1(s.check, 200);
    const prompt = cleanN(s.prompt, 4000);
    if (prompt.includes(FENCE)) return { ok: false, error: `prompt_has_fence:${i + 1}` };
    out.push(`### ${i + 1}. ${title}`);
    if (detail) out.push(detail);
    if (skill) out.push(`- スキル：${skill}`);
    if (check) out.push(`- 確認：${check}`);
    if (prompt) out.push("", `${FENCE}プロンプト`, prompt, FENCE);
    out.push("");
  }
  return { ok: true, text: out.join("\n") };
}

/** 全文の「## 流れ」の節を差し替える。無ければ最初の「## 」の前（無ければ末尾）に足す */
export function replaceFlow(text: string, flowText: string): string {
  const hm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  const head = hm ? hm[0] : "";
  const body = text.slice(head.length);
  const block = `${FLOW_HEAD}\n\n${flowText.trim()}\n\n`;
  const sec = flowSection(body);
  if (sec) return head + body.slice(0, sec.start) + block + body.slice(sec.end).replace(/^\n+/, "");
  const first = /^## /m.exec(body);
  if (first) return head + body.slice(0, first.index) + block + body.slice(first.index);
  return head + body.replace(/\n*$/, "\n\n") + block;
}

/** 表示名から ID の案を作る（英字にできない字は落とす）。空になれば null */
export function slugFrom(s: string): string | null {
  const t = String(s || "").toLowerCase().normalize("NFKC").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-").slice(0, 60);
  return t.length >= 2 ? t : null;
}
