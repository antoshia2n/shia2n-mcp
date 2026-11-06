/**
 * B（utage-alt-demo）の便 16a：UTAGE の読者を B が読む口 UtageReader（読むだけ）。
 *
 * 外（インターネット）からは呼べない。同じ Cloudflare のアカウントの Worker が
 * 「サービスの結び（Service Binding）」で名前 UtageReader を指したときだけ呼べる（TaskmasterReader と同じ形）。
 * UTAGE の REST の鍵は shia2n-mcp がすでに持っている UTAGE_API_KEY を使うので、B に鍵を増やさない。
 * B の wrangler.jsonc の services に
 *   { "binding": "UTAGE", "service": "shia2n-mcp", "entrypoint": "UtageReader" }
 * を書くと、B から env.UTAGE.accounts() と env.UTAGE.readers(accountId, page, perPage) で呼べる。
 *
 * 返すのは UTAGE の REST の返事そのまま（data と meta）。UTAGE には書かない。
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./index.js";
import { archiveDoc, archiveItem, archiveSearch, archiveStatus } from "./utage-archive.js";

const DEFAULT_UTAGE_API_BASE = "https://api.utage-system.com/v1";
const ID_RE = /^[A-Za-z0-9_-]{4,40}$/;

export class UtageReader extends WorkerEntrypoint<Env> {
  private async get(path: string, query: Record<string, string | number> = {}): Promise<object> {
    const key = this.env.UTAGE_API_KEY || this.env.UTAGE_MCP_TOKEN;
    if (!key) return { ok: false, error: "no_key" };
    const url = new URL(String(this.env.UTAGE_API_BASE || DEFAULT_UTAGE_API_BASE).replace(/\/$/, "") + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
    if (!res.ok) return { ok: false, error: `utage_${res.status}`, detail: (await res.text()).slice(0, 200) };
    return { ok: true, ...((await res.json()) as object) };
  }

  // 配信アカウントの一覧（data: [{ id, name, type, created_at }]）
  async accounts(): Promise<object> {
    return await this.get("/accounts");
  }

  // 1 アカウントの読者の 1 ページ（data と meta.total）。perPage は 1〜100
  async readers(accountId: string, page = 1, perPage = 100): Promise<object> {
    if (!ID_RE.test(String(accountId))) return { ok: false, error: "bad_account" };
    const p = Math.max(1, Math.floor(Number(page) || 1));
    const n = Math.min(100, Math.max(1, Math.floor(Number(perPage) || 100)));
    return await this.get(`/accounts/${encodeURIComponent(accountId)}/readers`, { per_page: n, page: p });
  }

  // v1.68.0（2026-11-06・UTAGE 解約の便 U1）：UTAGE の写しを読む（マーケくんの「UTAGE の写し」の棚から）。個人の情報は数だけ
  async archive_status(): Promise<object> {
    return await archiveStatus(this.env);
  }

  async archive_doc(doc: string, run?: string): Promise<object> {
    return await archiveDoc(this.env, String(doc ?? ""), run ? String(run) : undefined);
  }

  async archive_search(q: { words?: string; kind?: string; limit?: number; run?: string }): Promise<object> {
    return await archiveSearch(this.env, q ?? {});
  }

  async archive_item(ref: string, raw?: boolean, run?: string): Promise<object> {
    return await archiveItem(this.env, String(ref ?? ""), { raw: raw === true, run: run ? String(run) : undefined });
  }
}
