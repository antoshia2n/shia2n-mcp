/**
 * shia2n-mcp / src/manager-run.ts / 新設（2026-11-22 v1.131.0 開発部・マネージャーくん 6便目・Naoki OK 09:31）
 *
 * 任せる段階と自動実行。作業（mk_works）ごとの段階と、作業の下の依頼（mk_requests）を、
 * Claude Code のルーティン（API で呼べる実行係）へ渡して動かす。
 *   段階 0：実行しない（依頼は控えとして残る・依頼文をコピーして自分で始める）
 *   段階 1：チャットが出した案は Naoki の OK で実行。Naoki が画面で書いた依頼と直しは、書いた時点で OK とみなす
 *   段階 2：依頼が来たらそのまま実行して報告
 *   ・同じ作業で同時に動くのは 1 つだけ（2 つ目からは順番待ち。前の依頼の報告で次が動く）
 *   ・ルーティンには同じ呼び出しを防ぐ仕組みが無いので、状態を 順番待ち → 実行中 に「その状態のときだけ」書き換えてから 1 回だけ呼ぶ
 *   ・返事が来ないまま呼び出しが切れたときは、二重に動かさないため「止まった」にして Naoki に確かめてもらう
 *   ・OK待ちの依頼には TaskMaster に「OK待ち：…」を立て、OK・やめた・済みで済みにする（判断待ちと同じ形）
 * 実行係（ルーティン）の住所と鍵は mk_settings に置く（ブラウザからは読めない表・画面には鍵の末尾 4 字だけ返す）。
 */
import type { Env } from "./index.js";
import { handleTaskmasterAddTask, handleTaskmasterUpdateTask } from "./taskmaster.js";
import { getSetting, setSetting, syncDecisionTask } from "./manager-links.js";
import { ManagerError, addDone, chatByNo, createChat, updateChat, workById } from "./manager-store.js";
import { jstShort } from "./manager-core.js";

type Row = Record<string, any>;
const SITE = "https://manager.shia2n.jp";
const REQ_COLS = "id,work_id,title,body,why,stop,recipe,state,source,from_chat_no,run_chat_no,parent_id,session_url,result,fix,tm_task_id,created_at,fired_at,done_at,touched_at";
export const ROUTINE_URL_KEY = "routine_url";
export const ROUTINE_TOKEN_KEY = "routine_token";
export const ROUTINE_ERR_KEY = "routine_error";
export const RUN_ROLE = "実行係";
export const RUN_SURFACE = "ルーティン";

