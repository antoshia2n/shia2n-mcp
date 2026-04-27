import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callZeusExternalV1Compat, asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";

/**
 * Zeus（ナレッジハブ）v1 互換ツールを登録する。
 * Zeus v2 移行後も下位互換を維持するため、v1-compat エンドポイント経由で動作する。
 * 認証は ZEUS_EXTERNAL_SECRET（旧 ZEUS_INTERNAL_SECRET から移行済み）。
 *
 * 命名規約：`zeus__<action>`（ダブルアンダースコアでアプリ名と機能を分離）
 */
export function registerZeusTools(server: McpServer, env: Env): void {
  // ─── 1. zeus__search ─────────────────────────────────────────────────
  server.tool(
    "zeus__search",
    "Zeus（ナレッジハブ）に蓄積されたナレッジを意味検索する。Voyage AI のベクトル埋め込みによるコサイン類似度検索なので、言葉のゆらぎに強い（例：「モチベーション低下」で検索→「やる気が出ない」もヒット）。壁打ちやリサーチの最初にNaokiの過去の思考・事例・決定事項を引き出すのに使う。戻り値は { results: [{id, title, content, source, source_app, source_ref, tags, similarity, created_at}] }。similarity は 0〜1 の値で、1 に近いほど類似度が高い（一般に 0.5 以上が関連ありと判断できる目安）。",
    {
      query: z
        .string()
        .describe("検索クエリ（自然文でも可、例：『発信軸の決め方』『クライアントに伝わる言葉の選び方』）"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("返す件数（既定5、上限20）"),
      source: z
        .string()
        .optional()
        .describe(
          "ソース種別で絞り込み（任意）。例: 'whimsical', 'notion', 'memo', 'mm-app', 'content-os', 'chat', 'consult', 'evernote', 'iphone', 'other'"
        ),
    },
    async (args) => {
      const result = await callZeusExternalV1Compat(env, "search", args);
      return asMcpTextResult(result);
    }
  );

  // ─── 2. zeus__add_entry ──────────────────────────────────────────────
  server.tool(
    "zeus__add_entry",
    "Zeus（ナレッジハブ）に新しいナレッジエントリを追加する。壁打ち中に重要な洞察・決定事項・新しい思考が出たときに使う。保存時にVoyage AIでベクトル化され、以降 zeus__search で引き出せるようになる。追加は非破壊的なので承認フローは不要だが、Claudeは呼び出し前にNaokiに『これをZeusに保存しますか？』と意図を確認すること。戻り値は { entry: {id, title, content, source, tags, created_at, created_by: 'mcp'} }。",
    {
      title: z
        .string()
        .describe("ナレッジの見出し（後から一覧で見たときに内容が思い出せる簡潔なタイトル、必須）"),
      content: z
        .string()
        .describe("ナレッジの本文（必須）。Markdown 可。"),
      source: z
        .string()
        .optional()
        .describe(
          "ソース種別（既定 'memo'）。例: 'chat'（壁打ちから）, 'memo'（手動メモ）, 'consult'（コンサルシート転記）"
        ),
      source_app: z
        .string()
        .optional()
        .describe("連携元アプリID（外部アプリから同期した場合のみ。例：'mm-app', 'content-os'）"),
      source_ref: z
        .string()
        .optional()
        .describe("連携元レコードID（外部アプリから同期した場合のみ）"),
      tags: z
        .array(z.string())
        .optional()
        .describe("タグ配列（例：['発信軸', 'コーチング', '価値観']）"),
    },
    async (args) => {
      const result = await callZeusExternalV1Compat(env, "add-entry", args);
      return asMcpTextResult(result);
    }
  );

  // ─── 3. zeus__list_sources ───────────────────────────────────────────
  server.tool(
    "zeus__list_sources",
    "Zeus（ナレッジハブ）の全エントリをソース別に集計する。棚卸し・進捗把握・移行状況の確認に使う。戻り値は { sources: [{source, count}], total }。source は count の降順でソート済み。",
    {},
    async () => {
      const result = await callZeusExternalV1Compat(env, "list-sources", {});
      return asMcpTextResult(result);
    }
  );
}
