import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callInternalApi, asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";

/**
 * High-Shinくん用の6ツールを登録する。
 * 各ツールは High-Shinくん本体の /api/internal/* を薄くラップする。
 *
 * 命名規約：`high_shin__<action>`（ダブルアンダースコアでアプリ名と機能を分離）
 * これは shia2n-mcp-design.md の「3. ツール命名規約」に従う。
 */
export function registerHighShinTools(server: McpServer, env: Env): void {
  // ─── 1. search_contacts ──────────────────────────────────────────────
  server.tool(
    "high_shin__search_contacts",
    "High-Shinくんの購読者（コンタクト）を条件で検索する。タグやキーワードで絞り込み可能。戻り値は contacts 配列。",
    {
      query: z
        .string()
        .optional()
        .describe("名前またはメールアドレスの部分一致検索"),
      tag_ids: z
        .array(z.string())
        .optional()
        .describe("絞り込みタグIDの配列（指定時は全タグにマッチするコンタクトのみ）"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("最大取得件数（既定50、上限200）"),
    },
    async (args) => {
      const result = await callInternalApi(env, "search-contacts", args);
      return asMcpTextResult(result);
    }
  );

  // ─── 2. search_campaigns ─────────────────────────────────────────────
  server.tool(
    "high_shin__search_campaigns",
    "High-Shinくんの配信履歴（キャンペーン）を検索する。status・期間で絞り込み可能。戻り値は campaigns 配列。",
    {
      status: z
        .enum(["draft", "scheduled", "sent", "failed"])
        .optional()
        .describe("キャンペーンの状態"),
      date_from: z
        .string()
        .optional()
        .describe("この日時以降に作成されたもの（ISO 8601 形式、例: 2026-04-01T00:00:00Z）"),
      date_to: z
        .string()
        .optional()
        .describe("この日時以前に作成されたもの（ISO 8601 形式）"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("最大取得件数（既定50、上限200）"),
    },
    async (args) => {
      const result = await callInternalApi(env, "search-campaigns", args);
      return asMcpTextResult(result);
    }
  );

  // ─── 3. get_stats ────────────────────────────────────────────────────
  server.tool(
    "high_shin__get_stats",
    "High-Shinくんの配信全体の統計を取得する。購読者数・開封率・クリック率・配信数など。",
    {
      period: z
        .enum(["7d", "30d", "90d", "all"])
        .optional()
        .describe("集計期間（既定30d）"),
    },
    async (args) => {
      const result = await callInternalApi(env, "get-stats", args);
      return asMcpTextResult(result);
    }
  );

  // ─── 4. create_campaign_draft ────────────────────────────────────────
  server.tool(
    "high_shin__create_campaign_draft",
    "新しいメール配信の下書きを作成する。下書きは status=draft で保存され、human承認を経るまで送信されない。AIが直接本番送信することはできない。戻り値は作成されたcampaign（idを含む）。",
    {
      title: z.string().describe("キャンペーン管理用タイトル（管理画面で識別する名前）"),
      subject: z.string().describe("メール件名（受信者が最初に見る文言）"),
      body: z
        .string()
        .describe("メール本文（HTMLまたはプレーンテキスト）"),
      target_tag_ids: z
        .array(z.string())
        .optional()
        .describe("配信対象のタグIDリスト（未指定なら全購読者）"),
      scheduled_at: z
        .string()
        .optional()
        .describe("配信予定時刻（ISO 8601、未指定なら未定のまま）"),
    },
    async (args) => {
      const result = await callInternalApi(env, "create-draft", args);
      return asMcpTextResult(result);
    }
  );

  // ─── 5. edit_campaign_draft ──────────────────────────────────────────
  server.tool(
    "high_shin__edit_campaign_draft",
    "既存の配信下書きを編集する。status=draft のもののみ編集可能。scheduled や sent になった後は編集不可。戻り値は更新後のcampaign。",
    {
      campaign_id: z.string().describe("編集対象のキャンペーンID"),
      title: z.string().optional(),
      subject: z.string().optional(),
      body: z.string().optional(),
      target_tag_ids: z.array(z.string()).optional(),
      scheduled_at: z.string().optional(),
    },
    async (args) => {
      const result = await callInternalApi(env, "edit-draft", args);
      return asMcpTextResult(result);
    }
  );

  // ─── 6. request_approval ─────────────────────────────────────────────
  server.tool(
    "high_shin__request_approval",
    "下書きに対する承認URLを発行する。このURLをNaokiが開いて承認すると、キャンペーンが status=scheduled に遷移する。AIは本番送信を直接実行できないため、配信前に必ずこのツールを呼び、返却されたURLをNaokiに提示すること。戻り値は { approval_url, preview_token, expires_at }。",
    {
      target_type: z
        .enum(["campaign"])
        .describe("承認対象の種別。現在は 'campaign' のみサポート"),
      target_id: z
        .string()
        .describe("承認対象のID（create_campaign_draft の戻り値のID）"),
      expires_hours: z
        .number()
        .int()
        .min(1)
        .max(168)
        .optional()
        .describe("承認URLの有効期限（時間、既定24、最大168=7日）"),
    },
    async (args) => {
      const result = await callInternalApi(env, "request-approval", args);
      return asMcpTextResult(result);
    }
  );
}
