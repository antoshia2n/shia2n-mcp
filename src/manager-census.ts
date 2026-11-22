/**
 * マネージャーくん v1.145.0（2026-11-22 開発部・Naoki「全てのタブを開いて認識させた上で、統括に整理させる」→ 作る前の1枚に OK 16:15）
 *   ・棚卸し：パネルの「棚卸しを統括へ送る」で、全ウィンドウのタブ（住所・題・どのまとまりか）を 1 回分だけ残す（前の回は消す）
 *   ・統括は manager__tabs で読み、作業ごとの振り分け案（と閉じるタブ）を出す。案を出すだけで、タブは動かさない
 *   ・Naoki がパネルで「この案で並べる」を押すと、拡張がタブを作業の名前のまとまりへ移し、閉じるタブを閉じる
 *   ・閉じたタブは棚卸しの写しに残る（画面の「閉じたタブ」から開き直せる）
 */
import type { Env } from "./index.js";
import { ManagerError, findOrCreateWork, openWorkNamed, workById } from "./manager-store.js";
import { jstShort, workKey, workName } from "./manager-core.js";
import { setFolder, tmOpen } from "./manager-folders.js";

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

export type CensusTab = { n: number; win: string; group: string | null; tab_id: number; url: string; title: string };
export type PlanItem = { tabs: number[]; work_id: number | null; work: string; folder: string | null; folder_id: string | null };
export type Plan = { note: string; items: PlanItem[]; close: number[] };

/** パネルが送った全ウィンドウのタブ → 番号つきの 1 列（http(s) だけ・同じタブは 1 つ・300 本まで） */
export function censusTabs(windows: unknown): CensusTab[] {
  const out: CensusTab[] = [];
  const seen = new Set<number>();
  const add = (w: string, group: string | null, t: any) => {
    const url = String(t?.url ?? "").trim(), id = Number(t?.id);
    if (!/^https?:\/\/[^\s]+$/i.test(url) || url.length > 2000 || !Number.isFinite(id) || seen.has(id) || out.length >= 300) return;
    seen.add(id);
    out.push({ n: out.length + 1, win: w, group, tab_id: id, url, title: String(t?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 160) });
  };
  for (const x of Array.isArray(windows) ? windows : []) {
    const w = String((x as any)?.name || "").slice(0, 20);
    for (const g of Array.isArray((x as any)?.groups) ? (x as any).groups : []) for (const t of Array.isArray(g?.tabs) ? g.tabs : []) add(w, g?.title ? String(g.title).slice(0, 80) : "（名前のないまとまり）", t);
    for (const t of Array.isArray((x as any)?.loose) ? (x as any).loose : []) add(w, null, t);
  }
  return out;
}

export async function latestCensus(env: Env): Promise<Row | null> {
  return ((await sb(env, "mk_census?select=*&order=id.desc&limit=1")) || [])[0] ?? null;
}

/** 棚卸しを残す（前の回は消す） */
export async function saveCensus(env: Env, windows: unknown): Promise<Row> {
  const tabs = censusTabs(windows);
  if (!tabs.length) throw new ManagerError("no_tabs", "送れるタブがありません（ページのタブだけを送ります）");
  const rows = await sb(env, "mk_census?select=*", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ tabs }) });
  const row = rows?.[0];
  if (!row) throw new ManagerError("not_written", "棚卸しの行が返ってきませんでした");
  await sb(env, `mk_census?id=lt.${row.id}`, { method: "DELETE" });
  return row;
}

