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
 *   GET  /manager/api/transcript?no=  … 自動で読んだ全文（v1.126.0）
 *   POST /manager/api/ext-key         … 拡張の鍵を 1 本出す（前の鍵は止める・鍵はこの 1 回しか返さない）（v1.126.0）
 *   POST /manager/api/ext-revoke      … 拡張の鍵を全部止める（v1.126.0）
 *   GET  /manager/api/ext-status      … 鍵がつながっているか・最後に使った時刻（v1.126.0）
 *   POST /manager/ext/capture         … シアニンパネルが読んだチャットの全文を受ける。拡張の鍵（書くだけ）で通す（v1.126.0）
 *   manager.shia2n.jp の / は /manager と同じ画面（v1.126.0）
 *   v1.128.0（4便目）：chats に area（分野で絞る）と areas（棚ごとの数）、chat にやったことと最後の頼みごと、
 *   GET /manager/api/activity?range=today|week … 今日・今週やったこと（拡張だけのチャットは最後の頼みごとで代わりに出す）
 *   POST /manager/api/update に area（画面で決めた分野は拡張が上書きしない）
 *   v1.129.0（5便目）：GET works（作業の木）・GET work?id=（作業の中身）・POST work-update・POST work-merge、update に work（名前）・work_id
 *
 * 守り方は案件くんの受け口（anken-sheet-http.ts）と同じ：Firebase のログインの札を確かめ、Naoki 本人（NAOKI_UID）のときだけ読む・書く。
 * 画面と読み口は同じ住所なので、ほかの住所からの呼び出し（Origin が違うもの）は断る。
 */
