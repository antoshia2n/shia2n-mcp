/**
 * shia2n-mcp / src/manager-store.ts / 新設（2026-11-21 v1.125.0 開発部・マネージャーくん 1便目）
 *
 * マネージャーくんの台帳（Supabase の mk_chats・mk_pins）を読み書きする部品。
 * 道具（tools-manager.ts・tools-ai-log.ts）と画面の読み口（manager-http.ts）が同じこの 1 本を通る。
 * 表と関数を作る SQL は sql/manager.sql（ブラウザからは読めない・管理者キーだけ）。
 */
import type { Env } from "./index.js";
import { chatPageOf, extMayWriteArea, workKey, groupName, markerNo, mergeTurns, parseChatRef, pickChats, rankPins, titleWords, transcriptOf as joinTurns, nextTurn, workProgress, type CaptureCheck, type Turn, type TabRow } from "./manager-core.js";

type Row = Record<string, any>;
type SbEnv = Pick<Env, "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY">;

export class ManagerError extends Error {
  constructor(public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

const CHAT_COLS = "no,name,ai,url,state,doing,role,surface,pin_count,created_at,touched_at,transcript_at,turns,service,tm_task_id,initiative_no,initiative_name,area,area_src,work_id,turn,turn_at,work:mk_works(id,name,state)";
const PIN_INDEX_COLS = "id,chat_no,n,title,created_at";
const PICK_POOL = 500; // 名前で選ぶときに見る、最後に触った順のチャットの数

function headers(env: SbEnv, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    ...(/^eyJ/.test(String(env.SUPABASE_SERVICE_ROLE_KEY || "")) ? { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } : {}),
    "Content-Type": "application/json",
    ...extra,
  };
}

async function sb(env: SbEnv, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: headers(env, (init.headers as Record<string, string>) || {}) });
  const text = await res.text();
  if (!res.ok) {
    if (/chat_not_found/.test(text)) throw new ManagerError("chat_not_found", "そのチャット番号の行がありません");
    throw new ManagerError("supabase_error", `Supabase ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

const enc = encodeURIComponent;

/** チャットを 1 行作る */
export async function createChat(env: SbEnv, row: { name: string; ai: string; state: string; url?: string | null; role?: string | null; surface?: string | null; ai_log_id?: string | null; doing?: string; area?: string | null; area_src?: string | null }): Promise<Row> {
  const rows = await sb(env, `mk_chats?select=${CHAT_COLS}`, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
  if (!rows?.[0]) throw new ManagerError("not_written", "チャットの行が返ってきませんでした");
  return rows[0];
}

export async function chatByNo(env: SbEnv, no: number): Promise<Row | null> {
  const rows = await sb(env, `mk_chats?select=${CHAT_COLS}&no=eq.${no}`);
  return rows?.[0] ?? null;
}

export async function chatByUrl(env: SbEnv, url: string): Promise<Row | null> {
  const rows = await sb(env, `mk_chats?select=${CHAT_COLS}&url=eq.${enc(url)}&order=touched_at.desc&limit=1`);
  return rows?.[0] ?? null;
}

async function recentChats(env: SbEnv): Promise<Row[]> {
  return (await sb(env, `mk_chats?select=${CHAT_COLS}&order=touched_at.desc&limit=${PICK_POOL}`)) || [];
}

/**
 * 指し方（番号・住所・名前の言葉）からチャットを 1 本に決める。
 * 名前の言葉で複数当たったときは最後に触ったものを選び、ほかを候補（多くて 5）で返す。
 */
export async function resolveChat(env: SbEnv, ref: unknown, needPin?: number | null): Promise<{ chat: Row; others: Row[] }> {
  const r = parseChatRef(ref);
  if (!r) throw new ManagerError("invalid_chat", "chat が空です。チャット番号（例 12）か、名前の一部（例 統括）を渡してください");
  if ("no" in r) {
    const c = await chatByNo(env, r.no);
    if (!c) throw new ManagerError("chat_not_found", `チャット ${r.no} はありません`);
    return { chat: c, others: [] };
  }
  if ("url" in r) {
    const c = await chatByUrl(env, r.url);
    if (!c) throw new ManagerError("chat_not_found", "その住所のチャットは台帳にありません");
    return { chat: c, others: [] };
  }
  const hits = pickChats(await recentChats(env), r.words, needPin);
  if (!hits.length) throw new ManagerError("chat_not_found", `「${r.words.join(" ")}」を名前に含むチャット${needPin ? `（ピンが ${needPin} 個以上）` : ""}はありません。manager__search で探してください`);
  return { chat: hits[0], others: hits.slice(1, 6) };
}

/** 一覧。state を省くと閉じた以外。ai で絞れる */
export const UNSORTED = "未分類"; // 分野が空のチャットの棚

export async function listChats(env: SbEnv, opt: { state?: string | null; ai?: string | null; limit?: number; initiative?: string | null; area?: string | null; work?: number | null } = {}): Promise<Row[]> {
  const q = [`select=${CHAT_COLS}`, `order=touched_at.desc`, `limit=${Math.min(Math.max(opt.limit ?? 50, 1), 300)}`];
  if (opt.state === "すべて") { /* 絞らない */ }
  else if (opt.state) q.push(`state=eq.${enc(opt.state)}`);
  else q.push(`state=neq.${enc("閉じた")}`);
  if (opt.ai) q.push(`ai=eq.${enc(opt.ai)}`);
  if (opt.initiative && /^\d{2}$/.test(opt.initiative)) q.push(`initiative_no=eq.${opt.initiative}`);
  if (opt.work) q.push(`work_id=eq.${Number(opt.work)}`);
  if (opt.area === UNSORTED) q.push("area=is.null");
  else if (opt.area) q.push(`area=eq.${enc(opt.area)}`);
  return (await sb(env, `mk_chats?${q.join("&")}`)) || [];
}

/** 状態の数（閉じたも含む全部） */
export async function stateCounts(env: SbEnv): Promise<Record<string, number>> {
  const rows: Row[] = (await sb(env, `mk_chats?select=state&limit=10000`)) || [];
  const out: Record<string, number> = { 進行中: 0, 判断待ち: 0, 寝かせ中: 0, 閉じた: 0 };
  for (const r of rows) out[r.state] = (out[r.state] || 0) + 1;
  return out;
}

export async function updateChat(env: SbEnv, no: number, patch: Record<string, unknown>): Promise<Row> {
  const rows = await sb(env, `mk_chats?no=eq.${no}&select=${CHAT_COLS}`, {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ ...patch, touched_at: new Date().toISOString() }),
  });
  if (!rows?.[0]) throw new ManagerError("chat_not_found", `チャット ${no} はありません`);
  return rows[0];
}

export async function addPin(env: SbEnv, chatNo: number, title: string, body: string): Promise<Row> {
  const rows = await sb(env, `rpc/mk_add_pin`, { method: "POST", body: JSON.stringify({ p_chat: chatNo, p_title: title, p_body: body }) });
  if (!rows?.[0]) throw new ManagerError("not_written", "ピンの行が返ってきませんでした");
  return { ...rows[0], title };
}

/** そのチャットのピンの目次（題だけ・番号順） */
export async function pinIndex(env: SbEnv, chatNo: number): Promise<Row[]> {
  return (await sb(env, `mk_pins?select=${PIN_INDEX_COLS}&chat_no=eq.${chatNo}&order=n.asc&limit=1000`)) || [];
}

export async function pinFull(env: SbEnv, chatNo: number, n: number): Promise<Row | null> {
  const rows = await sb(env, `mk_pins?select=id,chat_no,n,title,body,created_at&chat_no=eq.${chatNo}&n=eq.${n}`);
  return rows?.[0] ?? null;
}

/** 自動で読んだ全文（v1.126.0） */
export async function transcriptOf(env: SbEnv, no: number): Promise<{ transcript: string | null; transcript_at: string | null; turns: number | null } | null> {
  const rows = await sb(env, `mk_chats?select=transcript,transcript_at,turns&no=eq.${no}`);
  return rows?.[0] ?? null;
}

export async function pinById(env: SbEnv, id: string): Promise<Row | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await sb(env, `mk_pins?select=id,chat_no,n,title,body,created_at&id=eq.${id}`);
  return rows?.[0] ?? null;
}

/** 題・1 行・ピンの全文から探す（言葉は空白で区切って全部を含むもの） */
export async function search(env: SbEnv, q: string, limit = 30): Promise<Row[]> {
  return (await sb(env, `rpc/mk_search`, { method: "POST", body: JSON.stringify({ p_q: q, p_limit: limit }) })) || [];
}

/** 判断待ちのチャットに、それぞれの最後のピンの題を添える */
export async function lastPinTitles(env: SbEnv, chatNos: number[]): Promise<Record<number, { n: number; title: string }>> {
  if (!chatNos.length) return {};
  const rows: Row[] = (await sb(env, `mk_pins?select=chat_no,n,title&chat_no=in.(${chatNos.join(",")})&order=n.desc&limit=2000`)) || [];
  const out: Record<number, { n: number; title: string }> = {};
  for (const r of rows) if (!out[r.chat_no]) out[r.chat_no] = { n: r.n, title: r.title };
  return out;
}

/* ─── v1.126.0（2026-11-21 2便目）：シアニンパネルが自動で読んだ全文を受ける ─── */

export const PANEL_SURFACE = "シアニンパネル"; // 拡張が作った行の印（名前を題に合わせて直してよい行）

/**
 * 読んだ全文を台帳の 1 行に結んで上書きする。結び方は 3 段：
 *   ① 住所が台帳にある行 ② 全文の中の「台帳 #N」の行（住所が空・同じ・拡張で読めないページのときだけ・住所を入れる） ③ 新しい行
 */
export async function applyCapture(env: SbEnv, cap: Extract<CaptureCheck, { ok: true }>): Promise<{ no: number; how: "url" | "marker" | "new"; name: string }> {
  const r = await applyCaptureRow(env, cap);
  if (cap.group) await attachGroup(env, r.no, cap.group).catch(() => null); // v1.132.0：タブのまとまりの名前 → 作業
  return r;
}

/** Chrome のタブのまとまりの名前の作業へ、チャットを入れる（同じ作業に入っていれば何もしない）（v1.132.0） */
export async function attachGroup(env: SbEnv, chatNo: number, group: string): Promise<{ chat: Row; work: Row | null }> {
  const name = groupName(group);
  const chat = await chatByNo(env, chatNo);
  if (!chat || !name) throw new ManagerError("chat_not_found", "チャットがありません");
  if (chat.work && workKey(chat.work.name) === workKey(name) && chat.work.state === "進行中") return { chat, work: chat.work };
  const any = await openWorkNamed(env, name); // v1.133.0：同じ名前の作業がほかの分野にあれば、そこへ入れる
  if (any) return { chat: await attachWorkId(env, chatNo, Number(any.id)), work: any };
  return { chat, work: null }; // v1.149.0：未保存のまとまりからは作業を作らない（v1.148.3 の片づけた名前もここで止まる）
}

async function applyCaptureRow(env: SbEnv, cap: Extract<CaptureCheck, { ok: true }>): Promise<{ no: number; how: "url" | "marker" | "new"; name: string }> {
  const now = new Date().toISOString();
  const body = { transcript: cap.transcript, transcript_at: now, turns: cap.turns, service: cap.service, touched_at: now, turns_json: cap.list };
  const hit = await chatByUrl(env, cap.url);
  if (hit) {
    const patch: Record<string, unknown> = { ...body };
    const prev = await sb(env, `mk_chats?select=turns_json,transcript&no=eq.${hit.no}`);
    // v1.126.2：往復の番号があれば、前に受けた分と足し合わせる（画面に出ていない往復を消さない）
    if (cap.list.some((t) => t.k)) {
      const merged = mergeTurns((prev?.[0]?.turns_json as Turn[] | null) ?? null, cap.list);
      Object.assign(patch, { turns_json: merged, turns: merged.length, transcript: joinTurns(merged, cap.service) });
    }
    // v1.133.0：誰の番。中身が変わったときだけ「返事が来た」にする（裏で開いただけのタブで点かない）
    const turn = nextTurn(hit.turn, String(prev?.[0]?.transcript ?? "") !== String(patch.transcript), cap.seen);
    if (turn && turn !== hit.turn) Object.assign(patch, { turn, turn_at: new Date().toISOString() });
    if (hit.surface === PANEL_SURFACE && hit.name !== cap.title) patch.name = cap.title; // 拡張が作った行だけ、題の変化に合わせる
    if (extMayWriteArea(hit, cap.project)) Object.assign(patch, { area: cap.project, area_src: "拡張" }); // v1.128.0：プロジェクト名を棚に
    const r = await updateChat(env, Number(hit.no), patch);
    return { no: Number(r.no), how: "url", name: String(r.name) };
  }
  const m = markerNo(cap.transcript);
  if (m) {
    const c = await chatByNo(env, m);
    // v1.126.1：印の行の住所が空・同じ・拡張では読めないページ（AI が渡した Claude Code の住所など）のときは結ぶ。
    // 別の Claude・ChatGPT のチャットの住所が入っている行は、写した印（引用）とみなして結ばない
    if (c && (!c.url || c.url === cap.url || !chatPageOf(c.url))) {
      const r = await updateChat(env, m, { ...body, url: cap.url, ...(extMayWriteArea(c, cap.project) ? { area: cap.project, area_src: "拡張" } : {}) });
      return { no: Number(r.no), how: "marker", name: String(r.name) };
    }
  }
  const row = await createChat(env, { name: cap.title, ai: cap.service === "chatgpt" ? "gpt" : "claude", state: "進行中", url: cap.url, surface: PANEL_SURFACE,
    ...(cap.project ? { area: cap.project, area_src: "拡張" } : {}) });
  const r = await updateChat(env, Number(row.no), { ...body, turn: "Naoki", turn_at: now });
  return { no: Number(r.no), how: "new", name: String(r.name) };
}

/** 拡張の鍵：新しく 1 本入れる（前の鍵は止める・拡張は 1 つの前提） */
export async function issueKey(env: SbEnv, hash: string): Promise<void> {
  await revokeKeys(env);
  await sb(env, `mk_ext_keys`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ key_hash: hash }) });
}

export async function revokeKeys(env: SbEnv): Promise<void> {
  await sb(env, `mk_ext_keys?revoked_at=is.null`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ revoked_at: new Date().toISOString() }) });
}

/** 生きている鍵なら id を返し、使った時刻を残す */
export async function useKey(env: SbEnv, hash: string): Promise<string | null> {
  const rows = await sb(env, `mk_ext_keys?select=id&key_hash=eq.${hash}&revoked_at=is.null`);
  const id = rows?.[0]?.id ?? null;
  if (id) await sb(env, `mk_ext_keys?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_used_at: new Date().toISOString() }) });
  return id;
}

