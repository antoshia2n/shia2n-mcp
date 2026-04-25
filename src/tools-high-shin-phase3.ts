import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callHighShinInternalApiGet, callInternalApi, asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";

/**
 * High-Shinくん Phase 3-4 シーケンス系ツールを登録する。
 * 読み取り系3本は GET /api/internal/* を呼ぶ（callHighShinInternalApiGet）。
 * 書き込み系3本は POST /api/internal/* を呼ぶ（callInternalApi、既存の承認フローと同パターン）。
 *
 * 書き込み系は hs_approval_requests に登録するだけで、
 * 実際の変更は Naoki が /approve/:token を承認して初めて実行される。
 */
export function registerHighShinPhase3Tools(server: McpServer, env: Env): void {
  // ─── 1. high_shin__list_sequences ────────────────────────────────────
  server.tool(
    "high_shin__list_sequences",
    "High-Shinくんに登録されているステップメールシーケンスの一覧を取得する。各シーケンスのステップ数・アクティブなenrollment数・有効/無効フラグも含む。戻り値: { ok, data: { sequences: [{id, name, channel, trigger_type, trigger_key, active, step_count, active_enrollment_count, created_at}], total } }。",
    {
      active: z
        .boolean()
        .optional()
        .describe("有効なシーケンスのみ取得するか（省略時は全件。true=有効のみ、false=無効のみ）"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("最大取得件数（既定50、上限100）"),
    },
    async (args) => {
      const result = await callHighShinInternalApiGet(env, "list-sequences", args);
      return asMcpTextResult(result);
    }
  );

  // ─── 2. high_shin__get_sequence ──────────────────────────────────────
  server.tool(
    "high_shin__get_sequence",
    "指定したシーケンスIDのステップメール詳細（ステップ定義・遅延設定・本文）を取得する。high_shin__list_sequences で id を確認してから使う。戻り値: { ok, data: { sequence: {id, name, channel, trigger_type, trigger_key, active, created_at, steps: [{id, step_order, delay_days, delay_hours, subject, body}]} } }。",
    {
      sequence_id: z
        .string()
        .describe("取得するシーケンスのID（必須）"),
    },
    async (args) => {
      const result = await callHighShinInternalApiGet(env, "get-sequence", args);
      return asMcpTextResult(result);
    }
  );

  // ─── 3. high_shin__list_enrollments ──────────────────────────────────
  server.tool(
    "high_shin__list_enrollments",
    "シーケンスへの購読者登録状況（enrollment）を取得する。誰がどのシーケンスに入っているか、次回送信日時や進行ステップ数を確認するときに使う。sequence_id を省略すると全シーケンスのenrollmentを返す。戻り値: { ok, data: { enrollments: [{id, sequence_id, contact_id, current_step, started_at, next_send_at, status}], total } }。",
    {
      sequence_id: z
        .string()
        .optional()
        .describe("絞り込むシーケンスID（省略時は全シーケンスのenrollmentを返す）"),
      status: z
        .enum(["active", "completed", "paused", "unsubscribed"])
        .optional()
        .describe("ステータスで絞り込み（省略時は全ステータス）。active=配信中、completed=完了、paused=停止中、unsubscribed=配信停止"),
    },
    async (args) => {
      const result = await callHighShinInternalApiGet(env, "list-enrollments", args);
      return asMcpTextResult(result);
    }
  );

  // ─── 4. high_shin__create_sequence_draft ─────────────────────────────
  server.tool(
    "high_shin__create_sequence_draft",
    "新しいステップメールシーケンスの作成を「下書き」として登録する。この時点では hs_approval_requests に登録されるだけで hs_sequences は変更されない。実際の作成は high_shin__request_approval で承認URLを発行し、Naokiが承認画面で確認・承認して初めて実行される。steps は step_number の昇順で定義する。戻り値: { preview_token, approve_url }。",
    {
      name: z
        .string()
        .describe("シーケンス名（必須。例：ウェルカムシーケンス・LP-Aフォローアップ）"),
      trigger_type: z
        .string()
        .describe("トリガー種別（必須。例：manual=手動登録、form_submit=フォーム送信、tag_added=タグ付与）"),
      trigger_key: z
        .string()
        .optional()
        .describe("トリガーキー（trigger_type が form_submit や tag_added の場合に指定。フォームIDやタグID）"),
      steps: z
        .array(
          z.object({
            step_number: z.number().int().min(1).describe("ステップ番号（1始まり）"),
            delay_hours: z.number().int().min(0).describe("前のステップから何時間後に送るか"),
            subject:     z.string().describe("メール件名"),
            body:        z.string().describe("メール本文（プレーンテキスト）"),
          })
        )
        .describe("ステップ定義の配列（必須。step_number の昇順で定義すること）"),
    },
    async (args) => {
      const result = await callInternalApi(env, "create-sequence-draft", args);
      return asMcpTextResult(result);
    }
  );

  // ─── 5. high_shin__edit_sequence_draft ───────────────────────────────
  server.tool(
    "high_shin__edit_sequence_draft",
    "既存のステップメールシーケンスの変更を「下書き」として登録する。変更したいフィールドだけ渡せばよい（省略したフィールドは変更されない）。stepsを渡した場合はステップ全体が置き換えられる。実際の変更は high_shin__request_approval → Naoki承認で初めて実行される。戻り値: { preview_token, approve_url }。",
    {
      sequence_id: z
        .string()
        .describe("変更するシーケンスのID（必須）"),
      name: z
        .string()
        .optional()
        .describe("新しいシーケンス名（変更する場合のみ）"),
      active: z
        .boolean()
        .optional()
        .describe("有効/無効の切り替え（変更する場合のみ）"),
      steps: z
        .array(
          z.object({
            step_number: z.number().int().min(1).describe("ステップ番号（1始まり）"),
            delay_hours: z.number().int().min(0).describe("前のステップから何時間後に送るか"),
            subject:     z.string().describe("メール件名"),
            body:        z.string().describe("メール本文（プレーンテキスト）"),
          })
        )
        .optional()
        .describe("ステップ定義の置き換え（渡した場合は全ステップが置き換えられる。変更しない場合は省略）"),
    },
    async (args) => {
      const result = await callInternalApi(env, "edit-sequence-draft", args);
      return asMcpTextResult(result);
    }
  );

  // ─── 6. high_shin__pause_enrollment_draft ────────────────────────────
  server.tool(
    "high_shin__pause_enrollment_draft",
    "特定のenrollment（購読者のシーケンス登録）を一時停止する「下書き」を登録する。enrollment_id は high_shin__list_enrollments で確認する。実際の停止は high_shin__request_approval → Naoki承認で初めて実行される。停止後は status=paused になり、以降のステップメールが送られなくなる。戻り値: { preview_token, approve_url }。",
    {
      enrollment_id: z
        .string()
        .describe("停止するenrollmentのID（必須。high_shin__list_enrollments で取得できる id フィールド）"),
    },
    async (args) => {
      const result = await callInternalApi(env, "pause-enrollment-draft", args);
      return asMcpTextResult(result);
    }
  );
}
