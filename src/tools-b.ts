/**
 * shia2n-mcp / src/tools-b.ts / 初版（2026-10-08 開発部・UTAGE の代わり B の便 3）
 *
 * UTAGE の代わり（B・utage-alt-demo）の AI の入口を、shia2n-mcp の窓口から 1 つで呼べるようにする。
 * 中身は B の /mcp（JSON-RPC）へそのまま渡すだけ。権限（自動・承認・禁止）と承認待ちは B の側で決まる。
 * 承認が要る道具を呼ぶと、B は実行せずに approval_url を返す。Naoki がその画面で「承認して実行」を押すまで動かない。
 * 合言葉 B_MCP_SECRET は B の Cloudflare の MCP_SECRET と同じ値（秘密の値。wrangler.jsonc には書かない）。
 * 命名規約：`b__<action>`
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";

const DEFAULT_B_MCP_URL = "https://utage-alt-demo.gameister1.workers.dev/mcp";

async function callB(env: Env, method: string, params: Record<string, unknown>): Promise<unknown> {
  const url = (env.B_MCP_URL ?? DEFAULT_B_MCP_URL).replace(/[/]+$/, "");
  const secret = env.B_MCP_SECRET ?? "";
  if (!secret) return { ok: false, message: "合言葉が設定されていません（B_MCP_SECRET）。B の MCP_SECRET と同じ値を shia2n-mcp の Secret に入れると使えます。" };
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return { ok: false, message: "B につながりませんでした。" };
  }
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { return { ok: false, status: res.status, raw: text.slice(0, 300) }; }
  if (!res.ok || body.error) return { ok: false, status: res.status, error: body.error ?? body };
  return body.result;
}

export function registerBTools(server: McpServer, env: Env): void {
  server.tool(
    "b__tools",
    "UTAGE の代わり（B）で使える道具の一覧と、それぞれの説明・引数を返す。b__call を呼ぶ前に見る。権限（自動・承認・禁止）は b__call で list_permissions を呼ぶと分かる。",
    {},
    async () => {
      const r: any = await callB(env, "tools/list", {});
      if (r && Array.isArray(r.tools)) {
        return asMcpTextResult({ ok: true, count: r.tools.length, tools: r.tools.map((t: any) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      }
      return asMcpTextResult(r);
    }
  );

  server.tool(
    "b__call",
    "UTAGE の代わり（B）の道具を 1 つ呼ぶ。tool に道具の名前（b__tools で見る）、arguments に引数を入れる。承認が要る道具は実行されずに pending_approval と approval_url が返るので、その URL を Naoki に渡して待つ。禁止の道具は denied_by_permission が返る。戻り値は B の道具の返事そのまま。",
    {
      tool: z.string().regex(/^[a-z_]{2,40}$/).describe("B の道具の名前（例 find_person・list_approvals）"),
      arguments: z.record(z.string(), z.unknown()).optional().describe("道具の引数。省略時は空"),
    },
    async ({ tool, arguments: args }) => {
      const r: any = await callB(env, "tools/call", { name: tool, arguments: args ?? {} });
      const text = r && Array.isArray(r.content) && r.content[0] && typeof r.content[0].text === "string" ? r.content[0].text : null;
      if (text !== null) {
        try { return asMcpTextResult(JSON.parse(text)); } catch { return asMcpTextResult({ ok: !r.isError, text }); }
      }
      return asMcpTextResult(r);
    }
  );
}