async function sb(env: Env, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      ...(/^eyJ/.test(String(env.SUPABASE_SERVICE_ROLE_KEY || "")) ? { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } : {}),
      "Content-Type": "application/json",
      ...((init.headers as Record<string, string>) || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new ManagerError("supabase_error", `Supabase ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const enc = encodeURIComponent;

/* ─── 計算だけ（試験で回す） ─── */

export function routineUrlOk(v: unknown): boolean {
  return /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/[A-Za-z0-9_-]{6,}\/fire$/.test(String(v ?? "").trim());
}
export function routineTokenOk(v: unknown): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(String(v ?? "").trim());
}

export type ReqInput = { title?: unknown; body?: unknown; why?: unknown; stop?: unknown; recipe?: unknown };
export type ReqCheck = { ok: true; row: { title: string; body: string; why: string; stop: string; recipe: string | null } } | { ok: false; message: string };
/** 依頼の中身を確かめる（題 1〜120 字・中身 20,000 字まで・なぜと止める条件は 1,000 字まで） */
export function checkRequest(v: ReqInput): ReqCheck {
  const title = String(v.title ?? "").trim().replace(/\s+/g, " ");
  const body = String(v.body ?? "").trim();
  const why = String(v.why ?? "").trim();
  const stop = String(v.stop ?? "").trim();
  const recipe = String(v.recipe ?? "").trim();
  if (!title) return { ok: false, message: "title（何をするかの 1 行）が空です" };
  if (title.length > 120) return { ok: false, message: "title は 120 字までです" };
  if (body.length > 20000) return { ok: false, message: "body は 20,000 字までです" };
  if (why.length > 1000 || stop.length > 1000) return { ok: false, message: "why と stop は 1,000 字までです" };
  if (recipe && !/^[a-z0-9][a-z0-9_-]{1,119}$/i.test(recipe)) return { ok: false, message: "recipe はレシピの名前（英数字とハイフン）です" };
  return { ok: true, row: { title, body, why, stop, recipe: recipe || null } };
}

/** 依頼を出したとき、すぐ実行の列に入れるか（段階 0 は入れない・段階 2 と Naoki が書いたものは入れる） */
export function autoQueue(level: number, source: string): boolean {
  if (level <= 0) return false;
  if (level >= 2) return true;
  return source === "Naoki" || source === "直し";
}

/** ルーティンへ渡す文（保存したプロンプトに添えて届く・65,536 字まで） */
export function requestText(req: Row, work: Row, runChatNo: number, ctx: { parent?: Row | null; done?: Row[]; chats?: Row[] } = {}): string {
  const L: string[] = [];
  L.push(`【マネージャーくんの依頼 #${req.id}】`);
  L.push(`依頼番号：${req.id}`);
  L.push(`このセッションのチャット番号：${runChatNo}（manager__done・manager__work・manager__report の chat にはこの番号を渡す。ai_log__add は呼ばない）`);
  L.push(`作業：${work.name}（分野：${work.area || "未分類"}・作業番号 ${work.id}・段階 ${work.level ?? 1}）`);
  L.push(`依頼：${req.title}`);
  if (req.body) L.push(`中身：\n${req.body}`);
  if (req.why) L.push(`なぜ：${req.why}`);
  L.push(`止める条件：${req.stop || "（指定なし。いつもの止める条件だけ）"}`);
  L.push(`レシピ：${req.recipe || "（指定なし。入口で依頼に合うレシピを選ぶ。合うものが無ければレシピなしで進める）"}`);
  if (req.source === "直し" && ctx.parent) {
    L.push("");
    L.push(`これは依頼 #${ctx.parent.id}「${ctx.parent.title}」への直しです。`);
    if (ctx.parent.result) L.push(`前の結果：${String(ctx.parent.result).slice(0, 2000)}`);
    if (ctx.parent.session_url) L.push(`前のセッション：${ctx.parent.session_url}`);
    L.push(`Naoki の直し（言葉のまま）：${req.fix || req.body}`);
    L.push("直す前に、この直しが効くスキルを 1 つ決めて skills__feedback_add に Naoki の言葉をそのまま渡す（レシピの名前も添える）。");
  }
  const done = (ctx.done || []).slice(0, 8);
  if (done.length) {
    L.push("");
    L.push("この作業でこれまでにやったこと（新しい順）：");
    for (const d of done) L.push(`- ${jstShort(d.at)} ${d.text}${d.link ? `（${d.link}）` : ""}`);
  }
  const chats = (ctx.chats || []).filter((c) => c.url).slice(0, 8);
  if (chats.length) {
    L.push("");
    L.push("この作業のチャット（読む必要があれば manager__get_pin や全文の検索で）：");
    for (const c of chats) L.push(`- ${c.name}（${c.state}）${c.url}`);
  }
  return L.join("\n").slice(0, 60000);
}

/** 依頼の 1 行 → 返す形 */
export function requestOut(r: Row, work?: Row | null) {
  return {
    番号: Number(r.id),
    作業番号: Number(r.work_id),
    ...(work ? { 作業: String(work.name ?? ""), 分野: work.area ? String(work.area) : null } : {}),
    題: String(r.title ?? ""),
    中身: String(r.body ?? ""),
    なぜ: String(r.why ?? ""),
    止める条件: String(r.stop ?? ""),
    レシピ: r.recipe ? String(r.recipe) : null,
    状態: String(r.state ?? ""),
    出どころ: String(r.source ?? ""),
    案を出したチャット: r.from_chat_no ? Number(r.from_chat_no) : null,
    実行したチャット: r.run_chat_no ? Number(r.run_chat_no) : null,
    元の依頼: r.parent_id ? Number(r.parent_id) : null,
    セッション: r.session_url ? String(r.session_url) : null,
    結果: String(r.result ?? ""),
    直し: String(r.fix ?? ""),
    作った: jstShort(r.created_at),
    動かした: r.fired_at ? jstShort(r.fired_at) : null,
    終わった: r.done_at ? jstShort(r.done_at) : null,
  };
}

/* ─── 実行係（ルーティン）の設定 ─── */

export async function routineStatus(env: Env): Promise<{ 設定済み: boolean; 住所: string | null; 鍵の末尾: string | null; 止まっている理由: string | null }> {
  const [url, token, err] = await Promise.all([getSetting(env, ROUTINE_URL_KEY), getSetting(env, ROUTINE_TOKEN_KEY), getSetting(env, ROUTINE_ERR_KEY)]);
  return { 設定済み: !!(url && token), 住所: url, 鍵の末尾: token ? token.slice(-4) : null, 止まっている理由: err };
}

export async function saveRoutine(env: Env, url: unknown, token: unknown): Promise<void> {
  const u = String(url ?? "").trim();
  if (!routineUrlOk(u)) throw new ManagerError("invalid_routine", "住所は https://api.anthropic.com/v1/claude_code/routines/…/fire の形です");
  await setSetting(env, ROUTINE_URL_KEY, u);
  const t = String(token ?? "").trim();
  if (t) {
    if (!routineTokenOk(t)) throw new ManagerError("invalid_routine", "鍵は sk-ant- で始まる文字です");
    await setSetting(env, ROUTINE_TOKEN_KEY, t);
  }
  await setSetting(env, ROUTINE_ERR_KEY, null);
}

/* ─── 依頼の読み書き ─── */

export async function requestById(env: Env, id: number): Promise<Row | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const rows = await sb(env, `mk_requests?select=${REQ_COLS}&id=eq.${id}`);
  return rows?.[0] ?? null;
}

export async function requestsOfWork(env: Env, workId: number): Promise<Row[]> {
  return (await sb(env, `mk_requests?select=${REQ_COLS}&work_id=eq.${workId}&order=created_at.desc&limit=100`)) || [];
}

/** 状態で絞った依頼（作業の名前つき・古い順） */
export async function requestsByState(env: Env, states: string[]): Promise<Array<{ req: Row; work: Row | null }>> {
  const rows: Row[] = (await sb(env, `mk_requests?select=${REQ_COLS}&state=in.(${states.map((s) => `"${s}"`).map(enc).join(",")})&order=created_at.asc&limit=200`)) || [];
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((r) => Number(r.work_id)))];
  const works: Row[] = (await sb(env, `mk_works?select=id,name,area,state,level&id=in.(${ids.join(",")})`)) || [];
  const byId = new Map(works.map((w) => [Number(w.id), w]));
  return rows.map((r) => ({ req: r, work: byId.get(Number(r.work_id)) ?? null }));
}