import type { Env } from "./index.js";
import { verifyIdToken } from "./gate.js";
import { STATES, areaName, normWorkState, prLinks, workName, workOut, checkCapture, checkUpdate, chatOut, jstShort, jstSince, keyHash, newKey, normState, pinOut } from "./manager-core.js";
import { ManagerError, applyCapture, areaCounts, attachWork, attachWorkId, mergeWork, updateWork, workDetail, worksWithChats, chatByNo, chatsByNos, chatsReadSince, doneOf, doneSince, issueKey, keyStatus, lastAsks, listChats, pinFull, pinIndex, revokeKeys, search, stateCounts, transcriptOf, updateChat, useKey } from "./manager-store.js";
import { NOTEBOOK_DOC_KEY, docIdOf, exportNotebook, initiativePatch, initiatives, notebookStatus, sessionsFor, setSetting, syncDecisionTask } from "./manager-links.js";
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
      const [rows, counts, areas] = await Promise.all([
        listChats(env, { state: st, ai: ai === "claude" || ai === "gpt" ? ai : null, limit: 300, initiative: sp.get("initiative"), area: areaName(sp.get("area")), work: Number(sp.get("work")) || null }),
        stateCounts(env),
        areaCounts(env),
      ]);
      return reply({ ok: true, chats: rows.map(chatOut), counts, areas });
    }
    if (request.method === "GET" && op === "chat") {
      const no = Number(sp.get("no"));
      if (!Number.isInteger(no) || no <= 0) return reply({ ok: false, message: "チャット番号が分かりません" }, 400);
      const c = await chatByNo(env, no);
      if (!c) return reply({ ok: false, message: `チャット ${no} はありません` }, 404);
      const [pins, done, asks] = await Promise.all([pinIndex(env, no), doneOf(env, no), lastAsks(env, [no])]);
      return reply({ ok: true, chat: chatOut(c), pins: pins.map((p) => ({ 番号: Number(p.n), 題: p.title, 作った: jstShort(p.created_at) })),
        done: done.map((d) => ({ やったこと: d.text, 時刻: jstShort(d.at) })), 最後の頼みごと: asks[no] ?? null });
    }
    if (request.method === "GET" && op === "works") {
      const ws = await worksWithChats(env, { all: sp.get("all") === "1" });
      return reply({ ok: true, works: ws.map((x) => workOut(x.work, x.chats)) });
    }
    if (request.method === "GET" && op === "work") {
      const id = Number(sp.get("id"));
      const d = await workDetail(env, id);
      if (!d) return reply({ ok: false, message: `作業 ${id} はありません` }, 404);
      const name = new Map(d.chats.map((c) => [Number(c.no), String(c.name)]));
      return reply({ ok: true, work: workOut(d.work, d.chats), chats: d.chats.map(chatOut),
        done: d.done.map((x) => ({ やったこと: x.text, 住所: x.link ?? null, 時刻: jstShort(x.at), チャット番号: Number(x.chat_no), チャットの名前: name.get(Number(x.chat_no)) ?? "" })),
        prs: prLinks(d.done).map((p) => ({ ...p, チャットの名前: name.get(p.チャット番号) ?? "" })),
        pins: d.pins.map((p) => ({ チャット番号: Number(p.chat_no), 番号: Number(p.n), 題: p.title, 作った: jstShort(p.created_at), チャットの名前: name.get(Number(p.chat_no)) ?? "" })) });
    }
    if (request.method === "POST" && (op === "work-update" || op === "work-merge")) {
      let body: Record<string, unknown>;
      try { body = await request.json() as Record<string, unknown>; } catch { return reply({ ok: false, message: "送った中身の形が違います" }, 400); }
      if (op === "work-merge") {
        const w = await mergeWork(env, Number(body.from), Number(body.to));
        return reply({ ok: true, work: workOut(w) });
      }
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) { const n = workName(body.name); if (!n) return reply({ ok: false, message: "作業の名前が空です" }, 400); patch.name = n; }
      if (body.state !== undefined) { const st = normWorkState(body.state); if (!st) return reply({ ok: false, message: "状態は 進行中 か 済み です" }, 400); patch.state = st; }
      if (body.area !== undefined) patch.area = areaName(body.area);
      const w = await updateWork(env, Number(body.id), patch);
      return reply({ ok: true, work: workOut(w) });
    }
    if (request.method === "GET" && op === "activity") {
      const range = sp.get("range") === "week" ? "week" : "today";
      const since = jstSince(range);
      const [done, read] = await Promise.all([doneSince(env, since), chatsReadSince(env, since)]);
      const withDone = new Set(done.map((d) => Number(d.chat_no)));
      const quiet = read.filter((c) => !withDone.has(Number(c.no)));
      const [chats, asks] = await Promise.all([chatsByNos(env, done.map((d) => Number(d.chat_no))), lastAsks(env, quiet.map((c) => Number(c.no)))]);
      const byNo = new Map([...chats, ...quiet].map((c) => [Number(c.no), c]));
      const items = [
        ...done.map((d) => ({ 種類: "やったこと", 時刻: jstShort(d.at), at: String(d.at), 中身: d.text, no: Number(d.chat_no) })),
        ...quiet.filter((c) => asks[Number(c.no)]).map((c) => ({ 種類: "最後の頼みごと", 時刻: jstShort(c.transcript_at), at: String(c.transcript_at), 中身: asks[Number(c.no)], no: Number(c.no) })),
      ].sort((a, b) => b.at.localeCompare(a.at)).map(({ at, no, ...x }) => {
        const c = byNo.get(no);
        return { ...x, チャット番号: no, チャットの名前: c?.name ?? "", 分野: c?.area ?? null, 状態: c?.state ?? "", AI: c?.ai ?? "" };
      });
      return reply({ ok: true, range, items });
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
      const ini = await initiativePatch(env, body.initiative);
      if (!ini.ok) return reply({ ok: false, message: ini.message }, 400);
      const ar = body.area === undefined ? {} : areaName(body.area) ? { area: areaName(body.area), area_src: "手" } : { area: null, area_src: null };
      let after = await updateChat(env, no, { ...c.patch, ...ini.patch, ...ar });
      if (body.work_id !== undefined) after = await attachWorkId(env, no, body.work_id === null || body.work_id === "" ? null : Number(body.work_id)); // v1.129.0
      else if (body.work !== undefined) after = (await attachWork(env, after, workName(body.work))).chat;
      const t = await syncDecisionTask(env, after); // v1.127.0：判断待ち ⇄ TaskMaster
      if (t.action !== "none") after = { ...after, tm_task_id: t.action === "added" ? t.task_id : null };
      return reply({ ok: true, chat: chatOut(after), ...(t.error ? { warning: `TaskMaster：${t.error}` } : {}) });
    }
    if (request.method === "GET" && op === "transcript") {
      const no = Number(sp.get("no"));
      if (!Number.isInteger(no) || no <= 0) return reply({ ok: false, message: "チャット番号が分かりません" }, 400);
      const t = await transcriptOf(env, no);
      if (!t) return reply({ ok: false, message: `チャット ${no} はありません` }, 404);
      return reply({ ok: true, 全文: t.transcript, 読んだ: t.transcript_at ? jstShort(t.transcript_at) : null, 往復: t.turns });
    }
    // v1.127.0：ほかのアプリとのつなぎ
    if (request.method === "GET" && op === "sessions") {
      const no = Number(sp.get("no"));
      const c = Number.isInteger(no) && no > 0 ? await chatByNo(env, no) : null;
      return reply({ ok: true, sessions: c ? await sessionsFor(env, c.url) : [] });
    }
    if (request.method === "GET" && op === "initiatives") {
      return reply({ ok: true, initiatives: await initiatives(env) });
    }
    if (request.method === "GET" && op === "notebook") {
      return reply({ ok: true, ...(await notebookStatus(env)) });
    }
    if (request.method === "POST" && op === "notebook") {
      let body: Record<string, unknown> = {};
      try { body = await request.json() as Record<string, unknown>; } catch { /* 空でよい */ }
      if (body.doc !== undefined) {
        const id = String(body.doc || "").trim() ? docIdOf(body.doc) : null;
        if (String(body.doc || "").trim() && !id) return reply({ ok: false, message: "Google ドキュメントの住所（https://docs.google.com/document/d/…）を貼ってください" }, 400);
        await setSetting(env, NOTEBOOK_DOC_KEY, id);
      }
      const r = await exportNotebook(env, true);
      return reply({ ok: r.ok, message: r.message, ...(await notebookStatus(env)) }, r.ok ? 200 : 502);
    }
    if (request.method === "POST" && op === "ext-key") {
      const key = newKey();
      await issueKey(env, await keyHash(key));
      return reply({ ok: true, key });
    }
    if (request.method === "POST" && op === "ext-revoke") {
      await revokeKeys(env);
      return reply({ ok: true });
    }
    if (request.method === "GET" && op === "ext-status") {
      const st = await keyStatus(env);
      return reply({ ok: true, つないでいる: st.connected, つないだ: st.created_at ? jstShort(st.created_at) : null, 最後に受けた: st.last_used_at ? jstShort(st.last_used_at) : null });
    }
    return reply({ ok: false, error: "not_found" }, 404);
  } catch (e) {
    if (e instanceof ManagerError) return reply({ ok: false, error: e.code, message: e.message }, e.code === "chat_not_found" ? 404 : 502);
    return reply({ ok: false, error: "failed", message: String((e as Error)?.message || e).slice(0, 300) }, 502);
  }
}

