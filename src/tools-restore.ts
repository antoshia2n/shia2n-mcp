/**
 * MCP tool 登録：munikis__restore_test（控えから戻す試し）
 *
 * 2026-08-06。控えは取れているが、一度も戻していない。
 * 戻せなければ控えを取っている意味が無いので、実際に 1 本通して確かめる。
 *
 * 安全のための決めごと（ここを崩さない）：
 *   1. 書き戻す先は必ず「元の名前 + _restore_test」。本番の表には絶対に書かない。
 *      名前はこちらで組み立てるので、呼ぶ側から本番の表を指定できない。
 *   2. 書き戻す前に、先が本当に試し用の表かを名前で検査する。
 *   3. 件数が多い表は断る。1 回の実行での外部呼び出しの上限に当たるため。
 *   4. 何回動かしても同じ結果になる（先を空にしてから入れ直す）。
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./index.js";

/** 1 回で書き戻せる上限。これを超える表は断る */
const MAX_ROWS = 5000;

/** 一度に送る行数 */
const CHUNK = 500;

/** 試し用の表の名前の決まり。この形以外へは書かない */
const TEST_SUFFIX = "_restore_test";

function jstDate(now: Date): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

function headers(env: Env): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

/** 表の件数を数える */
async function countRows(env: Env, table: string): Promise<number | null> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}?select=*&limit=1`,
    { headers: { ...headers(env), Prefer: "count=exact" } }
  );
  if (!res.ok) return null;
  const range = res.headers.get("content-range");
  if (!range) return null;
  const tail = range.slice(range.lastIndexOf("/") + 1);
  const n = Number(tail);
  return Number.isFinite(n) ? n : null;
}

export function registerRestoreTools(server: McpServer, env: Env): void {
  server.tool(
    "munikis__restore_test",
    "控えから 1 本だけ試しに戻す。書き戻す先は「元の名前 + _restore_test」に固定されており、本番の表には絶対に書かない（先の表は事前に作っておく必要がある）。控えの件数・書き戻した件数・戻した先の件数を返すので、その場で照合できる。何回動かしても同じ結果になる。",
    {
      confirm: z
        .literal("yes")
        .describe("実行する場合は yes を指定する（取り違えを防ぐための確認）"),
      table: z
        .string()
        .describe("控えの中の表の名前（例：rules）。書き戻す先は自動で rules_restore_test になる"),
      date: z
        .string()
        .optional()
        .describe("控えの日付（YYYY-MM-DD）。省略すると今日"),
    },
    async ({ table, date }) => {
      const 対象日 = date ?? jstDate(new Date());
      const key = `backup/${対象日}/supabase/${table}.json`;
      const 戻す先 = `${table}${TEST_SUFFIX}`;

      const result: Record<string, unknown> = {
        控えの場所: key,
        戻す先: 戻す先,
      };

      // 決めごと 2：先が試し用の表であることを名前で検査する
      if (!戻す先.endsWith(TEST_SUFFIX) || 戻す先 === TEST_SUFFIX) {
        result.結果 = "止めた";
        result.理由 = "戻す先の名前が試し用の形になっていない";
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      try {
        // 1. 控えを読む
        const obj = await env.BACKUP_BUCKET.get(key);
        if (!obj) {
          result.結果 = "止めた";
          result.理由 = "その日の控えに、この表のファイルが無い";
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        const rows = JSON.parse(await obj.text()) as Record<string, unknown>[];
        result.控えの件数 = rows.length;

        if (!Array.isArray(rows)) {
          result.結果 = "止めた";
          result.理由 = "控えの中身が行の並びになっていない";
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        // 決めごと 3：多すぎる表は断る
        if (rows.length > MAX_ROWS) {
          result.結果 = "止めた";
          result.理由 = `件数が多すぎる（${rows.length} 件・上限 ${MAX_ROWS} 件）。小さい表で試す`;
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        // 2. 戻す先が存在するかを見る（無ければ作れないので、ここで止める）
        const 先の最初の件数 = await countRows(env, 戻す先);
        if (先の最初の件数 === null) {
          result.結果 = "止めた";
          result.理由 = `戻す先の表が見つからない。先に ${戻す先} を作る必要がある`;
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        result.戻す前の件数 = 先の最初の件数;

        // 3. 先を空にする（何回動かしても同じ結果にするため）
        const del = await fetch(
          `${env.SUPABASE_URL}/rest/v1/${encodeURIComponent(戻す先)}?id=not.is.null`,
          { method: "DELETE", headers: headers(env) }
        );
        if (!del.ok) {
          result.結果 = "止めた";
          result.理由 = `戻す先を空にできなかった（${del.status}）`;
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        // 4. 分けて書き戻す
        let 書き戻した = 0;
        const 失敗: string[] = [];

        for (let i = 0; i < rows.length; i += CHUNK) {
          const part = rows.slice(i, i + CHUNK);
          const res = await fetch(
            `${env.SUPABASE_URL}/rest/v1/${encodeURIComponent(戻す先)}`,
            { method: "POST", headers: headers(env), body: JSON.stringify(part) }
          );
          if (res.ok) {
            書き戻した += part.length;
          } else {
            失敗.push(`${i + 1} 件目から ${part.length} 件：${res.status} ${await res.text()}`);
          }
        }

        result.書き戻した件数 = 書き戻した;
        if (失敗.length > 0) result.失敗 = 失敗;

        // 5. 実際に入った件数を数えて照合する
        const 戻したあとの件数 = await countRows(env, 戻す先);
        result.戻したあとの件数 = 戻したあとの件数;
        result.件数が一致したか = 戻したあとの件数 === rows.length;
        result.結果 =
          戻したあとの件数 === rows.length ? "戻せた（件数が一致）" : "戻し切れていない";

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        result.結果 = "止めた";
        result.理由 = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    }
  );
}
