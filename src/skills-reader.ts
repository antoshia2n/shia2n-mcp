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
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./index.js";
import { SKILLS_PUBLIC_BRANCH, SKILLS_REPO } from "./skills-core.js";
import { audienceOpen, buildZip, studentAudience, type ZipEntry } from "./skills-zip.js";
import { readAll } from "./tools-skills.js";

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
}
