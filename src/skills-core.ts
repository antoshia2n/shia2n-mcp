/**
 * スキルの正本（antoshia2n/shia2n-skills）の読み方。計算だけ（2026-11-15 v1.101.0 開発部・スキルズの管理 2便目）。
 * 正本の決まり：skills/<名前>/SKILL.md の頭（--- と --- の間）に name・description と metadata の 5 行
 *   version（版）・where（使う場所）・audience（見せる相手）・owner（担当）・updated（最終更新）
 * 台帳（README.md）は同じ 5 行から作られる。ここは README ではなく SKILL.md を直接読む（台帳の作り直しを待たないため）
 */

export const SKILLS_REPO = "antoshia2n/shia2n-skills";
export const SKILLS_BRANCH = "main";
/** 生徒に出している版だけを置く枝（2026-11-15 v1.102.0） */
export const SKILLS_PUBLIC_BRANCH = "public";
export const META_FIELDS = ["version", "where", "audience", "owner", "updated"] as const;
/** シアニン式スキル規格 1.0（2026-11-16 Naoki OK・正本の STANDARD.md）。ジャンルは 1 つ、カテゴリは複数 */
export const GENRES = ["文章", "図解・デザイン", "分析・レビュー", "戦略・企画", "販売・集客", "運営・仕組み"] as const;
export const CATEGORIES = ["手順", "スタイル", "コメント", "レビュー", "ガード", "進め方"] as const; // 進め方：AI と人のやり取りの型（2026-11-16 Naoki）

export type SkillMeta = {
  name: string;
  description: string;
  version: string | null;
  where: string[];
  audience: string[];
  owner: string | null;
  updated: string | null;
  purpose: string | null;
  public_version: string | null;
  /** 規格 1.0（v1.108.0）：表示名・ジャンル・カテゴリ・媒体・参照・ぶつかる・基本／選択 */
  title: string | null;
  genre: string | null;
  category: string[];
  media: string[];
  refs: string[];
  conflicts: string[];
  kind: string | null;
  missing: string[];
};

const unq = (s: string) => s.trim().replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1").trim();
const list = (s: string | null | undefined) => (s ? s.split(/[,、]/).map((x) => x.trim()).filter(Boolean) : []);

/** SKILL.md の頭を読む。頭が無ければ null */
export function parseSkillHead(text: string, folder: string): SkillMeta | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return null;
  const fm = m[1];
  const top = (k: string) => {
    const r = new RegExp(`^${k}:\\s*(.*)$`, "m").exec(fm);
    return r ? unq(r[1]) : "";
  };
  const meta: Record<string, string> = {};
  const block = /^metadata:\s*\r?\n((?:[ \t]+.*(?:\r?\n|$))+)/m.exec(fm);
  if (block) {
    for (const line of block[1].split(/\r?\n/)) {
      const kv = /^\s+(\w+):\s*(.*)$/.exec(line);
      if (kv) meta[kv[1]] = unq(kv[2]);
    }
  }
  const missing = META_FIELDS.filter((f) => !meta[f]);
  return {
    name: top("name") || folder,
    description: top("description"),
    version: meta.version || null,
    where: list(meta.where),
    audience: list(meta.audience),
    owner: meta.owner || null,
    updated: meta.updated || null,
    purpose: meta.purpose || null,
    public_version: meta.public_version || null,
    title: meta.title || null,
    genre: meta.genre || null,
    category: list(meta.category),
    media: list(meta.media),
    refs: list(meta.refs),
    conflicts: list(meta.conflicts),
    kind: meta.kind || null,
    missing,
  };
}

/** git の木（recursive）から、スキルのフォルダごとのファイルの並びを作る */
export function groupSkillFiles(tree: Array<{ path: string; type: string }>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of tree) {
    if (t.type !== "blob") continue;
    const m = /^skills\/([^/]+)\/(.+)$/.exec(t.path);
    if (!m) continue;
    if (!out.has(m[1])) out.set(m[1], []);
    out.get(m[1])!.push(m[2]);
  }
  for (const v of out.values()) v.sort();
  return out;
}

/** 使う場所の言い方をそろえる（claude.ai・Claude Code・GPT） */
export function normWhere(s: string): string | null {
  const k = s.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (k === "claude.ai" || k === "claudeai" || k === "claude") return "claude.ai";
  if (k === "claudecode" || k === "code") return "Claude Code";
  if (k === "gpt" || k === "chatgpt" || k === "gpts") return "GPT";
  return null;
}

export function filterSkills(rows: SkillMeta[], opts: { where?: string; owner?: string }): SkillMeta[] {
  const w = opts.where ? normWhere(opts.where) : null;
  return rows.filter((r) => (!w || r.where.includes(w)) && (!opts.owner || r.owner === opts.owner.trim()));
}

/** 名前の打ち間違いに近いものを 3 つまで返す（見つからないときの手がかり） */
export function nearNames(name: string, names: string[]): string[] {
  const q = name.toLowerCase();
  return names.filter((n) => n.toLowerCase().includes(q) || q.includes(n.toLowerCase())).slice(0, 3);
}

/** レシピ（recipes/<名前>/RECIPE.md）の頭を読む（2026-11-15 v1.105.0）。
 *  skills: の下の 1 行＝「- スキル名@版#コミット | 優先 1 | 強さ 標準」。優先・強さは省いてよい
 *  v1.106.0：「- スキル名@最新 | …」は版を固定せず main の最新を読む（commit は null・version は "最新"）。レビューのように外に合わせて動く基本スキル用 */
export type RecipeUse = { skill: string; version: string; commit: string | null; priority: number | null; strength: string | null };
export type RecipeMeta = { name: string; title: string | null; version: string | null; purpose: string | null; where: string[]; audience: string[]; owner: string | null; updated: string | null; uses: RecipeUse[]; bad: string[] };

export function parseRecipeHead(text: string, folder: string): RecipeMeta | null {
  const head = parseSkillHead(text, folder);
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!head || !m) return null;
  const uses: RecipeUse[] = [];
  const bad: string[] = [];
  const block = /^skills:\s*\r?\n((?:[ \t]+.*(?:\r?\n|$))+)/m.exec(m[1]);
  for (const line of block ? block[1].split(/\r?\n/) : []) {
    const t = line.trim();
    if (!t) continue;
    const r = /^-\s*([a-z0-9][a-z0-9_-]*)@(?:([0-9][0-9.]*)#([0-9a-f]{40})|(最新))\s*(.*)$/i.exec(t);
    if (!r) { bad.push(t); continue; }
    const pr = /優先\s*([0-9]+)/.exec(r[5]);
    const st = /強さ\s*([^|]+)/.exec(r[5]);
    const latest = !!r[4];
    uses.push({ skill: r[1], version: latest ? "最新" : r[2], commit: latest ? null : r[3].toLowerCase(), priority: pr ? Number(pr[1]) : null, strength: st ? st[1].trim() : null });
  }
  uses.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
  return { name: head.name, title: head.title, version: head.version, purpose: head.purpose, where: head.where, audience: head.audience, owner: head.owner, updated: head.updated, uses, bad };
}

/** 木から recipes/<名前>/RECIPE.md の名前の並びを作る */
export function recipeFolders(tree: Array<{ path: string; type: string }>): string[] {
  return tree.filter((t) => t.type === "blob").map((t) => /^recipes\/([^/]+)\/RECIPE\.md$/.exec(t.path)?.[1]).filter((x): x is string => !!x).sort();
}
