/**
 * 案件くんの画面から案件シートを読む・足す受け口（2026-10-22 v1.35.0 開発部）。
 * Naoki「アプリの方もデータが探しやすく、一覧性があるように」→ 案件シートを正本のまま、案件くんの「資料」とプロジェクトのページに出す。
 *
 *   GET  /anken/sheet?case_id=…  … 案件に登録した案件シートの全タブ（行：名前・リンク・詳細・ジャンル・行の番号）
 *   POST /anken/sheet            … { case_id, tab, items: [{ name, url, detail? }] }（20 件まで）。道具 anken__sheet_add_links と同じ 1 本を通す
 *
 * 守り方は TaskMaster の受け口（haaku-task-link-http.ts）と同じ
 *   ・呼べるのは案件くんの住所（https://anken.shia2n.jp）から開いた画面だけ
 *   ・Firebase のログインの札を確かめ、Naoki 本人（NAOKI_UID）のときだけ読む・書く
 *   ・案件は本人の行だけ（user_id で絞る）
 */
import type { Env } from "./index.js";
import { verifyIdToken } from "./gate.js";
import { addLinks, readSheet, sheetIdOf } from "./anken-sheet-io.js";
import { parseAddBody } from "./anken-sheet.js";

export const ANKEN_ORIGIN = "https://anken.shia2n.jp";
export const ANKEN_SHEET_PATH = "/anken/sheet";

const headers = { "Access-Control-Allow-Origin": ANKEN_ORIGIN, "Vary": "Origin", "Cache-Control": "no-store" };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers });

async function caseOf(env: Env, uid: string, caseId: string): Promise<{ id: string; name: string; sheet_url: string | null } | null> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/ak_cases?select=id,name,sheet_url&id=eq.${encodeURIComponent(caseId)}&user_id=eq.${encodeURIComponent(uid)}`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, ...(/^eyJ/.test(String(env.SUPABASE_SERVICE_ROLE_KEY || "")) ? { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } : {}) },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  const rows = (await res.json()) as any[];
  return rows[0] ?? null;
}

export async function handleAnkenSheet(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Origin") !== ANKEN_ORIGIN) return Response.json({ error: "origin_not_allowed" }, { status: 403 });
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...headers,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Authorization,Content-Type", "Access-Control-Max-Age": "300" } });
  }
  if (!["GET", "POST"].includes(request.method)) return reply({ error: "method_not_allowed" }, 405);
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return reply({ error: "missing_firebase_token", message: "ログインの札がありません。開き直してください" }, 401);
  let who;
  try { who = await verifyIdToken(auth.slice(7)); }
  catch { return reply({ error: "firebase_auth_failed", message: "ログインを確かめられませんでした。少しおいてもう一度" }, 503); }
  if (!who || !env.NAOKI_UID || who.uid !== env.NAOKI_UID) return reply({ error: "not_authorized_owner", message: "Naoki 本人のログインではありません" }, 403);

  try {
    if (request.method === "GET") {
      const caseId = new URL(request.url).searchParams.get("case_id") || "";
      if (!/^[\w-]{8,64}$/.test(caseId)) return reply({ error: "invalid_case_id", message: "案件が分かりません" }, 400);
      const c = await caseOf(env, who.uid, caseId);
      if (!c) return reply({ error: "case_not_found", message: "案件が見つかりません" }, 404);
      const id = sheetIdOf(c.sheet_url);
      if (!id) return reply({ ok: true, sheet: null, tabs: [], message: "管理シートの住所がまだ入っていません（設定から入れる）" });
      const s = await readSheet(env, id);
      return reply({ ok: true, sheet: { id, title: s.title, url: `https://docs.google.com/spreadsheets/d/${id}/edit` }, tabs: s.tabs, read_at: new Date().toISOString() });
    }
    let body;
    try { body = parseAddBody(await request.text()); }
    catch (e) { return reply({ error: String((e as Error).message), message: "送った中身の形が違います" }, 400); }
    const c = await caseOf(env, who.uid, body.caseId);
    if (!c) return reply({ error: "case_not_found", message: "案件が見つかりません" }, 404);
    const id = sheetIdOf(c.sheet_url);
    if (!id) return reply({ error: "no_sheet", message: "管理シートの住所がまだ入っていません（設定から入れる）" }, 400);
    const { created, plan } = await addLinks(env, id, body.tab, body.items);
    return reply({ ok: true, created, added: plan.rows.length, skipped: plan.skipped, rows: plan.rows.length ? [plan.startRow, plan.startRow + plan.rows.length - 1] : null });
  } catch (e) {
    const m = String((e as Error).message || e);
    const denied = /Sheets 403/.test(m);
    return reply({ error: denied ? "sheet_not_shared" : "sheet_failed",
      message: denied ? "案件シートに書き込み用の宛先が共有されていません（編集者で共有する）" : `案件シートを読めませんでした：${m.slice(0, 200)}` }, 502);
  }
}
