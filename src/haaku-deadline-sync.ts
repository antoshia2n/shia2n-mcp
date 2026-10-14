/**
 * shia2n-mcp / src/haaku-deadline-sync.ts / 新設（2026-10-13 v1.13.0 開発部）
 *
 * haAku のマス（マイルストーン）の期限を、結んだ TaskMaster のタスクの期限（deadline）へ写す。
 * 依頼：https://www.notion.so/3f79c6c1c43981448625fbcf4ebde941
 *
 * 写す決まり（依頼の 4 つだけ）
 *   1. 写す相手：結んだ未完了・未アーカイブのタスクのうち、期限が空のものと、期限が「前回 haAku が写した日」のままのもの
 *   2. 写さない相手：期限が入っていて、前回 haAku が写した日と違うもの（Naoki の日。上書きしない・写した記録も消す）
 *   3. マスの期限が空になったとき：期限が前回 haAku が写した日のままのタスクだけ空に戻す（写す前の空の形に戻す）
 *   4. 結びを外したとき：期限は触らない。写した記録だけ消す
 *   付け替え（別のマスへ結び直す）は「結んだまま」として扱い、新しいマスの期限を写す（記録は残る）
 *
 * v1.14.0（2026-10-13 開発部）：着手日も同じ 4 つの決まりで写す
 *   マスの startDate（YYYY-MM-DD・空可）→ 結んだタスクの startDate（同じ名前と形。欄の名前は統括が 1 枚で決めた）
 *   依頼：https://www.notion.so/3f79c6c1c43981448625fbcf4ebde941 の末尾／画面側：https://www.notion.so/3f79c6c1c43981b6bdffde986b9e0c04
 *   期限と着手日は記録を別に持つ（copies が期限・starts が着手日）。片方が Naoki の日でも、もう片方は写す
 *   1 つのタスクに両方書くときは 1 回の書き込みにまとめる（updateMask に 2 欄）
 *   マスの startDate が日付として読めないときは、そのマスの着手日には触らない（空と取り違えて消さないため）
 *
 * 置き場
 *   写した記録：users/{uid}/app_data/os_task_deadline_sync_v1（haAku の側・1 文書）
 *     { schemaVersion: 1, copies: { [taskId]: Copy }, starts?: { [taskId]: Copy }, updatedAt }   Copy = { milestoneId, date, before, beforeMissing?, at }
 *     before … はじめて写す前の値（null か空文字）。空に戻すときにこの形へ戻す
 *   TaskMaster の文書（users/{uid}/tm_tasks/{id}）に書くのは deadline と startDate の 2 欄だけ
 *
 * 読み書きの量（2026-10-02 に Firestore の無料枠を使い切った件があるため）
 *   タスクは全部読まず、結んだタスクだけを id で読む（documents:batchGet）。30 分ごとに動くため
 *   値が変わらないときは書かない。書くときは読んだ版（updateTime）を条件にし、間に Naoki が触っていたら書かない
 */
import { toFVal, readLayout } from "./taskmaster.js";
import { parseHaakuRoadmap } from "./haaku-plan-summary.js";
import { readValue, writeValue, parseLinksStore, LINKS_KEY } from "./haaku-home-store.js";
import { canonical } from "./haaku-ai-changes.js";
// v1.17.0：id で読む口は taskmaster-by-id.ts へ移した（結ぶ処理 linkTasks も同じ口を使うため）
import { readTasksById, type TaskNow } from "./taskmaster-by-id.js";
export type { TaskNow };

const DB = "projects/gen-lang-client-0371348401/databases/ai-studio-622b9a97-52df-425a-85c6-1a2670c54e0a";
const API = "https://firestore.googleapis.com/v1/" + DB + "/documents";
export const SYNC_KEY = "os_task_deadline_sync_v1";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Ctx = { token: string; uid: string };
export type Copy = { milestoneId: string; date: string; before: string | null; beforeMissing?: boolean; at: string };
export type SyncStore = { schemaVersion: 1; copies: Record<string, Copy>; starts?: Record<string, Copy>; updatedAt?: string };
export type Field = "deadline" | "startDate";
export type Write = { taskId: string; field?: Field; kind: "copy" | "clear"; from: string; to: string; value: string | null; remove: boolean; milestoneId: string };
export type Counts = { copied: number; naoki: number; cleared: number; unchanged: number; dropped: number; closed: number; no_due: number; missing: number };
export type Plan = {
  writes: Write[];
  next: SyncStore;
  counts: Counts;
  naoki: { taskId: string; deadline: string; milestoneId: string; due: string }[];
};
export type StartPlan = {
  writes: Write[];
  starts: Record<string, Copy>;
  counts: Counts;
  naoki: { taskId: string; startDate: string; milestoneId: string; start: string }[];
};

