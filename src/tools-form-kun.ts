import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callFormKunInternalApi, asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";

/**
 * Form-kun 用のツールを登録する。
 * 各ツールは Form-kun 本体の /api/internal/* を薄くラップする。
 *
 * 命名規約：`form_kun__<action>`（ダブルアンダースコアでアプリ名と機能を分離）
 */
export function registerFormKunTools(server: McpServer, env: Env): void {
  // ─── 1. form_kun__create_lp ──────────────────────────────────────────
  server.tool(
    "form_kun__create_lp",
    "Form-kun に新しいLPページ（ランディングページ）とフォームを作成し、公開URLを返す。HTMLを渡すだけで即座に公開URLが発行される。AIがHTMLを生成→このツールで作成→URLをNaokiに提示、という流れで使う。lp_html の中に {{FORM}} を入れるとその位置にフォームが挿入される。省略した場合はHTMLの末尾にフォームが追加される。戻り値: { page_id, title, slug, published, public_url, fields, created_at }。",
    {
      title: z
        .string()
        .describe("LPの管理用タイトル（管理画面で識別する名前、必須）"),
      lp_html: z
        .string()
        .describe("LPのHTML本文（必須）。フォームを挿入したい位置に {{FORM}} を入れる。レスポンシブデザイン推奨。"),
      fields: z
        .array(
          z.object({
            key:         z.string().describe("フォームのフィールドキー（英数字、例: email, name, company）"),
            label:       z.string().describe("フォームのラベル（日本語可、例: メールアドレス）"),
            type:        z.enum(["text", "email", "tel", "textarea"]).describe("フィールドの種類"),
            required:    z.boolean().optional().describe("必須項目か（既定: true）"),
            placeholder: z.string().optional().describe("プレースホルダー（省略可）"),
          })
        )
        .optional()
        .describe("フォーム項目の定義（省略時はメールアドレスとお名前の2項目）"),
      slug: z
        .string()
        .optional()
        .describe("URLのスラッグ（省略時は自動生成。英数字とハイフンのみ使用可。例: seminar-2024-05）"),
      redirect_url: z
        .string()
        .optional()
        .describe("送信後のリダイレクト先URL（省略時はサンクスメッセージを表示）"),
    },
    async (args) => {
      const result = await callFormKunInternalApi(env, "create-lp", args);
      return asMcpTextResult(result);
    }
  );

  // ─── 2. form_kun__list_lps ───────────────────────────────────────────
  server.tool(
    "form_kun__list_lps",
    "Form-kun に登録されているLPページの一覧を取得する。各LPの送信件数・公開状態・URLも含む。戻り値: { total_count, pages: [{id, title, slug, published, submission_count, public_url, created_at, updated_at}] }。",
    {
      published: z
        .boolean()
        .optional()
        .describe("公開状態で絞り込み（省略時は全件。true=公開中のみ、false=非公開のみ）"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("最大取得件数（既定50、上限100）"),
    },
    async (args) => {
      const result = await callFormKunInternalApi(env, "list-lps", args);
      return asMcpTextResult(result);
    }
  );

  // ─── 3. form_kun__get_submissions ────────────────────────────────────
  server.tool(
    "form_kun__get_submissions",
    "指定したLPへの送信データ（フォーム回答）を取得する。マーケ分析・リスト確認・フォローアップ対象の特定に使う。戻り値: { page: {id, title, slug}, total_count, submissions: [{id, data, created_at}] }。data はフォーム項目のキーと値のオブジェクト（例: {email: 'foo@bar.com', name: '山田太郎'}）。",
    {
      page_id: z
        .string()
        .describe("対象LPのID（form_kun__list_lps で取得できる id フィールド、必須）"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("最大取得件数（既定100、上限500）"),
    },
    async (args) => {
      const result = await callFormKunInternalApi(env, "get-submissions", args);
      return asMcpTextResult(result);
    }
  );
}
