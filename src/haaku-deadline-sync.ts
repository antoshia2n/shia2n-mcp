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
 * 置き場
 *   写した記録：users/{uid}/app_data/os_task_deadline_sync_v1（haAku の側・1 文書）
 *     { schemaVersion: 1, copies: { [taskId]: { milestoneId, date, before, beforeMissing?, at } }, updatedAt }
 *     before … はじめて写す前の deadline の値（null か空文字）。空に戻すときにこの形へ戻す
 *   TaskMaster の文書（users/{uid}/tm_tasks/{id}）には新しい欄を足さない。書くのは deadline の 1 欄だけ
 *
 * 読み書きの量（2026-10-02 に Firestore の無料枠を使い切った件があるため）
 *   タスクは全部読まず、結んだタスクだけを id で読む（documents:batchGet）。30 分ごとに動くため
 *   値が変わらないときは書かない。書くときは読んだ版（updateTime）を条件にし、間に Naoki が触っていたら書かない
 */
import { toFVal, readLayout, fromVal, type FSDoc, type FVal } from "./taskmaster.js";
import { parseHaakuRoadmap } from "./haaku-plan-summary.js";
import { readValue, writeValue, parseLinksStore, LINKS_KEY } from "./haaku-home-store.js";
import { canonical } from "./haaku-ai-changes.js";

const DB = "projects/gen-lang-client-0371348401/databases/ai-studio-622b9a97-52df-425a-85c6-1a2670c54e0a";
const API = "https://firestore.googleapis.com/v1/" + DB + "/documents";
export const SYNC_KEY = "os_task_deadline_sync_v1";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Ctx = { token: string; uid: string };
export type Copy = { milestoneId: string; date: string; before: string | null; beforeMissing?: boolean; at: string };
export type SyncStore = { schemaVersion: 1; copies: Record<string, Copy>; updatedAt?: string };
export type TaskNow = { exists: boolean; deadline: unknown; hasDeadline: boolean; completed: boolean; archived: boolean; updateTime: string };
export type Write = { taskId: string; kind: "copy" | "clear"; from: string; to: string; value: string | null; remove: boolean; milestoneId: string };
export type Plan = {
  writes: Write[];
  next: SyncStore;
  counts: { copied: number; naoki: number; cleared: number; unchanged: number; dropped: number; closed: number; no_due: number; missing: number };
  naoki: { taskId: string; deadline: string; milestoneId: string; due: string }[];
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
  return { schemaVersion: 1, copies: { ...(o.copies as Record<string, Copy>) }, updatedAt: o.updatedAt as string | undefined };
}

/**
 * 写す計画を立てる（外に触らない・試験で回す）
 * links … タスク → マス（未完了も完了も全部）／dues … マスの id → 期限（空文字は期限なし。無いマスは undefined）
 */
