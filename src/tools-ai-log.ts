import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { KNOWN_ROLES, WHERE_VALUES, checkAdd, jstRange, summarize, toJst } from "./ai-log-core.js";
import { aiOf, areaName, chatName, chatOut, chatUrl, firstState } from "./manager-core.js";
import { createChat, worksWithChats } from "./manager-store.js";

/**
 * AI の利用ログの道具（2026-10-26 v1.45.0 開発部）。
 * Supabase の ai_log を直接見る（思考整理くん・X分析くんの道具と同じ形）。命名規約：ai_log__<action>
 * 依頼：https://www.notion.so/4059c6c1c43981ec88d5cfdedb66132a
 *
 *   ・ai_log__add：会話の最初に 1 回呼ぶ。1 件足すだけ（直す・消す道具は作らない）
 *   ・ai_log__list：期間の一覧と回数。読むだけ。0 件は ok: true の 件数 0、失敗は ok: false
 *   ・テーブルはブラウザから読めない（RLS あり・決まりなし）。読み書きは shia2n-mcp の管理者キーだけ
 *   ・テーブルを作る SQL は sql/ai_log.sql
 *   ・v1.125.0（2026-11-21 マネージャーくん 1便目）：ai_log__add は同じ呼び出しで、マネージャーくんの台帳（mk_chats）に
 *     このチャットの行を 1 つ作り、チャット番号を返す（チャットを立てる道具を別に作らず一本化）。予約タスクの行は最初から閉じた。
 *     台帳の行が作れなくても利用ログは残し、warnings で知らせる（ログを止めないため）
 */

const TABLE = "ai_log";
const PAGE = 1000;
const MAX_PAGES = 20;

function sbHeaders(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    ...(/^eyJ/.test(String(env.SUPABASE_SERVICE_ROLE_KEY || "")) ? { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } : {}),
    "Content-Type": "application/json",
    ...extra,
  };
}

