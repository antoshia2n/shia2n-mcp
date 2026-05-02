/**
 * shia2n-mcp エントリーポイント v0.10.0
 *
 * 認証方式：
 *   - OAuth 2.1（@cloudflare/workers-oauth-provider）→ Claude.ai UI から接続
 *   - Bearer token（resolveExternalToken）→ Anthropic API / MCP Inspector からの後方互換
 *
 * v0.8.0：GET /taskmaster/tasks・/taskmaster/diag 追加
 * v0.9.0：MCP ツール taskmaster__list_tasks 追加
 * v0.10.0：MCP ツール sales_manager__get_revenue_summary 追加
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
import { registerTaskmasterTools } from "./tools-taskmaster.js";
import { registerSalesManagerTools } from "./tools-sales-manager.js";
import { AuthHandler } from "./auth-handler.js";
import { handleTaskmasterTasks, handleTaskmasterDiag } from "./taskmaster.js";

export interface Env {
  // Core
  MCP_SERVER_SECRET: string;
  MCP_DEFAULT_USER_ID: string;
  // OAuth
  OAUTH_KV: KVNamespace;
  // High-Shinくん
  HIGH_SHIN_API_BASE: string;
  HIGH_SHIN_INTERNAL_SECRET: string;
  // Zeus
  ZEUS_API_BASE: string;
  ZEUS_INTERNAL_SECRET: string;
  ZEUS_EXTERNAL_SECRET: string;
  // Form-kun
  FORM_KUN_API_BASE: string;
  FORM_KUN_INTERNAL_SECRET: string;
  // Pay-kun
  PAY_KUN_API_BASE: string;
  PAY_KUN_INTERNAL_SECRET: string;
  // TaskMaster（Firestore 読み取り用）
  FIREBASE_SA_EMAIL: string;
  FIREBASE_SA_PRIVATE_KEY: string;
  NAOKI_UID: string;
  // Sales Manager
  SALES_MANAGER_API_BASE: string; // 既定 https://sales-manager.shia2n.jp
}

function createMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "shia2n-mcp", version: "0.10.0" });
  registerHighShinTools(server, env);
  registerHighShinPhase3Tools(server, env);
  registerZeusTools(server, env);
  registerZeusV2Tools(server, env);
  registerFormKunTools(server, env);
  registerPayKunTools(server, env);
  registerTaskmasterTools(server, env);
  registerSalesManagerTools(server, env);
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

const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const server = createMcpServer(env);
    return createMcpHandler(server, { route: "/mcp" })(request, env, ctx);
  },
};

const oauthProvider = new OAuthProvider({
  apiRoute:   "/mcp",
  apiHandler: mcpApiHandler,
  defaultHandler: AuthHandler,
  authorizeEndpoint:          "/authorize",
  tokenEndpoint:              "/token",
  clientRegistrationEndpoint: "/register",
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

    // /taskmaster/diag は認証不要
    if (url.pathname === "/taskmaster/diag" && request.method === "GET") {
      return handleTaskmasterDiag(request, env);
    }

    // /taskmaster/tasks は Bearer 認証必須
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

    return oauthProvider.fetch(request, env, ctx);
  },
};
