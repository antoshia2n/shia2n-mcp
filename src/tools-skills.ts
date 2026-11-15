import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { SKILLS_BRANCH, SKILLS_PUBLIC_BRANCH, SKILLS_REPO, filterSkills, groupSkillFiles, nearNames, parseSkillHead, type SkillMeta } from "./skills-core.js";

/**
 * スキルの正本を AI が確かめる口（2026-11-15 v1.101.0 開発部・スキルズの管理 2便目・依頼 https://www.notion.so/4199c6c1c43981788264fa7286081a84）。
 * 命名規約：skills__<action>。読むだけで、書く先は 0。
 *   ・skills__list：正本にあるスキルの一覧と、版・使う場所・見せる相手・担当・最終更新
 *   ・skills__get：1 本の SKILL.md の全文と、同じフォルダのファイル（path を渡すとそのファイルの中身）
 *   ・正本は非公開の GitHub リポジトリ antoshia2n/shia2n-skills。鍵は db__impact と同じ読むだけの鍵（GITHUB_READ_TOKEN、無ければ GITHUB_TOKEN）
 */

const readKey = (env: Env) => env.GITHUB_READ_TOKEN || env.GITHUB_TOKEN;

export async function gh(env: Env, path: string, raw = false): Promise<{ ok: true; body: any } | { ok: false; status: number; message: string }> {
  const key = readKey(env);
  if (!key) return { ok: false, status: 0, message: "鍵が設定されていません（GITHUB_READ_TOKEN か GITHUB_TOKEN）" };
  const r = await fetch(`https://api.github.com/repos/${SKILLS_REPO}${path}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json", "User-Agent": "shia2n-mcp" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const why = r.status === 404 ? "正本のリポジトリが鍵で見えない（鍵の対象に shia2n-skills が入っていないか、名前が違う）" : `GitHub error ${r.status}`;
    return { ok: false, status: r.status, message: why };
  }
  return { ok: true, body: raw ? await r.text() : await r.json() };
}

export async function readAll(env: Env, ref: string = SKILLS_BRANCH): Promise<{ ok: true; commit: string; skills: Array<SkillMeta & { folder: string; files: string[] }>; broken: string[] } | { ok: false; message: string }> {
  const tree = await gh(env, `/git/trees/${ref}?recursive=1`);
  if (!tree.ok) return { ok: false, message: tree.message };
  const groups = groupSkillFiles(tree.body.tree || []);
  const skills: Array<SkillMeta & { folder: string; files: string[] }> = [];
  const broken: string[] = [];
  await Promise.all([...groups.entries()].map(async ([folder, files]) => {
    if (!files.includes("SKILL.md")) { broken.push(`${folder}（SKILL.md が無い）`); return; }
    const f = await gh(env, `/contents/skills/${encodeURIComponent(folder)}/SKILL.md?ref=${ref}`, true);
    if (!f.ok) { broken.push(`${folder}（${f.message}）`); return; }
    const meta = parseSkillHead(String(f.body), folder);
    if (!meta) { broken.push(`${folder}（頭の --- が無い）`); return; }
    skills.push({ ...meta, folder, files });
  }));
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, commit: String(tree.body.sha || "").slice(0, 7), skills, broken };
}

export function registerSkillsTools(server: McpServer, env: Env): void {
  server.tool(
    "skills__list",
    "シアニンの自作スキルの正本（GitHub の shia2n-skills）にある一覧を返す（読むだけ）。各スキルの 何に使うか・最新版・生徒の版・使う場所（claude.ai／Claude Code／GPT）・見せる相手・担当・最終更新・説明。手元のスキルが古くないかを確かめるとき、どのスキルをどこで使うかを見るときに呼ぶ。where（使う場所）か owner（担当）で絞れる。戻り値: { ok: true, 正本, 版の印, 件数, スキル: [{ name, version, where, audience, owner, updated, description, files }], 欄が欠けたスキル?, 読めなかったもの? }／失敗 { ok: false, message }。",
    {
      where: z.string().max(30).optional().describe("使う場所で絞る：claude.ai・Claude Code・GPT"),
      owner: z.string().max(30).optional().describe("担当で絞る（例：X・コンテンツ制作・るーみん）"),
    },
    async ({ where, owner }) => {
      try {
        const all = await readAll(env);
        if (!all.ok) return asMcpTextResult({ ok: false, message: all.message });
        const rows = filterSkills(all.skills, { where, owner }) as Array<SkillMeta & { folder: string; files: string[] }>;
        const lacking = all.skills.filter((s) => s.missing.length).map((s) => `${s.name}（${s.missing.join("・")}）`);
        return asMcpTextResult({
          ok: true,
          正本: `https://github.com/${SKILLS_REPO}`,
          版の印: all.commit,
          件数: rows.length,
          スキル: rows.map((s) => ({ name: s.name, purpose: s.purpose, version: s.version, public_version: s.public_version, where: s.where, audience: s.audience, owner: s.owner, updated: s.updated, description: s.description.slice(0, 160), files: s.files.length })),
          ...(lacking.length ? { 欄が欠けたスキル: lacking } : {}),
          ...(all.broken.length ? { 読めなかったもの: all.broken } : {}),
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  server.tool(
    "skills__get",
    "スキル 1 本の最新版を正本（GitHub の shia2n-skills）から返す（読むだけ）。name にスキルの名前（例 shia2n-marketing-skills）。path を省くと SKILL.md の全文と、版などの欄・同じフォルダのファイルの並び。channel=student で生徒に出している版（public の枝）を返す（既定は最新版）。path に並びの 1 つ（例 references/pitfalls.md）を渡すとそのファイルの中身。手元の写しと版が違うときは、こちらを正とする。戻り値: { ok: true, name, version, where, audience, owner, updated, files, path, 本文 }／見つからない { ok: false, message, 近い名前? }。",
    {
      name: z.string().min(2).max(80).describe("スキルの名前（フォルダ名）"),
      path: z.string().max(200).optional().describe("同じフォルダの中のファイル。省くと SKILL.md"),
      channel: z.enum(["latest", "student"]).optional().describe("latest＝最新版（main・既定）／student＝生徒に出している版（public の枝）"),
    },
    async ({ name, path, channel }) => {
      try {
        const folder = name.trim();
        if (!/^[a-z0-9][a-z0-9_-]*$/i.test(folder)) return asMcpTextResult({ ok: false, message: "名前は英数字とハイフンだけ" });
        const p = (path || "SKILL.md").trim();
        if (p.includes("..") || p.startsWith("/")) return asMcpTextResult({ ok: false, message: "path はフォルダの中だけ" });
        const ref = channel === "student" ? SKILLS_PUBLIC_BRANCH : SKILLS_BRANCH;
        const tree = await gh(env, `/git/trees/${ref}?recursive=1`);
        if (!tree.ok) return asMcpTextResult({ ok: false, message: tree.message });
        const groups = groupSkillFiles(tree.body.tree || []);
        const files = groups.get(folder);
        if (!files) return asMcpTextResult({ ok: false, message: channel === "student" ? `${folder} は生徒に出していない` : `正本に ${folder} が無い`, 近い名前: nearNames(folder, [...groups.keys()]) });
        if (!files.includes(p)) return asMcpTextResult({ ok: false, message: `${folder} の中に ${p} が無い`, files });
        const head = await gh(env, `/contents/skills/${encodeURIComponent(folder)}/SKILL.md?ref=${ref}`, true);
        if (!head.ok) return asMcpTextResult({ ok: false, message: head.message });
        const meta = parseSkillHead(String(head.body), folder);
        const body = p === "SKILL.md" ? String(head.body)
          : await gh(env, `/contents/skills/${encodeURIComponent(folder)}/${p.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`, true).then((r) => (r.ok ? String(r.body) : null));
        if (body === null) return asMcpTextResult({ ok: false, message: `${p} を読めなかった` });
        return asMcpTextResult({
          ok: true, channel: channel || "latest", name: meta?.name || folder, purpose: meta?.purpose ?? null, version: meta?.version ?? null, public_version: meta?.public_version ?? null, where: meta?.where ?? [], audience: meta?.audience ?? [],
          owner: meta?.owner ?? null, updated: meta?.updated ?? null, files, path: p, 本文: body,
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );
}
