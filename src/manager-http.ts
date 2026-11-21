/**
 * shia2n-mcp / src/manager-http.ts / 新設（2026-11-21 v1.125.0 開発部・マネージャーくん 1便目）
 *
 * マネージャーくんの画面と読み口。新しいリポジトリや住所を作らず、この Worker の /manager に置く（Naoki の手は Merge だけ）。
 *   GET  /manager                     … 画面（src/manager-page.ts）。右上は各アプリ共通の外枠（src/manager-assets.ts に束ねたもの）
 *   GET  /manager/shell.js・favicon.svg・favicon-32.png・apple-touch-icon.png
 *   GET  /manager/api/chats?state=&ai= … 一覧と状態ごとの数（state 空＝閉じた以外・すべて＝全部）
 *   GET  /manager/api/chat?no=        … チャット 1 本とピンの目次
 *   GET  /manager/api/pin?chat=&n=    … ピンの全文
 *   GET  /manager/api/search?q=       … 題・何をしているか・ピンの全文から探す
 *   POST /manager/api/update          … { no, state?, doing?, name?, url? }
 *
 * 守り方は案件くんの受け口（anken-sheet-http.ts）と同じ：Firebase のログインの札を確かめ、Naoki 本人（NAOKI_UID）のときだけ読む・書く。
 * 画面と読み口は同じ住所なので、ほかの住所からの呼び出し（Origin が違うもの）は断る。
 */
import type { Env } from "./index.js";
import { verifyIdToken } from "./gate.js";
import { STATES, checkUpdate, chatOut, jstShort, normState, pinOut } from "./manager-core.js";
import { ManagerError, chatByNo, listChats, pinFull, pinIndex, search, stateCounts, updateChat } from "./manager-store.js";
import { APPLE_TOUCH_PNG_B64, FAVICON_32_PNG_B64, FAVICON_SVG, SHELL_JS } from "./manager-assets.js";
import { managerPage } from "./manager-page.js";

export const MANAGER_PATH = "/manager";

const API_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: API_HEADERS });

function b64(s: string): Uint8Array {
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function asset(path: string): Response | null {
  const cache = "public, max-age=3600";
  if (path === "/manager/shell.js") return new Response(SHELL_JS, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": cache } });
  if (path === "/manager/favicon.svg") return new Response(FAVICON_SVG, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": cache } });
  if (path === "/manager/favicon-32.png") return new Response(b64(FAVICON_32_PNG_B64), { headers: { "Content-Type": "image/png", "Cache-Control": cache } });
  if (path === "/manager/apple-touch-icon.png") return new Response(b64(APPLE_TOUCH_PNG_B64), { headers: { "Content-Type": "image/png", "Cache-Control": cache } });
  return null;
}

async function owner(request: Request, env: Env): Promise<Response | null> {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return reply({ ok: false, error: "missing_firebase_token", message: "ログインの札がありません。開き直してください" }, 401);
  let who;
  try { who = await verifyIdToken(auth.slice(7)); }
  catch { return reply({ ok: false, error: "firebase_auth_failed", message: "ログインを確かめられませんでした。少しおいてもう一度" }, 503); }
  if (!who || !env.NAOKI_UID || who.uid !== env.NAOKI_UID) return reply({ ok: false, error: "not_authorized_owner", message: "Naoki 本人のログインではありません" }, 403);
  return null;
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return reply({ ok: false, error: "origin_not_allowed" }, 403);
  const denied = await owner(request, env);
  if (denied) return denied;
  const op = url.pathname.slice(`${MANAGER_PATH}/api/`.length);
  const sp = url.searchParams;
  try {
    if (request.method === "GET" && op === "chats") {
      const raw = (sp.get("state") || "").trim();
      const st = raw === "すべて" ? "すべて" : raw ? normState(raw) : null;
      if (raw && !st) return reply({ ok: false, message: `state は ${STATES.join("・")}・すべて のどれかです` }, 400);
      const ai = (sp.get("ai") || "").trim();
      const [rows, counts] = await Promise.all([
        listChats(env, { state: st, ai: ai === "claude" || ai === "gpt" ? ai : null, limit: 300 }),
        stateCounts(env),
      ]);
      return reply({ ok: true, chats: rows.map(chatOut), counts });
    }
    if (request.method === "GET" && op === "chat") {
      const no = Number(sp.get("no"));
      if (!Number.isInteger(no) || no <= 0) return reply({ ok: false, message: "チャット番号が分かりません" }, 400);
      const c = await chatByNo(env, no);
      if (!c) return reply({ ok: false, message: `チャット ${no} はありません` }, 404);
      const pins = await pinIndex(env, no);
      return reply({ ok: true, chat: chatOut(c), pins: pins.map((p) => ({ 番号: Number(p.n), 題: p.title, 作った: jstShort(p.created_at) })) });
    }
    if (request.method === "GET" && op === "pin") {
      const no = Number(sp.get("chat")), n = Number(sp.get("n"));
      if (!Number.isInteger(no) || no <= 0 || !Number.isInteger(n) || n <= 0) return reply({ ok: false, message: "ピンが分かりません" }, 400);
      const [c, p] = await Promise.all([chatByNo(env, no), pinFull(env, no, n)]);
      if (!p) return reply({ ok: false, message: `ピン ${no}#${n} はありません` }, 404);
      return reply({ ok: true, pin: pinOut(p, c, true) });
    }
    if (request.method === "GET" && op === "search") {
      const q = (sp.get("q") || "").trim().slice(0, 200);
      if (!q) return reply({ ok: true, hits: [] });
      const rows = await search(env, q, 50);
      return reply({ ok: true, hits: rows.map((r) => ({
        種類: r.kind === "pin" ? "ピン" : "チャット",
        ピン: r.kind === "pin" ? `${r.chat_no}#${r.pin_n}` : null,
        チャット番号: Number(r.chat_no), 番号: r.pin_n == null ? null : Number(r.pin_n),
        題: r.title, チャットの名前: r.chat_name, 状態: r.state, 抜き出し: String(r.snippet ?? ""), 日時: jstShort(r.at),
      })) });
    }
    if (request.method === "POST" && op === "update") {
      let body: Record<string, unknown>;
      try { body = await request.json() as Record<string, unknown>; } catch { return reply({ ok: false, message: "送った中身の形が違います" }, 400); }
      const no = Number(body.no);
      if (!Number.isInteger(no) || no <= 0) return reply({ ok: false, message: "チャット番号が分かりません" }, 400);
      const c = checkUpdate({ state: body.state, doing: body.doing, name: body.name, url: body.url });
      if (!c.ok) return reply({ ok: false, message: c.message }, 400);
      const after = await updateChat(env, no, c.patch);
      return reply({ ok: true, chat: chatOut(after) });
    }
    return reply({ ok: false, error: "not_found" }, 404);
  } catch (e) {
    if (e instanceof ManagerError) return reply({ ok: false, error: e.code, message: e.message }, e.code === "chat_not_found" ? 404 : 502);
    return reply({ ok: false, error: "failed", message: String((e as Error)?.message || e).slice(0, 300) }, 502);
  }
}

export async function handleManager(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path.startsWith(`${MANAGER_PATH}/api/`)) return api(request, env, url);
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405 });
  if (path === MANAGER_PATH || path === `${MANAGER_PATH}/`) {
    return new Response(managerPage(), { headers: {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'", "Referrer-Policy": "same-origin",
    } });
  }
  return asset(path) ?? new Response("not found", { status: 404 });
}