export async function keyStatus(env: SbEnv): Promise<{ connected: boolean; created_at: string | null; last_used_at: string | null }> {
  const rows: Row[] = (await sb(env, `mk_ext_keys?select=created_at,last_used_at&revoked_at=is.null&order=created_at.desc&limit=1`)) || [];
  return { connected: rows.length > 0, created_at: rows[0]?.created_at ?? null, last_used_at: rows[0]?.last_used_at ?? null };
}

/* ─── v1.128.0（2026-11-22 4便目）：分野の棚・やったこと・題名でピン ─── */

/** 分野ごとの数（閉じた以外・すべて）。空の分野は「未分類」 */
export async function areaCounts(env: SbEnv): Promise<Array<{ 分野: string; 閉じた以外: number; すべて: number }>> {
  const rows: Row[] = (await sb(env, `mk_chats?select=area,state&limit=10000`)) || [];
  const m = new Map<string, { 分野: string; 閉じた以外: number; すべて: number }>();
  for (const r of rows) {
    const k = r.area || UNSORTED;
    const o = m.get(k) || { 分野: k, 閉じた以外: 0, すべて: 0 };
    o.すべて++; if (r.state !== "閉じた") o.閉じた以外++;
    m.set(k, o);
  }
  return [...m.values()].sort((a, b) => (a.分野 === UNSORTED ? 1 : 0) - (b.分野 === UNSORTED ? 1 : 0) || b.閉じた以外 - a.閉じた以外 || b.すべて - a.すべて || a.分野.localeCompare(b.分野, "ja"));
}

