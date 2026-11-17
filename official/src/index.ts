/**
 * shia2n-mcp-official（外向けの MCP の窓口）
 *
 * 2026-11-17 新設（開発部・統括の依頼・Naoki OK 15:25）。
 * 生徒・ゲストの AI に見える道具を、その人の権利で使える道具だけにする窓口。
 * Naoki 用の窓口（shia2n-mcp）とは別の Worker・別の札の置き場（OAUTH_KV）なので、
 * ここで発行した札は shia2n-mcp には通らない。Naoki 用の道具のプログラムもここには無い。
 *
 *   /mcp        MCP の本体（このページの同意画面でつないだ札が要る。合言葉で通る裏口は置かない）
 *   /authorize  つなぐ画面（Google ログイン → 門番で会員と権利を確かめる）
 *
 * 人と権利は shia2n-mcp の OfficialGate（サービスの結び）で読む。この Worker には鍵を置かない。
 */

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp";
import { createAuthHandler } from "./auth.js";
import { buildServer, type GateBinding } from "./server.js";
import { canConnect } from "./rights.js";

export interface Env {
  OAUTH_KV: KVNamespace;
  GATE: GateBinding;
  MCP_ALLOWED_REDIRECT_HOSTS?: string;
}

const json = (v: unknown, status: number) => Response.json(v, { status });

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const memberId = String((ctx as unknown as { props?: { memberId?: unknown } }).props?.memberId ?? "");
    if (!memberId) return json({ error: "つないだ人が分かりません。つなぎ直してください" }, 401);
    let rights: Awaited<ReturnType<GateBinding["rights"]>>;
    try { rights = await env.GATE.rights(memberId); } catch { rights = { ok: false, reason: "lookup_failed" }; }
    if (!rights.ok) return json({ error: "いま権利を確かめられませんでした", reason: rights.reason }, 503);
    if (!canConnect(rights.targets)) return json({ error: "いまの会員の権利では、AI の窓口は使えません" }, 403);
    return createMcpHandler(buildServer(env.GATE, memberId, rights), { route: "/mcp" })(request, env, ctx);
  },
};

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: apiHandler as never,
  defaultHandler: createAuthHandler() as never,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
