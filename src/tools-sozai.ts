import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import { getGoogleTokenForScope } from "./google-token.js";
import type { Env } from "./index.js";
import { DRIVE_API, KINDS, SCENES, checkLook, putSozaiRows, resolveSheetId, toBase64, type DriveMeta, type SheetsJson } from "./sozai-core.js";

/**
 * 素材の一覧（ドライブの「素材」フォルダの表）に行を足す道具。命名規約：sozai__<action>
 *
 * 2026-10-20 新設（v1.22.0・Naoki「OK」14:21）：sozai__put_row
 *   ・毎朝 5:19 の振り分け（scheduled task）が、受け箱から移したものを 1 件 1 行で足す
 *   ・足すだけ。すでにある行は書き換えない・消さない。同じ住所の行があれば足さない
 *   ・表の番号の設定は要らない。機械用の身分（FIREBASE_SA_EMAIL）に共有された「素材の一覧」を名前で探す。
 *     SOZAI_SHEET_ID（任意）があればそちらを使う
 *   ・中身は src/sozai-core.ts。試験は test/sozai-core.test.ts
 *
 * 2026-10-20 追加（v1.23.0）：sozai__look
 *   ・受け箱の画面写真を、振り分けが目で見るための道具。読むだけ
 *   ・Google ドライブの道具の read_file_content は画像の文字しか返さず、空で返る写真があったため（10/20 の試しで 4 枚中 3 枚）
 *   ・機械用の身分に共有されたファイルだけ見える（受け箱を閲覧者で共有している）
 */

const SCOPE = "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.metadata.readonly";
const LOOK_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

export function registerSozaiTools(server: McpServer, env: Env): void {
  const row = z.object({
    振り分けた日: z.string().describe("YYYY-MM-DD（日本時間）"),
    種類: z.string().describe(`${KINDS.join("・")} のどれか`),
    名前: z.string().describe("振り分けで付けた名前（例：2026-10-21_実績_X記事インプ120万.png）"),
    何が写っているか: z.string().describe("1〜2 文"),
    数字: z.string().optional().describe("実績のときだけ。「何の数字：値（いつ時点）」"),
    使う場面: z.string().describe(`${SCENES.join("・")} から 1 つ以上（「、」でつなぐ）`),
    タグ: z.string().optional().describe("振り分けのルールのタグの一覧から（「、」でつなぐ）"),
    掲載の許可: z.string().optional().describe("生徒の声のときだけ。空なら「未確認」で入る"),
    住所: z.string().describe("移したあとのファイルの住所（https://drive.google.com/… か https://docs.google.com/…）"),
    元の名前: z.string().optional().describe("受け箱に入っていたときの名前"),
  });
  server.tool(
    "sozai__put_row",
    "ドライブの「素材」フォルダの表「素材の一覧」に、振り分けた素材を 1 件 1 行で足す（1 回 30 行まで）。足すだけで、すでにある行は書き換えない。同じ住所の行がすでにあれば足さずに skipped で返す。種類は 実績・生徒の声・お手本・セミナー資料・自分の写真・図解、使う場面は セミナー・X記事・note・告知・コンサル資料 だけ。数字は実績だけ、掲載の許可は生徒の声だけ（空なら未確認）。1 行でも形が合わなければ 1 行も書かない。dry_run=true なら書かずに、入れ先の行だけを返す。",
    {
      rows: z.array(row).describe("足す行（1〜30）"),
      dry_run: z.boolean().optional().describe("true なら書かずに、入れ先の行だけを返す"),
    },
    async (args) => {
      try {
        const token = await getGoogleTokenForScope(env, SCOPE);
        const call: SheetsJson = async <T>(url: string, init: RequestInit = {}) => {
          const headers = new Headers(init.headers);
          headers.set("authorization", `Bearer ${token}`);
          if (init.body) headers.set("content-type", "application/json");
          const res = await fetch(url, { ...init, headers });
          if (!res.ok) throw new Error(`Google ${res.status}: ${await res.text()}`);
          return (await res.json()) as T;
        };
        const sheet = await resolveSheetId(call, env.SOZAI_SHEET_ID);
        if ("error" in sheet) {
          return asMcpTextResult({ ok: false, written: false, reason: sheet.error, share_with: env.FIREBASE_SA_EMAIL });
        }
        return asMcpTextResult(await putSozaiRows(call, sheet.id, args));
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        const noAccess = /Google (403|404)/.test(message);
        return asMcpTextResult({
          ok: false,
          written: false,
          reason: noAccess
            ? "素材の一覧を開けません。表を share_with のメールアドレスへ編集者で共有してください"
            : "Google への呼び出しで止まりました",
          share_with: noAccess ? env.FIREBASE_SA_EMAIL : undefined,
          error: message.slice(0, 500),
        });
      }
    }
  );

  server.tool(
    "sozai__look",
    "ドライブの「素材」の受け箱にある画像（png・jpeg・webp・gif、4.5MB まで）を、そのまま画像として返す（読むだけ）。振り分けの前に、画面写真に何が写っているかを目で見るために使う。Google ドライブの道具の read_file_content が空を返す画像でも見られる。見えるのは機械用の身分に共有されたファイルだけ。",
    {
      file_id: z.string().describe("ドライブのファイル ID（search_files の id）"),
    },
    async ({ file_id }) => {
      try {
        const token = await getGoogleTokenForScope(env, LOOK_SCOPE);
        const auth = { authorization: `Bearer ${token}` };
        const id = encodeURIComponent(file_id.trim());
        const metaRes = await fetch(`${DRIVE_API}/${id}?fields=${encodeURIComponent("id,name,mimeType,size")}&supportsAllDrives=true`, { headers: auth });
        if (!metaRes.ok) throw new Error(`Google ${metaRes.status}: ${await metaRes.text()}`);
        const meta = (await metaRes.json()) as DriveMeta;
        const check = checkLook(meta);
        if ("error" in check) return asMcpTextResult({ ok: false, reason: check.error, name: meta.name });
        const res = await fetch(`${DRIVE_API}/${id}?alt=media&supportsAllDrives=true`, { headers: auth });
        if (!res.ok) throw new Error(`Google ${res.status}: ${await res.text()}`);
        const data = toBase64(new Uint8Array(await res.arrayBuffer()));
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ ok: true, id: meta.id, name: meta.name, mimeType: meta.mimeType, size: Number(meta.size) }) },
            { type: "image" as const, data, mimeType: meta.mimeType as string },
          ],
        };
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        const noAccess = /Google (403|404)/.test(message);
        return asMcpTextResult({
          ok: false,
          reason: noAccess
            ? "このファイルを開けません。受け箱を share_with のメールアドレスへ閲覧者で共有してください"
            : "Google への呼び出しで止まりました",
          share_with: noAccess ? env.FIREBASE_SA_EMAIL : undefined,
          error: message.slice(0, 500),
        });
      }
    }
  );
}