/** その状態のときだけ書き換える（返ってきた行が無ければ、ほかが先に書き換えた） */
async function patchIf(env: Env, id: number, from: string[] | null, patch: Record<string, unknown>): Promise<Row | null> {
  const cond = from ? `&state=in.(${from.map((s) => `"${s}"`).map(enc).join(",")})` : "";
  const rows = await sb(env, `mk_requests?id=eq.${id}${cond}&select=${REQ_COLS}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ ...patch, touched_at: new Date().toISOString() }) });
  return rows?.[0] ?? null;
}

/** OK待ちの依頼の TaskMaster のタスクを、いまの状態に合わせる */
async function syncRequestTask(env: Env, r: Row): Promise<void> {
  try {
    if (r.state === "OK待ち" && !r.tm_task_id) {
      const res = await handleTaskmasterAddTask(new Request("https://internal/taskmaster/tasks/add", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `OK待ち：${String(r.title).slice(0, 100)}`, links: [{ title: "マネージャーくんの依頼", url: `${SITE}/#r${r.id}` }] }),
      }), env);
      const b = (await res.json().catch(() => ({}))) as { task?: { id?: string } };
      if (res.ok && b.task?.id) await sb(env, `mk_requests?id=eq.${r.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ tm_task_id: b.task.id }) });
    } else if (r.state !== "OK待ち" && r.tm_task_id) {
      const res = await handleTaskmasterUpdateTask(new Request("https://internal/taskmaster/tasks/update", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id: r.tm_task_id, status: "done" }),
      }), env);
      if (res.ok || res.status === 404) await sb(env, `mk_requests?id=eq.${r.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ tm_task_id: null }) });
    }
  } catch { /* TaskMaster が止まっていても依頼は止めない */ }
}