/** deadline の値を日付（YYYY-MM-DD）か空文字に直す */
export function dayOf(v: unknown): string {
  return typeof v === "string" && DAY.test(v.slice(0, 10)) ? v.slice(0, 10) : "";
}

export function parseSyncStore(v: unknown): SyncStore {
  if (v === null || v === undefined) return { schemaVersion: 1, copies: {} };
  const o = v as Record<string, unknown>;
  if (!o || typeof o !== "object" || o.schemaVersion !== 1 || !o.copies || typeof o.copies !== "object" || Array.isArray(o.copies)) {
    throw new Error(SYNC_KEY + " の形が読めません。止めました");
  }
  if (o.starts !== undefined && (!o.starts || typeof o.starts !== "object" || Array.isArray(o.starts))) {
    throw new Error(SYNC_KEY + " の starts（着手日の記録）の形が読めません。止めました");
  }
  return { schemaVersion: 1, copies: { ...(o.copies as Record<string, Copy>) },
    ...(o.starts ? { starts: { ...(o.starts as Record<string, Copy>) } } : {}), updatedAt: o.updatedAt as string | undefined };
}

/**
 * 1 つの欄（deadline か startDate）について写す計画を立てる（外に触らない・試験で回す）
 * dates … マスの id → 日付（空文字は日付なし。無いマスと、日付が読めないマスは入れない＝触らない）
 */
function planField(field: Field, input: {
  links: { taskId: string; milestoneId: string }[];
  dates: Map<string, string>;
  tasks: Map<string, TaskNow>;
  copies: Record<string, Copy>;
  at: string;
}) {
  const { links, dates, tasks, at } = input;
  const copies: Record<string, Copy> = { ...input.copies };
  const writes: Write[] = [];
  const counts: Counts = { copied: 0, naoki: 0, cleared: 0, unchanged: 0, dropped: 0, closed: 0, no_due: 0, missing: 0 };
  const naoki: { taskId: string; current: string; milestoneId: string; target: string }[] = [];
  const linked = new Set(links.map(l => l.taskId));
  const valueOf = (t: TaskNow) => field === "deadline" ? t.deadline : t.startDate;
  const hasOf = (t: TaskNow) => field === "deadline" ? t.hasDeadline : !!t.hasStartDate;

  // 決まり 4：結びが無くなったタスクの記録は消す（値は触らない）
  for (const id of Object.keys(copies)) if (!linked.has(id)) { delete copies[id]; counts.dropped++; }

  for (const { taskId, milestoneId } of links) {
    const t = tasks.get(taskId);
    if (!t || !t.exists) { if (copies[taskId]) { delete copies[taskId]; counts.dropped++; } counts.missing++; continue; }
    if (t.completed || t.archived) { counts.closed++; continue; }
    if (!dates.has(milestoneId)) { counts.missing++; continue; } // マスが見つからない・日付が読めない結びは触らない
    const due = dates.get(milestoneId)!;
    const raw = valueOf(t);
    const cur = dayOf(raw);
    const rec = copies[taskId];
    const ours = !!rec && cur === rec.date;
    if (due) {
      if (cur === "" || ours) {
        if (cur === due) { counts.unchanged++; copies[taskId] = { ...rec!, milestoneId }; continue; }
        const before = rec ? rec.before : (typeof raw === "string" ? raw : null);
        const beforeMissing = rec ? rec.beforeMissing : !hasOf(t);
        copies[taskId] = { milestoneId, date: due, before, ...(beforeMissing ? { beforeMissing: true } : {}), at };
        writes.push({ taskId, field, kind: "copy", from: cur, to: due, value: due, remove: false, milestoneId });
        counts.copied++;
      } else {
        // 決まり 2：Naoki の日。上書きしない。記録が残っていれば消す（以後も Naoki の日として扱う）
        if (rec) { delete copies[taskId]; counts.dropped++; }
        counts.naoki++; naoki.push({ taskId, current: cur, milestoneId, target: due });
      }
    } else {
      counts.no_due++;
      if (ours) {
        // 決まり 3：マスの日付が空になった。写した日のままなら、写す前の空の形に戻す
        writes.push({ taskId, field, kind: "clear", from: cur, to: "", value: rec!.before ?? null, remove: !!rec!.beforeMissing, milestoneId });
        counts.cleared++;
      } else if (rec) { delete copies[taskId]; counts.dropped++; }
    }
  }
  return { writes, copies, counts, naoki };
}

/**
 * 期限を写す計画（v1.13.0 から形は同じ）
 * links … タスク → マス（未完了も完了も全部）／dues … マスの id → 期限（空文字は期限なし。無いマスは undefined）
 */
