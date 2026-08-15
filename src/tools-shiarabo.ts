import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";

/**
 * しあらぼ管理システム（shiarabo-admin）の道具。
 * Supabase の shr_students テーブルを直接参照する。
 *
 * テーブル：shr_students
 * 命名規約：`shiarabo__<action>`
 *
 * ── 2026-08-15 の変更：列の一覧を道具側に持たない形にした ──
 *   これまでは、返す欄も取りに行く欄も、この道具の中に名前を並べて持っていた。
 *   2026-08-15 に表の列を 32 から 22 へ入れ替えたとき、道具側を直していなかったため、
 *   一覧の道具は「column shr_students.next_action does not exist」で落ち、
 *   1 件の道具は落ちた列を空文字で返して「欄はあるが全員未入力」に見えていた。
 *   同じことが 2026-08-07 にも起きている（存在しない email を返し続けていた）。
 *   2 回目なので、個別に直すのをやめて形を変える：
 *     ・取りに行くときは列を指定しない（select=*）
 *     ・返さない列だけを名前で持つ（下の 2 つの一覧）
 *   これで、表に列が増えても減っても道具は落ちず、増えた列はそのまま読める。
 *
 * ── 2026-08-15 の変更：書く道具を足した ──
 *   悩みを拾って教材の種にするのは AI の仕事のため、読むだけでは足りない。
 *   依頼書：https://www.notion.so/3bd9c6c1c439819a9b1ee47437e09cf4
 *   危ないところの押さえ方は会員の道具（members__update）と同じ形にした：
 *     ・1 回の呼び出しで 1 人だけ
 *     ・触らせない列を名前で持つ（氏名・連絡先・作られた日時など）
 *     ・preview=true で、書かずに前後の値だけを返す
 *     ・書いたあとに必ず取り直し、その結果を返す
 *
 * ── 2026-08-15 の変更：ステージの言い換えをやめた ──
 *   S0〜S4 を日本語に言い換えて返していたが、2026-08-15 に段階の値そのものを
 *   領域の名前へ入れ替える方針になったため、古い対応表は当たらない。
 *   画面に出ている文字をそのまま返す形にして、道具側の言い換えを外した。
 */

// ─── 返さない列・書かせない列 ────────────────────────────────────────────────

/** 一覧では返さない列（連絡先は個人情報のため、1 件取得のときだけ返す） */
const LIST_HIDDEN_COLUMNS = ["contact", "user_id", "workspace_id"];

/** 1 件取得でも返さない列（画面にも出ない内部の値） */
const GET_HIDDEN_COLUMNS = ["user_id", "workspace_id"];

/** 書き込みを受け付けない列 */
const UPDATE_FORBIDDEN_COLUMNS = [
  "id",
  "name",
  "contact",
  "user_id",
  "workspace_id",
  "created_at",
  "updated_at",
];

// ─── Supabase ヘルパー ────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

async function sbGet(env: Env, path: string): Promise<Row[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }
  return (await res.json()) as Row[];
}

async function sbPatch(env: Env, path: string, body: Row): Promise<Row[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method: "PATCH",
    headers: {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }
  return (await res.json()) as Row[];
}

function omit(row: Row, hidden: string[]): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (!hidden.includes(k)) out[k] = v;
  }
  return out;
}

// ─── ツール登録 ───────────────────────────────────────────────────────────────

