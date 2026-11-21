/**
 * shia2n-mcp / src/manager-store.ts / 新設（2026-11-21 v1.125.0 開発部・マネージャーくん 1便目）
 *
 * マネージャーくんの台帳（Supabase の mk_chats・mk_pins）を読み書きする部品。
 * 道具（tools-manager.ts・tools-ai-log.ts）と画面の読み口（manager-http.ts）が同じこの 1 本を通る。
 * 表と関数を作る SQL は sql/manager.sql（ブラウザからは読めない・管理者キーだけ）。
 */
import type { Env } from "./index.js";
import { markerNo, parseChatRef, pickChats, type CaptureCheck } from "./manager-core.js";

type Row = Record<string, any>;
type SbEnv = Pick<Env, "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY">;

export class ManagerError extends Error {
  constructor(public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

const CHAT_COLS = "no,name,ai,url,state,doing,role,surface,pin_count,created_at,touched_at,transcript_at,turns,service";
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
export async function createChat(env: SbEnv, row: { name: string; ai: string; state: string; url?: string | null; role?: string | null; surface?: string | null; ai_log_id?: string | null; doing?: string }): Promise<Row> {
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
export async function listChats(env: SbEnv, opt: { state?: string | null; ai?: string | null; limit?: number } = {}): Promise<Row[]> {
  const q = [`select=${CHAT_COLS}`, `order=touched_at.desc`, `limit=${Math.min(Math.max(opt.limit ?? 50, 1), 300)}`];
  if (opt.state === "すべて") { /* 絞らない */ }
  else if (opt.state) q.push(`state=eq.${enc(opt.state)}`);
  else q.push(`state=neq.${enc("閉じた")}`);
  if (opt.ai) q.push(`ai=eq.${enc(opt.ai)}`);
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
 *   ① 住所が台帳にある行 ② 全文の中の「台帳 #N」の行（住所が空か同じときだけ・住所を入れる） ③ 新しい行
 */
export async function applyCapture(env: SbEnv, cap: Extract<CaptureCheck, { ok: true }>): Promise<{ no: number; how: "url" | "marker" | "new"; name: string }> {
  const now = new Date().toISOString();
  const body = { transcript: cap.transcript, transcript_at: now, turns: cap.turns, service: cap.service, touched_at: now };
  const hit = await chatByUrl(env, cap.url);
  if (hit) {
    const patch: Record<string, unknown> = { ...body };
    if (hit.surface === PANEL_SURFACE && hit.name !== cap.title) patch.name = cap.title; // 拡張が作った行だけ、題の変化に合わせる
    const r = await updateChat(env, Number(hit.no), patch);
    return { no: Number(r.no), how: "url", name: String(r.name) };
  }
  const m = markerNo(cap.transcript);
  if (m) {
    const c = await chatByNo(env, m);
    if (c && (!c.url || c.url === cap.url)) {
      const r = await updateChat(env, m, { ...body, url: cap.url });
      return { no: Number(r.no), how: "marker", name: String(r.name) };
    }
  }
  const row = await createChat(env, { name: cap.title, ai: cap.service === "chatgpt" ? "gpt" : "claude", state: "進行中", url: cap.url, surface: PANEL_SURFACE });
  const r = await updateChat(env, Number(row.no), body);
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
