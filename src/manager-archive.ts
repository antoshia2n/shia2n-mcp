/**
 * マネージャーくん v1.147.0（2026-11-23 開発部・Naoki「今後使わないタブや作業グループを削除やアーカイブ」→ デモ「タブと作業」に OK 10:34）
 *   ・アーカイブ：完了（済み）と中止の作業。タブとピンごと残し、本体の画面から探せる。パネルには出さない
 *   ・削除：アーカイブからだけ。評価や依頼の記録がある作業は消さない（自動化の材料を残すため）
 *   ・検索：保存したタブの題と住所も探す（開いている・保存済みの作業だけ）
 */
import type { Env } from "./index.js";
import { ManagerError, markGone } from "./manager-store.js";
import { jstShort } from "./manager-core.js";
import { tmUpdateTask } from "./manager-folders.js";

type Row = Record<string, any>;
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
const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
const hitAll = (txt: string, ws: string[]) => { const t = txt.toLowerCase(); return ws.every((w) => t.includes(w)); };

/** 完了・中止の作業の一覧。q は作業の名前・フォルダ・タブの題と住所・ピンの題と中身から探す */
export async function archiveList(env: Env, q: string, state: string): Promise<Row[]> {
  const st = state === "済み" || state === "完了" ? ["済み"] : state === "中止" ? ["中止"] : ["済み", "中止"];
  const works: Row[] = (await sb(env, `mk_works?select=id,name,state,kind,tabs,tm_project_name,tm_task_id,closed_at,touched_at&state=in.(${st.map(enc).join(",")})&order=closed_at.desc.nullslast,touched_at.desc&limit=500`)) || [];
  if (!works.length) return [];
  const ids = works.map((w) => w.id).join(",");
  const chats: Row[] = (await sb(env, `mk_chats?select=no,name,work_id&work_id=in.(${ids})&limit=5000`)) || [];
  const nos = chats.map((c) => c.no);
  const pins: Row[] = nos.length ? (await sb(env, `mk_pins?select=chat_no,n,title,body&chat_no=in.(${nos.join(",")})&order=n.desc&limit=5000`)) || [] : [];
  const [scores, reqs]: [Row[], Row[]] = await Promise.all([
    sb(env, `mk_scores?select=work_id&work_id=in.(${ids})&limit=5000`).then((x) => x || []),
    sb(env, `mk_requests?select=work_id&work_id=in.(${ids})&limit=5000`).then((x) => x || []),
  ]);
  const kept = new Set([...scores, ...reqs].map((r) => Number(r.work_id)));
  const ws = words(q);
  const out: Row[] = [];
  for (const w of works) {
    const cs = chats.filter((c) => c.work_id === w.id);
    const ps = pins.filter((p) => cs.some((c) => c.no === p.chat_no));
    const tabs: Row[] = Array.isArray(w.tabs) ? w.tabs : [];
    if (ws.length) {
      const txt = [w.name, w.tm_project_name, w.kind, ...tabs.map((t) => `${t.title} ${t.url}`), ...ps.map((p) => `${p.title} ${p.body}`), ...cs.map((c) => c.name)].join("\n");
      if (!hitAll(txt, ws)) continue;
    }
    out.push({
      番号: Number(w.id), 名前: String(w.name), 状態: w.state === "中止" ? "中止" : "完了", 型: w.kind ?? null, フォルダ: w.tm_project_name ?? null,
      日付: jstShort(w.closed_at || w.touched_at),
      タブ: tabs.map((t) => ({ 題: t.title || t.url, 住所: t.url })),
      ピン: ps.slice(0, 20).map((p) => ({ 題: p.title, リンク: `https://manager.shia2n.jp/#p${p.chat_no}-${p.n}` })),
      チャットの数: cs.length, 消せる: !kept.has(Number(w.id)),
    });
  }
  return out;
}

/** 消せるか（評価や依頼の記録が無いか）。パネルの「削除」が先に聞く（v1.148.2） */
export async function canDelete(env: Env, id: number): Promise<{ 消せる: boolean; 名前: string }> {
  const w: Row | undefined = ((await sb(env, `mk_works?select=id,name&id=eq.${id}`)) || [])[0];
  if (!w) throw new ManagerError("work_not_found", "作業がありません");
  const [s, r] = await Promise.all([sb(env, `mk_scores?select=id&work_id=eq.${id}&limit=1`), sb(env, `mk_requests?select=id&work_id=eq.${id}&limit=1`)]);
  return { 消せる: !(s || []).length && !(r || []).length, 名前: String(w.name) };
}

/** アーカイブから消す（作業と保存したタブ。チャットは台帳に残り、どの作業にも入っていない状態になる） */
export async function deleteWork(env: Env, id: number): Promise<{ 消した: string }> {
  const w: Row | undefined = ((await sb(env, `mk_works?select=id,name,state,tm_task_id&id=eq.${id}`)) || [])[0];
  if (!w) throw new ManagerError("work_not_found", "作業がありません");
  if (w.state === "進行中") throw new ManagerError("work_open", "削除できるのはアーカイブ（完了・中止）の作業だけです");
  const [s, r] = await Promise.all([sb(env, `mk_scores?select=id&work_id=eq.${id}&limit=1`), sb(env, `mk_requests?select=id&work_id=eq.${id}&limit=1`)]);
  if ((s || []).length || (r || []).length) throw new ManagerError("work_kept", `「${w.name}」は評価や依頼の記録があるため削除できません（アーカイブに残します）`);
  if (w.tm_task_id) await tmUpdateTask(env, { task_id: w.tm_task_id, archived: true }).catch(() => null);
  await sb(env, `mk_works?id=eq.${id}`, { method: "DELETE" });
  await markGone(env, String(w.name)); // v1.148.3：同じ名前のまとまりから作り直さない
  return { 消した: String(w.name) };
}

/** 検索：保存したタブ（開いている・保存済みの作業）の題と住所 */
export async function tabHits(env: Env, q: string, limit = 20): Promise<Row[]> {
  const ws = words(q); if (!ws.length) return [];
  const works: Row[] = (await sb(env, `mk_works?select=id,name,tabs&state=eq.${enc("進行中")}&tabs=not.is.null&limit=500`)) || [];
  const out: Row[] = [];
  for (const w of works) for (const t of (Array.isArray(w.tabs) ? w.tabs : [])) {
    if (out.length >= limit) return out;
    if (hitAll(`${t.title} ${t.url}`, ws)) out.push({ 作業番号: Number(w.id), 作業: String(w.name), 題: t.title || t.url, 住所: t.url });
  }
  return out;
}