/** シアニンパネルから全文を受ける（拡張の鍵で通す・書くだけ） */
async function capture(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "86400" } });
  const cors = { ...API_HEADERS, "Access-Control-Allow-Origin": "*" };
  const out = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
  if (request.method !== "POST") return out({ ok: false, error: "method_not_allowed" }, 405);
  const auth = request.headers.get("Authorization") || "";
  if (!/^Bearer mk_[A-Za-z0-9_-]{30,}$/.test(auth)) return out({ ok: false, error: "missing_key", message: "拡張の鍵がありません。マネージャーくんの画面で「この拡張をつなぐ」を押してください" }, 401);
  try {
    if (!(await useKey(env, await keyHash(auth.slice(7))))) return out({ ok: false, error: "key_revoked", message: "この鍵は止まっています。マネージャーくんの画面でつなぎ直してください" }, 401);
    const len = Number(request.headers.get("Content-Length") || 0);
    if (len > 8_000_000) return out({ ok: false, error: "too_large", message: "全文が大きすぎます" }, 413);
    let body: Record<string, unknown>;
    try { body = await request.json() as Record<string, unknown>; } catch { return out({ ok: false, error: "bad_json" }, 400); }
    const c = checkCapture(body);
    if (!c.ok) return out({ ok: false, error: "invalid", message: c.message }, 400);
    const r = await applyCapture(env, c);
    return out({ ok: true, 番号: r.no, 結び方: r.how, 名前: r.name, 往復: c.turns });
  } catch (e) {
    return out({ ok: false, error: "failed", message: String((e as Error)?.message || e).slice(0, 300) }, 502);
  }
}

export async function handleManager(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === `${MANAGER_PATH}/ext/capture`) return capture(request, env);
  if (path.startsWith(`${MANAGER_PATH}/api/`)) return api(request, env, url);
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405 });
  if (path === MANAGER_PATH || path === `${MANAGER_PATH}/`) {
    return new Response(managerPage(), { headers: {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      // v1.126.0：シアニンパネル（拡張機能のサイドパネル）の中にだけ入れられる。ほかのサイトの枠には入らない
      "Content-Security-Policy": "frame-ancestors 'self' chrome-extension:", "Referrer-Policy": "same-origin",
    } });
  }
  return asset(path) ?? new Response("not found", { status: 404 });
}