/** やったことを 1 行足す（チャットの最後に触った時刻も進める） */
export async function addDone(env: SbEnv, chatNo: number, text: string, link: string | null = null): Promise<{ row: Row; chat: Row }> {
  const rows = await sb(env, `mk_done?select=id,chat_no,text,link,at`, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ chat_no: chatNo, text, ...(link ? { link } : {}) }) });
  if (!rows?.[0]) throw new ManagerError("not_written", "やったことの行が返ってきませんでした");
  const chat = await updateChat(env, chatNo, {});
  if (chat.work_id) await touchWork(env, Number(chat.work_id));
  return { row: rows[0], chat };
}

/** そのチャットのやったこと（新しい順） */
export async function doneOf(env: SbEnv, chatNo: number, limit = 200): Promise<Row[]> {
  return (await sb(env, `mk_done?select=id,chat_no,text,link,at&chat_no=eq.${chatNo}&order=at.desc&limit=${limit}`)) || [];
}

/** ある時刻からのやったこと（新しい順） */
export async function doneSince(env: SbEnv, sinceIso: string, limit = 500): Promise<Row[]> {
  return (await sb(env, `mk_done?select=id,chat_no,text,link,at&at=gte.${enc(sinceIso)}&order=at.desc&limit=${limit}`)) || [];
}

