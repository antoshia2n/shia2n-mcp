/**
 * MCP tool 登録：munikis__get_context
 *
 * 運用効率化パッケージ v1.0（Decision 3959c6c1-c439-818b-b56d-ddce1d9fe776 / 2026-07-06）：
 *   Claude 起動時の Notion 全文 fetch 4〜5 回（数千〜1万トークン）を
 *   1 ツール呼び出し（圧縮 JSON・数百トークン）に置換する。
 *
 * SOT は Notion のまま（本ツールが Notion API を裏で読む・二重管理禁止）。
 * MCP 戻り値 ≠ 最新値対策：fetched_at と source をレスポンスに必ず含める。
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchMunikisContext } from "./munikis-client.js";

interface MunikisEnv {
  NOTION_TOKEN: string;
}

export function registerMunikisTools(server: McpServer, env: MunikisEnv): void {
  server.tool(
    "munikis__get_context",
    "Claude 起動時の状態取得を 1 回にまとめる。指定チャット種別の直近 Sessions 申し送り + オープン Decisions + 進行中 Tasks + MUNIKIS_VISION URL を返す。fetched_at と source を含むため MCP キャッシュと Notion 実状態の乖離を検知可能。SOT は Notion のまま（本ツールは Notion API を裏で読む thin ラッパ）。",
    {
      chat_type: z
        .string()
        .min(1)
        .describe(
          "Sessions のチャット種別フィルタ（例: '会員管理くん' / 'shia2n-mcp' / '統括ハブ' / 'シアニン担当' / '経理系' / '案件系' など Sessions DB のチャット種別プロパティ値と一致する文字列）"
        ),
      n_sessions: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("返却する直近セッション数（1-10・デフォルト 3）"),
    },
    async ({ chat_type, n_sessions }) => {
      const result = await fetchMunikisContext(env.NOTION_TOKEN, {
        chat_type,
        n_sessions: n_sessions ?? 3,
      });
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
