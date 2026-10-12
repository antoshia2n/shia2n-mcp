/**
 * shia2n-mcp / src/haaku-home-store.ts / 新設（2026-10-12 v1.10.0 開発部）
 *
 * haAku のホームの読み書き（Firestore に触る側）。計算は haaku-home.ts。
 * 依頼：https://www.notion.so/3f69c6c1c43981b8bb09fa162e38da9b
 *
 * 置き場（どれも users/{uid}/app_data/ の 1 文書・value 欄）
 *   os_task_links_v1      … タスク → ステップの結び。{ schemaVersion: 1, links: [{ taskId, milestoneId, at }], history: [{ at, taskId, from, to }] }
 *                           結びは haAku の側に持つ（TaskMaster の画面は知らない欄を落とすおそれがあるため・取り組みの結びと同じ理由）
 *                           承認は挟まない（タスクは毎日増えるので、承認を挟むと Naoki の手が増えるため）。外した結びも history に残す
 *   os_progress_weekly_v1 … 毎週日曜の夜に、取り組みとステップの行動と成果の率を残す。{ schemaVersion: 1, weeks: [{ weekStart, savedAt, initiatives, steps }] }
 *
 * 書くときは読んだ版（updateTime）を条件に付ける。間に別の書き込みが入っていたら書かずに止める（上書きで消さないため）。
 */
import { fromVal, toFVal, fsGetOrNull, type FSDoc, type FVal } from "./taskmaster.js";
import { readAllTasks } from "./taskmaster-census.js";
import { parseHaakuRoadmap } from "./haaku-plan-summary.js";
import { initiativeStore, INITIATIVES_KEY } from "./haaku-initiatives.js";
import { computeHome, type Link, type Step, type Task, type Initiative, type KpiMonth } from "./haaku-home.js";

const FIRESTORE_BASE =
  "https://firestore.googleapis.com/v1/projects/gen-lang-client-0371348401" +
  "/databases/ai-studio-622b9a97-52df-425a-85c6-1a2670c54e0a/documents";
export const LINKS_KEY = "os_task_links_v1";
export const WEEKLY_KEY = "os_progress_weekly_v1";
const MAX_HISTORY = 3000;
const MAX_WEEKS = 260;
const REF = /^[A-Za-z0-9_-]{1,180}$/;

type Obj = Record<string, unknown>;
type LinkRow = { taskId: string; milestoneId: string; at: string };
type HistoryRow = { at: string; taskId: string; from: string | null; to: string | null };
export type LinksStore = { schemaVersion: 1; links: LinkRow[]; history: HistoryRow[]; updatedAt?: string };

export function jstToday(now = new Date()): string {
  return new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
}

export async function readValue(token: string, uid: string, key: string): Promise<{ value: unknown | null; version: string | null }> {
  const doc = (await fsGetOrNull(token, `users/${uid}/app_data/${key}`)) as (FSDoc & { updateTime?: string }) | null;
  if (!doc) return { value: null, version: null };
  if (!doc.fields || !("value" in doc.fields)) throw new Error(key + " に value 欄がありません。空とみなさず止めました");
  return { value: fromVal(doc.fields.value as FVal), version: doc.updateTime ?? null };
}

