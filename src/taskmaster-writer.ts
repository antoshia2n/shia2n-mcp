/**
 * shia2n-mcp / src/taskmaster-writer.ts / 新設（2026-11-07 v1.71.0 開発部・マーケくんのチャット C1）
 *
 * B（マーケくん）のチャットから TaskMaster にタスクを 1 件足す口 TaskmasterWriter。
 * 外（インターネット）からは呼べない。同じ Cloudflare のアカウントの Worker が「サービスの結び」で
 * 名前 TaskmasterWriter を指したときだけ呼べる（TaskmasterReader・SalesWriter と同じ形）。
 * B の wrangler.jsonc の services に
 *   { "binding": "TASKS", "service": "shia2n-mcp", "entrypoint": "TaskmasterWriter" }
 * を書くと、B から env.TASKS.add({ title, deadline, link_url, link_title }) で呼べる。
 *
 * 書き方は持たない：道具 taskmaster__add_task と同じ handleTaskmasterAddTask を通すだけ（同じ判定を 2 か所に置かない）。
 * 読む口（TaskmasterReader）は「読むだけ」のまま残し、書く口はこちらに分けた。
 * 断られたときも投げずに { ok: false, error } で返す。
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./index.js";
import { handleTaskmasterAddTask } from "./taskmaster.js";
import { checkAddArgs, toAddTaskInput } from "./taskmaster-writer-core.js";

export class TaskmasterWriter extends WorkerEntrypoint<Env> {
  async add(input: unknown): Promise<object> {
    const c = checkAddArgs(input);
    if (!c.ok) return { ok: false, error: c.error };
    try {
      const res = await handleTaskmasterAddTask(new Request("https://internal/taskmaster/tasks/add", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(toAddTaskInput(c.args)),
      }), this.env);
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; task?: { id?: string; title?: string }; error?: string };
      if (!res.ok || !body.task) return { ok: false, status: res.status, error: String(body.error || `status_${res.status}`).slice(0, 120) };
      return { ok: true, id: body.task.id, title: body.task.title, url: `https://taskmaster.shia2n.jp/?task=${encodeURIComponent(String(body.task.id || ""))}` };
    } catch (e) {
      return { ok: false, error: "add_failed", detail: String((e as Error)?.message || e).slice(0, 200) };
    }
  }
}
