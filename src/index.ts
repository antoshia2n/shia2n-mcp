import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerHighShinTools } from "./tools.js";

/**
 * Cloudflare Workers の環境変数（Secrets）。
 * Cloudflare Dashboard > Workers > shia2n-mcp > Settings > Variables で設定。
 */
export interface Env {
  /** Claude/Anthropic API からこのMCPサーバーに接続する際の Bearer token */
  MCP_SERVER_SECRET: string;
  /** NaokiのFirebase UID。High-Shinの内部APIに user_id として渡される */
  MCP_DEFAULT_USER_ID: string;
  /** High-Shinくん本体のURL。例: https://high-shin.pages.dev */
  HIGH_SHIN_API_BASE: string;
  /** High-Shinくん本体の /api/internal/* への共有シークレット */
  HIGH_SHIN_INTERNAL_SECRET: string;
}

/**
 * リクエストごとに新しい McpServer インスタンスを作る。
 * MCP SDK 1.26.0+ ではグローバルスコープでの共有が禁止されている（CVE対応）。
 */
function createServer(env: Env): McpServer {
  const server = new McpServer({
    name: "shia2n-mcp",
    version: "0.1.0",
  });
  registerHighShinTools(server, env);
  return server;
}

/**
 * タイミング攻撃に耐性のある文字列比較。
 * Bearer token の検証に使用。
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Authorization: Bearer <token> を検証する。
 * env.MCP_SERVER_SECRET と一致すれば true。
 */
function authenticate(request: Request, env: Env): boolean {
  if (!env.MCP_SERVER_SECRET) return false;
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length).trim();
  return timingSafeEqual(token, env.MCP_SERVER_SECRET);
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // ヘルスチェック（非認証）。ブラウザで開いて動作確認できる。
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          name: "shia2n-mcp",
          version: "0.1.0",
          status: "ok",
          mcp_endpoint: "/mcp",
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // MCP エンドポイントは Bearer 認証必須
    if (url.pathname === "/mcp") {
      if (!authenticate(request, env)) {
        return new Response(
          JSON.stringify({ error: "Unauthorized" }),
          {
            status: 401,
            headers: {
              "Content-Type": "application/json",
              "WWW-Authenticate": "Bearer",
            },
          }
        );
      }
      // SDK 1.26.0+ 必須：リクエストごとに McpServer を作る
      const server = createServer(env);
      return createMcpHandler(server, { route: "/mcp" })(request, env, ctx);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
