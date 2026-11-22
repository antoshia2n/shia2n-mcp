/**
 * マネージャーくん 10便目（2026-11-22 開発部・Naoki「タブを整理して、フォルダとか。作業とか、タスクと結びつけないと」→ 確定案に OK 14:08）
 *   ・フォルダ＝TaskMaster のプロジェクト（事業の軸）。Claude・ChatGPT のプロジェクト名（mk_chats.area）は「部屋」の札のまま
 *   ・作業 1 つ＝TaskMaster のタスク 1 つ。フォルダを選ぶとタスクが立つ（すでにあるタスクを選んでつなぐこともできる）
 *   ・完了は両方へ：マネージャーくんで完了 → タスクも完了。TaskMaster で完了（開いているタスクの一覧から消えた）→ 作業も完了（15・45 分ごと）
 *   ・期日と重要度は TaskMaster が正本。作業には写しを持つだけ（15・45 分ごとに読み直す）
 *   ・繰り返しのタスクはつながない（完了すると次の回が立つため）
 */
import type { Env } from "./index.js";
import { handleTaskmasterAddTask, handleTaskmasterTasks, handleTaskmasterUpdateTask } from "./taskmaster.js";
import { ManagerError, workById } from "./manager-store.js";

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
  if (!res.ok) throw new ManagerError("supabase_error", `Supabase ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
async function patchWork(env: Env, id: number, patch: Record<string, unknown>): Promise<Row> {
  const rows = await sb(env, `mk_works?id=eq.${id}&select=*`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ ...patch, touched_at: new Date().toISOString() }) });
  if (!rows?.[0]) throw new ManagerError("work_not_found", `作業 ${id} はありません`);
  return rows[0];
}

/** TaskMaster の開いているタスクとプロジェクト（繰り返しのタスクは除く） */
export async function tmOpen(env: Env): Promise<{ tasks: Row[]; projects: Row[] }> {
  const res = await handleTaskmasterTasks(new Request("https://internal/taskmaster/tasks"), env);
  if (!res.ok) throw new ManagerError("taskmaster_error", `TaskMaster を読めませんでした（${res.status}）`);
  const b = (await res.json()) as { tasks?: Row[]; projects?: Row[] };
  return { tasks: b.tasks || [], projects: (b.projects || []).filter((p) => p.status !== "archived") };
}

const taskLink = (id: number) => [{ title: "マネージャーくんの作業", url: `${SITE}/#w${id}` }];

/** 作業のフォルダ（TaskMaster のプロジェクト）を決める。タスクがまだ無ければ、そのプロジェクトに同じ名前のタスクを立てる */
export async function setFolder(env: Env, workId: number, projectId: string | null): Promise<Row> {
  const w = await workById(env, workId);
  if (!w) throw new ManagerError("work_not_found", `作業 ${workId} はありません`);
  if (!projectId) return patchWork(env, workId, { tm_project_id: null, tm_project_name: null });
  const { projects } = await tmOpen(env);
  const p = projects.find((x) => x.id === projectId);
  if (!p) throw new ManagerError("project_not_found", "TaskMaster にそのプロジェクトがありません");
  let patch: Record<string, unknown> = { tm_project_id: p.id, tm_project_name: p.title };
  const cur = w as Row;
  if (cur.tm_task_id) {
    await tmUpdate(env, { task_id: cur.tm_task_id, projectId: p.id }).catch(() => null);
  } else {
    const res = await handleTaskmasterAddTask(new Request("https://internal/taskmaster/tasks/add", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: String(w.name).slice(0, 200), projectId: p.id, links: taskLink(workId) }),
    }), env);
    const b = (await res.json().catch(() => ({}))) as { task?: Row };
    if (!res.ok || !b.task?.id) throw new ManagerError("taskmaster_error", "TaskMaster にタスクを立てられませんでした");
    patch = { ...patch, tm_task_id: b.task.id, tm_deadline: b.task.deadline ?? null, tm_priority: b.task.priority ?? null, tm_synced_at: new Date().toISOString() };
  }
  return patchWork(env, workId, patch);
}

/** すでにある TaskMaster のタスクにつなぐ（フォルダもそのタスクのプロジェクトにそろえる） */
export async function linkTask(env: Env, workId: number, taskId: string | null): Promise<Row> {
  if (!taskId) return patchWork(env, workId, { tm_task_id: null, tm_deadline: null, tm_priority: null });
  const { tasks, projects } = await tmOpen(env);
  const t = tasks.find((x) => x.id === taskId);
  if (!t) throw new ManagerError("task_not_found", "TaskMaster の開いているタスクにありません");
  if (t.repeat) throw new ManagerError("repeat_task", "繰り返しのタスクはつなげません（完了すると次の回が立つため）");
  const other = ((await sb(env, `mk_works?select=id,name&tm_task_id=eq.${encodeURIComponent(taskId)}&id=neq.${workId}`)) || [])[0];
  if (other) throw new ManagerError("task_taken", `このタスクはもう作業「${other.name}」につながっています`);
  const p = projects.find((x) => x.id === t.projectId);
  return patchWork(env, workId, { tm_task_id: t.id, tm_project_id: p?.id ?? null, tm_project_name: p?.title ?? null, tm_deadline: t.deadline ?? null, tm_priority: t.priority ?? null, tm_synced_at: new Date().toISOString() });
}

async function tmUpdate(env: Env, body: Record<string, unknown>): Promise<Response> {
  return handleTaskmasterUpdateTask(new Request("https://internal/taskmaster/tasks/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), env);
}

/** 作業の完了・戻しを、つながっているタスクへ写す（TaskMaster が止まっていても作業は止めない） */
export async function syncWorkDone(env: Env, w: Row): Promise<void> {
  if (!w?.tm_task_id) return;
  try { await tmUpdate(env, { task_id: w.tm_task_id, status: w.state === "済み" ? "done" : "todo" }); } catch {}
}

/** 15・45 分ごと：つながっているタスクの期日・重要度を写し、TaskMaster で完了したものは作業も完了にする */
export async function syncFromTaskmaster(env: Env): Promise<{ updated: number; done: number }> {
  const works: Row[] = (await sb(env, `mk_works?select=id,tm_task_id,tm_deadline,tm_priority&tm_task_id=not.is.null&state=eq.${encodeURIComponent("進行中")}&limit=500`)) || [];
  if (!works.length) return { updated: 0, done: 0 };
  const { tasks, projects } = await tmOpen(env);
  const byId = new Map(tasks.map((t) => [String(t.id), t]));
  let updated = 0, done = 0;
  for (const w of works) {
    const t = byId.get(String(w.tm_task_id));
    if (!t) { await patchWork(env, Number(w.id), { state: "済み" }); done++; continue; }
    const p = projects.find((x) => x.id === t.projectId);
    if (t.deadline !== w.tm_deadline || t.priority !== w.tm_priority) {
      await patchWork(env, Number(w.id), { tm_deadline: t.deadline ?? null, tm_priority: t.priority ?? null, ...(p ? { tm_project_id: p.id, tm_project_name: p.title } : {}), tm_synced_at: new Date().toISOString() });
      updated++;
    }
  }
  return { updated, done };
}
