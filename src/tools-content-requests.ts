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
export const CONTENT_REQUEST_TOOLS = ["content_os__list_requests", "content_os__put_result", "content_os__list_templates", "content_os__save_template"] as const;

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

  // v1.74.0（2026-11-10 開発部・型の持ち帰り 便1）：成果の出た投稿のチャットで Naoki が「型にして」と言ったとき、AI が型・依頼パターンを候補として書き込む
  server.tool(
    "content_os__list_templates",
    "コンテンツくんの型（本文・締め・メモ・プロンプト・依頼パターン）を読む。型を書く前に、似た型がもう無いかを確かめるために使う。status＝mine（Naoki が自分で作った）／candidate（AI が書いた候補）／testing（検証中）／confirmed（確定）。query で名前・中身・なぜ効いたかを探す。一覧の中身は頭の 400 字、id を渡すと全文。戻り値: { ok, count, templates: [...] }。",
    {
      kind: z.enum(["body", "closing", "memo", "prompt", "request"]).optional().describe("型の種類。request＝依頼パターン（GPT へ図解・サムネ・本文を頼む文）"),
      status: z.enum(["mine", "candidate", "testing", "confirmed"]).optional(),
      query: z.string().max(100).optional(),
      id: z.string().optional().describe("型の番号（uuid）。渡すとその1件を全文で"),
    },
    async (args) => asMcpTextResult(await callContentOsInternalApi(env, "list-templates", args))
  );

  server.tool(
    "content_os__save_template",
    "コンテンツくんに型・依頼パターンを「候補」として書き込む。使うのは、Naoki が成果の出た投稿のチャットで「これを型にして」「依頼パターンにして」と言ったときだけ（自分の判断で作らない）。新しく作ると必ず候補になり、Naoki が型の管理画面で使いながら確かめる。id を渡すと、まだ候補のものだけ書き換えられる（Naoki が手を入れた型は書き換えられず 409）。kind：body 本文の型（{{cursor}} の所にカーソルが来る）／closing 締め／memo メモ（- と半角スペース2つで箇条書き）／prompt AI に渡す文（{タイトル}{本文}{メモ}{種類} が書いている中身に置き換わる）／request 依頼パターン（make＝quote_figure 引用の図解／article_figure 記事内の図解／thumbnail サムネ／text 本文の初稿）。why（なぜ効いたか）は必須で、Naoki が言った主観と数字をその言葉のまま入れる。source_post_id は元の投稿の id（content_os__get_post で読める数字）。refs にスワイプくん（k=swipe）・思考整理くん（k=map）の id を 5 件まで付けると、依頼のたびに GPT へ渡る。書く前に content_os__list_templates で似た型が無いか確かめる。戻り値: { ok, created, template, source_post }。",
    {
      id: z.string().optional().describe("書き換えるときだけ。まだ候補の型の番号（uuid）"),
      kind: z.enum(["body", "closing", "memo", "prompt", "request"]).optional().describe("新しく作るときは必須"),
      name: z.string().max(120).optional().describe("型の名前（何に使う型か一目でわかる名前）。新しく作るときは必須"),
      content: z.string().max(20000).optional().describe("型の中身。新しく作るときは必須"),
      why: z.string().max(4000).optional().describe("なぜ効いたか（Naoki の言葉のまま・主観と数字）。新しく作るときは必須"),
      source_post_id: z.number().int().optional().describe("元の投稿の id"),
      make: z.enum(["quote_figure", "article_figure", "thumbnail", "text"]).optional().describe("kind=request のときの作るもの"),
      post_type: z.string().max(60).optional().describe("使う投稿の種類（x_post・x_article・note など）。省略ですべての種類"),
      refs: z.array(z.object({ k: z.enum(["swipe", "map"]), id: z.string(), title: z.string().max(120).optional() })).max(5).optional(),
      made_by: z.enum(["claude", "gpt"]).optional().describe("書いた AI。Claude は claude、ChatGPT は gpt（既定 claude）"),
    },
    async (args) => asMcpTextResult(await callContentOsInternalApi(env, "save-template", args))
  );

  // v1.73.0：予約の見回りを手で 1 回動かす（Claude の入口だけ。GPT の入口 /content/mcp には出さない）
  server.tool(
    "content_os__run_schedules",
    "コンテンツくんの予約の見回りを 1 回動かす（ふだんは 30 分ごとに自動）。①送信済みの投稿の X の住所を残す ②予約の依頼（未着手・引用元待ち）を Buffer に入れる。戻り値: { ok, x_urls: {count, seen, error?}, done, waiting, error, errors }。",
    {},
    async () => asMcpTextResult(await callContentOsInternalApi(env, "run-schedules", {}))
  );
}
