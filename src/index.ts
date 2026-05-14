/**
 * shia2n-mcp エントリーポイント v0.23.0
 *
 * v0.8.0：GET /taskmaster/tasks・/taskmaster/diag 追加
 * v0.9.0：taskmaster__list_tasks 追加
 * v0.10.0：sales_manager__get_revenue_summary 追加
 * v0.11.0：slack_post_message 追加
 * v0.12.0：/taskmaster/diag に Bearer 認証追加
 * v0.13.0：POST /taskmaster/tasks・taskmaster__add_task 追加
 * v0.14.0：/diag 公開診断エンドポイント追加
 * v0.15.0：content_os__list_posts / content_os__get_post / content_os__search_posts 追加
 * v0.16.0：POST /taskmaster/tasks/update・taskmaster__update_task / content_os__update_score 追加
 * v0.17.0：inbox_review_assist 追加
 * v0.18.0：haAku__get_kpi_progress / haAku__get_daily_report 追加
 * v0.19.0：knowledge_tag_suggest 追加
 * v0.20.0：Cron ネタ9本メール追加（依頼書：3194c8d4-3517-4ad9-b996-fe53ca9cfe71）
 * v0.21.0：taskmaster__create_project / taskmaster__delete_project 追加（依頼書：de27238b-8526-4529-9e7c-a26667d506e4）
 * v0.22.0：taskmaster__update_task に projectId / groupId 追加（依頼書：e3756a13-2c72-441d-a6cf-f04c5ee73788）
 * v0.23.0：mn__create_lesson_from_youtube 追加（学ぶくん A S2先行解凍）
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
import { registerSlackTools } from "./tools-slack.js";
import { registerContentOsTools } from "./tools-content-os.js";
import { registerInboxReviewTools } from "./tools-inbox-review.js";
import { registerHaakuTools } from "./tools-haaku.js";
import { registerKnowledgeTagTools } from "./tools-knowledge-tag.js";
import { registerManabuTools } from "./tools-manabu.js";
import { registerShiaraboTools } from "./tools-shiarabo.js";
import { AuthHandler } from "./auth-handler.js";
import { handleTaskmasterTasks, handleTaskmasterAddTask, handleTaskmasterUpdateTask, handleTaskmasterCreateProject, handleTaskmasterDeleteProject, handleTaskmasterDiag } from "./taskmaster.js";
import { handleDiag } from "./diag.js";
import { handleScheduled } from "./cron-neta-mail.js";

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
  // ContentOS
  CONTENT_OS_API_BASE: string;
  CONTENT_OS_INTERNAL_SECRET: string;
  // TaskMaster / haAku（Firestore）
  FIREBASE_SA_EMAIL: string;
  FIREBASE_SA_PRIVATE_KEY: string;
  NAOKI_UID: string;
  // Sales Manager
  SALES_MANAGER_API_BASE: string;
  // Slack Incoming Webhooks
  SLACK_WEBHOOK_01: string;
  SLACK_WEBHOOK_02: string;
  SLACK_WEBHOOK_03: string;
  SLACK_WEBHOOK_04: string;
  // v0.17.0 追加
  NOTION_TOKEN: string;
  ANTHROPIC_API_KEY: string; // inbox_review_assist / knowledge_tag_suggest / cron-neta-mail / mn__ で共用
  // v0.20.0 追加（Cron ネタ9本メール）
  RESEND_API_KEY: string;
  RESEND_FROM_EMAIL: string;
  RESEND_TO_EMAIL: string;
  // v0.23.0 追加（学ぶくん A）
  YOUTUBE_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

function createMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "shia2n-mcp", version: "0.24.0" });
  registerHighShinTools(server, env);
  registerHighShinPhase3Tools(server, env);
  registerZeusTools(server, env);
  registerZeusV2Tools(server, env);
  registerFormKunTools(server, env);
  registerPayKunTools(server, env);
  registerTaskmasterTools(server, env);
  registerSalesManagerTools(server, env);
  registerSlackTools(server, env);
  registerContentOsTools(server, env);
  registerInboxReviewTools(server, env);
  registerHaakuTools(server, env);
  registerKnowledgeTagTools(server, env);
  registerManabuTools(server, env);
  registerShiaraboTools(server, env);
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

function isAuthorized(request: Request, env: Env): boolean {
  const authHeader = request.headers.get("Authorization") ?? "";
  return (
    authHeader.startsWith("Bearer ") &&
    timingSafeEqual(authHeader.slice(7), env.MCP_SERVER_SECRET)
  );
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

    if (url.pathname === "/diag" && request.method === "GET") {
      return handleDiag(request, env);
    }

    if (url.pathname.startsWith("/taskmaster/")) {
      if (!isAuthorized(request, env)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (url.pathname === "/taskmaster/diag" && request.method === "GET") {
        return handleTaskmasterDiag(request, env);
      }
      if (url.pathname === "/taskmaster/tasks" && request.method === "GET") {
        return handleTaskmasterTasks(request, env);
      }
      if (url.pathname === "/taskmaster/tasks" && request.method === "POST") {
        return handleTaskmasterAddTask(request, env);
      }
      if (url.pathname === "/taskmaster/tasks/update" && request.method === "POST") {
        return handleTaskmasterUpdateTask(request, env);
      }
      if (url.pathname === "/taskmaster/projects" && request.method === "POST") {
        return handleTaskmasterCreateProject(request, env);
      }
      if (url.pathname === "/taskmaster/projects/delete" && request.method === "POST") {
        return handleTaskmasterDeleteProject(request, env);
      }
      return Response.json({ error: "Not Found" }, { status: 404 });
    }

    return oauthProvider.fetch(request, env, ctx);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(env));
  },
};
