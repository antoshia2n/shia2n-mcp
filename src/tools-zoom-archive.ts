/**
 * shia2n-mcp / src/tools-zoom-archive.ts（2026-11-02 開発部・経理系の依頼 1 便 1）
 *
 * Zoom の録画の自動保管の一覧を返す道具 1 本。
 *   zoom_archive__list  録画 1 本ごとに「R2 に入った・YouTube に上がった・Zoom から消した」と名前の付け方を並べる
 *
 * 中身は zoom-to-youtube の ArchiveApi（RPC）が持つ。こちらは呼ぶだけで、数え方は持たない。
 * 結びは wrangler.jsonc の services（binding ZOOM_ARCHIVE・entrypoint ArchiveApi）。
 * 外の住所を通らないので合言葉は要らない。一覧には限定公開の住所が載るため、公開の口にはしていない。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";

export function registerZoomArchiveTools(server: McpServer, env: Env): void {
  server.tool(
    "zoom_archive__list",
    "Zoom の録画の自動保管（zoom-to-youtube）の一覧を返す。読むだけ。録画 1 本ごとに、原本が R2 に入ったか（r2・r2_key）・YouTube に上がったか（youtube・youtube_url は限定公開の住所なので外へ貼らない）・Zoom から消したか（zoom_deleted）・名前の付け方（naming：ai=AI が付けた／blocked=会員の名前が混ざったので止めた／no_transcript=文字起こしが無い／failed=AI が答えなかった／未=第18版より前の録画）を並べる。失敗は rows とは別に failures で返し、failure_count が 0 なら失敗は 0 件（一覧が空でも failures は別に数える）。返り値: { ok, count, counts: { r2, youtube, both, zoom_deleted }, rows: [{ rec_id, date, title, r2, r2_key, youtube, youtube_url, zoom_deleted, zoom_deleted_at, naming, naming_note, updated_at }], failure_count, failures: [{ where（見つける／録画／台帳／控え）, what, error }] }",
    {},
    async () => {
      if (!env.ZOOM_ARCHIVE) {
        throw new Error("zoom-to-youtube への結び（ZOOM_ARCHIVE）がありません。wrangler.jsonc の services を確かめてください");
      }
      try {
        return asMcpTextResult(await env.ZOOM_ARCHIVE.list());
      } catch (e) {
        throw new Error(
          `zoom-to-youtube の一覧を読めませんでした（第18版より前のまま・止まっている、のどちらか）：${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  );
}
