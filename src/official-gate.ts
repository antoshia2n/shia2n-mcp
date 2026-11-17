/**
 * 外向けの窓口（shia2n-mcp-official）が、つないだ人とその権利を確かめ、本人の番号で道具を呼ぶ口。
 *
 * v1.121.0（2026-11-17 開発部・Naoki OK 15:25）：login と rights の 2 つで新設。
 * v1.122.0（2026-11-17 開発部・統括の依頼）：本人の番号で道具を呼ぶ口（tools・run）を足し、X攻略くんの 8 本を通す。
 *
 * 外（インターネット）からは呼べない。同じ Cloudflare のアカウントの Worker が
 * 「サービスの結び（Service Binding）」で名前 OfficialGate を指したときだけ呼べる（SkillsReader と同じ形）。
 * Supabase の管理者の鍵は shia2n-mcp にだけ置き、外向けの窓口には渡さない。
 *
 *   ・login(idToken)：つなぐ画面で取った Google ログインの札を、門番（/gate/resolve と同じ中身）で確かめ、member の番号を返す
 *   ・rights(memberId)：その人のいまの権利（期限切れは外す）と、権利 × 開くもの（member_access）の開くものを返す
 *   ・tools(names)：外へ出してよい道具（OFFICIAL_GATE_TOOLS）のうち、渡した名前の説明文と引数の形を返す
 *   ・run(memberId, name, args)：ここでも権利を取り直し、その道具が開いている人なら、本人の番号（member.auth_uid）で道具を動かす
 *
 * 返すのは番号と権利の名前と開くものの名前と道具の結果だけ。名前・メールは返さない。
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./index.js";
import { handleGateResolve } from "./gate.js";
import { registerXbunsekiTools } from "./tools-xbunseki.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[a-z0-9_]{2,60}$/;
export const CONNECT_TARGET = "mcp_official";
export const TOOL_TARGET_PREFIX = "mcp-";

/**
 * 外へ出してよい道具の名簿（shia2n-mcp の側の鍵）。ここにある道具は、本人の番号で絞って動く形にしてあるものだけ。
 * Naoki の番号に決め打ちの道具は、ここへ入れない。
 */
export const OFFICIAL_GATE_TOOLS: readonly string[] = [
  "xbunseki__list_weeks", "xbunseki__get_week", "xbunseki__get_account", "xbunseki__get_strategy",
  "xbunseki__get_moves", "xbunseki__put_metrics", "xbunseki__get_stock", "xbunseki__put_stock",
];

type Row = Record<string, unknown>;
type Handler = (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>;
interface Captured { name: string; description: string; shape: z.ZodRawShape; cb: Handler }

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

/** 道具の登録を横取りして、名前・説明文・引数の形・中身を集める（本物の窓口には登録しない） */
export function captureTools(env: Env, uidOf: () => Promise<string>): Map<string, Captured> {
  const got = new Map<string, Captured>();
  const fake = {
    tool: (name: string, description: string, shape: z.ZodRawShape, cb: Handler) => {
      if (OFFICIAL_GATE_TOOLS.includes(name)) got.set(name, { name, description, shape, cb });
    },
  };
  registerXbunsekiTools(fake as unknown as McpServer, env, uidOf);
  return got;
}

export interface OfficialToolInfo { name: string; description: string; inputSchema: Record<string, unknown> }

/** 渡した名前のうち名簿にあるものの、説明文と引数の形（JSON Schema） */
export function describeTools(env: Env, names: readonly string[]): OfficialToolInfo[] {
  const got = captureTools(env, async () => { throw new Error("説明を返すだけ"); });
  return names.filter((n) => got.has(n)).map((n) => {
    const t = got.get(n)!;
    const schema = z.toJSONSchema(z.object(t.shape)) as Record<string, unknown>;
    delete schema.$schema;
    return { name: n, description: t.description, inputSchema: schema };
  });
}

export type RunResult = { ok: true; result: { content: unknown[]; isError?: boolean } } | { ok: false; reason: string };

/** 権利を取り直し、開いている人なら本人の番号で道具を動かす */
export async function runTool(env: Env, memberId: string, name: string, args: unknown): Promise<RunResult> {
  if (!OFFICIAL_GATE_TOOLS.includes(name)) return { ok: false, reason: "not_official" };
  const r = await readRights(env, memberId);
  if (!r.ok) return { ok: false, reason: r.reason };
  if (!r.targets.includes(CONNECT_TARGET) || !r.targets.includes(TOOL_TARGET_PREFIX + name)) return { ok: false, reason: "no_right" };
  let uid = "";
  try {
    const rows = await sbGet(env, `/member?select=auth_uid&id=eq.${encodeURIComponent(r.member_id)}&limit=1`);
    uid = String(rows[0]?.auth_uid ?? "");
  } catch {
    return { ok: false, reason: "lookup_failed" };
  }
  if (!uid) return { ok: false, reason: "no_login" };
  const tool = captureTools(env, async () => uid).get(name);
  if (!tool) return { ok: false, reason: "not_official" };
  const parsed = z.object(tool.shape).safeParse(args ?? {});
  if (!parsed.success) return { ok: true, result: { content: [{ type: "text", text: JSON.stringify({ ok: false, message: "引数の形が違います", 詳しく: parsed.error.issues.map((i) => i.message) }) }], isError: true } };
  return { ok: true, result: await tool.cb(parsed.data as Record<string, unknown>) };
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
    return readRights(this.env, String(member?.id ?? ""));
  }

  /** いまの権利と開くもの（道具の一覧を作るたび・道具を使うたびに呼ばれる） */
  async rights(memberId: string): Promise<OfficialRights> {
    return readRights(this.env, memberId);
  }

  /** 名簿の道具の説明文と引数の形 */
  async tools(names: string[]): Promise<OfficialToolInfo[]> {
    return describeTools(this.env, Array.isArray(names) ? names.map(String) : []);
  }

  /** 本人の番号で道具を動かす（ここでも権利を確かめる） */
  async run(memberId: string, name: string, args: unknown): Promise<RunResult> {
    try {
      return await runTool(this.env, String(memberId || ""), String(name || ""), args);
    } catch {
      return { ok: false, reason: "failed" };
    }
  }
}
