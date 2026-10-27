import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";

/**
 * shia2n-mcp につながっている先の一覧と、1 本の取り消し（2026-10-27 v1.54.0 開発部）。命名規約：mcp_auth__<action>
 *
 * 背景：v1.54.0 より前は、住所を知っている人なら誰でも「許可する」を押して Naoki として道具を使えた。
 *   その間に他人がつないでいても、発行済みの許可は v1.54.0 のあとも生きている。
 *   どれが Naoki 本人のつなぎかを見分けるための一覧と、見覚えのないものだけを 1 本ずつ切る道具。
 *
 *   ・mcp_auth__connections：読むだけ。許可ごとに、つなぎ先の名乗り・戻り先の住所・つないだ日時（日本時間）・
 *     v1.54.0 のログインを通ったか（login_checked）を返す。札そのものは返さない
 *   ・mcp_auth__revoke：許可 1 本を取り消す。confirm: true が無ければ下見だけ。
 *     いま使っているつなぎを切ると、その Claude はつなぎ直し（Google のログイン）が要る
 */

type Grant = { id: string; clientId: string; createdAt: number; metadata?: any; scope?: string[] };
type Provider = {
  listUserGrants(userId: string, options?: { limit?: number; cursor?: string }): Promise<{ items: Grant[]; cursor?: string }>;
  revokeGrant(grantId: string, userId: string): Promise<void>;
  lookupClient(clientId: string): Promise<{ clientName?: string; redirectUris: string[]; registrationDate?: number } | null>;
};

const jst = (sec: number) => {
  const ms = sec > 1e12 ? sec : sec * 1000;
  return new Date(ms + 9 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16) + "（日本時間）";
};
const hosts = (uris: string[]) => [...new Set(uris.map(u => { try { return new URL(u).host; } catch { return u; } }))];

export async function listConnections(provider: Provider, userId: string) {
  const out: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await provider.listUserGrants(userId, { limit: 100, ...(cursor ? { cursor } : {}) });
    for (const g of res.items) {
      let client: Awaited<ReturnType<Provider["lookupClient"]>> = null;
      try { client = await provider.lookupClient(g.clientId); } catch { client = null; }
      out.push({
        grant_id: g.id,
        つなぎ先の名乗り: client?.clientName ?? "（名乗りなし）",
        戻り先: client ? hosts(client.redirectUris) : ["（つなぎ先の登録が消えている）"],
        つないだ日時: jst(g.createdAt),
        login_checked: g.metadata?.login === "firebase",
      });
    }
    cursor = res.cursor;
    if (!cursor) break;
  }
  out.sort((a, b) => String(a.つないだ日時).localeCompare(String(b.つないだ日時)));
  return out;
}

export function registerMcpAuthTools(server: McpServer, env: Env): void {
  const provider = () => (env as unknown as { OAUTH_PROVIDER?: Provider }).OAUTH_PROVIDER;

  server.tool(
    "mcp_auth__connections",
    "shia2n-mcp につながっている先（許可）の一覧を返す。読むだけ。許可ごとに grant_id・つなぎ先の名乗り・戻り先の住所・つないだ日時（日本時間）・login_checked（v1.54.0 の Google のログインを通ってつないだか。false は直す前のつなぎで、他人の可能性がある）。札そのものは返さない。戻り値: { ok, 件数, 直す前のつなぎ, 一覧 }／失敗 { ok: false, message }。",
    {},
    async () => {
      try {
        const p = provider();
        if (!p) return asMcpTextResult({ ok: false, message: "許可の仕組みに届きません（OAUTH_PROVIDER が無い）" });
        const list = await listConnections(p, env.MCP_DEFAULT_USER_ID);
        return asMcpTextResult({ ok: true, 件数: list.length, 直す前のつなぎ: list.filter(x => !x.login_checked).length, 一覧: list });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  server.tool(
    "mcp_auth__revoke",
    "shia2n-mcp への許可を 1 本取り消す。grant_id は mcp_auth__connections の値をそのまま使う。confirm: true が無ければ下見だけ（何を切るかを返す）。切った許可の Claude（や GPT）は、つなぎ直し（Google のログイン）が要る。Naoki が見覚えのないつなぎだと言ったものだけに使う。戻り値: 下見 { ok, mode: 'preview', 対象 }／実行 { ok, mode: 'revoked', 対象 }／失敗 { ok: false, message }。",
    {
      grant_id: z.string().min(1).max(200).describe("取り消す許可の grant_id"),
      confirm: z.boolean().optional().describe("true で実行。省略か false なら下見だけ"),
    },
    async ({ grant_id, confirm }) => {
      try {
        const p = provider();
        if (!p) return asMcpTextResult({ ok: false, message: "許可の仕組みに届きません（OAUTH_PROVIDER が無い）" });
        const list = await listConnections(p, env.MCP_DEFAULT_USER_ID);
        const target = list.find(x => x.grant_id === grant_id);
        if (!target) return asMcpTextResult({ ok: false, message: "その grant_id の許可は見つかりません（mcp_auth__connections で取り直してください）" });
        if (!confirm) return asMcpTextResult({ ok: true, mode: "preview", 対象: target });
        await p.revokeGrant(grant_id, env.MCP_DEFAULT_USER_ID);
        return asMcpTextResult({ ok: true, mode: "revoked", 対象: target });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );
}
