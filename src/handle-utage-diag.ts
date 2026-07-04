/**
 * UTAGE 診断 HTTP Handler v1.0.0
 *
 * GET /utage/diag （認証不要・Naoki の 1 URL 検証用）
 *
 * 環境変数の存在確認 + UTAGE REST API 疎通確認 + 会員管理くん疎通確認を
 * 1 発の JSON レスポンスで返す。
 *
 * 秘密情報は返さない（キーの存在 boolean のみ返す）。
 */

import type { Env } from "./index.js";
import { listUtageAccounts } from "./utage-client.js";

const DEFAULT_UTAGE_API_BASE = "https://api.utage-system.com/v1";

interface EnvCheck {
  UTAGE_API_KEY_set: boolean;
  UTAGE_API_BASE: string;
  MEMBERS_API_BASE_set: boolean;
  MEMBERS_INTERNAL_SECRET_set: boolean;
  SLACK_WEBHOOK_03_set: boolean;
}

interface UtageCheck {
  reachable: boolean;
  accounts_count?: number;
  accounts?: Array<{ id: string; name: string; type?: string }>;
  error?: string;
}

interface MembersCheck {
  reachable: boolean;
  endpoint: string;
  status?: number;
  error?: string;
}

export async function handleUtageDiag(env: Env): Promise<Response> {
  const startedAt = Date.now();

  // ------------------------------------------------------------
  // 環境変数の存在確認（値そのものは返さない）
  // ------------------------------------------------------------
  const envCheck: EnvCheck = {
    UTAGE_API_KEY_set: Boolean(env.UTAGE_API_KEY || env.UTAGE_MCP_TOKEN),
    UTAGE_API_BASE: env.UTAGE_API_BASE || DEFAULT_UTAGE_API_BASE,
    MEMBERS_API_BASE_set: Boolean(env.MEMBERS_API_BASE),
    MEMBERS_INTERNAL_SECRET_set: Boolean(env.MEMBERS_INTERNAL_SECRET),
    SLACK_WEBHOOK_03_set: Boolean(env.SLACK_WEBHOOK_03),
  };

  // ------------------------------------------------------------
  // UTAGE REST API 疎通確認（/accounts で数件だけ取得）
  // ------------------------------------------------------------
  const utageCheck: UtageCheck = { reachable: false };
  if (envCheck.UTAGE_API_KEY_set) {
    try {
      const apiKey = env.UTAGE_API_KEY || env.UTAGE_MCP_TOKEN || "";
      const accounts = await listUtageAccounts(envCheck.UTAGE_API_BASE, apiKey);
      utageCheck.reachable = true;
      utageCheck.accounts_count = accounts.length;
      utageCheck.accounts = accounts.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
      }));
    } catch (e) {
      utageCheck.error = e instanceof Error ? e.message : String(e);
    }
  } else {
    utageCheck.error = "UTAGE_API_KEY is not set";
  }

  // ------------------------------------------------------------
  // 会員管理くん疎通確認（GET でヘルスチェック応答）
  // ------------------------------------------------------------
  const membersEndpoint = envCheck.MEMBERS_API_BASE_set
    ? `${env.MEMBERS_API_BASE!.replace(/\/$/, "")}/api/internal/sync-utage-batch`
    : "";
  const membersCheck: MembersCheck = {
    reachable: false,
    endpoint: membersEndpoint,
  };
  if (envCheck.MEMBERS_API_BASE_set) {
    try {
      const response = await fetch(membersEndpoint, { method: "GET" });
      membersCheck.reachable = response.ok;
      membersCheck.status = response.status;
      if (!response.ok) {
        membersCheck.error = `HTTP ${response.status}`;
      }
    } catch (e) {
      membersCheck.error = e instanceof Error ? e.message : String(e);
    }
  } else {
    membersCheck.error = "MEMBERS_API_BASE is not set";
  }

  // ------------------------------------------------------------
  // 総合判定
  // ------------------------------------------------------------
  const allOk = utageCheck.reachable && membersCheck.reachable;

  return Response.json(
    {
      ok: allOk,
      duration_ms: Date.now() - startedAt,
      env: envCheck,
      utage_api: utageCheck,
      members_api: membersCheck,
      note: "This endpoint is safe to call anytime. It does not leak secrets.",
    },
    { status: allOk ? 200 : 503 }
  );
}