/** ある時刻から触ったチャット（拡張が全文を読んだもの・新しい順） */
export async function chatsReadSince(env: SbEnv, sinceIso: string, limit = 200): Promise<Row[]> {
  return (await sb(env, `mk_chats?select=${CHAT_COLS}&transcript_at=gte.${enc(sinceIso)}&order=transcript_at.desc&limit=${limit}`)) || [];
}

export async function chatsByNos(env: SbEnv, nos: number[]): Promise<Row[]> {
  if (!nos.length) return [];
  return (await sb(env, `mk_chats?select=${CHAT_COLS}&no=in.(${[...new Set(nos)].join(",")})`)) || [];
}

/** 拡張だけで残ったチャットの「最後の頼みごと」（往復の最後の Naoki の発言・200 字まで） */
export async function lastAsks(env: SbEnv, nos: number[]): Promise<Record<number, string>> {
  if (!nos.length) return {};
  const rows: Row[] = (await sb(env, `rpc/mk_last_asks`, { method: "POST", body: JSON.stringify({ p_nos: [...new Set(nos)] }) })) || [];
  const out: Record<number, string> = {};
  for (const r of rows) if (r.ask) out[Number(r.no)] = String(r.ask).replace(/\s+/g, " ").trim();
  return out;
}

/** ピンを題の言葉で探す（言葉を全部含むもの）。題がそのまま一致するものが先、あとは新しい順 */
export async function pinsByTitle(env: SbEnv, q: string, limit = 20): Promise<Row[]> {
  const ws = titleWords(q);
  if (!ws.length) return [];
  const cond = ws.map((w) => `title.ilike.*${w}*`).join(",");
  const rows: Row[] = (await sb(env, `mk_pins?select=${PIN_INDEX_COLS}&and=(${enc(cond)})&order=created_at.desc&limit=200`)) || [];
  return rankPins(rows, ws.join(" ")).slice(0, limit);
}

