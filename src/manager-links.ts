/**
 * shia2n-mcp / src/manager-links.ts / 新設（2026-11-22 v1.127.0 開発部・マネージャーくん 3便目・Naoki OK 00:05）
 *
 * マネージャーくんの台帳を、ほかのアプリとつなぐ部品（新しい鍵は増やさない・今ある身分と受け口を使う）。
 *   ① TaskMaster：判断待ちのチャットに「判断：チャットの名前」のタスクを立て、判断待ちでなくなったら済みにする
 *      （taskmaster.ts の受け口 handleTaskmasterAddTask・handleTaskmasterUpdateTask を通す。立てたタスクの番号は mk_chats.tm_task_id）
 *   ② Notion：チャットの住所と Sessions の「チャットURL」が同じ行を探して返す（読むだけ・NOTION_TOKEN）
 *   ③ haAku：取り組みの一覧（番号と名前）を読む（読むだけ・haAku と同じ Firestore）
 *   ④ NotebookLM：Naoki が共有した Google ドキュメント 1 枚へ、ピンの全文と台帳の 1 行を書き直す
 *      （るーみんの台本と同じ機械用の身分 FIREBASE_SA_EMAIL。NotebookLM はドライブのドキュメントを自動で追いかける）
 * どれも失敗しても台帳そのものは止めない（結果を返すだけ）。
 */
import type { Env } from "./index.js";
import { getGoogleTokenForScope } from "./google-token.js";
import { fromVal, fsGetOrNull, getFirestoreToken, handleTaskmasterAddTask, handleTaskmasterUpdateTask, type FVal } from "./taskmaster.js";
import { jstShort } from "./manager-core.js";

type Row = Record<string, any>;
const SITE = "https://manager.shia2n.jp";

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
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/* ─── 設定（mk_settings） ─── */
export async function getSetting(env: Env, key: string): Promise<string | null> {
  const rows = await sb(env, `mk_settings?select=value&key=eq.${encodeURIComponent(key)}`);
  return rows?.[0]?.value ?? null;
}
export async function setSetting(env: Env, key: string, value: string | null): Promise<void> {
  await sb(env, `mk_settings?on_conflict=key`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }) });
}

/* ─── ① TaskMaster ─── */

/** 1 本のチャットの判断のタスクを、いまの状態に合わせる（何度呼んでも同じ結果） */
export async function syncDecisionTask(env: Env, chat: Row): Promise<{ action: "added" | "done" | "none"; task_id?: string; error?: string }> {
  const no = Number(chat.no);
  try {
    if (chat.state === "判断待ち" && !chat.tm_task_id) {
      const title = `判断：${String(chat.name || "").slice(0, 100)}${chat.doing ? `（${String(chat.doing).slice(0, 80)}）` : ""}`;
      const res = await handleTaskmasterAddTask(new Request("https://internal/taskmaster/tasks/add", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, links: [{ title: "マネージャーくんのチャット", url: `${SITE}/#c${no}` }] }),
      }), env);
      const b = (await res.json().catch(() => ({}))) as { task?: { id?: string }; error?: string };
      if (!res.ok || !b.task?.id) return { action: "none", error: String(b.error || `status_${res.status}`).slice(0, 120) };
      await sb(env, `mk_chats?no=eq.${no}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ tm_task_id: b.task.id }) });
      return { action: "added", task_id: b.task.id };
    }
    if (chat.state !== "判断待ち" && chat.tm_task_id) {
      const res = await handleTaskmasterUpdateTask(new Request("https://internal/taskmaster/tasks/update", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id: chat.tm_task_id, status: "done" }),
      }), env);
      // 人が TaskMaster で先に消していた（404）ときも、台帳の印は外す
      if (!res.ok && res.status !== 404) return { action: "none", error: `status_${res.status}` };
      await sb(env, `mk_chats?no=eq.${no}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ tm_task_id: null }) });
      return { action: "done", task_id: chat.tm_task_id };
    }
    return { action: "none" };
  } catch (e) {
    return { action: "none", error: String((e as Error)?.message || e).slice(0, 160) };
  }
}

/** 判断のタスクが要るのに無い・要らないのに残っている行を、全部そろえる（30 分ごと） */
export async function syncAllDecisionTasks(env: Env): Promise<{ added: number; done: number; errors: number }> {
  const rows: Row[] = (await sb(env, `mk_chats?select=no,name,doing,state,tm_task_id&or=(and(state.eq.${encodeURIComponent("判断待ち")},tm_task_id.is.null),and(state.neq.${encodeURIComponent("判断待ち")},tm_task_id.not.is.null))&limit=50`)) || [];
  let added = 0, done = 0, errors = 0;
  for (const r of rows) {
    const x = await syncDecisionTask(env, r);
    if (x.action === "added") added++; else if (x.action === "done") done++; else if (x.error) errors++;
  }
  return { added, done, errors };
}

