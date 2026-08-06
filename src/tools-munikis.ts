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
import { readAllRuns, runAndRecord } from "./cron-log.js";
import { handleBackupCron } from "./cron-backup.js";
import type { Env } from "./index.js";

export function registerMunikisTools(server: McpServer, env: Env): void {
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
      const [result, recent_runs] = await Promise.all([
        fetchMunikisContext(env.NOTION_TOKEN, {
          chat_type,
          n_sessions: n_sessions ?? 3,
        }),
        readAllRuns(env),
      ]);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ...result, recent_runs }, null, 2),
          },
        ],
      };
    }
  );

  // 2026-08-04：実行記録の仕組みそのものを確かめるための自己点検。
  // 成功だけ記録されて失敗が落ちる作りになっていないかを、本番の処理を
  // 動かさずに確認する。記録は selftest という名前で残るため、本番の
  // 3 つの処理の記録には混ざらない。
  server.tool(
    "munikis__cron_selftest",
    "自動で動くものの実行記録が、成功と失敗の両方を残せているかを確かめる。outcome=failure を指定すると、わざと失敗した記録を 1 件残す。本番の処理（Zeus 取り込み・UTAGE 取り込み・ネタ9本メール）は一切動かさない。結果は munikis__get_context の recent_runs.selftest と GET /diag の last_runs.selftest で確認できる。",
    {
      outcome: z
        .enum(["success", "failure"])
        .describe("success=成功として記録する / failure=わざと失敗させて記録する"),
    },
    async ({ outcome }) => {
      let thrown: string | null = null;

      try {
        await runAndRecord(env, "selftest", async () => {
          if (outcome === "failure") {
            throw new Error("自己点検のためのわざとの失敗（本番の処理ではありません）");
          }
          return { count: 1, detail: "自己点検（成功として記録）" };
        });
      } catch (error) {
        // ここで受け止める。記録は runAndRecord の中で済んでいる。
        thrown = error instanceof Error ? error.message : String(error);
      }

      const runs = await readAllRuns(env);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                requested: outcome,
                recorded: runs.selftest?.[0] ?? null,
                thrown,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 2026-08-06：控えを手で 1 回動かす口。
  // 毎日 4 時の自動実行を待たずに、直したことの効き目を同じ日に確かめるために置く。
  // 中身は自動実行と同じ処理を呼ぶだけ（別の作りを持たない＝二重管理にしない）。
  // その日の控えは同じ場所へ上書きされる。何回動かしても結果は同じになる。
  server.tool(
    "munikis__backup_now",
    "データの控えを手で 1 回だけ動かす。毎日 4 時の自動実行と同じ処理を呼び、同じ場所へ書き出す（何回動かしても結果は同じ）。失敗しても記録に残るため、直したことの効き目をその場で確かめられる。結果は munikis__get_context の recent_runs.backup と GET /diag の last_runs.backup にも出る。",
    {
      confirm: z
        .literal("yes")
        .describe("実行する場合は yes を指定する（取り違えを防ぐための確認）"),
    },
    async () => {
      let thrown: string | null = null;

      try {
        await runAndRecord(env, "backup", async () => handleBackupCron(env));
      } catch (error) {
        // 記録は runAndRecord の中で済んでいる。ここでは文面を返すだけ。
        thrown = error instanceof Error ? error.message : String(error);
      }

      const runs = await readAllRuns(env);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                recorded: runs.backup?.[0] ?? null,
                thrown,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