export function registerShiaraboTools(server: McpServer, env: Env): void {

  // ─── 1. shiarabo__list_students ──────────────────────────────────────────
  server.tool(
    "shiarabo__list_students",
    "しあらぼ管理の生徒一覧を取得する。統括Claudeがスプリントレビュー・顧問レポートで生徒状況を確認するときに使う。archived=false の全生徒を sort_order 昇順で返す。表にある列をそのまま返すため、列が増えても道具の側の直しは要らない（連絡先 contact だけは個人情報のため一覧では返さない。必要なときは shiarabo__get_student を使う）。戻り値: { ok, total, hidden_columns, students: [表の列がそのまま入った行] }。",
    {
      include_archived: z
        .boolean()
        .optional()
        .describe("アーカイブ済み生徒を含めるか（デフォルト: false）"),
      stage: z
        .string()
        .optional()
        .describe("段階でフィルタ（画面に出ている値をそのまま渡す）。省略時は全件"),
      status: z
        .string()
        .optional()
        .describe("状態でフィルタ（画面に出ている値をそのまま渡す）。省略時は全件"),
    },
    async (args) => {
      const includeArchived = args.include_archived ?? false;

      let path = "/shr_students?select=*&order=sort_order.asc";
      if (!includeArchived) path += "&archived=eq.false";
      if (args.stage)  path += `&stage=eq.${encodeURIComponent(args.stage)}`;
      if (args.status) path += `&status=eq.${encodeURIComponent(args.status)}`;

      const rows = await sbGet(env, path);
      const students = rows.map((r) => omit(r, LIST_HIDDEN_COLUMNS));

      return asMcpTextResult({
        ok: true,
        total: students.length,
        hidden_columns: LIST_HIDDEN_COLUMNS,
        students,
      });
    }
  );

  // ─── 2. shiarabo__get_student ─────────────────────────────────────────────
  server.tool(
    "shiarabo__get_student",
    "しあらぼ生徒 1 件の詳細を id で取得する。shiarabo__list_students で id を確認してから使う。表にある列をそのまま返す（連絡先 contact を含む）。戻り値: { ok, hidden_columns, student: 表の列がそのまま入った行 }。",
    {
      id: z.number().describe("生徒の id（shiarabo__list_students の id フィールド）"),
    },
    async (args) => {
      const rows = await sbGet(env, `/shr_students?select=*&id=eq.${args.id}&limit=1`);
      if (rows.length === 0) {
        return asMcpTextResult({ ok: false, error: `id=${args.id} の生徒が見つかりません` });
      }
      return asMcpTextResult({
        ok: true,
        hidden_columns: GET_HIDDEN_COLUMNS,
        student: omit(rows[0], GET_HIDDEN_COLUMNS),
      });
    }
  );

  // ─── 3. shiarabo__update_student ──────────────────────────────────────────
  server.tool(
    "shiarabo__update_student",
    "しあらぼ生徒 1 件の欄を書き換える。1 回の呼び出しで 1 人だけ。updates に渡した欄だけが変わり、渡さなかった欄は元の値のまま残る。氏名・連絡先・id・作られた日時は書き換えられない（400 で返る）。preview=true のときは書かずに、今の値と書いたあとの値だけを返す。書いたあとは必ず取り直した結果を返す。戻り値: { ok, preview, id, changed: {欄: {before, after}}, student: 取り直した行 }。",
    {
      id: z.number().describe("生徒の id"),
      updates: z
        .record(z.string(), z.any())
        .describe("書き換える欄と値。例: { \"goal\": \"3か月で月商30万\", \"seeded\": true }"),
      reason: z.string().min(1).describe("書き換える理由（記録に残す。空文字は不可）"),
      preview: z
        .boolean()
        .optional()
        .describe("true で書かずに前後の値だけを返す。初回は true を推奨（デフォルト: false）"),
    },
    async (args) => {
      const preview = args.preview ?? false;
      const keys = Object.keys(args.updates ?? {});

      if (keys.length === 0) {
        return asMcpTextResult({ ok: false, error: "updates が空です。書き換える欄を 1 つ以上渡してください" });
      }

      const forbidden = keys.filter((k) => UPDATE_FORBIDDEN_COLUMNS.includes(k));
      if (forbidden.length > 0) {
        return asMcpTextResult({
          ok: false,
          error: `書き換えられない欄が含まれています：${forbidden.join(" / ")}`,
          forbidden_columns: UPDATE_FORBIDDEN_COLUMNS,
        });
      }

      // 1. 今の行を取る（存在確認と、前後の値を出すため）
      const beforeRows = await sbGet(env, `/shr_students?select=*&id=eq.${args.id}&limit=1`);
      if (beforeRows.length === 0) {
        return asMcpTextResult({ ok: false, error: `id=${args.id} の生徒が見つかりません` });
      }
      const before = beforeRows[0];

      // 2. 表に無い欄が混ざっていないかを、今の行の列名で確かめる
      const unknown = keys.filter((k) => !(k in before));
      if (unknown.length > 0) {
        return asMcpTextResult({
          ok: false,
          error: `表に無い欄が含まれています：${unknown.join(" / ")}`,
          columns_in_table: Object.keys(before),
        });
      }

      const changed: Record<string, { before: unknown; after: unknown }> = {};
      for (const k of keys) changed[k] = { before: before[k], after: args.updates[k] };

      if (preview) {
        return asMcpTextResult({
          ok: true,
          preview: true,
          id: args.id,
          reason: args.reason,
          changed,
          note: "書いていません。実行するには preview を外して同じ内容で呼び直してください",
        });
      }

      // 3. 書く
      //    更新時刻は呼び出し側からは受け付けない（UPDATE_FORBIDDEN_COLUMNS）が、
      //    道具の側で必ず入れる。表に自動で時刻を入れる仕掛けが無く、画面の側だけが
      //    入れていたため、道具から書くと更新時刻が動かないままだった（2026-08-15 実測）。
      //    数字の欄は中身に更新日を含む定義のため、いつの値かが分からなくなる。
      const patch: Row = { ...(args.updates as Row), updated_at: new Date().toISOString() };
      await sbPatch(env, `/shr_students?id=eq.${args.id}`, patch);

      // 4. 取り直す（返り値が成功でも、入ったかどうかは取り直すまで分からない）
      const afterRows = await sbGet(env, `/shr_students?select=*&id=eq.${args.id}&limit=1`);
      const after = afterRows[0] ?? {};
      for (const k of keys) changed[k] = { before: before[k], after: after[k] };

      const notSaved = keys.filter((k) => JSON.stringify(after[k]) !== JSON.stringify(args.updates[k]));

      return asMcpTextResult({
        ok: notSaved.length === 0,
        preview: false,
        id: args.id,
        reason: args.reason,
        changed,
        not_saved: notSaved,
        student: omit(after, GET_HIDDEN_COLUMNS),
      });
    }
  );
}