export function planDeadlineSync(input: {
  links: { taskId: string; milestoneId: string }[];
  dues: Map<string, string>;
  tasks: Map<string, TaskNow>;
  store: SyncStore;
  at: string;
}): Plan {
  const { links, dues, tasks, store, at } = input;
  const copies: Record<string, Copy> = { ...store.copies };
  const writes: Write[] = [];
  const counts = { copied: 0, naoki: 0, cleared: 0, unchanged: 0, dropped: 0, closed: 0, no_due: 0, missing: 0 };
  const naoki: Plan["naoki"] = [];
  const linked = new Set(links.map(l => l.taskId));

  // 決まり 4：結びが無くなったタスクの記録は消す（期限は触らない）
  for (const id of Object.keys(copies)) if (!linked.has(id)) { delete copies[id]; counts.dropped++; }

  for (const { taskId, milestoneId } of links) {
    const t = tasks.get(taskId);
    if (!t || !t.exists) { if (copies[taskId]) { delete copies[taskId]; counts.dropped++; } counts.missing++; continue; }
    if (t.completed || t.archived) { counts.closed++; continue; }
    if (!dues.has(milestoneId)) { counts.missing++; continue; } // マスが見つからない結びは触らない
    const due = dues.get(milestoneId)!;
    const cur = dayOf(t.deadline);
    const rec = copies[taskId];
    const ours = !!rec && cur === rec.date;
    if (due) {
      if (cur === "" || ours) {
        if (cur === due) { counts.unchanged++; copies[taskId] = { ...rec!, milestoneId }; continue; }
        const before = rec ? rec.before : (typeof t.deadline === "string" ? t.deadline : null);
        const beforeMissing = rec ? rec.beforeMissing : !t.hasDeadline;
        copies[taskId] = { milestoneId, date: due, before, ...(beforeMissing ? { beforeMissing: true } : {}), at };
        writes.push({ taskId, kind: "copy", from: cur, to: due, value: due, remove: false, milestoneId });
        counts.copied++;
      } else {
        // 決まり 2：Naoki の日。上書きしない。記録が残っていれば消す（以後も Naoki の日として扱う）
        if (rec) { delete copies[taskId]; counts.dropped++; }
        counts.naoki++; naoki.push({ taskId, deadline: cur, milestoneId, due });
      }
    } else {
      counts.no_due++;
      if (ours) {
        // 決まり 3：マスの期限が空になった。写した日のままなら、写す前の空の形に戻す
        writes.push({ taskId, kind: "clear", from: cur, to: "", value: rec!.before ?? null, remove: !!rec!.beforeMissing, milestoneId });
        counts.cleared++;
      } else if (rec) { delete copies[taskId]; counts.dropped++; }
    }
  }
  return { writes, next: { schemaVersion: 1, copies, updatedAt: at }, counts, naoki };
}

/** 結んだタスクだけを id で読む（全部は読まない） */
async function readTasksById(ctx: Ctx, ids: string[]): Promise<Map<string, TaskNow>> {
  const out = new Map<string, TaskNow>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const res = await fetch(API + ":batchGet", {
      method: "POST",
      headers: { Authorization: "Bearer " + ctx.token, "Content-Type": "application/json" },
      body: JSON.stringify({ documents: chunk.map(id => DB + "/documents/users/" + ctx.uid + "/tm_tasks/" + encodeURIComponent(id)) }),
    });
    if (!res.ok) throw new Error("TaskMaster のタスクを読めませんでした（" + res.status + "）。書いていません");
    const rows = (await res.json()) as { found?: FSDoc & { updateTime?: string }; missing?: string }[];
    for (const r of rows) {
      if (r.found) {
        const id = decodeURIComponent(r.found.name.split("/").pop() || "");
        const f = r.found.fields ?? {};
        const v = (k: string) => (k in f ? fromVal(f[k] as FVal) : undefined);
        out.set(id, { exists: true, deadline: v("deadline"), hasDeadline: "deadline" in f,
          completed: v("completed") === true, archived: v("archived") === true, updateTime: r.found.updateTime ?? "" });
      } else if (r.missing) {
        out.set(decodeURIComponent(r.missing.split("/").pop() || ""), { exists: false, deadline: undefined, hasDeadline: false, completed: false, archived: false, updateTime: "" });
      }
    }
  }
  return out;
}

/** deadline の 1 欄だけを書く。読んだ版を条件にする（間に Naoki が触っていたら書かない） */
async function writeDeadline(ctx: Ctx, w: Write, updateTime: string): Promise<"ok" | "conflict"> {
  const url = API + "/users/" + ctx.uid + "/tm_tasks/" + encodeURIComponent(w.taskId) +
    "?updateMask.fieldPaths=deadline&currentDocument.updateTime=" + encodeURIComponent(updateTime);
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: "Bearer " + ctx.token, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: w.remove ? {} : { deadline: toFVal(w.value) } }),
  });
  if (res.ok) return "ok";
  const text = await res.text().catch(() => "");
  if (res.status === 409 || res.status === 412 || /FAILED_PRECONDITION/.test(text)) return "conflict";
  throw new Error("TaskMaster の期限を書けませんでした（" + res.status + "）：" + w.taskId + " " + text.slice(0, 160));
}