export function planDeadlineSync(input: {
  links: { taskId: string; milestoneId: string }[];
  dues: Map<string, string>;
  tasks: Map<string, TaskNow>;
  store: SyncStore;
  at: string;
}): Plan {
  const r = planField("deadline", { links: input.links, dates: input.dues, tasks: input.tasks, copies: input.store.copies, at: input.at });
  return { writes: r.writes, next: { schemaVersion: 1, copies: r.copies, updatedAt: input.at }, counts: r.counts,
    naoki: r.naoki.map(n => ({ taskId: n.taskId, deadline: n.current, milestoneId: n.milestoneId, due: n.target })) };
}

/** v1.14.0：着手日を写す計画。starts … マスの id → 着手日（空文字は着手日なし。無いマス・読めないマスは入れない） */
export function planStartSync(input: {
  links: { taskId: string; milestoneId: string }[];
  starts: Map<string, string>;
  tasks: Map<string, TaskNow>;
  store: SyncStore;
  at: string;
}): StartPlan {
  const r = planField("startDate", { links: input.links, dates: input.starts, tasks: input.tasks, copies: input.store.starts ?? {}, at: input.at });
  return { writes: r.writes, starts: r.copies, counts: r.counts,
    naoki: r.naoki.map(n => ({ taskId: n.taskId, startDate: n.current, milestoneId: n.milestoneId, start: n.target })) };
}

/** 1 つのタスクへの書き込みを 1 回にまとめる（期限と着手日を両方書くときも 1 回） */
export function groupWrites(writes: Write[]): { taskId: string; writes: Write[] }[] {
  const by = new Map<string, Write[]>();
  for (const w of writes) by.set(w.taskId, [...(by.get(w.taskId) ?? []), w]);
  return [...by].map(([taskId, ws]) => ({ taskId, writes: ws.sort((a, b) => (a.field === "startDate" ? 1 : 0) - (b.field === "startDate" ? 1 : 0)) }));
}

/**
 * 1 つのタスクの deadline と startDate のうち、変わる欄だけを書く（1 回にまとめる）。読んだ版を条件にする（間に Naoki が触っていたら書かない）
 * 欄を消す（写す前に欄が無かった）ときは updateMask に入れて fields に入れない
 */
async function writeTask(ctx: Ctx, taskId: string, ws: Write[], updateTime: string): Promise<"ok" | "conflict"> {
  const mask = ws.map(w => "updateMask.fieldPaths=" + (w.field ?? "deadline")).join("&");
  const url = API + "/users/" + ctx.uid + "/tm_tasks/" + encodeURIComponent(taskId) +
    "?" + mask + "&currentDocument.updateTime=" + encodeURIComponent(updateTime);
  const fields: Record<string, unknown> = {};
  for (const w of ws) if (!w.remove) fields[w.field ?? "deadline"] = toFVal(w.value);
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: "Bearer " + ctx.token, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (res.ok) return "ok";
  const text = await res.text().catch(() => "");
  if (res.status === 409 || res.status === 412 || /FAILED_PRECONDITION/.test(text)) return "conflict";
  throw new Error("TaskMaster のタスクを書けませんでした（" + res.status + "）：" + taskId + " " + text.slice(0, 160));
}

/**
 * 写す（dryRun なら何も書かずに計画だけ返す）
 * 書く順：① 写した記録（写す分は先に入れる・空に戻す分は残したまま）→ ② タスク（1 タスク 1 回）→ ③ 空に戻せた分の記録を消す
 *   ① を先にするのは、タスクを書いたあとに記録が書けないと、次の回に「Naoki の日」と見なしてしまうため
 *   ② で間に触られた（版が違う）タスクは、期限も着手日も書かず、③ でそのタスクの記録を ① の前に戻す
 */
