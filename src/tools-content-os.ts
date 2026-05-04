import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";

/**
 * ContentOS（content-os.shia2n.jp）の posts テーブル読み取りツール群。
 * ContentOS 側 /api/internal/{list-posts | get-post | search-posts} を
 * Bearer 認証（CONTENT_OS_INTERNAL_SECRET）で叩くラッパー。
 *
 * 命名規約：`content_os__<action>`
 * v0.15.0 で新規追加（依頼書：3569c6c1-c439-81a9-869e-ef122d33c77e）
 */

async function callContentOsInternalApi<T = unknown>(
  env: Env,
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  if (!env.CONTENT_OS_API_BASE) {
    throw new Error("CONTENT_OS_API_BASE is not configured");
  }
  if (!env.CONTENT_OS_INTERNAL_SECRET) {
    throw new Error("CONTENT_OS_INTERNAL_SECRET is not configured");
  }
  if (!env.MCP_DEFAULT_USER_ID) {
    throw new Error("MCP_DEFAULT_USER_ID is not configured");
  }

  const url = `${env.CONTENT_OS_API_BASE.replace(/\/$/, "")}/api/internal/${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CONTENT_OS_INTERNAL_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: env.MCP_DEFAULT_USER_ID,
        ...body,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`upstream_network_error: ${msg}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `upstream_error: ${res.status} ${res.statusText} — ${text.slice(0, 500)}`
    );
  }
  return (await res.json()) as T;
}

export function registerContentOsTools(server: McpServer, env: Env): void {
  // ─── 1. content_os__list_posts ───────────────────────────────────────
  server.tool(
    "content_os__list_posts",
    "ContentOS（コンテンツくん）の投稿一覧を取得する。シアニンが書いた直近の X / note 投稿の本文・スコア（S/A/B/C/D 評価）・ステータス・日時を返す。発信戦略の解像度を上げるための分析や、過去投稿の俯瞰に使う。score_desc を指定すると評価が高い順（S が最高）、created_desc は新しい順。戻り値: { ok, count, sort, posts: [{id, title, body, body_text, score, status, platform, datetime, account_id, post_type, created_at, updated_at}] }。body は HTML、body_text はタグ除去版。score は人手評価で null もありうる。",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("返す件数（既定20、上限50）"),
      sort: z
        .enum(["score_desc", "created_desc"])
        .optional()
        .describe("ソート順（既定 created_desc）。score_desc は S>A>B>C>D>null の順"),
    },
    async (args) => {
      const result = await callContentOsInternalApi(env, "list-posts", {
        limit: args.limit,
        sort: args.sort,
      });
      return asMcpTextResult(result);
    }
  );

  // ─── 2. content_os__get_post ─────────────────────────────────────────
  server.tool(
    "content_os__get_post",
    "ContentOS の投稿IDから1件の詳細を取得する。content_os__list_posts や content_os__search_posts で見つけた投稿のフルメタ情報（本文・スコア・スレッド・コメント・履歴・ラベル・メモリンク等の全カラム）を取得するときに使う。戻り値: { ok, post: { 全カラム + body_text } } または { ok: false, error: 'not_found' }。",
    {
      id: z
        .union([z.string(), z.number()])
        .describe("投稿ID（bigint。content_os__list_posts の id フィールド）"),
    },
    async (args) => {
      const result = await callContentOsInternalApi(env, "get-post", {
        id: args.id,
      });
      return asMcpTextResult(result);
    }
  );

  // ─── 3. content_os__search_posts ─────────────────────────────────────
  server.tool(
    "content_os__search_posts",
    "ContentOS の投稿本文（body）をキーワードで部分一致検索する（PostgreSQL ILIKE・大文字小文字無視）。シアニンの過去発信から特定テーマ・特定表現を含む投稿を引き出すときに使う。例：『発信軸』『AI時代』『令和のマナブ』。タイトルは検索対象外（依頼書仕様）。戻り値: { ok, count, keyword, posts: [{id, title, body, body_text, score, status, platform, datetime, account_id, post_type, created_at, updated_at}] }。created_at 降順。",
    {
      keyword: z
        .string()
        .min(1)
        .describe("検索キーワード（自然文OK・部分一致・大文字小文字無視）"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("返す件数（既定20、上限50）"),
    },
    async (args) => {
      const result = await callContentOsInternalApi(env, "search-posts", {
        keyword: args.keyword,
        limit: args.limit,
      });
      return asMcpTextResult(result);
    }
  );
}