/* ─── ② Notion の Sessions ─── */
const SESSIONS_DS = "bd92c72f-44d8-40d7-87db-b052e3b292ab";

/** チャットの住所と「チャットURL」が同じ Sessions の行（新しい順に 3 つまで）。見つからなければ空 */
export async function sessionsFor(env: Env, url: string | null | undefined): Promise<{ title: string; url: string; date: string | null }[]> {
  if (!url || !env.NOTION_TOKEN) return [];
  try {
    const res = await fetch(`https://api.notion.com/v1/data_sources/${SESSIONS_DS}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" },
      body: JSON.stringify({ filter: { property: "チャットURL", url: { equals: url } }, sorts: [{ timestamp: "created_time", direction: "descending" }], page_size: 3 }),
    });
    if (!res.ok) return [];
    const b = (await res.json()) as { results?: any[] };
    return (b.results || []).map((p) => ({
      title: (p.properties?.["セッション名"]?.title || []).map((t: any) => t.plain_text).join("") || "（名前なし）",
      url: String(p.url || ""),
      date: p.properties?.["日付"]?.date?.start ?? null,
    }));
  } catch { return []; }
}

/* ─── ③ haAku の取り組み ─── */
export async function initiatives(env: Env): Promise<{ no: string; name: string; stage: string }[]> {
  if (!env.NAOKI_UID) return [];
  const token = await getFirestoreToken(env);
  const doc = await fsGetOrNull(token, `users/${env.NAOKI_UID}/app_data/os_initiatives_v1`);
  const field = doc?.fields?.value as FVal | undefined;
  const v = field ? (fromVal(field) as any) : null;
  const recs: any[] = Array.isArray(v?.records) ? v.records : [];
  return recs
    .map((r) => { const rev = Array.isArray(r.revisions) ? r.revisions[r.revisions.length - 1] : null; return { no: String(r.initiativeNo || ""), name: String(rev?.name || ""), stage: String(rev?.stage || "") }; })
    .filter((x) => /^\d{2}$/.test(x.no) && x.name)
    .sort((a, b) => a.no.localeCompare(b.no));
}

/** 取り組みの指定（番号・名前・空）を台帳の列にする。undefined は触らない */
export async function initiativePatch(env: Env, v: unknown): Promise<{ ok: true; patch: Record<string, string | null> } | { ok: false; message: string }> {
  if (v === undefined || v === null) return { ok: true, patch: {} };
  const s = String(v).trim();
  if (!s) return { ok: true, patch: { initiative_no: null, initiative_name: null } };
  let list: { no: string; name: string }[];
  try { list = await initiatives(env); } catch (e) { return { ok: false, message: `haAku の取り組みを読めませんでした：${String((e as Error)?.message || e).slice(0, 120)}` }; }
  const hit = list.find((x) => x.no === s.padStart(2, "0")) || list.find((x) => x.name === s) || list.find((x) => x.name.includes(s));
  if (!hit) return { ok: false, message: `「${s}」に当たる取り組みがありません（${list.map((x) => x.no + " " + x.name).join("・").slice(0, 300)}）` };
  return { ok: true, patch: { initiative_no: hit.no, initiative_name: hit.name } };
}

/* ─── ④ NotebookLM へ書き出すドキュメント ─── */
const DOC_SCOPE = "https://www.googleapis.com/auth/documents";
export const NOTEBOOK_DOC_KEY = "notebook_doc_id";
const NOTEBOOK_SIG_KEY = "notebook_doc_sig";
const NOTEBOOK_AT_KEY = "notebook_doc_at";
const NOTEBOOK_ERR_KEY = "notebook_doc_error";

/** ドキュメントの住所か番号から番号を取る */
export function docIdOf(s: unknown): string | null {
  const v = String(s ?? "").trim();
  const m = v.match(/\/document\/d\/([A-Za-z0-9_-]{20,})/) || v.match(/^([A-Za-z0-9_-]{20,})$/);
  return m ? m[1] : null;
}

/** 書き出す中身（台帳の 1 行ずつ＋ピンの全文）。並びは新しい順 */
export function notebookText(chats: Row[], pins: Row[], at: string): string {
  const name = new Map(chats.map((c) => [Number(c.no), String(c.name)]));
  const lines: string[] = [];
  lines.push(`マネージャーくん：チャットの台帳とピン（自動で書き出し・${at}）`);
  lines.push("このドキュメントはマネージャーくんが 30 分ごとに書き直す。手で書いた分は消える。");
  lines.push("");
  lines.push("■ チャットの台帳（最後に触った順）");
  for (const c of chats) {
    lines.push(`チャット ${c.no}｜${c.name}｜${c.state}${c.area ? `｜分野 ${c.area}` : ""}${c.initiative_name ? `｜取り組み ${c.initiative_no} ${c.initiative_name}` : ""}｜最後に触った ${jstShort(c.touched_at)}${c.doing ? `｜${c.doing}` : ""}${c.url ? `｜${c.url}` : ""}`);
  }
  lines.push("");
  lines.push("■ ピン（新しい順・回答の全文）");
  for (const p of pins) {
    lines.push("");
    lines.push(`━━ ピン ${p.chat_no}#${p.n}：${p.title}（チャット「${name.get(Number(p.chat_no)) || p.chat_no}」・${jstShort(p.created_at)}）`);
    lines.push(String(p.body || ""));
  }
  return lines.join("\n") + "\n";
}

async function digest(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 中身が変わっていればドキュメントを丸ごと書き直す。force で変わっていなくても書く */
export async function exportNotebook(env: Env, force = false): Promise<{ ok: boolean; wrote: boolean; message: string; chars?: number }> {
  const docId = await getSetting(env, NOTEBOOK_DOC_KEY);
  if (!docId) return { ok: true, wrote: false, message: "書き出すドキュメントがまだ決まっていません" };
  try {
    const chats: Row[] = (await sb(env, `mk_chats?select=no,name,state,doing,url,touched_at,initiative_no,initiative_name,area&state=neq.${encodeURIComponent("閉じた")}&order=touched_at.desc&limit=500`)) || [];
    const closed: Row[] = (await sb(env, `mk_chats?select=no,name,state,doing,url,touched_at,initiative_no,initiative_name,area&state=eq.${encodeURIComponent("閉じた")}&pin_count=gt.0&order=touched_at.desc&limit=500`)) || [];
    const pins: Row[] = (await sb(env, `mk_pins?select=chat_no,n,title,body,created_at&order=created_at.desc&limit=2000`)) || [];
    const all = [...chats, ...closed];
    const body = notebookText(all, pins, "");
    const sig = await digest(body);
    if (!force && sig === (await getSetting(env, NOTEBOOK_SIG_KEY))) return { ok: true, wrote: false, message: "変わっていないので書いていません", chars: body.length };
    const text = notebookText(all, pins, jstShort(new Date().toISOString()));
    const token = await getGoogleTokenForScope(env, DOC_SCOPE);
    const g = async (url: string, init: RequestInit = {}) => {
      const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...((init.headers as Record<string, string>) || {}) } });
      const t = await r.text();
      if (!r.ok) throw new Error(r.status === 403 || r.status === 404 ? `ドキュメントに書けません（${r.status}）。ドキュメントをシアニンMCPのメールアドレスへ「編集者」で共有してください` : `Google ${r.status}: ${t.slice(0, 160)}`);
      return t ? JSON.parse(t) : null;
    };
    const doc = await g(`https://docs.googleapis.com/v1/documents/${docId}?fields=body(content(endIndex))`);
    const end = Math.max(...((doc?.body?.content || []) as { endIndex?: number }[]).map((c) => Number(c.endIndex || 1)), 1);
    const requests: object[] = [];
    if (end > 2) requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1 } } });
    requests.push({ insertText: { location: { index: 1 }, text } });
    await g(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests }) });
    await setSetting(env, NOTEBOOK_SIG_KEY, sig);
    await setSetting(env, NOTEBOOK_AT_KEY, new Date().toISOString());
    await setSetting(env, NOTEBOOK_ERR_KEY, null);
    return { ok: true, wrote: true, message: `書き出しました（ピン ${pins.length}・チャット ${all.length}）`, chars: text.length };
  } catch (e) {
    const msg = String((e as Error)?.message || e).slice(0, 300);
    await setSetting(env, NOTEBOOK_ERR_KEY, msg).catch(() => {});
    return { ok: false, wrote: false, message: msg };
  }
}

export async function notebookStatus(env: Env): Promise<{ doc_id: string | null; doc_url: string | null; at: string | null; error: string | null; share_to: string | null }> {
  const [doc_id, at, error] = await Promise.all([getSetting(env, NOTEBOOK_DOC_KEY), getSetting(env, NOTEBOOK_AT_KEY), getSetting(env, NOTEBOOK_ERR_KEY)]);
  return { doc_id, doc_url: doc_id ? `https://docs.google.com/document/d/${doc_id}/edit` : null, at: at ? jstShort(at) : null, error, share_to: env.FIREBASE_SA_EMAIL || null };
}
