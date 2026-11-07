/**
 * shia2n-mcp / src/taskmaster-writer-core.ts / 新設（2026-11-07 v1.71.0 開発部・マーケくんのチャット C1）
 *
 * B（マーケくん・utage-alt-demo）のチャットで、メッセージを右クリック →「タスクへ追加」したときの引数の確かめだけの部品
 * （外に触らない・試験で回す）。呼ぶ口そのものは src/taskmaster-writer.ts の TaskmasterWriter。
 * 足せるのは 題・期限・元のメッセージへ戻る住所 1 本 だけ（ほかの欄は TaskMaster の画面で直す）。
 */
import type { AddTaskInput } from "./taskmaster.js";

export type WriterArgs = { title: string; deadline: string | null; link: { title: string; url: string } | null };

const LINK_RE = /^https:\/\/(lab\.shia2n\.jp|utage-alt-demo\.gameister1\.workers\.dev)\/admin#[A-Za-z0-9/_-]{1,200}$/;

/** 確かめて形をそろえる。だめなら error に理由（英小文字の印）を返す */
export function checkAddArgs(a: unknown): { ok: true; args: WriterArgs } | { ok: false; error: string } {
  const o = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
  const title = String(o.title ?? "").replace(/[\u0000-\u001f]/g, " ").trim();
  if (!title) return { ok: false, error: "need_title" };
  if (title.length > 300) return { ok: false, error: "title_too_long" };
  let deadline: string | null = null;
  if (o.deadline != null && o.deadline !== "") {
    const d = String(o.deadline);
    const t = Date.parse(d + "T00:00:00Z");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== d) return { ok: false, error: "bad_deadline" };
    deadline = d;
  }
  let link: WriterArgs["link"] = null;
  if (o.link_url != null && o.link_url !== "") {
    const url = String(o.link_url);
    if (!LINK_RE.test(url)) return { ok: false, error: "bad_link_url" };
    link = { title: String(o.link_title ?? "マーケくんのチャット").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 80) || "マーケくんのチャット", url };
  }
  return { ok: true, args: { title, deadline, link } };
}

/** TaskMaster の受け口（handleTaskmasterAddTask）へ渡す中身。題と期限とリンクだけ */
export function toAddTaskInput(a: WriterArgs): AddTaskInput {
  return { title: a.title, deadline: a.deadline, projectId: null, ...(a.link ? { links: [a.link] } : {}) };
}
