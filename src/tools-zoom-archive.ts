/**
 * shia2n-mcp / src/tools-zoom-archive.ts（2026-11-02 開発部・経理系の依頼 1 便 1・便 4）
 *
 * Zoom の録画の自動保管（zoom-to-youtube）を Claude から見る・探す・消す道具 3 本。
 *   zoom_archive__list    数と失敗（行は include_rows のときだけ）
 *   zoom_archive__search  録画を探す（多くても 50 件）
 *   zoom_archive__delete  R2 から消す。confirm を付けなければ下見だけ
 *
 * 中身は zoom-to-youtube の ArchiveApi（RPC）が持つ。こちらは呼ぶだけで、数え方も消し方も持たない。
 * 結びは wrangler.jsonc の services（binding ZOOM_ARCHIVE・entrypoint ArchiveApi）。外の住所を通らないので合言葉は要らない。
 * 行には限定公開の住所が載ることがあるため、公開の口にはしていない。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";

function api(env: Env): NonNullable<Env["ZOOM_ARCHIVE"]> {
  if (!env.ZOOM_ARCHIVE) {
    throw new Error("zoom-to-youtube への結び（ZOOM_ARCHIVE）がありません。wrangler.jsonc の services を確かめてください");
  }
  return env.ZOOM_ARCHIVE;
}

async function call<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    throw new Error(`zoom-to-youtube を呼べませんでした（第21版より前のまま・止まっている、のどちらか）：${e instanceof Error ? e.message : String(e)}`);
  }
}

export function registerZoomArchiveTools(server: McpServer, env: Env): void {
  server.tool(
    "zoom_archive__list",
    "Zoom の録画の自動保管（zoom-to-youtube）の状態を返す。読むだけ。既定は数と失敗だけ：counts（r2・youtube・both・zoom_deleted）・legacy（11/02 より前の録画の移し：total・r2_done・remaining_gb・youtube_none）・failure_count・failures（where：見つける／録画／古い録画／台帳／控え）。failure_count が 0 なら失敗は 0 件。録画を探すときは zoom_archive__search を使う。全部の行が要るときだけ include_rows: true（500 行を超え、とても重い）。行の youtube_url は限定公開の住所なので外へ貼らない",
    {
      include_rows: z.boolean().optional().describe("全部の行も返すか。既定は false（数と失敗だけ）"),
    },
    async (args) => asMcpTextResult(await call(() => api(env).list({ include_rows: args.include_rows === true })))
  );

  server.tool(
    "zoom_archive__search",
    "Zoom の録画の自動保管から録画を探す。読むだけ。条件はすべて省略でき、渡したものを全部満たす録画を返す（多くても 50 件。matched は条件に合った全部の数、total_gb はその合計）。要らない録画を Naoki と壁打ちして選ぶときに使い、消すのは zoom_archive__delete。文字起こしの中の言葉（transcript_words）で探せるのは、R2 に文字起こしが入っている録画だけ（2022 年ごろの録画は文字起こしが無い）。返り値: { ok, matched, returned, total_gb, rows: [{ rec_id, date, kai, title, size_gb, kind（new=11/02 以降／legacy=それより前）, r2, youtube, zoom_deleted, naming, transcript_hit? }] }",
    {
      date_from: z.string().optional().describe("この日以降（YYYY-MM-DD）"),
      date_to: z.string().optional().describe("この日以前（YYYY-MM-DD）"),
      kai: z.enum(["セミナー", "Zoom添削", "個別相談", "打ち合わせ", "その他"]).optional().describe("会の名前"),
      words: z.string().optional().describe("題名に入っている言葉（空白で区切ると全部を含むもの）"),
      transcript_words: z.string().optional().describe("文字起こしの中に入っている言葉（空白で区切ると全部を含むもの）"),
      min_gb: z.number().optional().describe("この大きさ（GB）以上"),
      max_gb: z.number().optional().describe("この大きさ（GB）以下"),
      youtube: z.boolean().optional().describe("YouTube に上がっているか"),
      kind: z.enum(["new", "legacy"]).optional().describe("new=11/02 以降に録った録画／legacy=それより前"),
      zoom_deleted: z.boolean().optional().describe("Zoom から消したか"),
      include_r2_deleted: z.boolean().optional().describe("R2 から消した録画も含めるか。既定は含めない"),
      sort: z.enum(["date_desc", "date_asc", "size_desc"]).optional().describe("並べ方。既定は新しい順"),
      limit: z.number().optional().describe("返す数（1〜50・既定 20）"),
    },
    async (args) => asMcpTextResult(await call(() => api(env).search(args)))
  );

  server.tool(
    "zoom_archive__delete",
    "Zoom の録画の自動保管で、録画 1 本を R2 から消す。書く道具。confirm を付けない（または false）ときは下見だけを返し、何も消さない（消えるファイルと GB・YouTube の有無・Zoom の状態）。confirm: true のときだけ R2 から消す。R2 には消したものを戻す仕組みが無いので、必ず下見を Naoki に見せて、Naoki が「消す」と言ったものだけ confirm: true で呼び直す。YouTube には触らない。Zoom に残っていれば、次の実行で Zoom のゴミ箱へ移す（30 日は戻せる）。R2 へまだ入っていない古い録画も消せる（R2 へは入れなくなる）。返り値: 下見 { ok, mode: preview, rec_id, kind, date, title, files: [{ key, size_mb }], total_gb, youtube, zoom_deleted, will_do } ／ 消した { ok（R2 に残りが無ければ true）, mode: deleted, …, r2_deleted_at, left_in_r2 }",
    {
      rec_id: z.string().describe("消す録画の番号。zoom_archive__search の rec_id をそのまま渡す。必須"),
      confirm: z.boolean().optional().describe("true のときだけ消す。既定は false（下見だけ）"),
    },
    async (args) => asMcpTextResult(await call(() => api(env).remove(args.rec_id, args.confirm === true)))
  );
}