/* ─── v1.129.0（2026-11-22 5便目）：作業（分野 ＞ 作業 ＞ チャット） ─── */

const WORK_COLS = "id,name,area,state,level,kind,tabs,tabs_at,tm_project_id,tm_project_name,tm_task_id,tm_deadline,tm_priority,created_at,touched_at,closed_at";

export async function workById(env: SbEnv, id: number): Promise<Row | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const rows = await sb(env, `mk_works?select=${WORK_COLS}&id=eq.${id}`);
  return rows?.[0] ?? null;
}

export async function touchWork(env: SbEnv, id: number): Promise<void> {
  await sb(env, `mk_works?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ touched_at: new Date().toISOString() }) });
}

/** 作業の一覧と、それぞれの中のチャット（状態だけ）。all でなければ済みは外す */
export async function worksWithChats(env: SbEnv, opt: { all?: boolean; area?: string | null } = {}): Promise<Array<{ work: Row; chats: Row[]; reqs: Row[] }>> {
  const q = [`select=${WORK_COLS}`, "order=touched_at.desc", "limit=500"];
  if (!opt.all) q.push(`state=eq.${enc("進行中")}`);
  if (opt.area === UNSORTED) q.push("area=is.null"); else if (opt.area) q.push(`area=eq.${enc(opt.area)}`);
  const works: Row[] = (await sb(env, `mk_works?${q.join("&")}`)) || [];
  if (!works.length) return [];
  const ids = works.map((w) => w.id).join(",");
  const [chats, reqs]: [Row[], Row[]] = await Promise.all([
    sb(env, `mk_chats?select=no,name,ai,url,state,touched_at,work_id,turn&work_id=in.(${ids})&limit=5000`).then((x) => x || []),
    sb(env, `mk_requests?select=id,work_id,state,done_at&work_id=in.(${ids})&limit=5000`).then((x) => x || []),
  ]);
  // v1.136.0：評価した依頼に印（評価待ちの数のため）
  const scored = new Set(((await sb(env, `mk_scores?select=request_id&work_id=in.(${ids})&request_id=not.is.null&limit=5000`)) || []).map((r: Row) => Number(r.request_id)));
  for (const r of reqs) r.scored = scored.has(Number(r.id));
  // v1.134.0：作業ごとの最後のやったこと（「今」のカード）
  const byChat = new Map(chats.map((c) => [Number(c.no), Number(c.work_id)]));
  const lastDone = new Map<number, Row>();
  if (chats.length) {
    const done: Row[] = (await sb(env, `mk_done?select=chat_no,text,at&chat_no=in.(${chats.map((c) => c.no).join(",")})&order=at.desc&limit=1000`)) || [];
    for (const d of done) { const w = byChat.get(Number(d.chat_no)); if (w && !lastDone.has(w)) lastDone.set(w, d); }
  }
  return works.map((w) => ({ work: { ...w, last_done: lastDone.get(Number(w.id)) ?? null }, chats: chats.filter((c) => Number(c.work_id) === Number(w.id)), reqs: reqs.filter((r) => Number(r.work_id) === Number(w.id)) }));
}

/** 同じ分野の開いている作業から、名前の形が同じものを探す。無ければ作る */
export async function findOrCreateWork(env: SbEnv, name: string, area: string | null): Promise<{ work: Row; created: boolean }> {
  const q = [`select=${WORK_COLS}`, `state=eq.${enc("進行中")}`, "order=touched_at.desc", "limit=500", area ? `area=eq.${enc(area)}` : "area=is.null"];
  const open: Row[] = (await sb(env, `mk_works?${q.join("&")}`)) || [];
  const k = workKey(name);
  const hit = open.find((w) => workKey(w.name) === k);
  if (hit) return { work: hit, created: false };
  const rows = await sb(env, `mk_works?select=${WORK_COLS}`, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ name, area }) });
  if (!rows?.[0]) throw new ManagerError("not_written", "作業の行が返ってきませんでした");
  return { work: rows[0], created: true };
}

/** チャットを作業に入れる（name が null なら作業から外す）。チャットの分野の中で探す */
export async function attachWork(env: SbEnv, chat: Row, name: string | null): Promise<{ chat: Row; work: Row | null; created: boolean }> {
  if (!name) return { chat: await updateChat(env, Number(chat.no), { work_id: null }), work: null, created: false };
  const { work, created } = await findOrCreateWork(env, name, chat.area ?? null);
  const after = await updateChat(env, Number(chat.no), { work_id: work.id });
  if (!created) await touchWork(env, Number(work.id));
  return { chat: after, work, created };
}

export async function attachWorkId(env: SbEnv, chatNo: number, workId: number | null): Promise<Row> {
  if (workId !== null && !(await workById(env, workId))) throw new ManagerError("work_not_found", `作業 ${workId} はありません`);
  const after = await updateChat(env, chatNo, { work_id: workId });
  if (workId) await touchWork(env, workId);
  return after;
}

export async function updateWork(env: SbEnv, id: number, patch: Record<string, unknown>): Promise<Row> {
  const rows = await sb(env, `mk_works?id=eq.${id}&select=${WORK_COLS}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ ...patch, touched_at: new Date().toISOString() }) });
  if (!rows?.[0]) throw new ManagerError("work_not_found", `作業 ${id} はありません`);
  return rows[0];
}

