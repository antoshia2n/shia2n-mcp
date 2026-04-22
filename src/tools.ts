import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callInternalApi, asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";

/**
 * High-Shinくん用の6ツールを登録する。
 * 各ツールは High-Shinくん本体の /api/internal/* を薄くラップする。
 *
 * 重要：パラメータ仕様は High-Shinくん本体の実装（functions/api/internal/*.js）
 * と完全一致させている。ここを勝手に変えると 400/-32602 エラーで動かなくなる。
 *
 * 命名規約：`high_shin__<action>`（ダブルアンダースコアでアプリ名と機能を分離）
 */
export function registerHighShinTools(server: McpServer, env: Env): void {
  // ─── 1. search_contacts ──────────────────────────────────────────────
  server.tool(
    "high_shin__search_contacts",
    "High-Shinくんの購読者（コンタクト）を条件で検索する。名前・メールでのキーワード検索、タグIDでの絞り込み、登録経路・ステータス・登録日での絞り込みが可能。戻り値は { total_count, returned_count, contacts: [{id, email, line_uid, name, source, status, tags, created_at}] }。",
    {
      query: z
        .string()
        .optional()
        .describe("名前またはメールアドレスの部分一致検索（大文字小文字区別なし）"),
      tag_ids: z
        .array(z.string())
        .optional()
        .describe("絞り込みタグIDの配列（いずれかのタグを持つコンタクトにマッチ）"),
      source: z
        .string()
        .optional()
        .describe("登録経路で絞り込み（例: 'lp_a', 'manual' など自由文字列）"),
      status: z
        .enum(["active", "unsubscribed", "pending", "bounced", "all"])
        .optional()
        .describe("コンタクトの状態（既定: active）。'all' は全件"),
      created_after: z
        .string()
        .optional()
        .describe("この日時以降に登録されたもの（ISO 8601、例: 2026-04-01T00:00:00Z）"),
      created_before: z
        .string()
        .optional()
        .describe("この日時以前に登録されたもの（ISO 8601）"),
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
    "High-Shinくんの配信履歴（キャンペーン）を検索する。status・期間・タイトル/件名のキーワードで絞り込み可能。戻り値は { total_count, returned_count, campaigns: [{id, title, channel, subject, body_preview, target_tag_ids, scheduled_at, status, created_by, approved_at, sent_count, stats, created_at}] }。stats（開封・クリック数等）は status='sent' のキャンペーンにのみ付く。",
    {
      status: z
        .enum(["draft", "scheduled", "sent", "failed", "all"])
        .optional()
        .describe("キャンペーンの状態で絞り込み。'all' は全件"),
      query: z
        .string()
        .optional()
        .describe("タイトルまたは件名の部分一致検索"),
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
        .max(100)
        .optional()
        .describe("最大取得件数（既定20、上限100）"),
    },
    async (args) => {
      const result = await callInternalApi(env, "search-campaigns", args);
      return asMcpTextResult(result);
    }
  );

  // ─── 3. get_stats ────────────────────────────────────────────────────
  server.tool(
    "high_shin__get_stats",
    "High-Shinくんの配信全体の統計を取得する。コンタクト数（総数・アクティブ・配信停止・期間内新規）、キャンペーン数（送信済・予約・下書き）、配信指標（通数）を返す。戻り値は { period, period_start, period_end, contacts:{...}, campaigns:{...}, delivery:{...} }。注意: 開封率・クリック率・バウンス率は現時点では 0 固定（High-Shinフェーズ3で実装予定）。",
    {
      period: z
        .enum(["today", "week", "month", "all"])
        .optional()
        .describe("集計期間（既定: month）。today=今日、week=直近7日、month=今月1日から、all=全期間"),
    },
    async (args) => {
      const result = await callInternalApi(env, "get-stats", args);
      return asMcpTextResult(result);
    }
  );

  // ─── 4. create_campaign_draft ────────────────────────────────────────
  server.tool(
    "high_shin__create_campaign_draft",
    "新しい配信の下書きを作成する。下書きは status=draft で保存され、human承認を経るまで送信されない。AIが直接本番送信することはできない。戻り値は { campaign_id, title, target_count, status, preview_snippet, created_at }。",
    {
      title: z.string().describe("キャンペーン管理用タイトル（管理画面で識別する名前、必須）"),
      channel: z
        .enum(["email", "line"])
        .optional()
        .describe("配信チャネル（既定: email）。emailの場合 subject は必須"),
      subject: z
        .string()
        .optional()
        .describe("メール件名（channel=email の場合は必須、受信者が最初に見る文言）"),
      body: z
        .string()
        .describe("メール本文（HTMLまたはプレーンテキスト、必須）"),
      target_tag_ids: z
        .array(z.string())
        .optional()
        .describe("配信対象のタグIDリスト（未指定なら全アクティブ購読者）"),
      scheduled_at: z
        .string()
        .optional()
        .describe("配信予定時刻（ISO 8601、未来の日時でなければ400エラーになる。未指定なら未定のまま保存）"),
      created_by: z
        .string()
        .optional()
        .describe("作成者識別子（既定: 'ai'）"),
    },
    async (args) => {
      const result = await callInternalApi(env, "create-draft", args);
      return asMcpTextResult(result);
    }
  );

  // ─── 5. edit_campaign_draft ──────────────────────────────────────────
  server.tool(
    "high_shin__edit_campaign_draft",
    "既存の配信下書きまたは予約済みキャンペーンを編集する。status=draft または scheduled のもののみ編集可能。sent/sending になった後は編集不可（409 conflict）。指定されたフィールドのみ更新される。戻り値は { campaign_id, title, target_count, status, updated_fields, preview_snippet, updated_at }。",
    {
      campaign_id: z.string().describe("編集対象のキャンペーンID（必須）"),
      title: z.string().optional().describe("新しい管理用タイトル"),
      subject: z.string().optional().describe("新しいメール件名"),
      body: z.string().optional().describe("新しいメール本文"),
      target_tag_ids: z.array(z.string()).optional().describe("新しい配信対象タグIDリスト"),
      scheduled_at: z
        .string()
        .optional()
        .describe("新しい配信予定時刻（ISO 8601、未来の日時必須）"),
    },
    async (args) => {
      const result = await callInternalApi(env, "edit-draft", args);
      return asMcpTextResult(result);
    }
  );

  // ─── 6. request_approval ─────────────────────────────────────────────
  server.tool(
    "high_shin__request_approval",
    "下書きまたは予約キャンペーン/シーケンスに対する承認URLを発行する。このURLをNaokiが開いて承認すると配信実行される。AIは本番送信を直接実行できないため、配信前に必ずこのツールを呼び、返却されたpreview_urlをNaokiに提示すること。戻り値は { approval_id, preview_token, preview_url, expires_at, target_summary }。target_summary にはキャンペーンのタイトル・配信対象数・件名などの概要が含まれる。",
    {
      target_type: z
        .enum(["campaign", "sequence"])
        .describe("承認対象の種別。'campaign'=通常配信、'sequence'=ステップメール（未実装）"),
      target_id: z
        .string()
        .describe("承認対象のID（create_campaign_draft の戻り値の campaign_id）"),
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