/**
 * 写す（dryRun なら何も書かずに計画だけ返す）
 * 書く順：① 写した記録（写す分は先に入れる・空に戻す分は残したまま）→ ② タスクの deadline → ③ 空に戻せた分の記録を消す
 *   ① を先にするのは、タスクを書いたあとに記録が書けないと、次の回に「Naoki の日」と見なしてしまうため
 */
export async function syncTaskDeadlines(ctx: Ctx, opts: { dryRun?: boolean; at?: string } = {}) {
  const at = opts.at ?? new Date().toISOString();
  const layout = await readLayout(ctx.token, ctx.uid);
  if (layout !== "v2") throw new Error("TaskMaster の置き場が 1 本ずつの形（v2）ではありません（" + layout + "）。期限は写していません");
  const [roadDoc, linksDoc, syncDoc] = await Promise.all([
    readValue(ctx.token, ctx.uid, "os_roadmap_v1"), readValue(ctx.token, ctx.uid, LINKS_KEY), readValue(ctx.token, ctx.uid, SYNC_KEY),
  ]);
  const road = parseHaakuRoadmap(roadDoc.value);
  const dues = new Map((road?.milestones ?? []).map(m => [m.id, m.dueDate || ""]));
  const links = parseLinksStore(linksDoc.value).links.map(l => ({ taskId: l.taskId, milestoneId: l.milestoneId }));
  const store = parseSyncStore(syncDoc.value);
  const tasks = links.length ? await readTasksById(ctx, links.map(l => l.taskId)) : new Map<string, TaskNow>();
  const plan = planDeadlineSync({ links, dues, tasks, store, at });
  const summary = (c: Plan["counts"], conflicts = 0) =>
    `写した ${c.copied}・Naoki の日なので写さなかった ${c.naoki}・空に戻した ${c.cleared}・変わらず ${c.unchanged}` +
    `・写した記録を消した ${c.dropped}・完了かアーカイブで見送り ${c.closed}` + (conflicts ? `・間に触られて見送り ${conflicts}` : "") +
    `（結んだタスク ${links.length}）`;
  if (opts.dryRun) {
    return { ok: true, dry_run: true, counts: plan.counts, writes: plan.writes.map(w => ({ task_id: w.taskId, kind: w.kind, from: w.from || null, to: w.to || null, milestone_id: w.milestoneId })),
      naoki_dates: plan.naoki.map(n => ({ task_id: n.taskId, deadline: n.deadline, milestone_due: n.due, milestone_id: n.milestoneId })), detail: summary(plan.counts) };
  }
  // ①
  const clears = plan.writes.filter(w => w.kind === "clear");
  const phase1 = { ...plan.next, copies: { ...plan.next.copies } };
  for (const w of clears) phase1.copies[w.taskId] = store.copies[w.taskId];
  let version = syncDoc.version;
  if (canonical(phase1.copies) !== canonical(store.copies)) {
    await writeValue(ctx.token, ctx.uid, SYNC_KEY, phase1, version);
    version = (await readValue(ctx.token, ctx.uid, SYNC_KEY)).version;
  }
  // ②
  let conflicts = 0, copiedOk = 0;
  const cleared: string[] = [];
  for (const w of plan.writes) {
    const r = await writeDeadline(ctx, w, tasks.get(w.taskId)!.updateTime);
    if (r === "conflict") { conflicts++; continue; }
    if (w.kind === "clear") cleared.push(w.taskId); else copiedOk++;
  }
  // ③
  if (cleared.length) {
    const phase3 = { ...phase1, copies: { ...phase1.copies } };
    for (const id of cleared) delete phase3.copies[id];
    await writeValue(ctx.token, ctx.uid, SYNC_KEY, phase3, version);
  }
  const c = { ...plan.counts, copied: copiedOk, cleared: cleared.length };
  return { ok: true, dry_run: false, count: plan.writes.length - conflicts, counts: c, conflicts, detail: summary(c, conflicts) };
}
