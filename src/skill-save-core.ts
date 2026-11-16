/**
 * スキルを正本へ保存する前の確かめ（2026-11-16 v1.111.0 開発部・スキルクリエイターの便）。計算だけ。
 * 正本 shia2n-skills の STANDARD.md（シアニン式スキル規格 1.0）を、AI に任せず道具の側で必ず通すための関数。
 *   ・checkSkillText：頭の欄・ジャンル・カテゴリ・見出しの順・長さ・参照の段・版の上げ方を確かめる
 *   ・similarSkills：新しく作る前に、似ているスキルを点つきで返す（重複を作らないため）
 */
import { CATEGORIES, GENRES, parseSkillHead, type SkillMeta } from "./skills-core.js";
import { grams } from "./recipe-find-core.js";

export const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
/** 本文の見出し（STANDARD.md 5 節の順） */
export const HEADINGS = ["目的", "使う場面／使わない場面", "手順", "決まり", "出力の形", "参照"] as const;
const REQUIRED_META = ["title", "purpose", "genre", "category", "version", "where", "audience", "owner"] as const;

export type SaveCheck = { errors: string[]; warnings: string[]; meta: SkillMeta | null; bodyChanged: boolean };

const bodyOf = (t: string) => t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
const vnum = (v: string | null) => (v && /^\d+(\.\d+)?$/.test(v) ? v.split(".").map(Number) : null);
function bumped(before: string | null, after: string | null): boolean {
  const a = vnum(before), b = vnum(after);
  if (!a || !b) return false;
  return b[0] > a[0] || (b[0] === a[0] && (b[1] || 0) > (a[1] || 0));
}

/**
 * text：保存する SKILL.md の全文。current：今の正本の全文（新しく作るときは null）。
 * others：正本のほかのスキル（参照・ぶつかる先が実在するか、参照が 1 段までかを見る）
 */
export function checkSkillText(name: string, text: string, current: string | null, others: SkillMeta[]): SaveCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!NAME_RE.test(name)) errors.push("name は英小文字・数字・ハイフンで 2〜64 文字");
  const meta = parseSkillHead(text, name);
  if (!meta) return { errors: [...errors, "頭の --- が無い"], warnings, meta: null, bodyChanged: true };
  if (meta.name !== name) errors.push(`頭の name（${meta.name}）とフォルダ名（${name}）が違う`);
  if (!meta.description) errors.push("description が無い");
  else if (meta.description.length > 1024) errors.push("description は 1024 文字まで");
  const raw: Record<string, unknown> = meta as unknown as Record<string, unknown>;
  for (const k of REQUIRED_META) {
    const v = raw[k];
    if (v === null || v === undefined || (Array.isArray(v) && v.length === 0) || v === "") errors.push(`metadata.${k} が無い`);
  }
  if (meta.genre && !(GENRES as readonly string[]).includes(meta.genre)) errors.push(`ジャンル「${meta.genre}」は規格に無い（${GENRES.join("・")} から 1 つ）`);
  for (const c of meta.category) if (!(CATEGORIES as readonly string[]).includes(c)) errors.push(`カテゴリ「${c}」は規格に無い（${CATEGORIES.join("・")}）`);
  if (meta.kind && meta.kind !== "基本スキル" && meta.kind !== "選択スキル") errors.push("kind は 基本スキル か 選択スキル");

  const byName = new Map(others.filter((o) => o.name !== name).map((o) => [o.name, o]));
  for (const r of meta.refs) {
    const o = byName.get(r);
    if (!o) errors.push(`参照先「${r}」が正本に無い`);
    else if (o.refs.length) errors.push(`参照は 1 段まで：「${r}」がさらに ${o.refs.join("・")} を参照している`);
  }
  for (const c of meta.conflicts) if (!byName.has(c)) errors.push(`一緒に使えない先「${c}」が正本に無い`);
  if (meta.refs.length) for (const o of byName.values()) if (o.refs.includes(name)) errors.push(`参照は 1 段まで：「${o.name}」がこのスキルを参照している`);

  const body = bodyOf(text);
  const lines = body.split(/\r?\n/).length;
  const curLines = current === null ? 0 : bodyOf(current).split(/\r?\n/).length;
  if (lines >= 500 && curLines >= 500 && lines <= curLines) warnings.push(`本文が ${lines} 行（規格の前のスキル。500 行未満へは references/ に分けて直す）`);
  else if (lines >= 500) errors.push(`本文が ${lines} 行（500 行未満。長い中身は references/ へ）`);
  else if (lines > 200) warnings.push(`本文が ${lines} 行（目安は 200 行）`);
  // 規格 8 節（2026-11-16）：大きさの目安。小（部品）80 行・中（手順）200 行。止めずに注意だけ
  const size = skillSize(meta.category);
  if (size === "小" && lines > 80) warnings.push(`タスクスキルの目安 80 行を超えている（${lines} 行）。ワークスキルの references/ に置くか、2 つに分けるかを考える`);
  if (!/^#\s+\S/m.test(body)) errors.push("本文の最初に「# 表示名」が無い");
  const found = [...body.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]);
  const pos = HEADINGS.map((h) => found.indexOf(h));
  const missingH = HEADINGS.filter((_, i) => pos[i] < 0);
  const headErr = missingH.length ? `見出しが足りない：${missingH.join("・")}` : pos.some((p, i) => i > 0 && p < pos[i - 1]) ? `見出しの順が違う（${HEADINGS.join(" → ")}）` : "";
  // 規格の前に作った 15 本は、見出しを 1 本ずつ直す決め（STANDARD.md 6 節）。それまでの小さい直しは止めず、注意にとどめる
  const legacy = current !== null && headingProblem(bodyOf(current)) !== "";
  if (headErr) (legacy ? warnings : errors).push(legacy ? `${headErr}（規格の前のスキル。見出しは 1 本ずつ直す）` : headErr);

  let bodyChanged = true;
  if (current === null) {
    if (meta.version !== "1.0") errors.push("新しいスキルの版は 1.0");
  } else {
    const before = parseSkillHead(current, name);
    bodyChanged = bodyOf(current) !== body;
    if (bodyChanged && !bumped(before?.version ?? null, meta.version)) errors.push(`本文を変えたので版を上げる（今 ${before?.version ?? "なし"}）`);
    if (!bodyChanged && before?.version !== meta.version) errors.push("頭の欄だけの直しでは版を上げない");
  }
  return { errors, warnings, meta, bodyChanged };
}

