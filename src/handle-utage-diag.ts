/**
 * UTAGE 診断 HTTP Handler v1.1.0
 *
 * v1.2.0（2026-10-07 開発部）：読者の写し先が会員管理くんからデータベースへ替わったので、
 *   members_api の確かめを「member_utage_readers を 1 行引けるか」に替えた（応答の欄の名前は変えない）。
 *
 * v1.1.0（2026-08-04）：連絡ツールの宛先の項目（SLACK_WEBHOOK_03）を削除。
 *   通知そのものを廃止したため、設定の有無を見ても意味が無くなった。
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
  // 書き先の疎通確認（2026-10-07 v1.2.0：会員管理くんではなくデータベースを見る）
  // 読者の写し先 member_utage_readers を 1 行だけ引けるかを見る。件数・中身は返さない。
  // ------------------------------------------------------------
  const membersEndpoint = "supabase:member_utage_readers";
  const membersCheck: MembersCheck = {
    reachable: false,
    endpoint: membersEndpoint,
  };
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const response = await fetch(
        `${env.SUPABASE_URL}/rest/v1/member_utage_readers?select=id&limit=1`,
        {
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            ...(/^eyJ/.test(String(env.SUPABASE_SERVICE_ROLE_KEY || "")) ? { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } : {}),
          },
        }
      );
      membersCheck.reachable = response.ok;
      membersCheck.status = response.status;
      if (!response.ok) {
        membersCheck.error = `HTTP ${response.status}`;
      }
    } catch (e) {
      membersCheck.error = e instanceof Error ? e.message : String(e);
    }
  } else {
    membersCheck.error = "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set";
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
