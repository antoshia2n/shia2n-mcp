import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import { callContentOsInternalApi } from "./tools-content-os.js";
import type { Env } from "./index.js";

/**
 * v1.72.0（2026-11-10 開発部）：コンテンツくんの「依頼」（content_requests・作業69）を読む・書き戻す道具。
 * コンテンツくんでチェックを入れた依頼（引用の図解・記事内の図解・サムネ・本文）を、
 * ChatGPT の予定タスクが 1 時間ごとに読み、初稿を書き戻す。Naoki はそのチャットで仕上げ、OK で done にする。
 * 中身は content-os の /api/internal/list-requests と put-result。書けるのは結果と状態だけ（依頼の中身は変えられない）。
 */
export const CONTENT_REQUEST_TOOLS = ["content_os__list_requests", "content_os__put_result"] as const;

export function registerContentRequestTools(server: McpServer, env: Env): void {
  server.tool(
    "content_os__list_requests",
    "コンテンツくんの依頼（チェックで作られた、初稿づくりの依頼）を読む。既定は未着手（queued）を古い順に最大10件。各依頼に、もとの投稿（題・本文の文字）と、使う依頼の型（template.content）が付いて返る。kind＝作るもの（quote_figure 引用の図解／article_figure 記事内の図解／thumbnail サムネ／text 本文）、media＝媒体（x_article／note／x_post）、instruction＝Naoki の指示。id を渡すとその1件だけ返す。戻り値: { ok, count, requests: [...] }。",
    {
      status: z
        .array(z.enum(["queued", "drafting", "review", "done", "cancelled"]))
        .optional()
        .describe("読む状態。省略時は ['queued']"),
      id: z.string().optional().describe("依頼の番号（uuid）。渡すとその1件だけ"),
      limit: z.number().int().min(1).max(30).optional().describe("最大件数（既定10）"),
    },
    async (args) => asMcpTextResult(await callContentOsInternalApi(env, "list-requests", args))
  );

  server.tool(
    "content_os__put_result",
    "コンテンツくんの依頼に、作ったもの（初稿・仕上げ）を書き戻す。status は drafting（作り始めた）／review（初稿ができた・Naoki の確認待ち。既定）／done（Naoki が OK と言った）。result_text に文の成果、images に画像（base64・png/jpeg/webp・1枚8MBまで・最大6枚）を渡すと、コンテンツくんの置き場へ入れて住所を残す。urls には https の住所（Drive など）をそのまま足せる。replace_images=true で前の画像を外して入れ直す。done にしてよいのは Naoki が会話の中で OK と言ったときだけ。戻り値: { ok, request }。取り消し済みは 409。",
    {
      id: z.string().describe("依頼の番号（uuid。content_os__list_requests の id）"),
      status: z.enum(["drafting", "review", "done"]).optional().describe("既定 review"),
      result_text: z.string().max(50000).optional().describe("文の成果（本文・図解の文言・サムネの文字など）"),
      images: z
        .array(z.object({
          base64: z.string().describe("画像の base64（data: で始まってもよい）"),
          mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]).optional(),
          label: z.string().max(100).optional(),
        }))
        .max(6)
        .optional(),
      urls: z.array(z.string().url()).max(10).optional().describe("https の住所（Drive の共有リンクなど）"),
      replace_images: z.boolean().optional(),
      note: z.string().max(2000).optional().describe("Naoki への申し送り（1〜2行）"),
    },
    async (args) => asMcpTextResult(await callContentOsInternalApi(env, "put-result", args))
  );

  // v1.73.0：予約の見回りを手で 1 回動かす（Claude の入口だけ。GPT の入口 /content/mcp には出さない）
  server.tool(
    "content_os__run_schedules",
    "コンテンツくんの予約の見回りを 1 回動かす（ふだんは 30 分ごとに自動）。①送信済みの投稿の X の住所を残す ②予約の依頼（未着手・引用元待ち）を Buffer に入れる。戻り値: { ok, x_urls: {count, seen, error?}, done, waiting, error, errors }。",
    {},
    async () => asMcpTextResult(await callContentOsInternalApi(env, "run-schedules", {}))
  );
}
