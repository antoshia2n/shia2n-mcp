/**
 * B（utage-alt-demo）の便 8f-2：タスクマスターの「今日の分」を B のホームへ渡す口。
 *
 * 外（インターネット）からは呼べない。同じ Cloudflare のアカウントの Worker が
 * 「サービスの結び（Service Binding）」で名前 TaskmasterReader を指したときだけ呼べる。
 * そのため合言葉（秘密の値）は要らない。B の wrangler.jsonc の services に
 *   { "binding": "TASKMASTER", "service": "shia2n-mcp", "entrypoint": "TaskmasterReader" }
 * を書くと、B から env.TASKMASTER.today("2026-10-09") で呼べる。
 *
 * 読むだけ。書く口は作らない（タスクの追加・更新は今までどおり MCP の道具だけ）。
 * 中身は GET /taskmaster/tasks と同じ関数を呼び、期限が今日か過ぎている未完了だけに絞る。
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./index.js";
import { handleTaskmasterTasks } from "./taskmaster.js";

type Task = { id: string; title: string; status: string; priority: string; deadline: string | null; projectId: string | null };
type Project = { id: string; title: string };

const RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

export class TaskmasterReader extends WorkerEntrypoint<Env> {
  // day は日本時間の日付（YYYY-MM-DD）。期限が day のものと、day より前のもの（過ぎている）を返す
  async today(day: string): Promise<object> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return { ok: false, error: "bad_day" };
    const res = await handleTaskmasterTasks(new Request("https://internal/taskmaster/tasks"), this.env);
    const data = (await res.json()) as { tasks?: Task[]; projects?: Project[]; error?: string };
    if (!res.ok || !data.tasks) return { ok: false, error: String(data.error || `status_${res.status}`).slice(0, 120) };
    const pname = Object.fromEntries((data.projects || []).map((p) => [p.id, p.title]));
    const pick = (t: Task) => ({
      title: String(t.title || "").slice(0, 120),
      priority: t.priority,
      deadline: t.deadline,
      project: t.projectId ? pname[t.projectId] || "" : "",
    });
    const order = (a: Task, b: Task) => (RANK[a.priority] ?? 1) - (RANK[b.priority] ?? 1) || String(a.deadline).localeCompare(String(b.deadline));
    const due = data.tasks.filter((t) => t.deadline === day).sort(order);
    const overdue = data.tasks.filter((t) => t.deadline && t.deadline < day).sort(order);
    return { ok: true, day, due_count: due.length, overdue_count: overdue.length, due: due.slice(0, 30).map(pick), overdue: overdue.slice(0, 30).map(pick) };
  }
}
