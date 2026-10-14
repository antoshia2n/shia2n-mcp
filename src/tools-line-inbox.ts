/**
 * shia2n-mcp / src/tools-line-inbox.ts / 新設（2026-10-14 v1.16.0 開発部）
 * LINE タスク秘書を Claude から扱う道具 3 本（受け口そのものは src/line-inbox.ts）。
 *   line_inbox__status … 読むだけ。設定の有無・結んであるか・登録先の一覧
 *   line_inbox__pair   … 秘書グループで「/connect」と送ると出る 6 桁の番号で、そのグループと Naoki の LINE を結ぶ
 *   line_inbox__unpair … 結ぶのをやめ、Bot をそのグループから退出させる（LINE が使えなくなったとき用）
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { lineInboxStatus, pairLineInbox, unpairLineInbox } from "./line-inbox.js";

export function registerLineInboxTools(server: McpServer, env: Env): void {
  server.tool(
    "line_inbox__status",
    "LINE タスク秘書の状態を返す。読むだけ。LINE の鍵 2 つが入っているか（configured）・Workers AI の結び（ai_binding）・秘書グループと結んであるか（paired・結んだ日時）・登録先にするプロジェクトの一覧（haAku の取り組みに結んだ TaskMaster のプロジェクト）。番号そのものは末尾 4 字だけ返す。",
    {},
    async () => asMcpTextResult(await lineInboxStatus(env))
  );
  server.tool(
    "line_inbox__pair",
    "LINE タスク秘書を秘書グループと結ぶ。書く道具（Firestore の line_inbox/owner に 1 件）。Naoki が秘書グループで「/connect」と送ると Bot が 6 桁の番号を返すので、その番号を渡す。番号は 10 分有効。すでに結んであれば止める（先に line_inbox__unpair）。結んだあとは、そのグループの Naoki の発言だけを処理し、ほかのグループに招待されたらすぐ退出する。",
    { code: z.string().regex(/^\d{6}$/, "6 桁の数字").describe("秘書グループで Bot が返した 6 桁の番号") },
    async args => asMcpTextResult(await pairLineInbox(env, args.code))
  );
  server.tool(
    "line_inbox__unpair",
    "LINE タスク秘書の結びを外し、Bot を秘書グループから退出させる。書く道具。LINE で「/disconnect」と送れないとき（端末をなくした等）に使う。候補とタスクは消さない（候補は 7 日で自動で消える）。",
    {},
    async () => asMcpTextResult(await unpairLineInbox(env))
  );
}