export function registerAiLogTools(server: McpServer, env: Env): void {

  // ─── 1. ai_log__add ──────────────────────────────────────────────
  server.tool(
    "ai_log__add",
    `AI の利用ログに 1 件残し、同時にマネージャーくんの台帳にこのチャットの行を作る。各役割（統括・秘書・開発部・るーみん・おかぜり・予約タスク など）の会話の最初に 1 回だけ呼ぶ。時刻（日本時間）はサーバーが付ける。where は ${WHERE_VALUES.join("・")} のどれか。title はその会話の要件を短く（200 字まで・台帳のチャットの名前になる）。このチャットの住所が分かれば chat_url に渡す（Claude Code はセッションの住所、分からなければ省く）。戻り値の チャット.番号 を覚えておき、ピン（manager__pin）と状態の書き直し（manager__update）に渡す。戻り値の 次に に書かれたことはそのとおりにする。戻り値: 成功 { ok: true, 時刻, role, where, title, チャット: { 番号, 名前, 状態, … }, warnings? }／失敗 { ok: false, message }。`,
    {
      role: z.string().max(30).describe(`役割。決まった名前：${KNOWN_ROLES.join("・")}`),
      where: z.string().max(30).describe(`使った場所：${WHERE_VALUES.join("・")}`),
      title: z.string().max(200).describe("その会話の要件を短く"),
      chat_url: z.string().max(500).optional().describe("このチャットの住所（https://…）。分からなければ省く"),
    },
    async ({ role, where, title, chat_url }) => {
      try {
        const c = checkAdd({ role, where, title });
        if (!c.ok) return asMcpTextResult({ ok: false, message: c.message });
        const u = chatUrl(chat_url);
        const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${TABLE}?select=id,at,role,surface,title`, {
          method: "POST",
          headers: sbHeaders(env, { Prefer: "return=representation" }),
          body: JSON.stringify(c.row),
        });
        if (!res.ok) return asMcpTextResult({ ok: false, message: `Supabase error ${res.status}: ${await res.text()}` });
        const rows = (await res.json()) as Array<Record<string, any>>;
        const r = rows[0];
        if (!r) return asMcpTextResult({ ok: false, message: "書いた行が返ってきませんでした（入ったかは ai_log__list で確かめる）" });
        // v1.125.0：マネージャーくんの台帳にこのチャットの行を作る（失敗してもログは残っているので ok のまま知らせる）
        const warnings = [...c.warnings];
        let chat: ReturnType<typeof chatOut> | null = null;
        let openWorks: string[] = [];
        if (!u.ok) warnings.push(`${u.message}（住所は入れずに台帳の行を作りました。manager__update の url で直せます）`);
        try {
          const row = await createChat(env, {
            name: chatName(c.row.title), ai: aiOf(c.row.surface), state: firstState(c.row.surface),
            url: u.ok ? u.url : null, role: c.row.role, surface: c.row.surface, ai_log_id: r.id ?? null,
            area: areaName(c.row.role), // v1.128.0：棚はまず役割。拡張がプロジェクト名を読んだらそちらで置き換わる
          });
          chat = chatOut(row);
          // v1.129.0：同じ分野の開いている作業（このチャットの作業を決めるため）
          try {
            const ws = await worksWithChats(env, { area: row.area ?? null });
            openWorks = ws.slice(0, 15).map((x) => x.work.name);
          } catch { /* 作業が読めなくても台帳は立っている */ }
        } catch (e) { warnings.push(`マネージャーくんの台帳に行を作れませんでした：${String((e as Error)?.message || e).slice(0, 200)}`); }
        return asMcpTextResult({ ok: true, 時刻: toJst(String(r.at)), role: r.role, where: r.surface, title: r.title,
          ...(chat ? { チャット: chat, 開いている作業: openWorks, 次に: `このチャットの番号は ${chat.番号}。ピンは manager__pin、状態は manager__update、やったことは manager__done に chat=${chat.番号} を渡す。` +
            (c.row.surface === "予約タスク" ? "" : `最初の返事を書く前に、このチャットの作業を manager__work の name で決め、同じ呼び出しで kind に作業の型（仕事の種類。例「X のポスト作成」「アプリの便」）も渡す（開いている作業に同じ作業があればその名前をそのまま、無ければ何の作業か分かる短い名前で）。作業全体が終わったら manager__work の state に「済み」。`) +
            `ひとまとまりの作業が終わった区切りごとに manager__done で「○○をした」を 1 行残す（PR を出したら manager__work の pr に住所）` +
            (c.row.surface === "予約タスク" ? "" : `。最初の返事の末尾に「（台帳 #${chat.番号}）」と 1 回だけ書く（シアニンパネルがこの字でチャットの住所を結ぶ）`) } : {}),
          ...(warnings.length ? { warnings } : {}) });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 2. ai_log__list ─────────────────────────────────────────────
  server.tool(
    "ai_log__list",
    `AI の利用ログを期間で読む（読むだけ）。from・to は日本時間の日付 YYYY-MM-DD（両端を含む・最大 31 日）。from を省くと今日、to を省くと from と同じ日。戻り値: { ok: true, from, to, 件数, 役割ごと: { role: 回数 }, 場所ごと: { where: 回数 }, 日ごと: [{ 日, 回数, 役割ごと }]（0 回の日も並ぶ）, 一覧: [{ 時刻, role, where, title }]（古い順） }／失敗 { ok: false, message }。0 件は ok: true で 件数 0。`,
    {
      from: z.string().max(10).optional().describe("始まりの日（日本時間・YYYY-MM-DD）。省略で今日"),
      to: z.string().max(10).optional().describe("終わりの日（日本時間・YYYY-MM-DD・その日を含む）。省略で from と同じ日"),
    },
    async ({ from, to }) => {
      try {
        const r = jstRange(from, to);
        if (!r.ok) return asMcpTextResult({ ok: false, message: r.message });
        const rows: Array<Record<string, any>> = [];
        for (let p = 0; p < MAX_PAGES; p++) {
          const q = `select=at,role,surface,title&at=gte.${encodeURIComponent(r.startIso)}&at=lt.${encodeURIComponent(r.endIso)}&order=at.asc&limit=${PAGE}&offset=${p * PAGE}`;
          const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${TABLE}?${q}`, { headers: sbHeaders(env) });
          if (!res.ok) return asMcpTextResult({ ok: false, message: `Supabase error ${res.status}: ${await res.text()}` });
          const page = (await res.json()) as Array<Record<string, any>>;
          rows.push(...page);
          if (page.length < PAGE) break;
          if (p === MAX_PAGES - 1) return asMcpTextResult({ ok: false, message: `行が ${PAGE * MAX_PAGES} 件を超えたので止めました。期間を短くしてください` });
        }
        return asMcpTextResult({ ok: true, from: r.from, to: r.to, ...summarize(rows, r.days) });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );
}
