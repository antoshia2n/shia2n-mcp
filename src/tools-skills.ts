import { parseFlow } from "./recipe-write-core.js";
import { findRecipes } from "./recipe-find-core.js";
import { STRENGTHS, writeRecipeText, type FlowStep } from "./recipe-write-core.js";
import { checkSkillText, recipeSizeWarning, similarSkills, stampUpdated } from "./skill-save-core.js";
import { checkGlyph, glyphFromSvg, openaiYaml, skillIconSvg } from "./skill-icon-core.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { FEEDBACK_HINT, addFeedback, feedbackFiles, feedbackPath, feedbackSummary, listFeedback, recipesUsing, resolveFeedback } from "./feedback-core.js";
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

  // v1.110.0（2026-11-16 開発部・スキルの棚の便 4・Naoki OK 08:50）：入口。依頼の文から合うレシピと補強のスキルを探す（計算は recipe-find-core.ts・AI は呼ばない）
  server.tool(
    "recipes__find",
    "シアニンの制作（X の図解・画像ポスト・長文記事・スレッド・note・台本・スライド・LP など）を頼まれたら、作り始める前に最初に呼ぶ。依頼の文（task）から、合うレシピ（多くて 3 つ）と、いちばん合うレシピに足せる補強のスキル（多くて 3 つ）を返す。返った 聞き方 のとおり「このレシピを使います。補強にこのスキルも使いますか？」と人に聞き、答えを受けてから recipes__get でそのレシピを読み、流れのとおりに進める。補強を使うと言われたら skills__get でそのスキルも読む。レシピが無ければ スキルだけ を返す。読むだけ。戻り値: { ok, 依頼, おすすめ: [{ name, title, purpose, 点, 手がかり, 使うスキル }], 補強の候補: [{ name, title, category, 点, 手がかり, 理由 }], スキルだけ, 聞き方 }。",
    { task: z.string().min(2).max(2000).describe("依頼の文（人が言ったまま）"), media: z.string().max(30).optional().describe("出す先が分かっていれば（X・note・YouTube・セミナー など）") },
    async ({ task, media }) => {
      try {
        const [all, tree] = await Promise.all([readAll(env, SKILLS_BRANCH), gh(env, `/git/trees/${SKILLS_BRANCH}?recursive=1`)]);
        if (!all.ok) return asMcpTextResult({ ok: false, message: all.message });
        if (!tree.ok) return asMcpTextResult({ ok: false, message: tree.message });
        const recipes = (await Promise.all(recipeFolders(tree.body.tree || []).map(async (n) => {
          const f = await gh(env, `/contents/recipes/${encodeURIComponent(n)}/RECIPE.md?ref=${SKILLS_BRANCH}`, true);
          if (!f.ok) return null;
          const r = parseRecipeHead(String(f.body), n);
          return r ? { name: r.name, title: r.title, purpose: r.purpose, uses: r.uses, flow: parseFlow(String(f.body)) } : null;
        }))).filter((x): x is NonNullable<typeof x> => !!x);
        const skills = all.skills.map((k) => ({ name: k.folder, title: k.title, purpose: k.purpose, description: k.description, genre: k.genre, category: k.category, media: k.media, conflicts: k.conflicts, kind: k.kind }));
        return asMcpTextResult({ ok: true, ...findRecipes(task, recipes, skills, { media: media || null }), 次: "人の答えを受けてから recipes__get（レシピ）・skills__get（補強のスキル）" });
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

  // v1.111.0（2026-11-16 開発部・スキルクリエイターの便）：スキルとレシピを AI から正本へ保存する口。
  // 規格（STANDARD.md）の確かめ・重複の確かめ・版の上げ方を、AI に任せず道具の側で必ず通す。台帳は正本の push で自動で作り直される。
  server.tool(
    "skills__save",
    "シアニンのスキル 1 本を正本 shia2n-skills の skills/<name>/SKILL.md に保存する（main に 1 コミット）。スキルクリエイター（shia2n-skill-creator）の手順で、人が OK と言ったあとにだけ呼ぶ。保存の前に規格（STANDARD.md）を必ず確かめ、外れていれば保存せず理由を返す：頭の欄（title・purpose・genre・category・version・where・audience・owner）・ジャンル 6 つ・カテゴリ 5 つ・見出しの順（目的／使う場面／使わない場面／手順／決まり／出力の形／参照）・500 行未満・参照は 1 段まで・新しいスキルは 1.0・本文を変えたら版を上げる・頭の欄だけなら版を上げない。updated は今日の日付に道具がそろえる。icon（24×24 の線の絵）を渡すと、ジャンルの色でアイコン（assets/icon.svg・icon-small.svg）と ChatGPT 用の agents/openai.yaml を道具が作る。新しく作る（create）とき似たスキルがあれば止まり、new_reason（なぜ今のスキルの直しやレシピで足りないか）を渡したときだけ作る。check_only で確かめだけもできる。戻り値: { ok, name, version, commit, 注意? }／止まったとき { ok: false, 直すこと: [...], 似たスキル? }。",
    {
      name: z.string().min(2).max(64).describe("AI が呼ぶ名前（フォルダ名）。英小文字・数字・ハイフン"),
      text: z.string().min(50).max(60000).describe("SKILL.md の全文（頭の --- から）"),
      create: z.boolean().optional().describe("新しく作るとき true。直すときは省く"),
      new_reason: z.string().max(500).optional().describe("似たスキルがあっても新しく作る理由（人の言葉）"),
      check_only: z.boolean().optional().describe("true なら確かめだけして保存しない"),
      icon: z.string().max(2000).optional().describe("アイコンの絵（24×24 の線の中身。path・circle・rect・line・polyline・ellipse だけ）。新しく作るときは渡す。色はジャンルで道具が決める"),
      feedback_ids: z.array(z.string().regex(/^F?\d+$/i)).max(50).optional().describe("v1.116.0：この直しで反映した直しの番号（F3 か 3）。保存できたら feedback/<name>.md のその行を「反映済み 新しい版」にする"),
    },
    async ({ name, text, create, new_reason, check_only, icon, feedback_ids }) => {
      try {
        const all = await readAll(env, SKILLS_BRANCH);
        if (!all.ok) return asMcpTextResult({ ok: false, message: all.message });
        const date = jstDate();
        const stamped = stampUpdated(text.replace(/\r\n/g, "\n"), date);
        const exists = all.skills.some((k) => k.folder === name);
        if (create && exists) return asMcpTextResult({ ok: false, 直すこと: [`${name} はもう正本にある。直すなら create を省く`] });
        if (!create && !exists) return asMcpTextResult({ ok: false, 直すこと: [`${name} は正本に無い。新しく作るなら create: true`] });
        let current: string | null = null;
        if (exists) {
          const f = await gh(env, `/contents/skills/${encodeURIComponent(name)}/SKILL.md?ref=${SKILLS_BRANCH}`, true);
          if (!f.ok) return asMcpTextResult({ ok: false, message: f.message });
          current = String(f.body);
        }
        const c = checkSkillText(name, stamped, current, all.skills);
        if (icon) { const bad = checkGlyph(icon); if (bad) c.errors.push(`アイコン：${bad}`); }
        const hasIcon = all.skills.find((k) => k.folder === name)?.files.includes("assets/icon.svg") || false;
        if (!icon && !hasIcon) c.warnings.push("アイコンが無い。icon に絵（24×24 の線）を渡すと、ジャンルの色で道具が作る（STANDARD.md 7 節）");
        const similar = create && c.meta ? similarSkills(c.meta, all.skills) : [];
        if (c.errors.length) return asMcpTextResult({ ok: false, 直すこと: c.errors, ...(c.warnings.length ? { 注意: c.warnings } : {}), ...(similar.length ? { 似たスキル: similar } : {}) });
        if (similar.length && !new_reason) return asMcpTextResult({ ok: false, 直すこと: ["似たスキルがある。今のスキルの直し・レシピで足りないかを人に聞き、それでも新しく作るなら new_reason に理由を渡す"], 似たスキル: similar });
        if (check_only) return asMcpTextResult({ ok: true, 確かめだけ: true, name, version: c.meta?.version, ...(c.warnings.length ? { 注意: c.warnings } : {}), ...(similar.length ? { 似たスキル: similar } : {}) });
        let fail = "";
        const w = await writeSkillsFile(env, `skills/${name}/SKILL.md`, (cur) => {
          if ((cur === null) !== (current === null) || (cur !== null && cur !== current)) { fail = "保存の直前に正本が変わった。読み直してもう一度"; return null; }
          return stamped;
        }, () => `${create ? "スキルを作る" : c.bodyChanged ? "スキルを直す" : "スキルの頭の欄を直す"}：${name} ${c.meta?.version}${new_reason ? `（新しく作る理由：${new_reason.slice(0, 80)}）` : ""}`, !!create);
        if (fail) return asMcpTextResult({ ok: false, message: fail });
        if (!w.ok) return asMcpTextResult({ ok: false, message: w.message });
        const iconNote = await writeSkillIcon(env, name, c.meta!, icon || null, hasIcon);
        // v1.116.0：反映した直しに印を付け、このスキルを使っているレシピを並べる（固定している版を上げるか人に 1 回聞くため）
        const version = c.meta?.version ?? null;
        let fbNote: Record<string, unknown> | null = null;
        if (feedback_ids?.length) {
          const ids = feedback_ids.map((i) => Number(String(i).replace(/^F/i, "")));
          let res: { changed: number[]; missing: number[] } = { changed: [], missing: ids };
          const r = await writeSkillsFile(env, feedbackPath(name), (t) => { if (t === null) return null; const o = resolveFeedback(t, { ids, status: "反映済み", version, date }); res = o; return o.md; }, () => `直しを反映済みに：${name} ${version}（${ids.map((i) => `F${i}`).join("・")}）`);
          fbNote = r.ok ? { 反映済みにした: res.changed.map((i) => `F${i}`), ...(res.missing.length ? { 見つからない・未反映でない: res.missing.map((i) => `F${i}`) } : {}) } : { 直しの印を付けられなかった: r.message };
        }
        const using = c.bodyChanged ? recipesUsing(name, await readRecipeHeads(env), version) : [];
        const bump = using.filter((u) => u.上げる必要);
        return asMcpTextResult({
          ok: true, name, version, ...(iconNote ? { アイコン: iconNote } : {}), commit: w.commit.slice(0, 7), ...(c.warnings.length ? { 注意: c.warnings } : {}),
          ...(fbNote ? { 直し: fbNote } : {}),
          ...(using.length ? { 使っているレシピ: using } : {}),
          次: bump.length
            ? `レシピ ${bump.map((u) => u.title || u.recipe).join("・")} は前の版で固定している。「新しい版で試す」かを人に 1 回だけ聞き、OK なら recipes__save（そのスキルだけ pin: now、ほかは keep）`
            : "棚（マーケくん 素材 › スキル）と台帳に出る。レシピに入れるなら recipes__save",
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  server.tool(
    "recipes__save",
    "レシピ（スキルの組み合わせ）を正本 shia2n-skills の recipes/<name>/RECIPE.md に作る・直す（main に 1 コミット・版は自動で上がる）。スキルクリエイターで「今のスキルの組み合わせで足りる」と決まり、人が OK と言ったあとにだけ呼ぶ。uses の pin は keep（今の固定のまま）／now（いまの版で固定）／latest（@最新・基本スキル shia2n-x-review だけ）。選択スキルは版で固定する決め（Decisions 2026-11-16）。flow を渡すと「## 流れ」を書き直す（手順＝題・説明・使うスキル・確認・プロンプト・20 個まで）。戻り値: { ok, name, version, commit }／失敗 { ok: false, error }。",
    {
      name: z.string().min(2).max(80).describe("レシピの ID（英小文字・数字・ハイフン）"),
      title: z.string().max(60).optional().describe("表示名（人が見て分かる日本語）"),
      purpose: z.string().max(200).optional().describe("何に使うか 1 行"),
      uses: z.array(z.object({ skill: z.string().max(80), pin: z.enum(["keep", "now", "latest"]), strength: z.enum(STRENGTHS).optional() })).min(1).max(12).describe("使うスキル（優先の順）"),
      flow: z.array(z.object({ title: z.string().max(80), detail: z.string().max(1000).optional(), skill: z.string().max(80).optional(), check: z.string().max(300).optional(), prompt: z.string().max(4000).optional() })).max(20).optional().describe("流れ（手順の並び）"),
      create: z.boolean().optional().describe("新しく作るとき true"),
    },
    async ({ name, title, purpose, uses, flow, create }) => {
      try {
        if (!/^[a-z0-9][a-z0-9_-]{1,79}$/i.test(name)) return asMcpTextResult({ ok: false, error: "bad_name" });
        const [all, c] = await Promise.all([readAll(env, SKILLS_BRANCH), gh(env, `/commits/${SKILLS_BRANCH}`)]);
        if (!all.ok) return asMcpTextResult({ ok: false, error: all.message });
        if (!c.ok) return asMcpTextResult({ ok: false, error: c.message });
        const skills = new Map(all.skills.map((s) => [s.folder, s.version]));
        let fail = "", version = "";
        const w = await writeSkillsFile(env, `recipes/${name}/RECIPE.md`, (text) => {
          if (text === null && !create) { fail = "not_found（新しく作るなら create: true）"; return null; }
          if (text !== null && create) { fail = "already（もうある。直すなら create を省く）"; return null; }
          const cur = new Map((text ? parseRecipeHead(text, name)?.uses || [] : []).map((u) => [u.skill, { version: u.version, commit: u.commit }]));
          const r = writeRecipeText(text, { name, title: title ?? null, purpose: purpose ?? null, uses, flow: (flow as FlowStep[] | undefined) ?? null }, { skills, current: cur, head: String(c.body.sha || ""), date: jstDate() });
          if (!r.ok) { fail = r.error; return null; }
          version = r.version;
          return r.text;
        }, () => `${create ? "レシピを作る" : "レシピを直す"}：${name} ${version}（AI・recipes__save）`, !!create);
        if (fail) return asMcpTextResult({ ok: false, error: fail });
        if (!w.ok) return asMcpTextResult({ ok: false, error: w.message });
        const sizeNote = recipeSizeWarning(uses.map((u) => u.skill), new Map(all.skills.map((k) => [k.folder, k.kind])));
        return asMcpTextResult({ ok: true, name, version, commit: w.commit.slice(0, 7), ...(sizeNote ? { 注意: [sizeNote] } : {}) });
      } catch (e) { return asMcpTextResult({ ok: false, error: String(e) }); }
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

  // v1.116.0（2026-11-16 開発部・Naoki OK 14:30「直しを貯めるのと、任意の僕のタイミングで改善の両方ができるように」）：
  // 作業中の Naoki の直しを、スキルごとに正本 shia2n-skills の feedback/<スキル>.md へためる。改善案はスキルクリエイターが読んで出す。
  server.tool(
    "skills__feedback_add",
    "作業中に Naoki が出した直しを 1 件、そのスキルの直しの記録（正本 shia2n-skills の feedback/<スキル>.md）にためる。レシピやスキルで作っている途中・作ったあとに Naoki が「ここ直して」「もっと〇〇に」と言ったら、その回の仕上がりを直すのとは別に、直しが効くスキルを 1 つ決めて呼ぶ（どのスキルか決められないときだけ人に聞く）。words は Naoki の言葉をそのまま渡す（要約・言い換えをしない）。その回だけの話（今回の題の中身など）はためない。スキルは書き換えない。戻り値の 改善の目安 が true なら、作業の区切りで「直しが 2 件たまりました。スキルクリエイターで改善案を出しますか？」と 1 回だけ聞く。戻り値: { ok, skill, id, 未反映, 改善の目安, commit }／失敗 { ok: false, message }。",
    {
      skill: z.string().min(2).max(80).describe("直しが効くスキルの名前（フォルダ名）"),
      words: z.string().min(1).max(2000).describe("Naoki の直しの言葉そのまま"),
      recipe: z.string().max(80).optional().describe("そのとき使っていたレシピの名前（あれば）"),
    },
    async ({ skill, words, recipe }) => {
      try {
        if (!/^[a-z0-9][a-z0-9_-]*$/i.test(skill)) return asMcpTextResult({ ok: false, message: "skill は英数字とハイフンだけ" });
        const has = await gh(env, `/contents/skills/${encodeURIComponent(skill)}/SKILL.md?ref=${SKILLS_BRANCH}`, true);
        if (!has.ok) return asMcpTextResult({ ok: false, message: has.status === 404 ? `${skill} は正本に無い（skills__list で名前を確かめる）` : has.message });
        let id = 0;
        const w = await writeSkillsFile(env, feedbackPath(skill), (t) => { const a = addFeedback(t, skill, { words, recipe: recipe || null, date: jstDate() }); id = a.id; return a.md; }, () => `直しをためる：${skill} F${id}`, true);
        if (!w.ok) return asMcpTextResult({ ok: false, message: w.message });
        const sum = feedbackSummary(skill, listFeedback(w.text));
        return asMcpTextResult({ ok: true, skill, id: `F${id}`, 未反映: sum.未反映, 改善の目安: sum.改善の目安, commit: w.commit.slice(0, 7), ...(sum.改善の目安 ? { 次: `未反映が ${FEEDBACK_HINT} 件以上。作業の区切りで、スキルクリエイターで改善案を出すかを 1 回だけ聞く` } : {}) });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  server.tool(
    "skills__feedback_list",
    "ためた直しを読む（読むだけ）。skill を渡すとそのスキルの直しを全部（番号・日付・状態・レシピ・言葉）、省くと直しがあるスキルごとの未反映の数と、改善の目安（未反映 2 件以上）に届いたか。スキルクリエイターが改善案を出す前に呼ぶ。Naoki が「〇〇のスキルを改善して」「たまった直しを見せて」と言ったときも呼ぶ（目安に届いていなくても出してよい）。only_open で未反映だけ。戻り値: { ok, skill?, 直し?: [...], スキル?: [{ skill, 未反映, 改善の目安 }] }。",
    {
      skill: z.string().max(80).optional().describe("スキルの名前。省くと全部のスキルのまとめ"),
      only_open: z.boolean().optional().describe("true なら未反映だけ"),
    },
    async ({ skill, only_open }) => {
      try {
        if (skill) {
          if (!/^[a-z0-9][a-z0-9_-]*$/i.test(skill)) return asMcpTextResult({ ok: false, message: "skill は英数字とハイフンだけ" });
          const f = await gh(env, `/contents/${feedbackPath(skill)}?ref=${SKILLS_BRANCH}`, true);
          if (!f.ok && f.status !== 404) return asMcpTextResult({ ok: false, message: f.message });
          const items = f.ok ? listFeedback(String(f.body)) : [];
          const shown = only_open ? items.filter((i) => i.status === "未反映") : items;
          return asMcpTextResult({ ok: true, ...feedbackSummary(skill, items), 直し: shown.map((i) => ({ id: `F${i.id}`, 日付: i.date, 状態: i.status, ...(i.recipe ? { レシピ: i.recipe } : {}), 言葉: i.words, ...(i.resolved ? { 結果: i.resolved } : {}) })) });
        }
        const tree = await gh(env, `/git/trees/${SKILLS_BRANCH}?recursive=1`);
        if (!tree.ok) return asMcpTextResult({ ok: false, message: tree.message });
        const names = feedbackFiles(tree.body.tree || []);
        const rows = await Promise.all(names.map(async (n) => {
          const f = await gh(env, `/contents/${feedbackPath(n)}?ref=${SKILLS_BRANCH}`, true);
          return f.ok ? feedbackSummary(n, listFeedback(String(f.body))) : { skill: n, 読めなかった: true };
        }));
        const out = only_open ? rows.filter((r: any) => r.未反映 > 0 || r.読めなかった) : rows;
        return asMcpTextResult({ ok: true, 件数: out.length, スキル: out, 目安: `同じスキルに未反映 ${FEEDBACK_HINT} 件で改善案。Naoki の合図があればいつでも` });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  server.tool(
    "skills__feedback_resolve",
    "ためた直しの状態を変える：反映済み（スキルを直して入れた）／見送り（Naoki が「これはスキルに入れない」と言った）。スキルを直したときは skills__save の feedback_ids で印が付くので、これを呼ぶのは見送りのときと、レシピ側で直したときだけ。note に理由（Naoki の言葉）を付けられる。戻り値: { ok, 変えた, 見つからない?, 未反映, commit }。",
    {
      skill: z.string().min(2).max(80).describe("スキルの名前"),
      ids: z.array(z.string().regex(/^F?\d+$/i)).min(1).max(50).describe("直しの番号（F3 か 3）"),
      status: z.enum(["反映済み", "見送り"]).describe("新しい状態"),
      version: z.string().max(20).optional().describe("反映した版（反映済みのとき）"),
      note: z.string().max(500).optional().describe("理由（Naoki の言葉そのまま）"),
    },
    async ({ skill, ids, status, version, note }) => {
      try {
        if (!/^[a-z0-9][a-z0-9_-]*$/i.test(skill)) return asMcpTextResult({ ok: false, message: "skill は英数字とハイフンだけ" });
        const nums = ids.map((i) => Number(String(i).replace(/^F/i, "")));
        let res: { changed: number[]; missing: number[] } = { changed: [], missing: nums };
        const w = await writeSkillsFile(env, feedbackPath(skill), (t) => { if (t === null) return null; const o = resolveFeedback(t, { ids: nums, status, version: version || null, date: jstDate(), note: note || null }); res = o; return o.md; }, () => `直しを${status}に：${skill}（${nums.map((i) => `F${i}`).join("・")}）`);
        if (!w.ok) return asMcpTextResult({ ok: false, message: w.missing ? `${skill} の直しの記録が無い` : w.message });
        const sum = feedbackSummary(skill, listFeedback(w.text));
        return asMcpTextResult({ ok: true, 変えた: res.changed.map((i) => `F${i}`), ...(res.missing.length ? { 見つからない: res.missing.map((i) => `F${i}`) } : {}), 未反映: sum.未反映, commit: w.commit.slice(0, 7) });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );
}

function jstDate(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}


/** レシピの頭（使うスキルと固定した版）を全部読む（v1.116.0：skills__save のあとに使っているレシピを並べるため） */
async function readRecipeHeads(env: Env): Promise<Array<{ name: string; title: string | null; uses: Array<{ skill: string; version: string | null }> }>> {
  const tree = await gh(env, `/git/trees/${SKILLS_BRANCH}?recursive=1`);
  if (!tree.ok) return [];
  const names = recipeFolders(tree.body.tree || []);
  const rows = await Promise.all(names.map(async (n) => {
    const f = await gh(env, `/contents/recipes/${encodeURIComponent(n)}/RECIPE.md?ref=${SKILLS_BRANCH}`, true);
    const r = f.ok ? parseRecipeHead(String(f.body), n) : null;
    return r ? { name: r.name, title: r.title ?? null, uses: r.uses.map((u) => ({ skill: u.skill, version: u.version ?? null })) } : null;
  }));
  return rows.filter((x): x is NonNullable<typeof x> => !!x);
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

/**
 * スキルのアイコンと agents/openai.yaml を書く（v1.112.0）。glyph を渡せばその絵で、無ければ今の icon.svg の絵を
 * 今のジャンルの色で作り直す（ジャンルを変えたときに色が付いていくため）。中身が同じなら書かない
 */
export async function writeSkillIcon(env: Env, name: string, meta: SkillMeta, glyph: string | null, hasIcon: boolean): Promise<string | null> {
  let g = glyph;
  if (!g && hasIcon) {
    const f = await gh(env, `/contents/skills/${encodeURIComponent(name)}/assets/icon.svg?ref=${SKILLS_BRANCH}`, true);
    g = f.ok ? glyphFromSvg(String(f.body)) : null;
  }
  const notes: string[] = [];
  if (g && meta.genre) {
    for (const [path, svg] of [["icon.svg", skillIconSvg(meta.genre, g)], ["icon-small.svg", skillIconSvg(meta.genre, g, true, 32)]] as const) {
      const r = await writeSkillsFile(env, `skills/${name}/assets/${path}`, () => svg + "\n", () => `スキルのアイコン：${name}`, true);
      if (!r.ok) notes.push(`${path} を書けなかった（${r.message}）`);
    }
  }
  if (meta.title && meta.purpose && meta.genre) {
    const r = await writeSkillsFile(env, `skills/${name}/agents/openai.yaml`, () => openaiYaml({ title: meta.title!, purpose: meta.purpose!, genre: meta.genre! }), () => `スキルの見た目（ChatGPT）：${name}`, true);
    if (!r.ok) notes.push(`agents/openai.yaml を書けなかった（${r.message}）`);
  }
  return notes.length ? notes.join("／") : null;
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
