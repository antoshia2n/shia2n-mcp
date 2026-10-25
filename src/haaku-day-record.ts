/**
 * shia2n-mcp / src/haaku-day-record.ts / 新設（2026-10-13 v1.15.0 開発部）
 *
 * 「その日の記録」を 1 日 1 件で haAku の側に組んで残す。AI と haAku の画面は、これを読むだけで振り返りとレポートを出せる。
 * 依頼：https://www.notion.so/3f89c6c1c43981308c9dc4e780af3f0d
 *
 * 中身（5 つ）
 *   1. 日報：haAku の os_daily_{年} のその日の 4 欄と KPI の数字（名前と単位つき）
 *   2. こなしたこと：その日に完了したタスク（doneAt がその日・完了の印あり）。プロジェクトと結んだマスつき
 *   3. 残ったこと：着手日か期限がその日以前で、その日の終わりに未完了だったタスク
 *        いま未完了のもの ＋ その日より後に完了したもの（doneAt がその日より後）。アーカイブ・その日より後に作ったものは外す
 *   4. 予定：haAku に保存した非公開アドレス（os_calendar_private_v1・最大 5 つ）から、その日に重なる予定（時刻つき）
 *   5. 記録くん：その日の daily_logs の行と rule_checks（決まりの行つき）
 *
 * 置き場：users/{uid}/app_data/os_day_record_v1_{YYYY-MM-DD}（1 日 1 文書・value 欄）
 *   同じ日を組み直したら上書き。中身（builtAt を除く）が変わらなければ書かない
 *   1 つの元が読めなかったときは、前に組んだ記録のその部分を残す（空で上書きしない）。sources に理由を残す
 *
 * 読む量（2026-10-02 に Firestore の無料枠を使い切った件があるため）
 *   タスクは全部読まない。doneAt がその日のもの・未完了のもの・doneAt がその日より後のものの 3 つの条件で引く
 *   毎日 1 回（JST 0 時台）に前の日の分だけ組む。手で組む道具もある
 */
import type { Env } from "./index.js";
import { getFirestoreToken, readLayout, fromVal, type FSDoc, type FVal } from "./taskmaster.js";
import { readValue, writeValue, parseLinksStore, LINKS_KEY, jstToday } from "./haaku-home-store.js";
import { parseHaakuRoadmap } from "./haaku-plan-summary.js";
import { canonical } from "./haaku-ai-changes.js";
import { fetchDayEvents, type DayEvent } from "./ical-day.js";
import { readKiroku } from "./kiroku-read.js";

const FIRESTORE_BASE =
  "https://firestore.googleapis.com/v1/projects/gen-lang-client-0371348401/databases/ai-studio-622b9a97-52df-425a-85c6-1a2670c54e0a/documents";
export const DAY_PREFIX = "os_day_record_v1_";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
type Item = Record<string, unknown>;

export type TaskRow = {
  id: string; title: string; status: string | null; priority: string | null;
  project_id: string | null; project_title: string | null; milestone_id: string | null; milestone_title: string | null;
  start_date: string | null; deadline: string | null; done_at: string | null; completed_at: string | null;
  /** v1.41.0：TaskMaster の時間帯（タスクの groupId と app_data/groups の題名）。時間帯なしは null */
  group_id?: string | null; group_title?: string | null;
};
export type DayRecord = {
  schemaVersion: 1;
  date: string;
  builtAt: string;
  sources: { report: string; tasks: string; calendar: string; kiroku: string };
  report: { goal: string | null; achieved: string | null; reflection: string | null; improvement: string | null };
  kpi: { id: string; title: string | null; unit: string | null; value: number | null }[];
  done: TaskRow[];
  remaining: TaskRow[];
  events: DayEvent[];
  calendars: { name: string; status: string; count: number }[];
  kiroku: { daily_log: Item | null; rule_checks: Item[] };
};

export function validDay(d: string): string {
  if (!DAY.test(d) || new Date(d + "T00:00:00Z").toISOString().slice(0, 10) !== d) throw new Error("日付は YYYY-MM-DD で渡してください：" + d);
  return d;
}
export const yesterdayJst = (now = new Date()) => jstToday(new Date(now.getTime() - 86400000));
const dayOf = (v: unknown) => (typeof v === "string" && DAY.test(v.slice(0, 10)) ? v.slice(0, 10) : "");
const s = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
const isTrue = (v: unknown) => v === true || v === "true";