/** 統括の案を受ける。タブの番号・作業・フォルダを確かめてから残す（タブは動かさない） */
export async function setPlan(env: Env, input: { note?: string; items?: Array<{ tabs?: number[]; work_id?: number; new_work?: string; folder?: string }>; close?: number[] }): Promise<{ row: Row; plan: Plan }> {
  const c = await latestCensus(env);
  if (!c) throw new ManagerError("no_census", "棚卸しがまだありません。Naoki にパネルのタブの画面で「棚卸しを統括へ送る」を押してもらってください");
  if (c.applied_at || c.discarded_at) throw new ManagerError("census_used", "この棚卸しはもう並べ終えたか捨てられています。Naoki にもう一度「棚卸しを統括へ送る」を押してもらってください");
  const have = new Set((c.tabs as CensusTab[]).map((t) => t.n));
  const used = new Set<number>();
  const take = (ns: unknown, where: string): number[] => {
    const out: number[] = [];
    for (const v of Array.isArray(ns) ? ns : []) {
      const n = Number(v);
      if (!have.has(n)) throw new ManagerError("bad_tab", `${where}：タブ ${v} は棚卸しにありません`);
      if (used.has(n)) throw new ManagerError("dup_tab", `タブ ${n} が 2 か所に入っています`);
      used.add(n); out.push(n);
    }
    return out;
  };
  let projects: Row[] | null = null;
  const items: PlanItem[] = [];
  for (const [i, it] of (input.items || []).entries()) {
    const where = `${i + 1} 番目の振り分け`;
    const tabs = take(it.tabs, where);
    if (!tabs.length) continue;
    let work_id: number | null = null, work = "";
    if (it.work_id) {
      const w = await workById(env, Number(it.work_id));
      if (!w) throw new ManagerError("work_not_found", `${where}：作業 ${it.work_id} はありません`);
      if (w.state !== "進行中") throw new ManagerError("work_done", `${where}：作業 ${it.work_id}「${w.name}」は完了しています`);
      work_id = Number(w.id); work = String(w.name);
    } else {
      const nm = workName(it.new_work ?? "");
      if (!nm) throw new ManagerError("no_work", `${where}：work_id か new_work のどちらかを渡してください`);
      const same = await openWorkNamed(env, nm); // 同じ名前の作業が開いていればそこへ（重なりを作らない）
      if (same) { work_id = Number(same.id); work = String(same.name); } else work = nm;
    }
    let folder: string | null = null, folder_id: string | null = null;
    if (it.folder && it.folder.trim()) {
      projects ??= (await tmOpen(env)).projects;
      const k = workKey(it.folder);
      const hits = projects.filter((p) => String(p.title ?? "").trim() === it.folder!.trim());
      const h = hits.length ? hits : projects.filter((p) => workKey(p.title) === k);
      if (h.length !== 1) throw new ManagerError("folder_not_found", `${where}：「${it.folder}」という TaskMaster のプロジェクトが${h.length ? ` ${h.length} つあります` : "ありません"}。候補：${projects.map((p) => p.title).slice(0, 30).join("・")}`);
      folder = String(h[0].title); folder_id = String(h[0].id);
    }
    const prev = items.find((x) => workKey(x.work) === workKey(work));
    if (prev) { prev.tabs.push(...tabs); prev.folder ??= folder; prev.folder_id ??= folder_id; }
    else items.push({ tabs, work_id, work, folder, folder_id });
  }
  const close = take(input.close, "閉じるタブ");
  if (!items.length && !close.length) throw new ManagerError("empty_plan", "振り分けも閉じるタブもありません");
  const plan: Plan = { note: String(input.note ?? "").trim().slice(0, 1000), items, close };
  const rows = await sb(env, `mk_census?id=eq.${c.id}&select=*`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ plan, plan_at: new Date().toISOString() }) });
  return { row: rows?.[0] ?? c, plan };
}

/** Naoki が「この案で並べる」を押したあと：新しい作業を作り、フォルダを決め、並べ終えた印を付ける */
export async function markApplied(env: Env): Promise<{ made: string[]; folders: string[] }> {
  const c = await latestCensus(env);
  if (!c?.plan) throw new ManagerError("no_plan", "整理案がありません");
  const made: string[] = [], folders: string[] = [];
  for (const it of (c.plan as Plan).items) {
    let w = it.work_id ? await workById(env, it.work_id) : await openWorkNamed(env, it.work);
    if (!w) { w = (await findOrCreateWork(env, it.work, null)).work; made.push(it.work); }
    if (it.folder_id && String(w.tm_project_id ?? "") !== it.folder_id) { await setFolder(env, Number(w.id), it.folder_id).catch(() => null); folders.push(`${it.work} → ${it.folder}`); }
  }
  await sb(env, `mk_census?id=eq.${c.id}`, { method: "PATCH", body: JSON.stringify({ applied_at: new Date().toISOString() }) });
  return { made, folders };
}

export async function discardPlan(env: Env): Promise<void> {
  const c = await latestCensus(env);
  if (!c) return;
  await sb(env, `mk_census?id=eq.${c.id}`, { method: "PATCH", body: JSON.stringify({ plan: null, plan_at: null }) });
}

/** 画面と道具へ返す形 */
export function censusOut(c: Row | null) {
  if (!c) return null;
  const tabs = (c.tabs as CensusTab[]) || [];
  const plan = c.plan as Plan | null;
  const byN = new Map(tabs.map((t) => [t.n, t]));
  return {
    送った: jstShort(c.at), タブの数: tabs.length,
    タブ: tabs.map((t) => ({ 番号: t.n, 画面: t.win || null, まとまり: t.group, 題: t.title, 住所: t.url, tab_id: t.tab_id })),
    整理案: plan ? {
      出した: jstShort(c.plan_at), 一言: plan.note,
      振り分け: plan.items.map((x) => ({ 作業: x.work, 作業番号: x.work_id, 新しい作業: !x.work_id, フォルダ: x.folder, タブ: x.tabs.map((n) => ({ 番号: n, 題: byN.get(n)?.title ?? "", 住所: byN.get(n)?.url ?? "", tab_id: byN.get(n)?.tab_id ?? null })) })),
      閉じる: plan.close.map((n) => ({ 番号: n, 題: byN.get(n)?.title ?? "", 住所: byN.get(n)?.url ?? "", tab_id: byN.get(n)?.tab_id ?? null })),
    } : null,
    並べ終えた: c.applied_at ? jstShort(c.applied_at) : null,
  };
}
