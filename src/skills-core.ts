/**
 * スキルの正本（antoshia2n/shia2n-skills）の読み方。計算だけ（2026-11-15 v1.101.0 開発部・スキルズの管理 2便目）。
 * 正本の決まり：skills/<名前>/SKILL.md の頭（--- と --- の間）に name・description と metadata の 5 行
 *   version（版）・where（使う場所）・audience（見せる相手）・owner（担当）・updated（最終更新）
 * 台帳（README.md）は同じ 5 行から作られる。ここは README ではなく SKILL.md を直接読む（台帳の作り直しを待たないため）
 */

export const SKILLS_REPO = "antoshia2n/shia2n-skills";
export const SKILLS_BRANCH = "main";
export const META_FIELDS = ["version", "where", "audience", "owner", "updated"] as const;

export type SkillMeta = {
  name: string;
  description: string;
  version: string | null;
  where: string[];
  audience: string[];
  owner: string | null;
  updated: string | null;
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
