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
 *   POST /manager/ext/turn            … 誰の番の合図（AI が書き始めた・Naoki が見た）（v1.133.0）
 *   POST /manager/ext/pin             … ピンの中身（チャットの画面でその出力まで動かすため）（v1.150.2）
 *   POST /manager/ext/tabs            … タブのまとまりの中身（チャット以外も）を作業へ写す（v1.133.0）
 *   manager.shia2n.jp の / は /manager と同じ画面（v1.126.0）
 *   v1.128.0（4便目）：chats に area（分野で絞る）と areas（棚ごとの数）、chat にやったことと最後の頼みごと、
 *   GET /manager/api/activity?range=today|week … 今日・今週やったこと（拡張だけのチャットは最後の頼みごとで代わりに出す）
 *   POST /manager/api/update に area（画面で決めた分野は拡張が上書きしない）
 *   v1.131.0（6便目）：GET requests?state=・GET request?id=・GET request-text?id=・POST request-new・request-ok・request-cancel・request-fix、GET/POST routine（実行係の設定）、work-update に level、work に依頼
 *   v1.129.0（5便目）：GET works（作業の木）・GET work?id=（作業の中身）・POST work-update・POST work-merge、update に work（名前）・work_id
 *
 * 守り方は案件くんの受け口（anken-sheet-http.ts）と同じ：Firebase のログインの札を確かめ、Naoki 本人（NAOKI_UID）のときだけ読む・書く。
 * 画面と読み口は同じ住所なので、ほかの住所からの呼び出し（Origin が違うもの）は断る。
 */