/** from の作業のチャットを to へ移し、from を消す */
export async function mergeWork(env: SbEnv, from: number, to: number): Promise<Row> {
  if (from === to) throw new ManagerError("invalid_merge", "同じ作業にはまとめられません");
  const [a, b] = await Promise.all([workById(env, from), workById(env, to)]);
  if (!a || !b) throw new ManagerError("work_not_found", "作業が見つかりません");
  const min = { method: "PATCH", headers: { Prefer: "return=minimal" } };
  await sb(env, `mk_chats?work_id=eq.${from}`, { ...min, body: JSON.stringify({ work_id: to }) });
  // v1.142.0：依頼と評価も移す（前は作業を消したときに一緒に消えていた）
  await sb(env, `mk_requests?work_id=eq.${from}`, { ...min, body: JSON.stringify({ work_id: to }) });
  await sb(env, `mk_scores?work_id=eq.${from}`, { ...min, body: JSON.stringify({ work_id: to }) });
  // 保存したタブは足し合わせ、型・フォルダ・タスクは移す先に無いときだけ引き継ぐ
  const tabs = [...(Array.isArray(b.tabs) ? b.tabs : []), ...(Array.isArray(a.tabs) ? a.tabs : [])].filter((t: any, i: number, xs: any[]) => xs.findIndex((x: any) => x.url === t.url) === i).slice(0, 40);
  const patch: Record<string, unknown> = { tabs: tabs.length ? tabs : null };
  if (!b.kind && a.kind) patch.kind = a.kind;
  if (!b.tm_project_id && a.tm_project_id) Object.assign(patch, { tm_project_id: a.tm_project_id, tm_project_name: a.tm_project_name });
  const moveTask = !b.tm_task_id && a.tm_task_id;
  await sb(env, `mk_works?id=eq.${from}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  if (moveTask) Object.assign(patch, { tm_task_id: a.tm_task_id, tm_deadline: a.tm_deadline, tm_priority: a.tm_priority });
  const after = await updateWork(env, to, patch);
  return Object.assign(after, { dropped_task: !moveTask && a.tm_task_id ? String(a.tm_task_id) : null });
}

/** 作業の中身：チャット・やったこと（住所つき）・ピンの題 */
export async function workDetail(env: SbEnv, id: number): Promise<{ work: Row; chats: Row[]; done: Row[]; pins: Row[] } | null> {
  const work = await workById(env, id);
  if (!work) return null;
  const chats: Row[] = (await sb(env, `mk_chats?select=${CHAT_COLS}&work_id=eq.${id}&order=touched_at.desc&limit=200`)) || [];
  const nos = chats.map((c) => Number(c.no));
  if (!nos.length) return { work, chats, done: [], pins: [] };
  const [done, pins] = await Promise.all([
    sb(env, `mk_done?select=id,chat_no,text,link,at&chat_no=in.(${nos.join(",")})&order=at.desc&limit=500`),
    sb(env, `mk_pins?select=${PIN_INDEX_COLS}&chat_no=in.(${nos.join(",")})&order=created_at.desc&limit=500`),
  ]);
  return { work, chats, done: done || [], pins: pins || [] };
}

/* ─── v1.133.0（2026-11-22 7便目）：誰の番・タブの保存 ─── */

/** 分野を問わず、開いている作業から名前の形が同じものを探す（いちばん最近触ったもの） */
/**
 * v1.148.3（2026-11-23 Naoki「削除したのに復活して入ってくる」）：完了・中止・削除した作業の名前を、30 分は作り直さない。
 * Chrome にその名前のまとまりが残っていると、拡張の自動保存（3 秒）やチャットの読み取りが同じ名前の作業を新しく作っていた。
 */
export const GONE_MIN = 30;
export async function recentlyGone(env: SbEnv, name: string): Promise<boolean> {
  const k = workKey(name), since = new Date(Date.now() - GONE_MIN * 60_000).toISOString();
  const [closed, gone]: [Row[], Row[]] = await Promise.all([
    sb(env, `mk_works?select=name&state=in.(${enc("済み")},${enc("中止")})&closed_at=gte.${enc(since)}&limit=200`).then((x) => x || []),
    sb(env, `mk_gone?select=key&at=gte.${enc(since)}&limit=200`).then((x) => x || []).catch(() => []),
  ]);
  return closed.some((w) => workKey(w.name) === k) || gone.some((g) => g.key === k);
}
export async function markGone(env: SbEnv, name: string): Promise<void> {
  await sb(env, "mk_gone", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ key: workKey(name), name, at: new Date().toISOString() }) }).catch(() => null);
}
export async function openWorkNamed(env: SbEnv, name: string): Promise<Row | null> {
  const k = workKey(name);
  const open: Row[] = (await sb(env, `mk_works?select=${WORK_COLS}&state=eq.${enc("進行中")}&order=touched_at.desc&limit=500`)) || [];
  return open.find((w) => workKey(w.name) === k) ?? null;
}

/** 拡張からの合図：AI が書き始めた／Naoki がそのタブを見た。台帳に無いチャットは何もしない */
export async function setTurnByUrl(env: SbEnv, url: string, kind: "AI" | "seen"): Promise<Row | null> {
  const c = await chatByUrl(env, url);
  if (!c) return null;
  const turn = kind === "AI" ? "AI" : c.turn === "新着" ? "Naoki" : null;
  if (!turn || turn === c.turn) return c;
  const rows = await sb(env, `mk_chats?no=eq.${c.no}&select=${CHAT_COLS}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ turn, turn_at: new Date().toISOString() }) });
  return rows?.[0] ?? c;
}

