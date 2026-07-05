/**
 * MCP tool 登録：members__search / members__get / members__update
 *
 * 会員管理くん Phase 4 スコープ A（2026-07-05）
 *
 * shia2n-mcp から会員管理くん本体の内部 API を Bearer 認証で叩く thin wrapper。
 * リスク吸収 3 点は会員管理くん本体側で実装：
 *   1. PII 更新の水際バリデーション（禁止 8 種の 400 拒否）
 *   2. preview モード（Decision 論点 1：デフォルト false）
 *   3. 1 リクエスト = 1 会員の強制（配列不可）
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  postMembersSearch,
  postMembersGet,
  postMembersUpdate,
} from "./members-client.js";

interface MembersEnv {
  MEMBERS_API_BASE: string;
  MEMBERS_INTERNAL_TOKEN: string;
}

export function registerMembersTools(server: McpServer, env: MembersEnv): void {
  // ============================================================
  // members__search
  // ============================================================
  server.tool(
    "members__search",
    "会員管理くんの会員一覧から検索する。query_type=display_name（部分一致）/ email（SHA256 hash 経由の完全一致）/ sor_id（shr_member_id / shr_student_id / note_account / consult_case_ids の 4 カラム完全一致）。PII は返さず、一覧向けの最小フィールド（member_id / display_name / entitlements_count / payment_status_keys / updated_at）のみ返す。詳細は members__get で取得。",
    {
      query_type: z
        .enum(["display_name", "email", "sor_id"])
        .describe(
          "検索種別。display_name=部分一致 / email=完全一致（SHA256 hash 経由）/ sor_id=4 カラム完全一致"
        ),
      query: z.string().min(1).describe("検索文字列（空文字禁止）"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("最大件数（1-100・デフォルト 20）"),
    },
    async ({ query_type, query, limit }) => {
      const result = await postMembersSearch(
        env.MEMBERS_API_BASE,
        env.MEMBERS_INTERNAL_TOKEN,
        { query_type, query, limit }
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // ============================================================
  // members__get
  // ============================================================
  server.tool(
    "members__get",
    "会員 1 件の詳細情報（PII 復号済み）を取得する。members_decrypted view 経由。member_id 未存在時は 404 相当（ok: false, error: 'MEMBER_NOT_FOUND'）。",
    {
      member_id: z.string().uuid().describe("会員の UUID"),
    },
    async ({ member_id }) => {
      const result = await postMembersGet(
        env.MEMBERS_API_BASE,
        env.MEMBERS_INTERNAL_TOKEN,
        { member_id }
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // ============================================================
  // members__update（最重要リスク管理箇所）
  // ============================================================
  server.tool(
    "members__update",
    "会員 1 件の非 PII フィールドを更新する。許容 6 種（entitlements / shr_member_id / shr_student_id / note_account / consult_case_ids / meta）のみ更新可。PII / システム管理 8 種（email / legal_name / notes / firebase_uid / id / email_hash / encryption_key_version / payment_status）は禁止で 400 FIELD_NOT_ALLOWED。preview: true で影響提示のみ（適用しない）。1 リクエスト = 1 会員のみ（配列不可）。entitlements は update_member_entitlements RPC 経由で entitlement_logs 自動記録。非 entitlements は members テーブル直接 UPDATE で audit_logs トリガー記録。全実行を sync_run_logs（source='mcp_manual'）に監査痕跡。",
    {
      member_id: z.string().uuid().describe("会員の UUID"),
      updates: z
        .object({
          entitlements: z
            .array(z.string())
            .optional()
            .describe(
              "エンタイトルメント配列（update_member_entitlements RPC 経由・entitlement_logs 自動記録）"
            ),
          shr_member_id: z
            .string()
            .nullable()
            .optional()
            .describe("shr-webhook 会員 ID（null で解除可）"),
          shr_student_id: z
            .string()
            .nullable()
            .optional()
            .describe("しあらぼ生徒 ID（null で解除可）"),
          note_account: z
            .string()
            .nullable()
            .optional()
            .describe("note アカウント（null で解除可）"),
          consult_case_ids: z
            .array(z.string())
            .optional()
            .describe("コンサル案件 ID 配列"),
          meta: z
            .string()
            .optional()
            .describe(
              "汎用メタデータ（JSON 文字列で渡す。例: '{\"key\":\"value\"}'。会員管理くん本体側で JSON.parse して jsonb 列に格納）"
            ),
        })
        .describe(
          "更新フィールド（許容 6 種のみ・PII 禁止）。空 object 拒否は本体側で 400 応答"
        ),
      reason: z
        .string()
        .min(1)
        .describe("更新理由（sync_run_logs 監査記録に転記・空文字禁止）"),
      preview: z
        .boolean()
        .optional()
        .describe(
          "true で適用せず影響提示のみ。デフォルト false（明示指定を推奨・初回は必ず true から）"
        ),
    },
    async ({ member_id, updates, reason, preview }) => {
      const result = await postMembersUpdate(
        env.MEMBERS_API_BASE,
        env.MEMBERS_INTERNAL_TOKEN,
        { member_id, updates, reason, preview }
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}
