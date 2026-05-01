/**
 * shia2n-mcp エントリーポイント v0.8.0
 *
 * 認証方式：
 *   - OAuth 2.1（@cloudflare/workers-oauth-provider）→ Claude.ai UI から接続
 *   - Bearer token（resolveExternalToken）→ Anthropic API / MCP Inspector からの後方互換
 *
 * ツール実装（src/tools-*.ts）は v0.6.0 から無修正。
 * v0.8.0 追加：GET /taskmaster/tasks（Firestore 直接読み取り・Firebase REST API 方式）
 */
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { registerHighShinTools } from "./tools.js";
import { registerHighShinPhase3Tools } from "./tools-high-shin-phase3.js";
import { registerZeusTools } from "./tools-zeus.js";
import { registerZeusV2Tools } from "./tools-zeus-v2.js";
import { registerFormKunTools } from "./tools-form-kun.js";
import { registerPayKunTools } from "./tools-pay-kun.js";
import { AuthHandler } from "./auth-handler.js";
import { handleTaskmasterTasks } from "./taskmaster.js";

export interface Env {
  // Core
  MCP_SERVER_SECRET: string;       // Bearer token（後方互換用）
  MCP_DEFAULT_USER_ID: string;     // Naoki の Firebase UID
  // OAuth トークンストレージ（@cloudflare/workers-oauth-provider が OAUTH_KV という名前で使う）
  OAUTH_KV: KVNamespace;
  // High-Shinくん
  HIGH_SHIN_API_BASE: string;
  HIGH_SHIN_INTERNAL_SECRET: string;
  // Zeus（ナレッジハブ）
  ZEUS_API_BASE: string;
  ZEUS_INTERNAL_SECRET: string;    // v1-compat 移行後は不要予定（設定は残す）
  ZEUS_EXTERNAL_SECRET: string;    // Zeus v2 外部 API 用
  // Form-kun
  FORM_KUN_API_BASE: string;
  FORM_KUN_INTERNAL_SECRET: string;
  // Pay-kun
  PAY_KUN_API_BASE: string;
  PAY_KUN_INTERNAL_SECRET: string;
  // TaskMaster（Firestore 読み取り用）
  FIREBASE_SA_EMAIL: string;       // Service Account メールアドレス
  FIREBASE_SA_PRIVATE_KEY: string; // Service Account 秘密鍵（PEM。改行は \n で保存）
  NAOKI_UID: string;               // Naoki の Firebase Auth UID
}

function createMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "shia2n-mcp", version: "0.8.0" });
  registerHighShinTools(server, env);
  registerHighShinPhase3Tools(server, env);
  registerZeusTools(server, env);
  registerZeusV2Tools(server, env);
  registerFormKunTools(server, env);
  registerPayKunTools(server, env);
  return server;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// OAuthProvider から /mcp リクエストが届くときに呼ばれるハンドラー。
// OAuth トークン検証は OAuthProvider が済ませているため、ここでは認証チェック不要。
const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const server = createMcpServer(env);
    return createMcpHandler(server, { route: "/mcp" })(request, env, ctx);
  },
};

// OAuthProvider を変数に保持し、後段で fetch を委譲する。
// export default を { fetch } オブジェクトに変えることで
// /taskmaster/tasks を先に横取りできる。
const oauthProvider = new OAuthProvider({
  // /mcp への OAuth 認証済みリクエストを mcpApiHandler に渡す
  apiRoute:   "/mcp",
  apiHandler: mcpApiHandler,
  // /mcp 以外のリクエスト（/authorize・/health 等）を AuthHandler に渡す
  defaultHandler: AuthHandler,
  // OAuth 2.1 エンドポイント設定
  // /token・/register は OAuthProvider が自動実装（DCR 含む）
  authorizeEndpoint:          "/authorize",
  tokenEndpoint:              "/token",
  clientRegistrationEndpoint: "/register",
  // 後方互換：Bearer token（MCP_SERVER_SECRET）による認証を継続サポート。
  // Anthropic API の mcp_servers 経由・MCP Inspector からの接続で使う。
  resolveExternalToken: async ({ token, env: rawEnv }) => {
    const env = rawEnv as Env;
    if (!env.MCP_SERVER_SECRET) return null;
    if (!timingSafeEqual(token, env.MCP_SERVER_SECRET)) return null;
    return {
      userId: env.MCP_DEFAULT_USER_ID,
      props:  { userId: env.MCP_DEFAULT_USER_ID },
    };
  },
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS プリフライト（/taskmaster/tasks 向け）
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
        },
      });
    }

    // ── TaskMaster エンドポイント（Bearer token 認証） ──────────────────────
    if (url.pathname === "/taskmaster/tasks" && request.method === "GET") {
      const authHeader = request.headers.get("Authorization") ?? "";
      if (
        !authHeader.startsWith("Bearer ") ||
        !timingSafeEqual(authHeader.slice(7), env.MCP_SERVER_SECRET)
      ) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      return handleTaskmasterTasks(request, env);
    }

    // ── それ以外はすべて OAuthProvider に委譲 ──────────────────────────────
    return oauthProvider.fetch(request, env, ctx);
  },
};