/** 読んだ版を条件にして value 欄だけを書く。版が変わっていれば Firestore が断る */
export async function writeValue(token: string, uid: string, key: string, value: unknown, version: string | null): Promise<void> {
  const cond = version ? `currentDocument.updateTime=${encodeURIComponent(version)}` : "currentDocument.exists=false";
  const res = await fetch(`${FIRESTORE_BASE}/users/${uid}/app_data/${key}?updateMask.fieldPaths=value&${cond}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { value: toFVal(value) } }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 409 || res.status === 412 || /FAILED_PRECONDITION|ALREADY_EXISTS/.test(text)) {
      throw new Error(key + " は読んだあとに別の書き込みが入りました。書いていません。もう一度呼んでください");
    }
    throw new Error(key + " の書き込みに失敗しました（" + res.status + "）。" + text.slice(0, 200));
  }
}

export function parseLinksStore(value: unknown): LinksStore {
  if (value === null || value === undefined) return { schemaVersion: 1, links: [], history: [] };
  const v = value as Obj;
  if (!v || typeof v !== "object" || v.schemaVersion !== 1 || !Array.isArray(v.links) || !Array.isArray(v.history)) {
    throw new Error("タスクの結び（os_task_links_v1）の形が読めません。止めました");
  }
  const links = (v.links as Obj[]).map(l => ({ taskId: String(l.taskId ?? ""), milestoneId: String(l.milestoneId ?? ""), at: String(l.at ?? "") }));
  if (links.some(l => !l.taskId || !l.milestoneId) || new Set(links.map(l => l.taskId)).size !== links.length) {
    throw new Error("タスクの結びに空の ID か、同じタスクの重複があります。止めました");
  }
  return { schemaVersion: 1, links, history: v.history as HistoryRow[], updatedAt: v.updatedAt as string | undefined };
}

/** 結ぶ・付け替える・外す（milestoneId が null）。1 タスクは 0〜1 ステップ。外したものも history に残す */
export function applyLinkChanges(
  store: LinksStore, changes: { taskId: string; milestoneId: string | null }[], at: string,
  knownTasks: Set<string>, knownSteps: Set<string>,
): { store: LinksStore; results: { task_id: string; from: string | null; to: string | null; changed: boolean }[] } {
  if (!changes.length || changes.length > 100) throw new Error("結びの変更は 1 回に 1〜100 件です");
  if (new Set(changes.map(c => c.taskId)).size !== changes.length) throw new Error("同じタスクが 2 回入っています");
  const links = [...store.links];
  const history = [...store.history];
  const results = [];
  for (const c of changes) {
    if (!REF.test(c.taskId)) throw new Error("task_id の形が不正です：" + c.taskId);
    if (!knownTasks.has(c.taskId)) throw new Error("TaskMaster にそのタスクがありません：" + c.taskId);
    if (c.milestoneId !== null && !knownSteps.has(c.milestoneId)) throw new Error("haAku にそのステップ（マイルストーン）がありません：" + c.milestoneId);
    const i = links.findIndex(l => l.taskId === c.taskId);
    const from = i >= 0 ? links[i].milestoneId : null;
    if (from === c.milestoneId) { results.push({ task_id: c.taskId, from, to: c.milestoneId, changed: false }); continue; }
    if (i >= 0) links.splice(i, 1);
    if (c.milestoneId !== null) links.push({ taskId: c.taskId, milestoneId: c.milestoneId, at });
    history.push({ at, taskId: c.taskId, from, to: c.milestoneId });
    results.push({ task_id: c.taskId, from, to: c.milestoneId, changed: true });
  }
  if (history.length > MAX_HISTORY) throw new Error("結びの記録が上限（" + MAX_HISTORY + " 件）です。消さずに開発部へ");
  return { store: { schemaVersion: 1, links, history, updatedAt: at }, results };
}

type Ctx = { token: string; uid: string };

async function loadSteps({ token, uid }: Ctx): Promise<Step[]> {
  const road = parseHaakuRoadmap((await readValue(token, uid, "os_roadmap_v1")).value);
  return (road?.milestones ?? []).map(m => ({ id: m.id, title: m.title, status: m.status, dueDate: m.dueDate,
    dependsOn: m.dependsOn, dependsOnIds: m.dependsOnIds, dependsMismatch: m.dependsMismatch }));
}

async function loadTasks({ token, uid }: Ctx): Promise<Task[]> {
  const { items, truncated } = await readAllTasks(token, uid);
  if (truncated) throw new Error("TaskMaster のタスクが多すぎて読み切れませんでした（6000 件超）。止めました");
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return items.map(t => ({
    id: s(t.id), title: s(t.title), completed: t.completed === true, archived: t.archived === true,
    deadline: s(t.deadline), priority: s(t.priority),
  }));
}

async function loadKpis({ token, uid }: Ctx, today: string): Promise<KpiMonth[]> {
  const [kpiDoc, dailyDoc] = await Promise.all([
    readValue(token, uid, "os_kpis"),
    readValue(token, uid, "os_daily_" + today.slice(0, 4)),
  ]);
  const kpis = Array.isArray(kpiDoc.value) ? (kpiDoc.value as Obj[]) : [];
  const daily = dailyDoc.value && typeof dailyDoc.value === "object" ? (dailyDoc.value as Record<string, { kpiValues?: Record<string, number> }>) : {};
  const month = today.slice(0, 7);
  // haAku__get_kpi_progress と同じ数え方（合計、または最新の 0 でない値）
  return kpis.map(k => {
    const id = String(k.id ?? "");
    let actual = 0, latest = "";
    for (const [date, rec] of Object.entries(daily)) {
      const v = rec?.kpiValues?.[id];
      if (!date.startsWith(month) || typeof v !== "number" || !Number.isFinite(v)) continue;
      if (k.aggregation === "latest") { if (v !== 0 && date > latest) { latest = date; actual = v; } }
      else actual += v;
    }
    const target = Number(k.monthlyTarget) || 0;
    return { id, title: String(k.title ?? ""), unit: String(k.unit ?? ""), monthlyTarget: target, monthlyActual: actual,
      pct: target > 0 ? Math.round((actual / target) * 100) : null };
  });
}

async function loadInitiatives({ token, uid }: Ctx): Promise<Initiative[]> {
  const doc = initiativeStore((await readValue(token, uid, INITIATIVES_KEY)).value);
  return (doc.records as Obj[]).map(r => {
    const last = (r.revisions as Obj[]).at(-1) as Obj;
    return { no: String(r.initiativeNo), name: String(last.name ?? ""),
      linkedMilestoneIds: (last.linkedMilestoneIds as string[] | undefined) ?? [],
      linkedKpiIds: (last.linkedKpiIds as string[] | undefined) ?? [] };
  });
}

export async function buildHome(ctx: Ctx, today = jstToday()) {
  const [steps, tasks, linksDoc, initiatives, kpis] = await Promise.all([
    loadSteps(ctx), loadTasks(ctx), readValue(ctx.token, ctx.uid, LINKS_KEY), loadInitiatives(ctx), loadKpis(ctx, today),
  ]);
  const store = parseLinksStore(linksDoc.value);
  const home = computeHome({ steps, tasks, links: store.links as Link[], initiatives, kpis, today });
  return {
    ok: true, readonly: true, ...home,
    links: { state: linksDoc.value === null ? "not_configured" : "ready", count: store.links.length,
      stale: store.links.filter(l => !tasks.some(t => t.id === l.taskId) || !steps.some(s => s.id === l.milestoneId)).length },
    note: "行動の率＝結んだタスクの完了÷全部（アーカイブして未完了は数えない）。成果の率＝取り組みに結んだ KPI の今月の率（1 本ずつ 100 で頭打ちにして平均）。KPI の数え方は haAku__get_kpi_progress と同じ。",
  };
}

export async function linkTasks(ctx: Ctx, changes: { taskId: string; milestoneId: string | null }[], at = new Date().toISOString()) {
  const [steps, tasks, linksDoc] = await Promise.all([loadSteps(ctx), loadTasks(ctx), readValue(ctx.token, ctx.uid, LINKS_KEY)]);
  const store = parseLinksStore(linksDoc.value);
  const { store: next, results } = applyLinkChanges(store, changes, at, new Set(tasks.map(t => t.id)), new Set(steps.map(s => s.id)));
  if (results.some(r => r.changed)) await writeValue(ctx.token, ctx.uid, LINKS_KEY, next, linksDoc.version);
  const after = parseLinksStore((await readValue(ctx.token, ctx.uid, LINKS_KEY)).value);
  for (const r of results) {
    const now = after.links.find(l => l.taskId === r.task_id)?.milestoneId ?? null;
    if (now !== r.to) throw new Error("書いたあとの読み直しで結びが合いません：" + r.task_id);
  }
  return { ok: true, results, links_total: after.links.length, history_total: after.history.length };
}

/** 毎週日曜の夜（JST 23:30）に、その週の率を残す。同じ週は上書き */
export async function snapshotWeekly(ctx: Ctx, today = jstToday()): Promise<{ count: number; detail: string }> {
  const home = await buildHome(ctx, today);
  const t = new Date(today + "T00:00:00Z");
  const weekStart = new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
  const doc = await readValue(ctx.token, ctx.uid, WEEKLY_KEY);
  const cur = doc.value === null ? { schemaVersion: 1, weeks: [] as Obj[] } : (doc.value as { schemaVersion: number; weeks: Obj[] });
  if (cur.schemaVersion !== 1 || !Array.isArray(cur.weeks)) throw new Error("os_progress_weekly_v1 の形が読めません。止めました");
  const row = {
    weekStart, savedAt: new Date().toISOString(),
    initiatives: home.initiatives.map(i => ({ no: i.no, name: i.name, action_pct: i.action_pct, outcome_pct: i.outcome_pct, tasks_total: i.tasks_total, tasks_done: i.tasks_done })),
    steps: home.steps.map(s => ({ id: s.id, title: s.title, state: s.state, action_pct: s.action_pct, tasks_total: s.tasks_total, tasks_done: s.tasks_done })),
  };
  const weeks = [...cur.weeks.filter(w => w.weekStart !== weekStart), row].sort((a, b) => String(a.weekStart).localeCompare(String(b.weekStart))).slice(-MAX_WEEKS);
  await writeValue(ctx.token, ctx.uid, WEEKLY_KEY, { schemaVersion: 1, weeks, updatedAt: row.savedAt }, doc.version);
  const back = (await readValue(ctx.token, ctx.uid, WEEKLY_KEY)).value as { weeks: Obj[] };
  if (!back.weeks.some(w => w.weekStart === weekStart)) throw new Error("週の記録を書いたあとに読み直せませんでした");
  return { count: row.initiatives.length, detail: `${weekStart} の週：取り組み ${row.initiatives.length} 件・ステップ ${row.steps.length} 件の率を残しました` };
}