import type { Env } from "./index.js";
import { verifyIdToken } from "./gate.js";
import { STATES, areaName, chatPageOf, chatName, groupName, normWorkState, prLinks, workName, workOut, checkCapture, checkTabs, checkScore, scoreOut, scoreTrend, needsScore, checkUpdate, chatOut, jstShort, jstSince, keyHash, newKey, normState, pinOut } from "./manager-core.js";
import { yourTurnChats, noteBusy, setPinUrl, ManagerError, openWorkNamed, applyCapture, attachGroup, findOrCreateWork, saveGroupTabs, setTurnByUrl, workColor, chatByUrl, createChat, PANEL_SURFACE, areaCounts, attachWork, attachWorkId, mergeWork, updateWork, workDetail, worksWithChats, chatByNo, chatsByNos, chatsReadSince, doneOf, doneSince, issueKey, keyStatus, lastAsks, listChats, pinFull, pinIndex, revokeKeys, search, stateCounts, transcriptOf, updateChat, useKey } from "./manager-store.js";
import { approveRequest, cancelRequest, fixRequest, requestById, requestOut, requestPlainText, requestsByState, requestsOfWork, routineStatus, runAllWaiting, saveRoutine, submitRequest } from "./manager-run.js";
import { NOTEBOOK_DOC_KEY, docIdOf, exportNotebook, initiativePatch, initiatives, notebookStatus, sessionsFor, setSetting, syncDecisionTask } from "./manager-links.js";
import { APPLE_TOUCH_PNG_B64, FAVICON_32_PNG_B64, FAVICON_SVG, SHELL_JS } from "./manager-assets.js";
import { managerPage } from "./manager-page.js";
import { addScore, kinds, scoresFor, setKind, setKindLevel } from "./manager-score.js";
import { linkTask, setFolder, syncWorkDone, tmOpen } from "./manager-folders.js";
import { runKaizen } from "./manager-kaizen.js";
import { censusOut, discardPlan, latestCensus, markApplied, saveCensus } from "./manager-census.js";
import { archiveList, canDelete, deleteWork, tabHits } from "./manager-archive.js";

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
      return reply({ ok: true, works: ws.map((x) => workOut(x.work, x.chats, x.reqs)), kinds: (await kinds(env)).map((k) => ({ 名前: String(k.name), 段階: Number(k.level) })) });
    }
    if (request.method === "GET" && op === "work") {
      const id = Number(sp.get("id"));
      const d = await workDetail(env, id);
      if (!d) return reply({ ok: false, message: `作業 ${id} はありません` }, 404);
      const name = new Map(d.chats.map((c) => [Number(c.no), String(c.name)]));
      const reqs = await requestsOfWork(env, id);
      const sc = await scoresFor(env, d.work); // v1.136.0：評価
      const byReq = new Map(sc.mine.filter((x) => x.request_id).map((x) => [Number(x.request_id), x]));
      for (const r of reqs) r.scored = byReq.has(Number(r.id));
      return reply({ ok: true, work: workOut(d.work, d.chats, reqs), chats: d.chats.map(chatOut), requests: reqs.map((r) => ({ ...requestOut(r), 評価: byReq.has(Number(r.id)) ? scoreOut(byReq.get(Number(r.id))!) : null, 評価待ち: needsScore(r) })),
        scores: sc.mine.map(scoreOut), 型の流れ: sc.kind.length ? scoreTrend(sc.kind) : null, 型の段階: sc.kindRow ? Number(sc.kindRow.level) : null,
        tabs: (Array.isArray(d.work.tabs) ? d.work.tabs : []).map((t: any) => ({ 住所: String(t.url), 題: String(t.title || "") })), タブを写した: d.work.tabs_at ? jstShort(d.work.tabs_at) : null,
        done: d.done.map((x) => ({ やったこと: x.text, 住所: x.link ?? null, 時刻: jstShort(x.at), チャット番号: Number(x.chat_no), チャットの名前: name.get(Number(x.chat_no)) ?? "" })),
        prs: prLinks(d.done).map((p) => ({ ...p, チャットの名前: name.get(p.チャット番号) ?? "" })),
        pins: d.pins.map((p) => ({ チャット番号: Number(p.chat_no), 番号: Number(p.n), 題: p.title, 作った: jstShort(p.created_at), チャットの名前: name.get(Number(p.chat_no)) ?? "" })) });
    }
    if (request.method === "POST" && op === "work-attach-url") {
      // v1.132.0：今のタブ（チャットの住所）を作業に入れる。台帳に無ければ行を作る（全文は拡張が読んだときに入る）
      let body: Record<string, unknown>;
      try { body = await request.json() as Record<string, unknown>; } catch { return reply({ ok: false, message: "送った中身の形が違います" }, 400); }
      const page = chatPageOf(body.url);
      if (!page) return reply({ ok: false, message: "Claude か ChatGPT のチャットの住所ではありません" }, 400);
      let c = await chatByUrl(env, page.url);
      if (!c) c = await createChat(env, { name: chatName(String(body.title || "").replace(/\s*[-|｜]\s*(ChatGPT|Claude)\s*$/, "")) || "名前のないチャット", ai: page.service === "chatgpt" ? "gpt" : "claude", state: "進行中", url: page.url, surface: PANEL_SURFACE });
      const after = await attachWorkId(env, Number(c.no), Number(body.work_id));
      return reply({ ok: true, chat: chatOut(after) });
    }
    if (request.method === "POST" && (op === "work-update" || op === "work-merge")) {
      let body: Record<string, unknown>;
      try { body = await request.json() as Record<string, unknown>; } catch { return reply({ ok: false, message: "送った中身の形が違います" }, 400); }
      if (op === "work-merge") {
        const w = await mergeWork(env, Number(body.from), Number(body.to));
        if (w.dropped_task) await syncWorkDone(env, { tm_task_id: w.dropped_task, state: "済み" }); // v1.142.0：まとめて消えた作業のタスクは完了に
        return reply({ ok: true, work: workOut(w) });
      }
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) { const n = workName(body.name); if (!n) return reply({ ok: false, message: "作業の名前が空です" }, 400); patch.name = n; }
      if (body.state !== undefined) { const st = normWorkState(body.state); if (!st) return reply({ ok: false, message: "状態は 進行中・済み・中止 のどれかです" }, 400); patch.state = st; patch.closed_at = st === "進行中" ? null : new Date().toISOString(); }
      if (body.area !== undefined) patch.area = areaName(body.area);
      if (body.level !== undefined) { const lv = Number(body.level); if (![0, 1, 2].includes(lv)) return reply({ ok: false, message: "段階は 0・1・2 のどれかです" }, 400); patch.level = lv; }
      let w = Object.keys(patch).length || body.kind === undefined ? await updateWork(env, Number(body.id), patch) : null;
      if (body.kind !== undefined) w = await setKind(env, Number(body.id), body.kind); // v1.136.0：型
      if (patch.state) await syncWorkDone(env, w!); // v1.138.0：完了をタスクへ
      return reply({ ok: true, work: workOut(w!) });
    }
    // v1.138.0：フォルダ（TaskMaster のプロジェクト）とタスク
    if (request.method === "GET" && op === "tm") {
      const t = await tmOpen(env);
      const linked = new Set(((await worksWithChats(env, { all: true })) || []).map((x) => String(x.work.tm_task_id || "")).filter(Boolean));
      return reply({ ok: true, projects: t.projects.map((p) => ({ 番号: String(p.id), 名前: String(p.title) })),
        tasks: t.tasks.filter((x) => !x.repeat && !linked.has(String(x.id))).map((x) => ({ 番号: String(x.id), 題: String(x.title).slice(0, 120), プロジェクト: x.projectId ? String(x.projectId) : null, 期日: x.deadline ?? null })) });
    }
    if (request.method === "POST" && (op === "work-folder" || op === "work-task")) {
      let body: Record<string, unknown>;
      try { body = await request.json() as Record<string, unknown>; } catch { return reply({ ok: false, message: "送った中身の形が違います" }, 400); }
      const w = op === "work-folder" ? await setFolder(env, Number(body.id), body.project_id ? String(body.project_id) : null) : await linkTask(env, Number(body.id), body.task_id ? String(body.task_id) : null);
      return reply({ ok: true, work: workOut(w) });
    }
    // v1.141.0：新しい作業（パネルから先に作る）と、保存したタブを直す（1 本外す・全部消す・元に戻す）
    if (request.method === "POST" && (op === "work-new" || op === "work-tabs")) {
      let body: Record<string, unknown>;
      try { body = await request.json() as Record<string, unknown>; } catch { return reply({ ok: false, message: "送った中身の形が違います" }, 400); }
      if (op === "work-new") {
        const n = workName(body.name);
        if (!n) return reply({ ok: false, message: "作業の名前を入れてください" }, 400);
        const r = await findOrCreateWork(env, n, null);
        let w = r.work;
        if (body.project_id) w = await setFolder(env, Number(w.id), String(body.project_id));
        return reply({ ok: true, work: workOut(w), 作った: r.created });
      }
      const tabs = checkTabs(body.tabs);
      const w = await updateWork(env, Number(body.id), { tabs: tabs.length ? tabs : null, tabs_at: new Date().toISOString() });
      return reply({ ok: true, work: workOut(w) });
    }
    // v1.147.0：アーカイブ（完了・中止した作業。タブとピンごと）と削除
    if (request.method === "GET" && op === "archive") {
      const rows = await archiveList(env, (sp.get("q") || "").trim().slice(0, 200), sp.get("state") || "");
      return reply({ ok: true, works: rows });
    }
    if (request.method === "GET" && op === "work-can-delete") return reply({ ok: true, ...(await canDelete(env, Number(sp.get("id")))) });
    if (request.method === "POST" && op === "work-delete") {
      let body: Record<string, unknown>;
      try { body = await request.json() as Record<string, unknown>; } catch { return reply({ ok: false, message: "送った中身の形が違います" }, 400); }
      const r = await deleteWork(env, Number(body.id));
      return reply({ ok: true, ...r });
    }
    // v1.145.0：タブの棚卸し（全ウィンドウのタブを統括へ）と統括の整理案
    if (request.method === "GET" && op === "census") return reply({ ok: true, census: censusOut(await latestCensus(env)) });
    if (request.method === "POST" && op === "census") {
      let body: Record<string, unknown>;
      try { body = await request.json() as Record<string, unknown>; } catch { return reply({ ok: false, message: "送った中身の形が違います" }, 400); }
      return reply({ ok: true, census: censusOut(await saveCensus(env, body.windows)) });
    }
    if (request.method === "POST" && op === "census-applied") return reply({ ok: true, ...(await markApplied(env)), census: censusOut(await latestCensus(env)) });
    if (request.method === "POST" && op === "census-discard") { await discardPlan(env); return reply({ ok: true, census: censusOut(await latestCensus(env)) }); }
    // v1.142.0：改善係を今すぐ動かす（設定の画面から）
    if (request.method === "POST" && op === "kaizen-now") return reply({ ok: true, ...(await runKaizen(env, { force: true })) });
    // v1.136.0：評価（クオリティ・仕組み）と型の段階
    if (request.method === "POST" && (op === "score" || op === "kind-level")) {
      let body: Record<string, unknown>;
      try { body = await request.json() as Record<string, unknown>; } catch { return reply({ ok: false, message: "送った中身の形が違います" }, 400); }
      if (op === "kind-level") { const n = await setKindLevel(env, String(body.name || ""), Number(body.level)); return reply({ ok: true, 作業の数: n }); }
      const c = checkScore(body);
      if (!c.ok) return reply({ ok: false, message: c.message }, 400);
      const rid = body.request_id ? Number(body.request_id) : null;
      const r = await addScore(env, Number(body.work_id), rid, c);
      return reply({ ok: true, score: scoreOut(r.score), 上げた: r.raised });
    }
    // v1.131.0：依頼と実行係
    if (request.method === "GET" && op === "requests") {
      const st = (sp.get("state") || "OK待ち").split(",").map((x) => x.trim()).filter((x) => ["OK待ち", "順番待ち", "実行中", "済み", "止まった", "やめた"].includes(x));
      const rows = await requestsByState(env, st.length ? st : ["OK待ち"]);
      return reply({ ok: true, requests: rows.map((x) => requestOut(x.req, x.work)) });
    }
    if (request.method === "GET" && op === "request") {
      const r = await requestById(env, Number(sp.get("id")));
      if (!r) return reply({ ok: false, message: "その依頼はありません" }, 404);
      return reply({ ok: true, request: requestOut(r) });
    }
    if (request.method === "GET" && op === "request-text") {
      return reply({ ok: true, text: await requestPlainText(env, Number(sp.get("id"))) });
    }
    if (request.method === "GET" && op === "routine") {
      return reply({ ok: true, ...(await routineStatus(env)) });
    }
    if (request.method === "POST" && ["request-new", "request-ok", "request-cancel", "request-fix", "routine"].includes(op)) {
      let body: Record<string, unknown>;
      try { body = await request.json() as Record<string, unknown>; } catch { return reply({ ok: false, message: "送った中身の形が違います" }, 400); }
      if (op === "routine") {
        await saveRoutine(env, body.url, body.token);
        const run = await runAllWaiting(env);
        return reply({ ok: true, ...(await routineStatus(env)), 動かした: run.fired });
      }
      if (op === "request-new") {
        const r = await submitRequest(env, Number(body.work_id), { title: body.title, body: body.body, why: body.why, stop: body.stop, recipe: body.recipe }, { source: "Naoki" });
        return reply({ ok: true, request: requestOut(r.req), fired: r.fired });
      }
      if (op === "request-ok") { const r = await approveRequest(env, Number(body.id)); return reply({ ok: true, request: requestOut(r.req), fired: r.fired }); }
      if (op === "request-cancel") { const r = await cancelRequest(env, Number(body.id)); return reply({ ok: true, request: requestOut(r) }); }
      const r = await fixRequest(env, Number(body.id), String(body.fix ?? ""));
      return reply({ ok: true, request: requestOut(r.req), fired: r.fired });
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
    if (request.method === "POST" && op === "pin-url") {
      let body: Record<string, unknown>;
      try { body = await request.json() as Record<string, unknown>; } catch { return reply({ ok: false, message: "送った中身の形が違います" }, 400); }
      const page = chatPageOf(body.url);
      if (!page) return reply({ ok: false, message: "Claude か ChatGPT の会話の住所を入れてください" }, 400);
      await setPinUrl(env, Number(body.chat), Number(body.n), page.url);
      return reply({ ok: true });
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
      const [rows, tabs] = await Promise.all([search(env, q, 50), tabHits(env, q, 20)]);
      return reply({ ok: true, tabs, hits: rows.map((r) => ({
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
    return out({ ok: true, 番号: r.no, 結び方: r.how, 名前: r.name, 往復: c.turns, ...(await paintOf(env, r.no)) });
  } catch (e) {
    return out({ ok: false, error: "failed", message: String((e as Error)?.message || e).slice(0, 300) }, 502);
  }
}

/** シアニンパネルから、タブのまとまりの名前を受ける（拡張の鍵で通す・書くだけ）（v1.132.0） */
async function groupHook(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "86400" } });
  const out = (body: unknown, status = 200) => Response.json(body, { status, headers: { ...API_HEADERS, "Access-Control-Allow-Origin": "*" } });
  if (request.method !== "POST") return out({ ok: false, error: "method_not_allowed" }, 405);
  const auth = request.headers.get("Authorization") || "";
  if (!/^Bearer mk_[A-Za-z0-9_-]{30,}$/.test(auth)) return out({ ok: false, error: "missing_key" }, 401);
  try {
    if (!(await useKey(env, await keyHash(auth.slice(7))))) return out({ ok: false, error: "key_revoked" }, 401);
    let body: Record<string, unknown>;
    try { body = await request.json() as Record<string, unknown>; } catch { return out({ ok: false, error: "bad_json" }, 400); }
    const page = chatPageOf(body.url);
    const g = groupName(body.group);
    if (!page || !g) return out({ ok: false, error: "invalid", message: "チャットの住所とまとまりの名前が要ります" }, 400);
    // v1.132.1：台帳に無いチャットは、その場で行を作って作業に入れる（全文と名前は拡張が読んだときに入る）
    let c = await chatByUrl(env, page.url);
    if (!c) c = await createChat(env, { name: chatName(String(body.title || "").replace(/\s*[-|｜]\s*(ChatGPT|Claude)\s*$/, "")) || "読み込み待ちのチャット", ai: page.service === "chatgpt" ? "gpt" : "claude", state: "進行中", url: page.url, surface: PANEL_SURFACE });
    const r = await attachGroup(env, Number(c.no), g);
    return out({ ok: true, 番号: Number(c.no), 作業: r.work?.name ?? null, ...(await paintOf(env, Number(c.no))) });
  } catch (e) {
    return out({ ok: false, error: "failed", message: String((e as Error)?.message || e).slice(0, 300) }, 502);
  }
}

/** そのチャットの作業の色（拡張がまとまりを塗る）。作業に入っていなければ空 */
async function paintOf(env: Env, chatNo: number): Promise<{ まとまり?: { 名前: string; 色: string } }> {
  try {
    const c = await chatByNo(env, chatNo);
    const p = c?.work_id ? await workColor(env, Number(c.work_id)) : null;
    return p ? { まとまり: { 名前: p.name, 色: p.color } } : {};
  } catch { return {}; }
}

/** 拡張の鍵で通す口の共通の形（書くだけ）（v1.133.0） */
async function extHook(request: Request, env: Env, fn: (body: Record<string, unknown>) => Promise<{ status?: number; body: Record<string, unknown> }>): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "86400" } });
  const out = (body: unknown, status = 200) => Response.json(body, { status, headers: { ...API_HEADERS, "Access-Control-Allow-Origin": "*" } });
  if (request.method !== "POST") return out({ ok: false, error: "method_not_allowed" }, 405);
  const auth = request.headers.get("Authorization") || "";
  if (!/^Bearer mk_[A-Za-z0-9_-]{30,}$/.test(auth)) return out({ ok: false, error: "missing_key" }, 401);
  try {
    if (!(await useKey(env, await keyHash(auth.slice(7))))) return out({ ok: false, error: "key_revoked" }, 401);
    if (Number(request.headers.get("Content-Length") || 0) > 200_000) return out({ ok: false, error: "too_large" }, 413);
    let body: Record<string, unknown>;
    try { body = await request.json() as Record<string, unknown>; } catch { return out({ ok: false, error: "bad_json" }, 400); }
    const r = await fn(body);
    return out(r.body, r.status ?? 200);
  } catch (e) {
    return out({ ok: false, error: "failed", message: String((e as Error)?.message || e).slice(0, 300) }, 502);
  }
}

