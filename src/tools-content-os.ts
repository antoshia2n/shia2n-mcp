import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";

/**
 * ContentOS（content-os.shia2n.jp）の posts テーブル読み取り・更新ツール群。
 * ContentOS 側 /api/internal/{list-posts | get-post | search-posts | update-score | list-slots | fill-slot | create-slot} を
 * Bearer 認証（CONTENT_OS_INTERNAL_SECRET）で叩くラッパー。
 *
 * 命名規約：`content_os__<action>`
 * v0.15.0 で読み取り3ツール追加（依頼書：3569c6c1-c439-81a9-869e-ef122d33c77e）
 * v0.16.0 で content_os__update_score 追加（依頼書：3579c6c1-c439-81b4-98b4-cd4940145e4a）
 * v0.17.0 で content_os__list_slots / content_os__fill_slot 追加（依頼書：3619c6c1-c439-817f-9533-ee9b661830f4）
 * v0.25.0 で content_os__create_slot 追加（依頼書：3619c6c1-c439-8128-9de8-fb5da46c209b）
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

  // ─── 4. content_os__update_score ─────────────────────────────────────
  // v0.16.0 で追加（依頼書：3579c6c1-c439-81b4-98b4-cd4940145e4a）
  server.tool(
    "content_os__update_score",
    "ContentOS の投稿スコアを手動設定する。コンテンツ分析後に評価を記録するときに使う。S/A/B/C/D の5段階または null（未評価に戻す）を指定できる。戻り値: { ok: true, post: {id, score, updated_at} } または { ok: false, error: 'not_found' }。",
    {
      id: z
        .union([z.string(), z.number()])
        .describe("投稿ID（bigint。content_os__list_posts の id フィールド）"),
      score: z
        .enum(["S", "A", "B", "C", "D"])
        .nullable()
        .describe("スコア。S/A/B/C/D の5段階、または null で未評価に戻す"),
    },
    async (args) => {
      const result = await callContentOsInternalApi(env, "update-score", {
        id: args.id,
        score: args.score,
      });
      return asMcpTextResult(result);
    }
  );

  // ─── 5. content_os__list_slots ───────────────────────────────────────
  // v0.17.0 で追加（依頼書：3619c6c1-c439-817f-9533-ee9b661830f4）
  server.tool(
    "content_os__list_slots",
    "ContentOS の空き予約枠一覧を取得する。Naoki が事前に ContentOS UI で作成した「body が空の投稿レコード」を返す。Claude はこの枠に content_os__fill_slot で本文を書き込む。戻り値: { ok, count, slots: [{id, datetime, platform, post_type, status, title, account_id}] }。datetime 昇順。",
    {
      after: z
        .string()
        .optional()
        .describe("この日時以降の枠を返す（YYYY-MM-DDTHH:mm 形式）"),
      before: z
        .string()
        .optional()
        .describe("この日時以前の枠を返す（YYYY-MM-DDTHH:mm 形式）"),
      platform: z
        .string()
        .optional()
        .describe("媒体で絞り込む（例: x / note）"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("返す件数（既定20、上限50）"),
    },
    async (args) => {
      const result = await callContentOsInternalApi(env, "list-slots", {
        after: args.after,
        before: args.before,
        platform: args.platform,
        limit: args.limit,
      });
      return asMcpTextResult(result);
    }
  );

  // ─── 6. content_os__fill_slot ────────────────────────────────────────
  // v0.17.0 で追加（依頼書：3619c6c1-c439-817f-9533-ee9b661830f4）
  server.tool(
    "content_os__fill_slot",
    "ContentOS の指定予約枠（body が空のレコード）に title / body を書き込み、status を draft に更新する。すでに body が埋まっている枠への上書きは error（slot_already_filled）を返す。force=true を指定した場合のみ上書きを許可。必ず content_os__list_slots で枠の id を確認してから呼ぶこと。戻り値: { ok: true, post: {id, title, status, datetime} } または { ok: false, error: 'slot_already_filled' | 'not_found' }。",
    {
      id: z
        .union([z.string(), z.number()])
        .describe("予約枠の投稿ID（bigint。content_os__list_slots の id フィールド）"),
      title: z
        .string()
        .min(1)
        .describe("投稿タイトル（必須）"),
      body: z
        .string()
        .describe("投稿本文（HTML可・空文字不可）"),
      post_type: z
        .string()
        .optional()
        .describe("投稿タイプ（省略時は枠の既存値を維持）。例: x_post / x_article / note"),
      force: z
        .boolean()
        .optional()
        .describe("true を指定するとすでに body が入っている枠にも上書きする。省略時は false"),
    },
    async (args) => {
      const result = await callContentOsInternalApi(env, "fill-slot", {
        id: args.id,
        title: args.title,
        body: args.body,
        post_type: args.post_type,
        force: args.force,
      });
      return asMcpTextResult(result);
    }
  );

  // ─── 7. content_os__create_slot ──────────────────────────────────────
  // v0.25.0 で追加（依頼書：3619c6c1-c439-8128-9de8-fb5da46c209b）
  // 運用ルール（Decisions：3619c6c1-c439-8127-a30d-c283e3ac7d56）：
  //   Claude が単独判断で呼ぶことは禁止。Naoki の明示指示があった時のみ呼ぶ。
  //   1回の呼び出しは原則1枠。連続枠生成は別途 Naoki 承認が必要。
  server.tool(
    "content_os__create_slot",
    "ContentOS に新しい空き予約枠（スロット）を作成する。Naoki から「○月○日に X 記事の予約枠を1本作って」のような明示指示があった時のみ呼ぶ。Claude が単独判断で呼ぶことは禁止。1回の呼び出しは原則1枠（連続枠生成は別途 Naoki 承認が必要）。作成後は枠の id と datetime を Naoki へ報告し、その後 content_os__fill_slot で本文を流し込む。戻り値: { ok: true, slot: { id, datetime, title, platform, post_type, status } } または { ok: false, error: string }。",
    {
      datetime: z
        .string()
        .describe("予約日時（YYYY-MM-DDTHH:mm 形式）。例: 2026-05-20T10:00"),
      title: z
        .string()
        .min(1)
        .describe("投稿タイトル（必須・空文字不可）"),
      platform: z
        .string()
        .describe("媒体（x / note）"),
      post_type: z
        .string()
        .describe("投稿タイプ（x_post / x_article / note 等）"),
      account_id: z
        .string()
        .describe("ContentOS アカウントID（content_os__list_slots の account_id フィールドで確認）"),
    },
    async (args) => {
      const result = await callContentOsInternalApi(env, "create-slot", {
        datetime: args.datetime,
        title: args.title,
        platform: args.platform,
        post_type: args.post_type,
        account_id: args.account_id,
      });
      return asMcpTextResult(result);
    }
  );
}
