/**
 * 外向けの窓口（shia2n-mcp-official）が、つないだ人とその権利を確かめる口（2026-11-17 v1.121.0 開発部・統括の依頼・Naoki OK 15:25）。
 *
 * 外（インターネット）からは呼べない。同じ Cloudflare のアカウントの Worker が
 * 「サービスの結び（Service Binding）」で名前 OfficialGate を指したときだけ呼べる（SkillsReader と同じ形）。
 * Supabase の管理者の鍵は shia2n-mcp にだけ置き、外向けの窓口には渡さない。
 *
 *   ・login(idToken)：つなぐ画面で取った Google ログインの札を、門番（/gate/resolve と同じ中身）で確かめ、member の番号を返す
 *   ・rights(memberId)：その人のいまの権利（期限切れは外す）と、権利 × 開くもの（member_access）の開くものを返す
 *
 * 返すのは番号と権利の名前と開くものの名前だけ。名前・メールは返さない。
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./index.js";
import { handleGateResolve } from "./gate.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[a-z0-9_]{2,60}$/;

type Row = Record<string, unknown>;

async function sbGet(env: Env, path: string): Promise<Row[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      ...(/^eyJ/.test(String(env.SUPABASE_SERVICE_ROLE_KEY || "")) ? { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase GET ${res.status}`);
  return (await res.json()) as Row[];
}

export type OfficialRights = { ok: true; member_id: string; keys: string[]; targets: string[] } | { ok: false; reason: string };

/** その人のいまの権利と開くもの。中身だけの関数（試験から呼ぶため WorkerEntrypoint の外に置く） */
export async function readRights(env: Env, memberId: string): Promise<OfficialRights> {
  const id = String(memberId || "");
  if (!UUID_RE.test(id)) return { ok: false, reason: "bad_member" };
  const nowIso = new Date().toISOString();
  try {
    const ents = await sbGet(
      env,
      `/member_entitlement?select=key&member_id=eq.${encodeURIComponent(id)}` +
        `&or=(expires_at.is.null,expires_at.gt.${encodeURIComponent(nowIso)})`,
    );
    const keys = [...new Set(ents.map((e) => String(e.key)))].filter((k) => KEY_RE.test(k)).sort();
    if (!keys.length) return { ok: true, member_id: id, keys, targets: [] };
    const rows = await sbGet(env, `/member_access?select=target&entitlement_key=in.(${keys.join(",")})`);
    const targets = [...new Set(rows.map((r) => String(r.target)))].sort();
    return { ok: true, member_id: id, keys, targets };
  } catch {
    return { ok: false, reason: "lookup_failed" };
  }
}

export class OfficialGate extends WorkerEntrypoint<Env> {
  /** Google ログインの札を門番で確かめる。通れば member の番号と、いまの権利を返す */
  async login(idToken: string): Promise<OfficialRights> {
    const token = String(idToken || "");
    if (!token) return { ok: false, reason: "no_token" };
    const req = new Request("https://internal/gate/resolve", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-App": "mcp-official" },
    });
    let body: Row;
    try {
      body = (await (await handleGateResolve(req, this.env)).json()) as Row;
    } catch {
      return { ok: false, reason: "lookup_failed" };
    }
    if (body.ok !== true) return { ok: false, reason: String(body.reason ?? "denied") };
    const member = body.member as Row | undefined;
    const memberId = String(member?.id ?? "");
    return readRights(this.env, memberId);
  }

  /** いまの権利と開くもの（道具の一覧を作るたび・道具を使うたびに呼ばれる） */
  async rights(memberId: string): Promise<OfficialRights> {
    return readRights(this.env, memberId);
  }
}