/** 依頼を作る。段階と出どころで、そのまま順番待ちへ入れて動かすか、OK待ちで止めるかを決める */
export async function submitRequest(env: Env, workId: number, input: ReqInput, meta: { source: "Naoki" | "チャット" | "直し"; from_chat_no?: number | null; parent_id?: number | null; fix?: string }): Promise<{ req: Row; fired: FireResult | null }> {
  const c = checkRequest(input);
  if (!c.ok) throw new ManagerError("invalid_request", c.message);
  const work = await workById(env, workId);
  if (!work) throw new ManagerError("work_not_found", `作業 ${workId} はありません`);
  if (work.state === "済み") throw new ManagerError("work_done", `作業「${work.name}」は済みです。進行中に戻してから依頼を出してください`);
  const queue = autoQueue(Number(work.level ?? 1), meta.source);
  const rows = await sb(env, `mk_requests?select=${REQ_COLS}`, {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ work_id: workId, ...c.row, source: meta.source, from_chat_no: meta.from_chat_no ?? null, parent_id: meta.parent_id ?? null, fix: meta.fix ?? "", state: queue ? "順番待ち" : "OK待ち" }),
  });
  const req = rows?.[0];
  if (!req) throw new ManagerError("not_written", "依頼の行が返ってきませんでした");
  if (!queue) { if (Number(work.level ?? 1) >= 1) await syncRequestTask(env, req); return { req, fired: null }; }
  const fired = await runNext(env, workId);
  return { req: (await requestById(env, Number(req.id))) ?? req, fired };
}

/** OK：OK待ち → 順番待ちにして、空いていれば動かす */
export async function approveRequest(env: Env, id: number): Promise<{ req: Row; fired: FireResult | null }> {
  const r = await requestById(env, id);
  if (!r) throw new ManagerError("request_not_found", `依頼 ${id} はありません`);
  const w = await workById(env, Number(r.work_id));
  if (w && Number(w.level ?? 1) <= 0) throw new ManagerError("level_zero", "この作業は段階 0（実行しない）です。依頼文をコピーして自分で始めるか、段階を 1 に上げてください");
  const after = await patchIf(env, id, ["OK待ち"], { state: "順番待ち" });
  if (!after) throw new ManagerError("not_waiting", `依頼 ${id} は OK待ちではありません（いま：${r.state}）`);
  await syncRequestTask(env, after);
  const fired = await runNext(env, Number(r.work_id));
  return { req: (await requestById(env, id)) ?? after, fired };
}

export async function cancelRequest(env: Env, id: number): Promise<Row> {
  const after = await patchIf(env, id, ["OK待ち", "順番待ち"], { state: "やめた", done_at: new Date().toISOString() });
  if (!after) throw new ManagerError("not_cancellable", "やめられるのは OK待ち・順番待ちの依頼だけです");
  await syncRequestTask(env, after);
  return after;
}

export type FireResult = { ok: boolean; request_id: number; session_url?: string; message: string };

/** 作業の中で順番待ちの先頭を 1 つ動かす（実行中があれば何もしない） */
export async function runNext(env: Env, workId: number): Promise<FireResult | null> {
  const running: Row[] = (await sb(env, `mk_requests?select=id&work_id=eq.${workId}&state=eq.${enc("実行中")}&limit=1`)) || [];
  if (running.length) return null;
  const next: Row[] = (await sb(env, `mk_requests?select=${REQ_COLS}&work_id=eq.${workId}&state=eq.${enc("順番待ち")}&order=created_at.asc&limit=1`)) || [];
  if (!next.length) return null;
  const [url, token] = await Promise.all([getSetting(env, ROUTINE_URL_KEY), getSetting(env, ROUTINE_TOKEN_KEY)]);
  if (!url || !token) return { ok: false, request_id: Number(next[0].id), message: "実行係（ルーティン）の住所と鍵がまだ設定されていません。マネージャーくんの「実行係の設定」で入れると、順番待ちの依頼が動きます" };
  const req = await patchIf(env, Number(next[0].id), ["順番待ち"], { state: "実行中", fired_at: new Date().toISOString() });
  if (!req) return null; // ほかが先に動かした
  return fire(env, req, url, token);
}

