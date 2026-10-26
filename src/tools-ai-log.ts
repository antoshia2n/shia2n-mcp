import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { KNOWN_ROLES, WHERE_VALUES, checkAdd, jstRange, summarize, toJst } from "./ai-log-core.js";

/**
 * AI の利用ログの道具（2026-10-26 v1.45.0 開発部）。
 * Supabase の ai_log を直接見る（思考整理くん・X分析くんの道具と同じ形）。命名規約：ai_log__<action>
 * 依頼：https://www.notion.so/4059c6c1c43981ec88d5cfdedb66132a
 *
 *   ・ai_log__add：会話の最初に 1 回呼ぶ。1 件足すだけ（直す・消す道具は作らない）
 *   ・ai_log__list：期間の一覧と回数。読むだけ。0 件は ok: true の 件数 0、失敗は ok: false
 *   ・テーブルはブラウザから読めない（RLS あり・決まりなし）。読み書きは shia2n-mcp の管理者キーだけ
 *   ・テーブルを作る SQL は sql/ai_log.sql
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
    `AI の利用ログに 1 件残す。各役割（統括・秘書・開発部・るーみん・おかぜり・予約タスク など）の会話の最初に 1 回だけ呼ぶ。時刻（日本時間）はサーバーが付ける。where は ${WHERE_VALUES.join("・")} のどれか。title はその会話の要件を短く（200 字まで）。戻り値: 成功 { ok: true, 時刻, role, where, title, warnings? }／失敗 { ok: false, message }。`,
    {
      role: z.string().max(30).describe(`役割。決まった名前：${KNOWN_ROLES.join("・")}`),
      where: z.string().max(30).describe(`使った場所：${WHERE_VALUES.join("・")}`),
      title: z.string().max(200).describe("その会話の要件を短く"),
    },
    async ({ role, where, title }) => {
      try {
        const c = checkAdd({ role, where, title });
        if (!c.ok) return asMcpTextResult({ ok: false, message: c.message });
        const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${TABLE}?select=at,role,surface,title`, {
          method: "POST",
          headers: sbHeaders(env, { Prefer: "return=representation" }),
          body: JSON.stringify(c.row),
        });
        if (!res.ok) return asMcpTextResult({ ok: false, message: `Supabase error ${res.status}: ${await res.text()}` });
        const rows = (await res.json()) as Array<Record<string, any>>;
        const r = rows[0];
        if (!r) return asMcpTextResult({ ok: false, message: "書いた行が返ってきませんでした（入ったかは ai_log__list で確かめる）" });
        return asMcpTextResult({ ok: true, 時刻: toJst(String(r.at)), role: r.role, where: r.surface, title: r.title, ...(c.warnings.length ? { warnings: c.warnings } : {}) });
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
