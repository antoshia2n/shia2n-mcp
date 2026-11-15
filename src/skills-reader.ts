/**
 * マーケくん（utage-alt-demo）が、生徒に出しているスキルを読む口（2026-11-15 v1.103.0 開発部・スキルズの管理 3便目）。
 *
 * 外（インターネット）からは呼べない。同じ Cloudflare のアカウントの Worker が
 * 「サービスの結び（Service Binding）」で名前 SkillsReader を指したときだけ呼べる（TaskmasterReader と同じ形）。
 * GitHub の鍵（GITHUB_READ_TOKEN）は shia2n-mcp にだけ置き、マーケくんには渡さない。
 *
 * 読むのは public の枝（生徒に出す版）だけ。main（最新版・自分用）は読まない。
 *   ・list(keys)：その人に見せてよいスキルの並び（keys＝その人の権利のキー。null はシアニン＝全部）
 *   ・zip(name, keys)：1 本を claude.ai に上げられる zip にして返す（フォルダ 1 つ・中に SKILL.md）
 *
 * v1.107.0（2026-11-16 開発部・スキルの棚の便 1・Naoki OK 00:36）：シアニン用の管理画面「スキル」の棚の口。
 * マーケくんは管理者（シアニン）の画面からだけ呼ぶ。正本は GitHub のまま、ここは読んで見せる・書き足す口（第 2 の正本にしない）。
 *   ・shelf()：スキル（main の全部と生徒の版）・レシピ・仮説を 1 回で
 *   ・saveRecipe(input, by)：レシピの組み合わせ・強さ・何に使うかを書き、版を 1 つ上げる（新規も）
 *   ・addHypothesis(input)／updateHypothesis(input)：仮説（hypotheses__add・hypotheses__update と同じ書き方）
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./index.js";
import { SKILLS_PUBLIC_BRANCH, SKILLS_REPO } from "./skills-core.js";
import { audienceOpen, buildZip, studentAudience, type ZipEntry } from "./skills-zip.js";
import { gh, readAll, writeHypotheses, writeSkillsFile } from "./tools-skills.js";
import { SKILLS_BRANCH, parseRecipeHead, recipeFolders } from "./skills-core.js";
import { BASE_LATEST, STRENGTHS, writeRecipeText, type RecipeSaveInput } from "./recipe-write-core.js";
import { HYPOTHESIS_STATUSES, addHypothesis, hypothesisSections, updateHypothesis, type HypothesisStatus } from "./hypothesis-core.js";

const HYPO_SKILL = "shia2n-x-review";
const jstDate = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

const MAX_BYTES = 5 * 1024 * 1024;

const cleanKeys = (keys: unknown): string[] | null =>
  keys === null ? null : Array.isArray(keys) ? keys.map((k) => String(k)).filter((k) => /^[a-z0-9_]{2,40}$/.test(k)).slice(0, 30) : [];

export class SkillsReader extends WorkerEntrypoint<Env> {
  async list(keys: string[] | null): Promise<object> {
    const k = cleanKeys(keys);
    const all = await readAll(this.env, SKILLS_PUBLIC_BRANCH);
    if (!all.ok) return { ok: false, error: all.message };
    const rows = all.skills
      .filter((s) => studentAudience(s.audience).length && audienceOpen(studentAudience(s.audience), k))
      .map((s) => ({ name: s.name, purpose: s.purpose, version: s.public_version || s.version, updated: s.updated, where: s.where, description: s.description.slice(0, 200), files: s.files.length }));
    return { ok: true, commit: all.commit, skills: rows };
  }

  async zip(name: string, keys: string[] | null): Promise<object> {
    const folder = String(name || "").trim();
    if (!/^[a-z0-9][a-z0-9_-]{1,79}$/i.test(folder)) return { ok: false, error: "bad_name" };
    const k = cleanKeys(keys);
    const all = await readAll(this.env, SKILLS_PUBLIC_BRANCH);
    if (!all.ok) return { ok: false, error: all.message };
    const s = all.skills.find((x) => x.folder === folder);
    if (!s || !studentAudience(s.audience).length || !audienceOpen(studentAudience(s.audience), k)) return { ok: false, error: "not_found" };
    const key = this.env.GITHUB_READ_TOKEN || this.env.GITHUB_TOKEN;
    const entries: ZipEntry[] = [];
    let total = 0;
    for (const f of s.files) {
      const r = await fetch(`https://api.github.com/repos/${SKILLS_REPO}/contents/skills/${encodeURIComponent(folder)}/${f.split("/").map(encodeURIComponent).join("/")}?ref=${SKILLS_PUBLIC_BRANCH}`, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/vnd.github.raw+json", "User-Agent": "shia2n-mcp" },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) return { ok: false, error: `read_failed:${f}` };
      const bytes = new Uint8Array(await r.arrayBuffer());
      total += bytes.length;
      if (total > MAX_BYTES) return { ok: false, error: "too_large" };
      entries.push({ path: f, bytes });
    }
    const version = s.public_version || s.version || "0";
    return { ok: true, filename: `${folder}-${version}.zip`, version, bytes: buildZip(folder, entries) };
  }

  async shelf(): Promise<object> {
    const [all, pub, tree, hyp] = await Promise.all([
      readAll(this.env, SKILLS_BRANCH),
      readAll(this.env, SKILLS_PUBLIC_BRANCH),
      gh(this.env, `/git/trees/${SKILLS_BRANCH}?recursive=1`),
      gh(this.env, `/contents/skills/${HYPO_SKILL}/references/hypotheses.md?ref=${SKILLS_BRANCH}`, true),
    ]);
    if (!all.ok) return { ok: false, error: all.message };
    const pubVer = new Map(pub.ok ? pub.skills.map((s) => [s.folder, s.public_version || s.version]) : []);
    const skills = all.skills.map((s) => ({
      name: s.folder, purpose: s.purpose, version: s.version, student_version: pubVer.get(s.folder) || null, where: s.where, audience: s.audience,
      owner: s.owner, updated: s.updated, description: s.description.slice(0, 300), files: s.files.length, missing: s.missing, latest_ok: (BASE_LATEST as readonly string[]).includes(s.folder),
    }));
    const recipes = tree.ok ? await Promise.all(recipeFolders(tree.body.tree || []).map(async (n) => {
      const f = await gh(this.env, `/contents/recipes/${encodeURIComponent(n)}/RECIPE.md?ref=${SKILLS_BRANCH}`, true);
      const r = f.ok ? parseRecipeHead(String(f.body), n) : null;
      return r ? { name: n, purpose: r.purpose, version: r.version, updated: r.updated, audience: r.audience, uses: r.uses.map((u) => ({ skill: u.skill, version: u.version, pinned: !!u.commit, commit: u.commit ? u.commit.slice(0, 7) : null, priority: u.priority, strength: u.strength })), bad: r.bad }
        : { name: n, broken: true };
    })) : [];
    const hypotheses = hyp.ok ? hypothesisSections(String(hyp.body)).map((h) => ({ id: `H${h.id}`, title: h.title, status: h.status, body: h.body.slice(0, 4000) })) : [];
    return {
      ok: true, commit: all.commit, repo: `https://github.com/${SKILLS_REPO}`, skills, recipes, hypotheses, hypotheses_skill: HYPO_SKILL,
      statuses: HYPOTHESIS_STATUSES, strengths: STRENGTHS, base_latest: BASE_LATEST, ...(all.broken.length ? { broken: all.broken } : {}),
      ...(pub.ok ? {} : { student_error: pub.message }), ...(hyp.ok ? {} : { hypotheses_error: hyp.message }),
    };
  }

  async saveRecipe(input: RecipeSaveInput & { create?: boolean }, by: string): Promise<object> {
    const name = String(input?.name || "").trim();
    if (!/^[a-z0-9][a-z0-9_-]{1,79}$/i.test(name)) return { ok: false, error: "bad_name" };
    const [all, c] = await Promise.all([readAll(this.env, SKILLS_BRANCH), gh(this.env, `/commits/${SKILLS_BRANCH}`)]);
    if (!all.ok) return { ok: false, error: all.message };
    if (!c.ok) return { ok: false, error: c.message };
    const skills = new Map(all.skills.map((s) => [s.folder, s.version]));
    const head = String(c.body.sha || "");
    let fail = "", version = "";
    const w = await writeSkillsFile(this.env, `recipes/${name}/RECIPE.md`, (text) => {
      if (text === null && !input.create) { fail = "not_found"; return null; }
      if (text !== null && input.create) { fail = "already"; return null; }
      const cur = new Map((text ? parseRecipeHead(text, name)?.uses || [] : []).map((u) => [u.skill, { version: u.version, commit: u.commit }]));
      const r = writeRecipeText(text, input, { skills, current: cur, head, date: jstDate() });
      if (!r.ok) { fail = r.error; return null; }
      version = r.version;
      return r.text;
    }, () => `${input.create ? "レシピを作る" : "レシピを直す"}：${name} ${version}（棚・${String(by || "").slice(0, 60)}）`, !!input.create);
    if (fail) return { ok: false, error: fail };
    if (!w.ok) return { ok: false, error: w.message };
    return { ok: true, name, version, commit: w.commit.slice(0, 7) };
  }

  async addHypothesis(input: { title: string; words: string; target?: string }): Promise<object> {
    const title = String(input?.title || "").trim().slice(0, 80), words = String(input?.words || "").trim().slice(0, 2000);
    if (!title || !words) return { ok: false, error: "need_title_words" };
    const target = input.target ? String(input.target).trim().slice(0, 200) : undefined;
    let id = 0;
    const r = await writeHypotheses(this.env, HYPO_SKILL, (md) => { const a = addHypothesis(md, { title, words, target, date: jstDate() }); id = a.id; return a.md; }, () => `仮説を足す：H${id} ${title}（棚）`);
    return r.ok ? { ok: true, id: `H${id}`, commit: r.commit.slice(0, 7) } : { ok: false, error: r.message };
  }

  async updateHypothesis(input: { id: string; status?: string; note?: string }): Promise<object> {
    const n = Number(String(input?.id || "").replace(/^H/i, ""));
    if (!Number.isInteger(n) || n < 1) return { ok: false, error: "bad_id" };
    const status = input.status && (HYPOTHESIS_STATUSES as readonly string[]).includes(input.status) ? (input.status as HypothesisStatus) : undefined;
    const note = input.note ? String(input.note).trim().slice(0, 2000) : undefined;
    if (!status && !note) return { ok: false, error: "need_status_or_note" };
    let miss = false;
    const r = await writeHypotheses(this.env, HYPO_SKILL, (md) => { const o = updateHypothesis(md, { id: n, date: jstDate(), status, note }); if (o === null) { miss = true; return md; } return o; },
      () => `仮説を直す：H${n}${status ? ` ${status}` : ""}${note ? " 追記" : ""}（棚）`);
    if (miss) return { ok: false, error: "not_found" };
    return r.ok ? { ok: true, id: `H${n}`, commit: r.commit.slice(0, 7) } : { ok: false, error: r.message };
  }
}