/** 順番待ちのある作業を全部見て動かす（設定を保存したとき・30 分ごと） */
export async function runAllWaiting(env: Env): Promise<{ fired: number; errors: number }> {
  const rows: Row[] = (await sb(env, `mk_requests?select=work_id&state=eq.${enc("順番待ち")}&limit=200`)) || [];
  let fired = 0, errors = 0;
  for (const w of [...new Set(rows.map((r) => Number(r.work_id)))]) {
    const r = await runNext(env, w);
    if (r?.ok) fired++; else if (r && !r.ok) errors++;
  }
  return { fired, errors };
}

/** ルーティンを 1 回だけ呼ぶ（呼ぶ前に、このセッションのチャットの行を作って番号を渡す） */
async function fire(env: Env, req: Row, url: string, token: string): Promise<FireResult> {
  const id = Number(req.id);
  const work = await workById(env, Number(req.work_id));
  if (!work) { await patchIf(env, id, ["実行中"], { state: "止まった", result: "作業が見つかりませんでした", done_at: new Date().toISOString() }); return { ok: false, request_id: id, message: "作業が見つかりません" }; }
  const chat = await createChat(env, { name: `実行係：${String(req.title).slice(0, 100)}`, ai: "claude", state: "進行中", role: RUN_ROLE, surface: RUN_SURFACE, area: work.area ?? null });
  const runNo = Number(chat.no);
  await updateChat(env, runNo, { work_id: work.id, turn: "AI", turn_at: new Date().toISOString() });
  const [parent, done, chats] = await Promise.all([
    req.parent_id ? requestById(env, Number(req.parent_id)) : Promise.resolve(null),
    sb(env, `mk_done?select=text,link,at,chat_no&chat_no=in.(${await workChatNos(env, Number(work.id))})&order=at.desc&limit=8`).catch(() => []),
    sb(env, `mk_chats?select=no,name,state,url&work_id=eq.${work.id}&order=touched_at.desc&limit=10`).catch(() => []),
  ]);
  const text = requestText(req, work, runNo, { parent, done: done || [], chats: (chats || []).filter((c: Row) => Number(c.no) !== runNo) });
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "experimental-cc-routine-2026-04-01", "anthropic-version": "2026-10-21", "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    // 届いたか分からない：二重に動かさないため止めて、Naoki に確かめてもらう
    const msg = `実行係を呼んだが返事が来なかった（${String((e as Error)?.message || e).slice(0, 120)}）。claude.ai/code にこの依頼のセッションができていないか確かめてから、直しで出し直す`;
    await patchIf(env, id, ["実行中"], { state: "止まった", result: msg, run_chat_no: runNo, done_at: new Date().toISOString() });
    await updateChat(env, runNo, { state: "判断待ち", doing: msg.slice(0, 200), turn: "新着", turn_at: new Date().toISOString() });
    return { ok: false, request_id: id, message: msg };
  }
  const body = (await res.json().catch(() => ({}))) as { claude_code_session_url?: string; error?: { message?: string; type?: string } };
  if (!res.ok || !body.claude_code_session_url) {
    // 断られた（作られていない）：順番待ちへ戻し、作ったチャットの行は消す
    const why = res.status === 429 ? "呼び出しの回数の上限（1 時間あたり）に当たった。あとで自動でもう一度動かす" :
      res.status === 401 || res.status === 403 ? "実行係の鍵が通らない。claude.ai/code/routines で鍵を作り直し、設定に貼り直す" :
      `実行係が断った（${res.status}${body.error?.message ? `：${String(body.error.message).slice(0, 120)}` : ""}）`;
    await patchIf(env, id, ["実行中"], { state: "順番待ち", fired_at: null, result: why });
    await sb(env, `mk_chats?no=eq.${runNo}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch(() => null);
    await setSetting(env, ROUTINE_ERR_KEY, why);
    return { ok: false, request_id: id, message: why };
  }
  const session = String(body.claude_code_session_url);
  await patchIf(env, id, null, { session_url: session, run_chat_no: runNo, result: "" });
  await updateChat(env, runNo, { url: session, doing: `依頼 #${id} を実行中` });
  await setSetting(env, ROUTINE_ERR_KEY, null);
  return { ok: true, request_id: id, session_url: session, message: "実行係が動き始めました" };
}

async function workChatNos(env: Env, workId: number): Promise<string> {
  const rows: Row[] = (await sb(env, `mk_chats?select=no&work_id=eq.${workId}&limit=500`)) || [];
  return rows.length ? rows.map((r) => r.no).join(",") : "0";
}

/** 実行係からの報告：済み・止まった。やったことを残し、チャットを閉じる（止まったら判断待ち）。次の順番待ちを動かす */
export async function reportRequest(env: Env, id: number, input: { state: "済み" | "止まった"; result: string; pr?: string | null; pr_title?: string | null }): Promise<{ req: Row; next: FireResult | null }> {
  const r = await requestById(env, id);
  if (!r) throw new ManagerError("request_not_found", `依頼 ${id} はありません`);
  const after = await patchIf(env, id, ["実行中"], { state: input.state, result: input.result.slice(0, 4000), done_at: new Date().toISOString() });
  if (!after) throw new ManagerError("not_running", `依頼 ${id} は実行中ではありません（いま：${r.state}）`);
  const runNo = Number(after.run_chat_no || 0);
  if (runNo) {
    if (input.pr) await addDone(env, runNo, (input.pr_title || "PR を出した").slice(0, 200), input.pr);
    await addDone(env, runNo, `${input.state === "済み" ? "依頼を終えた" : "依頼を止めた"}：${input.result.replace(/\s+/g, " ").slice(0, 160)}`);
    const chat = await updateChat(env, runNo, input.state === "済み" ? { state: "閉じた", doing: "", turn: null } : { state: "判断待ち", doing: `依頼 #${id} で止まった：${input.result.replace(/\s+/g, " ").slice(0, 150)}`, turn: "新着", turn_at: new Date().toISOString() });
    await syncDecisionTask(env, chat);
  }
  const next = await runNext(env, Number(after.work_id));
  return { req: after, next };
}

/** 直し：結果に Naoki の言葉で直しを付け、同じ作業に「直し」の依頼を出す（書いた時点で OK とみなす） */
export async function fixRequest(env: Env, id: number, words: string): Promise<{ req: Row; fired: FireResult | null }> {
  const r = await requestById(env, id);
  if (!r) throw new ManagerError("request_not_found", `依頼 ${id} はありません`);
  const w = String(words || "").trim();
  if (!w) throw new ManagerError("invalid_fix", "直しの言葉が空です");
  await patchIf(env, id, null, { fix: w.slice(0, 4000) });
  return submitRequest(env, Number(r.work_id), { title: `直し：${String(r.title).replace(/^直し：/, "").slice(0, 110)}`, body: w, why: `依頼 #${id} の結果への直し`, stop: r.stop, recipe: r.recipe }, { source: "直し", parent_id: id, fix: w });
}

/** 段階 0 で自分で始めるための依頼文（ルーティンに渡すものとほぼ同じ） */
export async function requestPlainText(env: Env, id: number): Promise<string> {
  const r = await requestById(env, id);
  if (!r) throw new ManagerError("request_not_found", `依頼 ${id} はありません`);
  const work = await workById(env, Number(r.work_id));
  return [`【マネージャーくんの依頼 #${r.id}】`, `作業：${work?.name ?? ""}`, `依頼：${r.title}`, r.body && `中身：\n${r.body}`, r.why && `なぜ：${r.why}`, r.stop && `止める条件：${r.stop}`, r.recipe && `レシピ：${r.recipe}`,
    "", `始めたら ai_log__add のあと manager__work の name に「${work?.name ?? ""}」を渡して、この作業に入る。`].filter((x) => x !== "" && x !== null && x !== undefined && x !== false).join("\n");
}

/** チャットが今いる作業（無ければ null） */
export async function workOfChat(env: Env, chatNo: number): Promise<Row | null> {
  const c = await chatByNo(env, chatNo);
  return c?.work_id ? workById(env, Number(c.work_id)) : null;
}