function docToItem(d: FSDoc): Item {
  const out: Item = {};
  for (const [k, v] of Object.entries(d.fields ?? {})) out[k] = fromVal(v as FVal);
  if (!out.id) out.id = d.name.split("/").pop();
  return out;
}

/** tm_tasks を 1 つの欄の条件で引く（1 つの欄だけなので、組み合わせの索引は要らない） */
async function queryTasks(token: string, uid: string, field: string, op: "EQUAL" | "GREATER_THAN", value: FVal): Promise<Item[]> {
  const res = await fetch(`${FIRESTORE_BASE}/users/${uid}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "tm_tasks" }], where: { fieldFilter: { field: { fieldPath: field }, op, value } } } }),
  });
  if (!res.ok) throw new Error("TaskMaster のタスクを引けませんでした（" + res.status + "）");
  const rows = (await res.json()) as { document?: FSDoc }[];
  return rows.filter(r => r.document).map(r => docToItem(r.document as FSDoc));
}

/** 計算だけ（外に触らない・試験で回す）：こなしたこと・残ったこと */
export function splitTasks(day: string, input: {
  doneThatDay: Item[]; open: Item[]; doneLater: Item[];
  projects: Map<string, string>; links: Map<string, string>; milestones: Map<string, string>;
  groups?: Map<string, string>;
}): { done: TaskRow[]; remaining: TaskRow[] } {
  const row = (t: Item): TaskRow => {
    const pid = s(t.projectId), mid = input.links.get(String(t.id)) ?? null, gid = s(t.groupId);
    return {
      id: String(t.id), title: String(t.title ?? ""), status: s(t.status), priority: s(t.priority),
      project_id: pid, project_title: pid ? input.projects.get(pid) ?? null : null,
      milestone_id: mid, milestone_title: mid ? input.milestones.get(mid) ?? null : null,
      start_date: dayOf(t.startDate) || null, deadline: dayOf(t.deadline) || null,
      done_at: dayOf(t.doneAt) || null, completed_at: s(t.completedAt),
      group_id: gid, group_title: gid ? input.groups?.get(gid) ?? null : null,
    };
  };
  const byTitle = (a: TaskRow, b: TaskRow) => (a.completed_at ?? "").localeCompare(b.completed_at ?? "") || a.title.localeCompare(b.title, "ja") || a.id.localeCompare(b.id);
  const done = input.doneThatDay.filter(t => isTrue(t.completed) && dayOf(t.doneAt) === day).map(row).sort(byTitle);
  const seen = new Set<string>();
  const remaining: TaskRow[] = [];
  for (const t of [...input.open.filter(t => !isTrue(t.completed)), ...input.doneLater.filter(t => isTrue(t.completed) && dayOf(t.doneAt) > day)]) {
    const id = String(t.id);
    if (seen.has(id) || isTrue(t.archived)) continue;
    const created = dayOf(t.createdAt);
    if (created && created > day) continue;
    const st = dayOf(t.startDate), dl = dayOf(t.deadline);
    if (!((st && st <= day) || (dl && dl <= day))) continue;
    seen.add(id);
    remaining.push(row(t));
  }
  remaining.sort((a, b) => (a.deadline ?? a.start_date ?? "").localeCompare(b.deadline ?? b.start_date ?? "") || a.title.localeCompare(b.title, "ja") || a.id.localeCompare(b.id));
  return { done, remaining };
}

/** v1.41.0：TaskMaster の時間帯（app_data/groups の value）を id → 題名に。並びでなければ空 */
export function groupsMapOf(v: unknown): Map<string, string> {
  if (!Array.isArray(v)) return new Map();
  return new Map((v as Item[]).filter(g => g && typeof g === "object" && typeof g.id === "string" && g.id).map(g => [String(g.id), typeof g.title === "string" ? g.title : ""]));
}

/** v1.41.0：前に組んだ記録（時間帯の欄が無い行）に、今のタスクの groupId と時間帯の題名を付ける。計算だけ */
export function fillGroups(days: DayRecord[], taskGroup: Map<string, string | null>, groups: Map<string, string>): number {
  let filled = 0;
  for (const d of days) for (const t of [...(d.done ?? []), ...(d.remaining ?? [])]) {
    if ("group_id" in t) continue;
    if (!taskGroup.has(t.id)) continue;
    const gid = taskGroup.get(t.id) ?? null;
    t.group_id = gid; t.group_title = gid ? groups.get(gid) ?? null : null;
    filled++;
  }
  return filled;
}

/** 保存した非公開アドレスの一覧（v2：calendars[]／前の形：url 1 つを「メイン」として） */
export function calendarsOf(v: unknown): { name: string; url: string }[] {
  if (v === null || v === undefined) return [];
  const o = v as Item;
  if (Array.isArray(o.calendars)) {
    return (o.calendars as Item[]).filter(c => typeof c?.url === "string" && c.url).map((c, i) => ({ name: typeof c.name === "string" && c.name ? c.name : "カレンダー" + (i + 1), url: String(c.url) }));
  }
  if (typeof o.url === "string" && o.url) return [{ name: "メイン", url: o.url }];
  throw new Error("カレンダーの保存の形が読めません（os_calendar_private_v1）");
}

const contentOf = (r: DayRecord) => canonical({ ...r, builtAt: "" });

/** Firestore は配列の中に配列を置けない。記録くんの行などに入っていたら、その配列だけ JSON の文字にして残す */
export function firestoreSafe(v: unknown, inArray = false): unknown {
  if (Array.isArray(v)) return inArray ? JSON.stringify(v) : v.map(x => firestoreSafe(x, true));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Item).map(([k, x]) => [k, firestoreSafe(x, false)]));
  return v;
}

export type BuildResult = {
  ok: true; date: string; dry_run: boolean; written: boolean; unchanged: boolean;
  counts: { done: number; remaining: number; events: number; rule_checks: number; daily_log: boolean; kpi: number };
  sources: DayRecord["sources"]; calendars: DayRecord["calendars"]; detail: string;
  record?: DayRecord;
};

/** その日の記録を組む（dryRun なら書かずに返す） */
export async function buildDayRecord(env: Env, day: string, opts: { dryRun?: boolean; at?: string; token?: string } = {}): Promise<BuildResult> {
  validDay(day);
  if (!env.NAOKI_UID || !env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) throw new Error("haAku の読み書き設定がありません（NAOKI_UID / FIREBASE_SA_EMAIL / FIREBASE_SA_PRIVATE_KEY）");
  const at = opts.at ?? new Date().toISOString();
  const uid = env.NAOKI_UID;
  const token = opts.token ?? (await getFirestoreToken(env));
  const key = DAY_PREFIX + day;
  const prevDoc = await readValue(token, uid, key);
  const prev = (prevDoc.value ?? null) as DayRecord | null;
  const sources: DayRecord["sources"] = { report: "", tasks: "", calendar: "", kiroku: "" };
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

  // 1. 日報
  let report: DayRecord["report"] = { goal: null, achieved: null, reflection: null, improvement: null };
  let kpi: DayRecord["kpi"] = [];
  try {
    const [daily, kpis] = await Promise.all([readValue(token, uid, "os_daily_" + day.slice(0, 4)), readValue(token, uid, "os_kpis")]);
    const rec = ((daily.value ?? {}) as Record<string, Item>)[day] ?? {};
    const r = (rec.report ?? {}) as Item;
    report = { goal: s(r.goal), achieved: s(r.achieved), reflection: s(r.reflection), improvement: s(r.improvement) };
    const defs = new Map(((Array.isArray(kpis.value) ? kpis.value : []) as Item[]).map(k => [String(k.id), k]));
    kpi = Object.entries((rec.kpiValues ?? {}) as Record<string, unknown>).map(([id, v]) => ({
      id, title: s(defs.get(id)?.title), unit: s(defs.get(id)?.unit), value: typeof v === "number" && Number.isFinite(v) ? v : null,
    })).sort((a, b) => a.id.localeCompare(b.id));
    sources.report = rec.report || rec.kpiValues ? "ok" : "ok（その日の日報は空）";
  } catch (e) {
    sources.report = "読めなかった：" + msg(e) + (prev ? "（前の記録を残した）" : "");
    if (prev) { report = prev.report; kpi = prev.kpi; }
  }

  // 2・3. タスク
  let done: TaskRow[] = [], remaining: TaskRow[] = [];
  try {
    if ((await readLayout(token, uid)) !== "v2") throw new Error("TaskMaster の置き場が 1 本ずつの形（v2）ではありません");
    const [doneThatDay, open, doneLater, projects, links, road, groupsDoc] = await Promise.all([
      queryTasks(token, uid, "doneAt", "EQUAL", { stringValue: day }),
      queryTasks(token, uid, "completed", "EQUAL", { booleanValue: false }),
      queryTasks(token, uid, "doneAt", "GREATER_THAN", { stringValue: day }),
      readValue(token, uid, "projects"),
      readValue(token, uid, LINKS_KEY),
      readValue(token, uid, "os_roadmap_v1"),
      readValue(token, uid, "groups").catch(() => null),
    ]);
    const pmap = new Map(((Array.isArray(projects.value) ? projects.value : []) as Item[]).map(p => [String(p.id), String(p.title ?? "")]));
    const lmap = new Map(parseLinksStore(links.value).links.map(l => [l.taskId, l.milestoneId]));
    const mmap = new Map((parseHaakuRoadmap(road.value)?.milestones ?? []).map(m => [m.id, m.title]));
    const gmap = groupsMapOf(groupsDoc?.value);
    ({ done, remaining } = splitTasks(day, { doneThatDay, open, doneLater, projects: pmap, links: lmap, milestones: mmap, groups: gmap }));
    sources.tasks = groupsDoc ? "ok" : "ok（時間帯の題名を読めなかった）";
  } catch (e) {
    sources.tasks = "読めなかった：" + msg(e) + (prev ? "（前の記録を残した）" : "");
    if (prev) { done = prev.done; remaining = prev.remaining; }
  }

  // 4. 予定
  let events: DayEvent[] = [];
  let calendars: DayRecord["calendars"] = [];
  try {
    const list = calendarsOf((await readValue(token, uid, "os_calendar_private_v1")).value);
    if (!list.length) sources.calendar = "つないだカレンダーが無い";
    const seen = new Set<string>();
    let failed = 0;
    for (const c of list) {
      try {
        const r = await fetchDayEvents(c.url, day);
        for (const ev of r.events) {
          const k = ev.uid + "|" + ev.start;
          if (seen.has(k)) { const hit = events.find(x => x.uid + "|" + x.start === k); if (hit && hit.calendar && !hit.calendar.split("・").includes(c.name)) hit.calendar += "・" + c.name; continue; }
          seen.add(k); events.push({ ...ev, calendar: c.name });
        }
        calendars.push({ name: c.name, status: "読めた" + (r.unreadable ? `（読めない形の予定 ${r.unreadable} 件を外した）` : ""), count: r.events.length });
      } catch (e) {
        failed++;
        calendars.push({ name: c.name, status: "読めなかった：" + msg(e), count: 0 });
      }
    }
    events.sort((a, b) => (a.all_day === b.all_day ? a.start.localeCompare(b.start) : a.all_day ? -1 : 1) || a.title.localeCompare(b.title, "ja"));
    if (list.length) sources.calendar = failed === 0 ? "ok" : failed === list.length ? "読めなかった" : `一部読めなかった（${failed}/${list.length}）`;
    if (failed && prev && prev.events.length) {
      // 読めなかったカレンダーの分は、前の記録から残す
      const bad = new Set(calendars.filter(c => c.count === 0 && c.status.startsWith("読めなかった")).map(c => c.name));
      for (const ev of prev.events) if (ev.calendar && ev.calendar.split("・").some(n => bad.has(n)) && !seen.has(ev.uid + "|" + ev.start)) events.push(ev);
      sources.calendar += "（読めなかった分は前の記録を残した）";
    }
  } catch (e) {
    sources.calendar = "読めなかった：" + msg(e) + (prev ? "（前の記録を残した）" : "");
    if (prev) { events = prev.events; calendars = prev.calendars; }
  }

  // 5. 記録くん
  let kiroku: DayRecord["kiroku"] = { daily_log: null, rule_checks: [] };
  try {
    const k = await readKiroku(env, day, day);
    kiroku = { daily_log: k.daily_logs[0] ?? null, rule_checks: k.rule_checks };
    sources.kiroku = "ok（日付の欄 " + k.columns.daily_logs_date + "・" + k.columns.rule_checks_date + (k.daily_logs.length > 1 ? `・その日の行が ${k.daily_logs.length} 行あり 1 行目を使った` : "") + "）";
  } catch (e) {
    sources.kiroku = "読めなかった：" + msg(e) + (prev ? "（前の記録を残した）" : "");
    if (prev) kiroku = prev.kiroku;
  }

  const record = firestoreSafe(JSON.parse(JSON.stringify({ schemaVersion: 1, date: day, builtAt: at, sources, report, kpi, done, remaining, events, calendars, kiroku }))) as DayRecord;
  const unchanged = !!prev && contentOf(prev) === contentOf(record);
  let written = false;
  if (!opts.dryRun && !unchanged) {
    await writeValue(token, uid, key, record, prevDoc.version);
    written = true;
  }
  const counts = { done: done.length, remaining: remaining.length, events: events.length, rule_checks: kiroku.rule_checks.length, daily_log: !!kiroku.daily_log, kpi: kpi.length };
  const detail = `${day}：こなしたこと ${counts.done}・残ったこと ${counts.remaining}・予定 ${counts.events}` +
    `（カレンダー ${calendars.filter(c => c.status.startsWith("読めた")).length}/${calendars.length} 読めた）・記録くん ${counts.daily_log ? "その日の行あり" : "その日の行なし"}・チェック ${counts.rule_checks}` +
    `・${opts.dryRun ? "見るだけ" : written ? "書いた" : "変わらず"}` +
    (Object.values(sources).some(v => v.startsWith("読めなかった")) ? "・読めなかった元あり" : "");
  return { ok: true, date: day, dry_run: !!opts.dryRun, written, unchanged, counts, sources, calendars, detail, ...(opts.dryRun ? { record } : {}) };
}

/** from〜to のその日の記録を返す（最大 62 日・無い日は missing に並べる） */
export async function readDayRecords(env: Env, from: string, to: string): Promise<{ ok: true; from: string; to: string; days: DayRecord[]; missing: string[]; groups_note?: string }> {
  validDay(from); validDay(to);
  if (to < from) throw new Error("to は from 以後の日付にしてください");
  const dates: string[] = [];
  for (let d = new Date(from + "T00:00:00Z"); d.toISOString().slice(0, 10) <= to; d = new Date(d.getTime() + 86400000)) dates.push(d.toISOString().slice(0, 10));
  if (dates.length > 62) throw new Error("一度に読めるのは 62 日までです");
  if (!env.NAOKI_UID || !env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) throw new Error("haAku の読み書き設定がありません");
  const token = await getFirestoreToken(env);
  const db = "projects/gen-lang-client-0371348401/databases/ai-studio-622b9a97-52df-425a-85c6-1a2670c54e0a";
  const res = await fetch(FIRESTORE_BASE + ":batchGet", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ documents: dates.map(d => db + "/documents/users/" + env.NAOKI_UID + "/app_data/" + DAY_PREFIX + d) }),
  });
  if (!res.ok) throw new Error("その日の記録を読めませんでした（" + res.status + "）");
  const rows = (await res.json()) as { found?: FSDoc; missing?: string }[];
  const got = new Map<string, DayRecord>();
  for (const r of rows) if (r.found?.fields?.value) {
    const v = fromVal(r.found.fields.value as FVal) as DayRecord;
    if (v && typeof v === "object" && typeof v.date === "string") got.set(v.date, v);
  }
  const days = dates.filter(d => got.has(d)).map(d => got.get(d)!);
  // v1.41.0：時間帯の欄が無い前の記録には、今のタスクの groupId を引いて付ける（記録は書き換えない）。読めなくても記録は返す
  let groups_note: string | undefined;
  const need = [...new Set(days.flatMap(d => [...(d.done ?? []), ...(d.remaining ?? [])]).filter(t => !("group_id" in t)).map(t => t.id))];
  if (need.length) {
    try {
      const groups = groupsMapOf((await readValue(token, env.NAOKI_UID, "groups")).value);
      const taskGroup = new Map<string, string | null>();
      for (let i = 0; i < need.length; i += 200) {
        const part = need.slice(i, i + 200);
        const r = await fetch(FIRESTORE_BASE + ":batchGet", {
          method: "POST",
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify({ documents: part.map(id => db + "/documents/users/" + env.NAOKI_UID + "/tm_tasks/" + encodeURIComponent(id)) }),
        });
        if (!r.ok) throw new Error("タスクを読めませんでした（" + r.status + "）");
        for (const x of (await r.json()) as { found?: FSDoc }[]) if (x.found) {
          const t = docToItem(x.found);
          taskGroup.set(String(t.id), s(t.groupId));
        }
      }
      const filled = fillGroups(days, taskGroup, groups);
      groups_note = `時間帯の欄が無い前の記録 ${need.length} 件のうち ${filled} 件に、今のタスクから時間帯を付けた` + (filled < need.length ? `（${need.length - filled} 件はタスクが見つからない）` : "");
    } catch (e) {
      groups_note = "前の記録に時間帯を付けられなかった：" + (e instanceof Error ? e.message : String(e)).slice(0, 200);
    }
  }
  return { ok: true, from, to, days, missing: dates.filter(d => !got.has(d)), ...(groups_note ? { groups_note } : {}) };
}