export async function syncTaskDeadlines(ctx: Ctx, opts: { dryRun?: boolean; at?: string } = {}) {
  const at = opts.at ?? new Date().toISOString();
  const layout = await readLayout(ctx.token, ctx.uid);
  if (layout !== "v2") throw new Error("TaskMaster の置き場が 1 本ずつの形（v2）ではありません（" + layout + "）。期限は写していません");
  const [roadDoc, linksDoc, syncDoc] = await Promise.all([
    readValue(ctx.token, ctx.uid, "os_roadmap_v1"), readValue(ctx.token, ctx.uid, LINKS_KEY), readValue(ctx.token, ctx.uid, SYNC_KEY),
  ]);
  const road = parseHaakuRoadmap(roadDoc.value);
  const milestones = road?.milestones ?? [];
  const dues = new Map(milestones.map(m => [m.id, m.dueDate || ""]));
  // 着手日が日付として読めないマスは入れない（＝そのマスの着手日には触らない）
  const starts = new Map(milestones.filter(m => !m.startDateBad).map(m => [m.id, m.startDate || ""]));
  const badStarts = milestones.filter(m => m.startDateBad).map(m => m.id);
  const links = parseLinksStore(linksDoc.value).links.map(l => ({ taskId: l.taskId, milestoneId: l.milestoneId }));
  const store = parseSyncStore(syncDoc.value);
  const tasks = links.length ? await readTasksById(ctx, links.map(l => l.taskId)) : new Map<string, TaskNow>();
  const plan = planDeadlineSync({ links, dues, tasks, store, at });
  const sp = planStartSync({ links, starts, tasks, store, at });
  const summary = (c: Counts, s: Counts, conflicts = 0) =>
    `写した ${c.copied}・Naoki の日なので写さなかった ${c.naoki}・空に戻した ${c.cleared}・変わらず ${c.unchanged}` +
    `・写した記録を消した ${c.dropped}・完了かアーカイブで見送り ${c.closed}` + (conflicts ? `・間に触られて見送り ${conflicts}` : "") +
    `（結んだタスク ${links.length}）` +
    `／着手日：写した ${s.copied}・Naoki の日なので写さなかった ${s.naoki}・空に戻した ${s.cleared}・変わらず ${s.unchanged}・写した記録を消した ${s.dropped}` +
    (badStarts.length ? `・日付が読めないマス ${badStarts.length}` : "");
  if (opts.dryRun) {
    const view = (w: Write) => ({ task_id: w.taskId, kind: w.kind, from: w.from || null, to: w.to || null, milestone_id: w.milestoneId });
    return { ok: true, dry_run: true, counts: plan.counts, writes: plan.writes.map(view),
      naoki_dates: plan.naoki.map(n => ({ task_id: n.taskId, deadline: n.deadline, milestone_due: n.due, milestone_id: n.milestoneId })),
      start_counts: sp.counts, start_writes: sp.writes.map(view),
      naoki_start_dates: sp.naoki.map(n => ({ task_id: n.taskId, start_date: n.startDate, milestone_start: n.start, milestone_id: n.milestoneId })),
      unreadable_start_milestones: badStarts,
      detail: summary(plan.counts, sp.counts) };
  }
  // ①
  const all = [...plan.writes, ...sp.writes];
  const phase1: SyncStore = { schemaVersion: 1, copies: { ...plan.next.copies }, starts: { ...sp.starts }, updatedAt: at };
  for (const w of all) if (w.kind === "clear") {
    if (w.field === "startDate") phase1.starts![w.taskId] = (store.starts ?? {})[w.taskId];
    else phase1.copies[w.taskId] = store.copies[w.taskId];
  }
  let version = syncDoc.version;
  if (canonical(phase1.copies) !== canonical(store.copies) || canonical(phase1.starts) !== canonical(store.starts ?? {})) {
    await writeValue(ctx.token, ctx.uid, SYNC_KEY, phase1, version);
    version = (await readValue(ctx.token, ctx.uid, SYNC_KEY)).version;
  }
  // ②
  let conflicts = 0;
  const done: Write[] = [], failed: Write[] = [];
  for (const g of groupWrites(all)) {
    const r = await writeTask(ctx, g.taskId, g.writes, tasks.get(g.taskId)!.updateTime);
    if (r === "conflict") { conflicts++; failed.push(...g.writes); continue; }
    done.push(...g.writes);
  }
  // ③ 空に戻せた分の記録を消す。間に触られて書けなかった分は、記録を ① の前に戻す
  //   （戻さないと、次の回に「写した日と違う＝Naoki の日」と見なして以後写さなくなるため）
  const cleared = done.filter(w => w.kind === "clear");
  if (cleared.length || failed.length) {
    const phase3: SyncStore = { ...phase1, copies: { ...phase1.copies }, starts: { ...phase1.starts } };
    for (const w of cleared) delete (w.field === "startDate" ? phase3.starts! : phase3.copies)[w.taskId];
    for (const w of failed) {
      const target = w.field === "startDate" ? phase3.starts! : phase3.copies;
      const prev = (w.field === "startDate" ? store.starts ?? {} : store.copies)[w.taskId];
      if (prev) target[w.taskId] = prev; else delete target[w.taskId];
    }
    await writeValue(ctx.token, ctx.uid, SYNC_KEY, phase3, version);
  }
  const n = (f: Field, k: "copy" | "clear") => done.filter(w => (w.field ?? "deadline") === f && w.kind === k).length;
  const c = { ...plan.counts, copied: n("deadline", "copy"), cleared: n("deadline", "clear") };
  const s2 = { ...sp.counts, copied: n("startDate", "copy"), cleared: n("startDate", "clear") };
  return { ok: true, dry_run: false, count: done.length, counts: c, start_counts: s2, conflicts, detail: summary(c, s2, conflicts) };
}