/** 誰の番の合図：AI が書き始めた（AI）／Naoki がそのタブを見た（seen） */
const turnHook = (request: Request, env: Env) => extHook(request, env, async (b) => {
  const page = chatPageOf(b.url);
  const kind = b.kind === "AI" ? "AI" : b.kind === "seen" ? "seen" : null;
  if (!page || !kind) return { status: 400, body: { ok: false, error: "invalid" } };
  const c = await setTurnByUrl(env, page.url, kind);
  // v1.150.4：AI が答え始めたタブを覚える（ピンを付けた会話と、何番目の回答かを決めるため）
  if (kind === "AI") await noteBusy(env, page.url, page.service, Number(b.turns), typeof b.key === "string" ? b.key : null).catch(() => null);
  return { body: { ok: true, 番号: c ? Number(c.no) : null, ...(c ? await paintOf(env, Number(c.no)) : {}) } };
});

/** タブのまとまりの中身（チャット以外も）を作業へ写す */
const tabsHook = (request: Request, env: Env) => extHook(request, env, async (b) => {
  const g = groupName(b.group);
  let tabs = checkTabs(b.tabs);
  if (!g || !tabs.length) return { status: 400, body: { ok: false, error: "invalid", message: "まとまりの名前とタブが要ります" } };
  // v1.146.0：add＝今ある保存に足す（「全部しまう」の受け箱。前にしまった分を消さない・新しいものを上に・100 本まで）
  if (b.add === true) { const cur = await openWorkNamed(env, g); tabs = checkTabs([...tabs, ...(Array.isArray(cur?.tabs) ? cur!.tabs : [])], 100); }
  const r = await saveGroupTabs(env, g, tabs, b.add === true || b.save === true);
  if (!r.work) return { body: { ok: true, 外した: true, message: r.unsaved ? "未保存のまとまりなので保存していません" : "片づけたばかりの作業の名前なので、作り直していません" } };
  const p = await workColor(env, Number(r.work.id));
  return { body: { ok: true, 作業: String(r.work.name), 作業番号: Number(r.work.id), 作った: r.created, タブの数: tabs.length, ...(p ? { まとまり: { 名前: p.name, 色: p.color } } : {}) } };
});

