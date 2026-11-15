import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { SKILLS_BRANCH, SKILLS_PUBLIC_BRANCH, SKILLS_REPO, filterSkills, groupSkillFiles, nearNames, parseRecipeHead, parseSkillHead, recipeFolders, type SkillMeta } from "./skills-core.js";

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
          用語集: "言葉の定義は skills__get name=用語集 で読む。スキル・レシピ・カテゴリなどの名前はこれに合わせる",
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
      name: z.string().min(2).max(80).describe("スキルの名前（フォルダ名）。用語集 を渡すと言葉の定義（GLOSSARY.md）"),
      path: z.string().max(200).optional().describe("同じフォルダの中のファイル。省くと SKILL.md"),
      ref: z.string().regex(/^[0-9a-f]{40}$/i).optional().describe("v1.105.0：レシピが固定したコミット（40 桁）。渡すとその時点の版を読む（channel より優先）"),
      channel: z.enum(["latest", "student"]).optional().describe("latest＝最新版（main・既定）／student＝生徒に出している版（public の枝）"),
    },
    async ({ name, path, channel, ref: pin }) => {
      try {
        const folder = name.trim();
        // v1.104.0：用語集（スキル・レシピ・カテゴリなどの言葉の定義）。いつも main の GLOSSARY.md
        if (folder === "用語集" || folder.toLowerCase() === "glossary") {
          const g = await gh(env, `/contents/GLOSSARY.md?ref=${SKILLS_BRANCH}`, true);
          if (!g.ok) return asMcpTextResult({ ok: false, message: g.message });
          return asMcpTextResult({ ok: true, name: "用語集", path: "GLOSSARY.md", 本文: String(g.body) });
        }
        if (!/^[a-z0-9][a-z0-9_-]*$/i.test(folder)) return asMcpTextResult({ ok: false, message: "名前は英数字とハイフンだけ" });
        const p = (path || "SKILL.md").trim();
        if (p.includes("..") || p.startsWith("/")) return asMcpTextResult({ ok: false, message: "path はフォルダの中だけ" });
        const ref = pin ? pin.toLowerCase() : channel === "student" ? SKILLS_PUBLIC_BRANCH : SKILLS_BRANCH;
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
          ok: true, channel: pin ? `ref ${pin.slice(0, 7)}` : channel || "latest", name: meta?.name || folder, purpose: meta?.purpose ?? null, version: meta?.version ?? null, public_version: meta?.public_version ?? null, where: meta?.where ?? [], audience: meta?.audience ?? [],
          owner: meta?.owner ?? null, updated: meta?.updated ?? null, files, path: p, 本文: body,
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // v1.105.0（2026-11-15 開発部・レシピの便 1）：レシピ＝スキルの組み合わせ。recipes/<名前>/RECIPE.md
  server.tool(
    "recipes__list",
    "シアニンのレシピ（スキルの組み合わせ）の一覧を正本（GitHub の shia2n-skills の recipes/）から返す（読むだけ）。各レシピの 何に使うか・版・使うスキルと固定した版・優先・強さ。どのレシピで作るかを選ぶときに呼ぶ。中身は recipes__get。戻り値: { ok, 件数, レシピ: [{ name, purpose, version, updated, uses: [{ skill, version, priority, strength }] }] }。",
    {},
    async () => {
      try {
        const tree = await gh(env, `/git/trees/${SKILLS_BRANCH}?recursive=1`);
        if (!tree.ok) return asMcpTextResult({ ok: false, message: tree.message });
        const names = recipeFolders(tree.body.tree || []);
        const rows = await Promise.all(names.map(async (n) => {
          const f = await gh(env, `/contents/recipes/${encodeURIComponent(n)}/RECIPE.md?ref=${SKILLS_BRANCH}`, true);
          const r = f.ok ? parseRecipeHead(String(f.body), n) : null;
          return r ? { name: r.name, purpose: r.purpose, version: r.version, updated: r.updated, uses: r.uses.map((u) => ({ skill: u.skill, version: u.version, priority: u.priority, strength: u.strength })) } : { name: n, 読めなかった: true };
        }));
        return asMcpTextResult({ ok: true, 件数: rows.length, レシピ: rows, 用語集: "言葉の定義は skills__get name=用語集" });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  server.tool(
    "recipes__get",
    "レシピ 1 本を、使うスキルの本文まで一度に返す（読むだけ）。name にレシピの名前（例 shia2n-10sen-koboke）。各スキルはレシピが固定した版（コミット）の SKILL.md を返すので、スキルが更新されてもレシピの中身は変わらない。スキルの中の別ファイル（references/ など）は skills__get に name・path・ref（返した commit）を渡して読む。作るときは、本文の流れに従い、優先の順・強さを守る。戻り値: { ok, name, version, purpose, 本文, スキル: [{ skill, version, priority, strength, commit, files, 版の食い違い?, SKILL }], 読めなかった? }。",
    { name: z.string().min(2).max(80).describe("レシピの名前（フォルダ名）") },
    async ({ name }) => {
      try {
        const folder = name.trim();
        if (!/^[a-z0-9][a-z0-9_-]*$/i.test(folder)) return asMcpTextResult({ ok: false, message: "名前は英数字とハイフンだけ" });
        const f = await gh(env, `/contents/recipes/${encodeURIComponent(folder)}/RECIPE.md?ref=${SKILLS_BRANCH}`, true);
        if (!f.ok) return asMcpTextResult({ ok: false, message: f.status === 404 ? `レシピ ${folder} が無い（recipes__list で名前を確かめる）` : f.message });
        const text = String(f.body);
        const r = parseRecipeHead(text, folder);
        if (!r) return asMcpTextResult({ ok: false, message: "レシピの頭の --- が無い" });
        const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
        const failed: string[] = [];
        const skills = await Promise.all(r.uses.map(async (u) => {
          const t = await gh(env, `/git/trees/${u.commit}?recursive=1`);
          const files = t.ok ? groupSkillFiles(t.body.tree || []).get(u.skill) || [] : [];
          const h = await gh(env, `/contents/skills/${encodeURIComponent(u.skill)}/SKILL.md?ref=${u.commit}`, true);
          if (!h.ok) { failed.push(`${u.skill}@${u.version}（${h.message}）`); return { skill: u.skill, version: u.version, priority: u.priority, strength: u.strength, commit: u.commit, 読めなかった: true }; }
          const meta = parseSkillHead(String(h.body), u.skill);
          const mismatch = meta?.version && meta.version !== u.version ? `レシピは ${u.version}、固定したコミットの版は ${meta.version}` : null;
          return { skill: u.skill, version: u.version, priority: u.priority, strength: u.strength, commit: u.commit, files, ...(mismatch ? { 版の食い違い: mismatch } : {}), SKILL: String(h.body) };
        }));
        return asMcpTextResult({
          ok: true, name: r.name, version: r.version, purpose: r.purpose, updated: r.updated, 本文: body, スキル: skills,
          ...(r.bad.length ? { 読めなかった行: r.bad } : {}), ...(failed.length ? { 読めなかった: failed } : {}),
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );
}