/** 作業の色（まとまりを塗る）：中のチャットと依頼から */
export async function workColor(env: SbEnv, workId: number): Promise<{ name: string; color: string } | null> {
  const w = await workById(env, workId);
  if (!w) return null;
  const [chats, reqs] = await Promise.all([
    sb(env, `mk_chats?select=no,state,turn&work_id=eq.${workId}&limit=500`),
    sb(env, `mk_requests?select=state&work_id=eq.${workId}&limit=500`),
  ]);
  return { name: String(w.name), color: workProgress(w, chats || [], reqs || []).色 };
}

/** タブのまとまりの中身を作業へ写す。作業が無ければ作る（分野は中のチャットの分野でいちばん多いもの） */
export async function saveGroupTabs(env: SbEnv, group: string, tabs: TabRow[], create = false): Promise<{ work: Row | null; created: boolean; skipped?: boolean; unsaved?: boolean }> {
  const name = groupName(group);
  if (!name) throw new ManagerError("invalid", "まとまりの名前がありません");
  let work = await openWorkNamed(env, name);
  let created = false;
  if (!work && await recentlyGone(env, name)) return { work: null, created: false, skipped: true }; // v1.148.3
  // v1.149.0（2026-11-24 Naoki「保存は保存したいやつだけ」）：自動保存は、保存済みの作業のタブを追いかけるだけ。作業は Naoki が「保存」を押したとき（create）だけ作る
  if (!work && !create) return { work: null, created: false, unsaved: true };
  if (!work) {
    const areas: string[] = [];
    for (const t of tabs) { const p = chatPageOf(t.url); if (!p) continue; const c = await chatByUrl(env, p.url); if (c?.area) areas.push(String(c.area)); }
    const top = areas.sort((a, b) => areas.filter((x) => x === b).length - areas.filter((x) => x === a).length)[0] ?? null;
    const r = await findOrCreateWork(env, name, top);
    work = r.work; created = r.created;
  }
  const rows = await sb(env, `mk_works?id=eq.${work.id}&select=${WORK_COLS}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ tabs, tabs_at: new Date().toISOString(), touched_at: new Date().toISOString() }) });
  return { work: rows?.[0] ?? work, created };
}
