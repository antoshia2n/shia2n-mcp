import { parseFlow } from "./recipe-write-core.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { HYPOTHESIS_STATUSES, addHypothesis, listHypotheses, updateHypothesis } from "./hypothesis-core.js";
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
  // v1.107.2：枝の名前（main・public）で読むときは、毎回ちがう住所にして途中の置き場の写しを使わない。
  // 2026-11-16 本番で、保存の 10 分後も棚に前の中身（前のコミット）が出た。コミット（40 桁）で読むときは中身が変わらないので付けない
  const pinned = /[?&]ref=[0-9a-f]{40}\b|\/(?:trees|commits)\/[0-9a-f]{40}\b/i.test(path);
  const url = `https://api.github.com/repos/${SKILLS_REPO}${path}${pinned ? "" : `${path.includes("?") ? "&" : "?"}_=${Date.now()}`}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json", "User-Agent": "shia2n-mcp", "Cache-Control": "no-cache" },
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
          スキル: rows.map((s) => ({ name: s.name, title: s.title, genre: s.genre, category: s.category, media: s.media, ...(s.refs.length ? { refs: s.refs } : {}), purpose: s.purpose, version: s.version, public_version: s.public_version, where: s.where, audience: s.audience, owner: s.owner, updated: s.updated, description: s.description.slice(0, 160), files: s.files.length })),
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
          return r ? { name: r.name, title: r.title, purpose: r.purpose, version: r.version, updated: r.updated, uses: r.uses.map((u) => ({ skill: u.skill, version: u.version, priority: u.priority, strength: u.strength })) } : { name: n, 読めなかった: true };
        }));
        return asMcpTextResult({ ok: true, 件数: rows.length, レシピ: rows, 用語集: "言葉の定義は skills__get name=用語集" });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  server.tool(
    "recipes__get",
    "レシピ 1 本を、使うスキルの本文まで一度に返す（読むだけ）。name にレシピの名前（例 shia2n-10sen-koboke）。各スキルはレシピが固定した版（コミット）の SKILL.md を返すので、スキルが更新されてもレシピの中身は変わらない。ただし @最新 の行（レビューなど）は main の最新を読み、references/ の .md（コードの数字の表・シアニンの仮説）も 参考 に入れて返す。スキルの中の別ファイル（references/ など）は skills__get に name・path・ref（返した commit）を渡して読む。作るときは、流れ（手順の並び）を上から 1 つずつ進め、手順にプロンプトがあればその文で作り、確認があれば人に見せて止まる。優先の順・強さを守る。戻り値: { ok, name, title, version, purpose, 流れ: [{ title, detail?, skill?, check?, prompt? }], 本文, スキル: [{ skill, version, priority, strength, commit, files, 版の食い違い?, SKILL, 参考? }], 読めなかった? }。",
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
        // v1.106.0：@最新 の行は main の今のコミットで読む（1 回だけ取る）
        let head: string | null = null;
        if (r.uses.some((u) => !u.commit)) {
          const c = await gh(env, `/commits/${SKILLS_BRANCH}`);
          head = c.ok ? String(c.body.sha) : null;
          if (!head) failed.push(`main の今のコミットが読めなかった（${c.ok ? "" : c.message}）`);
        }
        const skills = await Promise.all(r.uses.map(async (u) => {
          const latest = !u.commit;
          const ref = u.commit || head;
          if (!ref) return { skill: u.skill, version: u.version, priority: u.priority, strength: u.strength, commit: null, 読めなかった: true };
          const t = await gh(env, `/git/trees/${ref}?recursive=1`);
          const files = t.ok ? groupSkillFiles(t.body.tree || []).get(u.skill) || [] : [];
          const h = await gh(env, `/contents/skills/${encodeURIComponent(u.skill)}/SKILL.md?ref=${ref}`, true);
          if (!h.ok) { failed.push(`${u.skill}@${u.version}（${h.message}）`); return { skill: u.skill, version: u.version, priority: u.priority, strength: u.strength, commit: ref, 読めなかった: true }; }
          const meta = parseSkillHead(String(h.body), u.skill);
          const mismatch = !latest && meta?.version && meta.version !== u.version ? `レシピは ${u.version}、固定したコミットの版は ${meta.version}` : null;
          // @最新 のスキルは references/ の .md も一緒に返す（レビューは数字の表と仮説を毎回読むため）。合計 80KB まで
          let refs: Record<string, string> | undefined;
          if (latest) {
            refs = {};
            let total = 0;
            for (const fp of files.filter((x) => /^references\/[^/]+\.md$/.test(x)).sort()) {
              const b = await gh(env, `/contents/skills/${encodeURIComponent(u.skill)}/${fp}?ref=${ref}`, true);
              if (!b.ok) { failed.push(`${u.skill}/${fp}（${b.message}）`); continue; }
              const s = String(b.body);
              if (total + s.length > 80_000) { refs[fp] = "（大きいので省いた。skills__get で path を渡して読む）"; continue; }
              total += s.length;
              refs[fp] = s;
            }
          }
          return {
            skill: u.skill, version: latest ? `最新（${meta?.version ?? "版不明"}）` : u.version, priority: u.priority, strength: u.strength, commit: ref, files,
            ...(mismatch ? { 版の食い違い: mismatch } : {}), SKILL: String(h.body), ...(refs ? { 参考: refs } : {}),
          };
        }));
        return asMcpTextResult({
          ok: true, name: r.name, title: r.title, version: r.version, purpose: r.purpose, updated: r.updated, 流れ: parseFlow(text), 本文: body, スキル: skills,
          ...(r.bad.length ? { 読めなかった行: r.bad } : {}), ...(failed.length ? { 読めなかった: failed } : {}),
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // v1.106.0（2026-11-15 開発部）：シアニンの仮説を足す・状態を変える。書くのは正本 shia2n-skills の main に直接（1 コミット）。
  // 後で作るアプリの画面も writeHypotheses を通す。鍵は書く鍵 GITHUB_TOKEN（読む鍵では書けない）。
  server.tool(
    "hypotheses__add",
    "シアニンの仮説を 1 つ足す（正本 shia2n-skills の skills/<スキル>/references/hypotheses.md に、言葉のまま日付つきで入れる）。Naoki が「仮説を足して：…」と言ったときに呼ぶ。words は Naoki の言葉をそのまま渡す（要約・言い換えをしない）。title は短い題（Naoki の言葉から取る）。target は誰に当てるか（例：生徒だけ）を Naoki が言ったときだけ。次のレビューから使われる（レシピが @最新 で読むため）。戻り値: { ok, id, commit, 一覧 }／失敗 { ok: false, message }。",
    {
      title: z.string().min(1).max(80).describe("短い題（Naoki の言葉から）"),
      words: z.string().min(1).max(2000).describe("Naoki の言葉そのまま"),
      target: z.string().max(200).optional().describe("誰に当てるか（Naoki が言ったときだけ）"),
      skill: z.string().max(80).optional().describe("仮説を持つスキル。省くと shia2n-x-review"),
    },
    async ({ title, words, target, skill }) => {
      try {
        let id = 0;
        const r = await writeHypotheses(env, skill || "shia2n-x-review", (md) => { const a = addHypothesis(md, { title, words, target, date: jstDate() }); id = a.id; return a.md; }, () => `仮説を足す：H${id} ${title}`);
        return asMcpTextResult(r.ok ? { ok: true, id: `H${id}`, commit: r.commit, 一覧: r.list } : r);
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  server.tool(
    "hypotheses__update",
    "シアニンの仮説 1 つの状態を変える・追記を足す（状態：仮説／確かめ中／確定／やめた。前の状態は日付つきで残す）。note は Naoki の言葉をそのまま渡す。仮説の中身そのものは書き換えない（変えたいときは追記で足す）。戻り値: { ok, id, commit, 一覧 }／失敗 { ok: false, message }。",
    {
      id: z.string().regex(/^H?\d+$/i).describe("仮説の番号（H3 か 3）"),
      status: z.enum(HYPOTHESIS_STATUSES).optional().describe("新しい状態"),
      note: z.string().max(2000).optional().describe("追記（Naoki の言葉そのまま）"),
      skill: z.string().max(80).optional().describe("仮説を持つスキル。省くと shia2n-x-review"),
    },
    async ({ id, status, note, skill }) => {
      try {
        if (!status && !note) return asMcpTextResult({ ok: false, message: "status か note のどちらかを渡す" });
        const n = Number(String(id).replace(/^H/i, ""));
        let miss = false;
        const r = await writeHypotheses(env, skill || "shia2n-x-review", (md) => {
          const out = updateHypothesis(md, { id: n, date: jstDate(), status, note });
          if (out === null) { miss = true; return md; }
          return out;
        }, () => `仮説を直す：H${n}${status ? ` ${status}` : ""}${note ? " 追記" : ""}`);
        if (miss) return asMcpTextResult({ ok: false, message: `H${n} が無い`, 一覧: r.ok ? r.list : undefined });
        return asMcpTextResult(r.ok ? { ok: true, id: `H${n}`, commit: r.commit, 一覧: r.list } : r);
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );
}

function jstDate(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

function b64utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function unb64utf8(s: string): string {
  const bin = atob(s.replace(/\s+/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/**
 * 正本 shia2n-skills の main のファイル 1 つを読み、change で作り直し、1 コミットで書く（2026-11-16 v1.107.0 で仮説から分けた）。
 * 間に別の書き込みが入って食い違ったら、取り直して 1 回だけやり直す。create が真なら、無いファイルは change(null) で新しく作る。
 * change が null を返したら書かない（呼び手が理由を持つ）。
 */
export async function writeSkillsFile(
  env: Env, path: string, change: (text: string | null) => string | null, message: () => string, create = false,
): Promise<{ ok: true; commit: string; text: string } | { ok: false; message: string; missing?: boolean }> {
  if (!/^[A-Za-z0-9_./-]+$/.test(path) || path.includes("..")) return { ok: false, message: "path が変" };
  const key = env.GITHUB_TOKEN;
  if (!key) return { ok: false, message: "書く鍵（GITHUB_TOKEN）が無い" };
  const url = `https://api.github.com/repos/${SKILLS_REPO}/contents/${path}`;
  const headers = { Authorization: `Bearer ${key}`, Accept: "application/vnd.github+json", "User-Agent": "shia2n-mcp", "Content-Type": "application/json" };
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await fetch(`${url}?ref=${SKILLS_BRANCH}`, { headers });
    if (cur.status === 404 && !create) return { ok: false, message: `${path} が無い`, missing: true };
    if (!cur.ok && cur.status !== 404) return { ok: false, message: `読めなかった（${cur.status}）${(await cur.text()).slice(0, 200)}` };
    const j: any = cur.status === 404 ? null : await cur.json();
    const before = j ? unb64utf8(String(j.content || "")) : null;
    const after = change(before);
    if (after === null) return { ok: false, message: "変えなかった" };
    if (after === before) return { ok: true, commit: "変更なし", text: after };
    const put = await fetch(url, { method: "PUT", headers, body: JSON.stringify({ message: `${message()}（shia2n-mcp）`, content: b64utf8(after), ...(j ? { sha: j.sha } : {}), branch: SKILLS_BRANCH }) });
    if (put.ok) { const pj: any = await put.json(); return { ok: true, commit: String(pj.commit?.sha || ""), text: after }; }
    if (put.status === 409 || put.status === 422) continue;
    if (put.status === 403 || put.status === 404) return { ok: false, message: `書く鍵に shia2n-skills へ書く権限が無い（${put.status}）。GitHub の鍵の設定で shia2n-skills の Contents を Read and write にする` };
    return { ok: false, message: `書けなかった（${put.status}）${(await put.text()).slice(0, 200)}` };
  }
  return { ok: false, message: "別の書き込みと 2 回ぶつかった。少し待ってもう一度" };
}

/** hypotheses.md を読み、change で作り直して書く（2026-11-15 v1.106.0）。アプリの画面からもこれを呼ぶ */
export async function writeHypotheses(
  env: Env, skill: string, change: (md: string) => string, message: () => string,
): Promise<{ ok: true; commit: string; list: Array<{ id: string; title: string; status: string | null }> } | { ok: false; message: string }> {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(skill)) return { ok: false, message: "skill は英数字とハイフンだけ" };
  const r = await writeSkillsFile(env, `skills/${skill}/references/hypotheses.md`, (t) => (t === null ? null : change(t)), message);
  if (!r.ok) return { ok: false, message: r.missing ? `${skill} に references/hypotheses.md が無い` : r.message };
  return { ok: true, commit: r.commit, list: listHypotheses(r.text).map((h) => ({ id: `H${h.id}`, title: h.title, status: h.status })) };
}