/* v1.150.5（2026-11-26 Naoki「Naoki の番が目立たない・見逃す」）：拡張が「Naoki の番」のチャットの住所を聞く（アイコンの数字・タブ名の ●） */
const yoursHook = (request: Request, env: Env) => extHook(request, env, async () => {
  const rows = await yourTurnChats(env);
  return { body: { ok: true, 件数: rows.length, 住所: rows.map((r) => r.url).filter(Boolean) } };
});

/* v1.150.2（2026-11-24 Naoki「ピンのリンクがマネージャーくんに飛ぶ」→ 元のチャットのその出力まで）：拡張がピンの中身を受け取り、チャットの画面で同じ文を探して動かす */
const pinHook = (request: Request, env: Env) => extHook(request, env, async (b) => {
  const chat = Number(b.chat), n = Number(b.n);
  if (!Number.isInteger(chat) || !Number.isInteger(n) || chat < 1 || n < 1) return { status: 400, body: { ok: false, error: "invalid", message: "ピンの番号が違います" } };
  const p = await pinFull(env, chat, n);
  if (!p) return { status: 404, body: { ok: false, error: "pin_not_found", message: "ピンがありません" } };
  return { body: { ok: true, 題: String(p.title ?? ""), 中身: String(p.body ?? "").slice(0, 4000), 回答番号: p.turn ?? null, 印: p.turn_key ?? null } };
});

export async function handleManager(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === `${MANAGER_PATH}/ext/capture`) return capture(request, env);
  if (path === `${MANAGER_PATH}/ext/group`) return groupHook(request, env);
  if (path === `${MANAGER_PATH}/ext/turn`) return turnHook(request, env);
  if (path === `${MANAGER_PATH}/ext/tabs`) return tabsHook(request, env);
  if (path === `${MANAGER_PATH}/ext/pin`) return pinHook(request, env);
  if (path === `${MANAGER_PATH}/ext/yours`) return yoursHook(request, env);
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