function headingProblem(body: string): string {
  const found = [...body.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]);
  const pos = HEADINGS.map((h) => found.indexOf(h));
  if (pos.some((p) => p < 0)) return "missing";
  return pos.some((p, i) => i > 0 && p < pos[i - 1]) ? "order" : "";
}

/** 大きさはカテゴリで決まる（規格 8 節）。手順を含めば中、それ以外は小 */
export function skillSize(category: string[]): "小" | "中" { // 小＝タスクスキル・中＝ワークスキル（Naoki 命名 2026-11-16）
  return category.includes("手順") ? "中" : "小";
}

/** レシピの選んで入れるスキル（基本スキルを除く）が 3 本を超えたら注意（規格 8 節） */
export function recipeSizeWarning(uses: string[], kinds: Map<string, string | null>): string | null {
  const picked = uses.filter((u) => kinds.get(u) !== "基本スキル");
  return picked.length > 3 ? `選んで入れるスキルが ${picked.length} 本（目安は 3 本まで・基本スキルは数えない）。1 本減らすか、レシピを 2 つに分けるかを考える` : null;
}

/** metadata.updated を date にそろえる（無ければ足す）。人に打たせないため */
export function stampUpdated(text: string, date: string): string {
  if (/^(\s+)updated:.*$/m.test(text.split(/\r?\n---/)[0])) return text.replace(/^(\s+)updated:.*$/m, `$1updated: "${date}"`);
  return text.replace(/^metadata:\s*\r?\n/m, (m) => `${m}  updated: "${date}"\n`);
}

/** 似ているスキル（新しく作る前の重複の確かめ）。表示名・何に使うか・説明の 2 文字の重なりで点をつける */
export function similarSkills(meta: { name: string; title: string | null; purpose: string | null; description: string; genre: string | null }, others: SkillMeta[], limit = 3): Array<{ name: string; title: string | null; 点: number }> {
  const q = grams([meta.title, meta.purpose, meta.description].filter(Boolean).join(" "));
  if (!q.size) return [];
  return others.filter((o) => o.name !== meta.name).map((o) => {
    const t = grams([o.title, o.purpose, o.description].filter(Boolean).join(" "));
    let hit = 0;
    for (const g of q) if (t.has(g)) hit++;
    const score = Math.round((hit / q.size) * 100 + (o.genre && o.genre === meta.genre ? 10 : 0));
    return { name: o.name, title: o.title, 点: score };
  }).filter((x) => x.点 >= 30).sort((a, b) => b.点 - a.点).slice(0, limit);
}
