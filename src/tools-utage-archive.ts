/**
 * shia2n-mcp / src/tools-utage-archive.ts（v1.68.0・2026-11-06 開発部・UTAGE 解約の便 U1）
 *
 * UTAGE の写し（src/utage-archive.ts）を Claude から読む道具 5 本。UTAGE には書かない。
 *   utage_archive__status  進み具合と最後に読み終えた回
 *   utage_archive__run     新しい回を今すぐ始める（ふだんは毎晩 JST 3 時台に自動で始まる）
 *   utage_archive__read    棚ごとの読み物（AI が最初に読む目次）
 *   utage_archive__search  品目を言葉で探す
 *   utage_archive__get     品目 1 つの全文（と、UTAGE が返したそのままの中身）
 * 個人の情報（読者・LINE 友だち・申込者・受講生・売上）は数だけ。一人ひとりは返さない。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { archiveDoc, archiveItem, archiveSearch, archiveStatus, DOCS, startRun, tick } from "./utage-archive.js";

export function registerUtageArchiveTools(server: McpServer, env: Env): void {
  server.tool(
    "utage_archive__status",
    "UTAGE の写し（解約に備えて UTAGE の中身を全部、保管庫へ写したもの）の進み具合を返す。読むだけ。latest＝最後に読み終えた回、current＝いま進んでいる回（queue_left が 0 で finished_at があれば読み終わり）・items（種類ごとの数）・errors（読めなかった数）。毎晩 JST 3 時台に新しい回が始まり、15 分ごとに少しずつ進む。docs は utage_archive__read に渡せる読み物の名前",
    {},
    async () => asMcpTextResult(await archiveStatus(env))
  );

  server.tool(
    "utage_archive__run",
    "UTAGE の写しの新しい回を今すぐ始め、1 回分（多くて 60 回の読み）を進める。続きは 15 分ごとに自動で進む。前の回がまだ読み終わっていないときは始めない（進めるだけ）。UTAGE には書かない。返り値: { ok, run, started, did, left, finished }",
    {},
    async () => {
      const s = await startRun(env);
      const t = await tick(env, { maxCalls: 60, maxMs: 25_000 });
      return asMcpTextResult({ ok: true, run: t.run, started: s.ok, note: s.ok ? undefined : s.why, did: t.did, left: t.left, finished: t.finished, stopped: t.stopped });
    }
  );

  server.tool(
    "utage_archive__read",
    `UTAGE の写しの読み物（Markdown）を返す。読むだけ。UTAGE で何を作っていたかを知りたいとき・マーケくんで作り直すときの参考に、まずここを読む。doc は ${Object.entries(DOCS).map(([k, v]) => `${k}＝${v}`).join("／")}。各行の \`種類:番号\` を utage_archive__get に渡すと全文が読める。run を省くと最後に読み終えた回`,
    {
      doc: z.enum(Object.keys(DOCS) as [string, ...string[]]).describe("読み物の名前"),
      run: z.string().optional().describe("回（YYYY-MM-DD）。省くと最後に読み終えた回"),
    },
    async (args) => asMcpTextResult(await archiveDoc(env, args.doc, args.run))
  );

  server.tool(
    "utage_archive__search",
    "UTAGE の写しの品目（ファネル・ページ・シナリオ・メッセージ・LINE のテンプレート・イベント・コース・レッスン・商品など）を、名前・道筋・抜き書き・住所に入っている言葉で探す。読むだけ。多くても 50 件。返り値の ref を utage_archive__get に渡す",
    {
      words: z.string().optional().describe("探す言葉（空白で区切ると全部を含むもの）"),
      kind: z.string().optional().describe("種類で絞る（funnel・step・page・account・scenario・message・line_template_body・richmenu・autoreply・event・site・course・lesson・product・price・media_video など）"),
      limit: z.number().optional().describe("返す数（1〜50・既定 20）"),
      run: z.string().optional(),
    },
    async (args) => asMcpTextResult(await archiveSearch(env, args))
  );

  server.tool(
    "utage_archive__get",
    "UTAGE の写しの品目 1 つを返す。読むだけ。text はページ・メール・LINE・レッスンから人が読む文だけを抜いたもの。raw: true で UTAGE が返したそのままの中身（ページの要素の形など）も返す（大きいものは省いて置き場を返す）。個人の情報の種類は返さない",
    {
      ref: z.string().describe("読み物か utage_archive__search の `種類:番号`（例 page:abc123）"),
      raw: z.boolean().optional().describe("UTAGE が返したそのままの中身も返すか。既定 false"),
      run: z.string().optional(),
    },
    async (args) => asMcpTextResult(await archiveItem(env, args.ref, { raw: args.raw === true, run: args.run }))
  );
}
