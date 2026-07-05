/**
 * shia2n-mcp エントリーポイント v0.28.0
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
 * v0.24.0：content_os__list_slots / content_os__fill_slot 追加（依頼書：3619c6c1-c439-817f-9533-ee9b661830f4）
 * v0.25.0：content_os__create_slot 追加（依頼書：3619c6c1-c439-8128-9de8-fb5da46c209b）
 * v0.26.0：会員管理くん Phase 3 ③ UTAGE ポーリング追加（POST /utage/backfill）
 * v0.26.1：cron を 1 本（0,30 * * * *）に統合（Free プラン 5 本上限対策）
 *          ネタメールは handler 内の UTC 時刻判定で既存と同時刻（UTC 18:00 / 22:00）発火
 * v0.27.0：UTAGE を MCP から REST API に切り替え（api.utage-system.com/v1）
 *          scheduled 発火直後ログ + エラー再 throw で Cron Events に失敗記録
 *          GET /utage/diag 診断エンドポイント追加（認証不要）
 * v0.28.0：会員管理くん Phase 3 ④ 自動写像適用 cron 追加（15,45 * * * *）
 *          controller.cron で分岐して handleAutoMappingCron を呼び出す
 *          既存 UTAGE ポーリング（0,30）とは別 cron で 15 分後に reconciliation 実行
 * v0.29.0：会員管理くん Phase 4 スコープ A の members__* 3 本追加
 *          members__search / members__get / members__update
 *          認証は MEMBERS_INTERNAL_TOKEN（sync-utage-batch 用の MEMBERS_INTERNAL_SECRET とは別 Secret）
 *          リスク吸収 3 点（PII 禁止 8 種 / preview モード / 1req=1 会員）は会員管理くん本体側で実装
 *          仕様確定 Decision：https://www.notion.so/3949c6c1c4398176805ae41019b5a6ec
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
import { registerMembersTools } from "./tools-members.js";
import { AuthHandler } from "./auth-handler.js";
import { handleTaskmasterTasks, handleTaskmasterAddTask, handleTaskmasterUpdateTask, handleTaskmasterCreateProject, handleTaskmasterDeleteProject, handleTaskmasterDiag } from "./taskmaster.js";
import { handleDiag } from "./diag.js";
import { handleScheduled } from "./cron-neta-mail.js";
import { handleUtagePolling } from "./cron-utage-polling.js";
import { handleUtageBackfill } from "./handle-utage-backfill.js";
import { handleUtageDiag } from "./handle-utage-diag.js";
import { handleAutoMappingCron } from "./cron-auto-mapping.js";

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
  ANTHROPIC_API_KEY: string;
  // v0.20.0 追加（Cron ネタ9本メール）
  RESEND_API_KEY: string;
  RESEND_FROM_EMAIL: string;
  RESEND_TO_EMAIL: string;
  // v0.23.0 追加（学ぶくん A）
  YOUTUBE_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  // v0.26.0 追加（会員管理くん Phase 3 ③ UTAGE ポーリング）
  UTAGE_MCP_URL: string;              // https://api.utage-system.com/mcp（v0.27.0 で未使用・後方互換のみ）
  UTAGE_MCP_TOKEN: string;            // v0.27.0 で暫定フォールバック（UTAGE_API_KEY が未設定時のみ）
  MEMBERS_API_BASE: string;           // https://members.shia2n.jp（v0.28.0 で auto-mapping cron でも再利用）
  MEMBERS_INTERNAL_SECRET: string;    // 会員管理くん Cloudflare Secret と同値（v0.28.0 で auto-mapping cron でも再利用）
  // v0.27.0 追加（UTAGE REST API 移行）
  UTAGE_API_KEY: string;              // UTAGE 管理画面で発行した REST API キー
  UTAGE_API_BASE: string;             // https://api.utage-system.com/v1（wrangler vars で設定）
  // v0.29.0 追加（会員管理くん Phase 4 スコープ A members__* 3 本）
  MEMBERS_INTERNAL_TOKEN: string;     // 会員管理くん Cloudflare Pages 側の MEMBERS_INTERNAL_TOKEN と同値
                                      // MEMBERS_INTERNAL_SECRET とは別 Secret（スコープ分離：漏洩時の被害範囲最小化）
}

function createMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "shia2n-mcp", version: "0.29.0" });
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
  registerMembersTools(server, env);
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

    // v0.27.0：UTAGE 診断エンドポイント（認証不要・秘密情報は返さない）
    if (url.pathname === "/utage/diag" && request.method === "GET") {
      return handleUtageDiag(env);
    }

    // v0.26.0：UTAGE 手動バックフィル用エンドポイント
    if (url.pathname === "/utage/backfill" && request.method === "POST") {
      if (!isAuthorized(request, env)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      return handleUtageBackfill(request, env);
    }

    return oauthProvider.fetch(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // v0.28.0：cron は 2 本（"0,30 * * * *" と "15,45 * * * *"）
    // controller.cron で分岐する（Free プラン 5 本上限内・現状 2 本使用）。
    const scheduledDate = new Date(controller.scheduledTime);
    const utcHour = scheduledDate.getUTCHours();
    const utcMinute = scheduledDate.getUTCMinutes();

    // 発火直後ログ（Cron Events / Observability に必ず記録される）
    console.log(
      "[scheduled] fired",
      JSON.stringify({
        cron: controller.cron,
        scheduled_time: scheduledDate.toISOString(),
        utc_hour: utcHour,
        utc_minute: utcMinute,
      })
    );

    const tasks: Promise<void>[] = [];

    if (controller.cron === "0,30 * * * *") {
      // 既存：UTAGE ポーリング（毎回 30 分ごと）
      tasks.push(handleUtagePolling(env));

      // 既存：ネタ9本メール（UTC 18:00 / 22:00 のみ発火）
      if (utcMinute === 0 && (utcHour === 18 || utcHour === 22)) {
        tasks.push(handleScheduled(env));
      }
    } else if (controller.cron === "15,45 * * * *") {
      // v0.28.0：会員管理くん Phase 3 ④ 自動写像適用 reconciliation
      // UTAGE ポーリング（0,30）の 15 分後に走ることで payment_status 変更を反映
      tasks.push(handleAutoMappingCron(env));
    } else {
      // 想定外の cron が来た場合はログのみ（fail しない）
      console.warn(
        "[scheduled] unknown cron",
        JSON.stringify({ cron: controller.cron })
      );
    }

    // エラーを握りつぶさず再 throw して Cron Events に失敗記録
    const results = await Promise.allSettled(tasks);
    const failed = results.filter((result) => result.status === "rejected");

    if (failed.length > 0) {
      console.error(
        "[scheduled] failed",
        JSON.stringify({
          cron: controller.cron,
          failed_count: failed.length,
          results: results.map((result) =>
            result.status === "rejected"
              ? {
                  status: "rejected",
                  reason:
                    result.reason instanceof Error
                      ? result.reason.message
                      : String(result.reason),
                }
              : { status: "fulfilled" }
          ),
        })
      );
      throw new Error(`scheduled tasks failed: ${failed.length}/${results.length}`);
    }

    console.log(
      "[scheduled] completed",
      JSON.stringify({
        cron: controller.cron,
        task_count: tasks.length,
      })
    );
  },
};
