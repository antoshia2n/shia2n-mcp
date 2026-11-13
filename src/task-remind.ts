/**
 * shia2n-mcp / src/task-remind.ts / 新設（2026-11-13 開発部・v1.92.0）
 *
 * TaskMaster のリマインド。毎朝 8:00（日本時間）に 1 通だけ送る。
 *   ・「着手日の朝にメール」（remindStart）が入っていて、着手日が今日のタスク
 *   ・「期限を過ぎたら毎朝メール」（remindOverdue）が入っていて、期限が昨日より前のタスク（済むまで毎朝）
 *   済み・アーカイブは出さない。どちらも無い朝は送らない（記録は「送らなかった」で残す）
 * Naoki「リマインド設定みたいにしておいて、着手の通知と、期限漏れの通知ってイメージ」（2026-11-13 20:27）
 * 読むのはスイッチの入ったタスクだけ（runQuery で欄の値が true のもの・全部は読まない）
 */
import type { Env } from "./index.js";
import { getFirestoreToken, queryTasks, readLayout, toFVal } from "./taskmaster.js";
import { jstToday, dayLabel } from "./seminar-tasks.js";

export const TASKMASTER = "https://taskmaster.shia2n.jp";
type T = Record<string, unknown>;
export type RemindRow = { id: string; title: string; day: string; late: number };

const day10 = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : "");
const open = (t: T) => t.completed !== true && t.status !== "done" && t.archived !== true;
const diffDays = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 864e5);

/** 今朝知らせるタスクを選ぶ（書かない・試験しやすいように中身だけ） */
export function pickReminders(startOn: T[], overdueOn: T[], today: string): { starts: RemindRow[]; overdue: RemindRow[] } {
  const row = (t: T, day: string): RemindRow => ({ id: String(t.id ?? ""), title: String(t.title || "（題なし）"), day, late: diffDays(today, day) });
  const starts = startOn.filter(t => t.remindStart === true && open(t) && day10(t.startDate) === today).map(t => row(t, today));
  const overdue = overdueOn.filter(t => t.remindOverdue === true && open(t) && day10(t.deadline) && day10(t.deadline) < today)
    .map(t => row(t, day10(t.deadline))).sort((a, b) => b.late - a.late || a.title.localeCompare(b.title));
  return { starts, overdue };
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const link = (id: string) => `${TASKMASTER}/?task=${encodeURIComponent(id)}`;

export function buildRemindMail(p: { starts: RemindRow[]; overdue: RemindRow[] }, today: string): { subject: string; html: string; text: string } | null {
  if (!p.starts.length && !p.overdue.length) return null;
  const parts = [p.starts.length && `今日から ${p.starts.length} 件`, p.overdue.length && `期限切れ ${p.overdue.length} 件`].filter(Boolean).join("・");
  const subject = `TaskMaster のリマインド：${parts}`;
  const sec = (head: string, rows: RemindRow[], note: (r: RemindRow) => string) => rows.length ? { head, rows, note } : null;
  const secs = [
    sec("今日から始めるもの", p.starts, () => "着手日が今日"),
    sec("期限を過ぎたもの", p.overdue, r => `${dayLabel(r.day)}が期限・${r.late} 日過ぎ`),
  ].filter(Boolean) as { head: string; rows: RemindRow[]; note: (r: RemindRow) => string }[];
  const text = secs.map(s => `■ ${s.head}\n${s.rows.map(r => `・${r.title}（${s.note(r)}）\n  ${link(r.id)}`).join("\n")}`).join("\n\n")
    + `\n\n止めるときは、タスクを済みにするか、日付の「リマインド」を外す。（${dayLabel(today)} 8:00）`;
  const html = `<div style="font-family:sans-serif;font-size:14px;line-height:1.7;color:#222">`
    + secs.map(s => `<p style="margin:16px 0 4px"><b>${esc(s.head)}</b></p><ul style="margin:0;padding-left:18px">${s.rows.map(r => `<li><a href="${link(r.id)}">${esc(r.title)}</a> <span style="color:${s.head.startsWith("期限") ? "#b91c1c" : "#555"}">（${esc(s.note(r))}）</span></li>`).join("")}</ul>`).join("")
    + `<p style="margin-top:20px;color:#666;font-size:12px">止めるときは、タスクを済みにするか、日付の「リマインド」を外す。</p></div>`;
  return { subject, html, text };
}

export async function runTaskRemind(env: Env, now = new Date()): Promise<{ sent: boolean; count: number; detail: string }> {
  const today = jstToday(now);
  const token = await getFirestoreToken(env);
  const layout = await readLayout(token, env.NAOKI_UID);
  if (layout !== "v2") return { sent: false, count: 0, detail: `TaskMaster の置き場が ${layout} のため見なかった` };
  const [s, o] = await Promise.all([
    queryTasks(token, env.NAOKI_UID, "remindStart", toFVal(true)),
    queryTasks(token, env.NAOKI_UID, "remindOverdue", toFVal(true)),
  ]);
  const p = pickReminders(s, o, today);
  const mail = buildRemindMail(p, today);
  if (!mail) return { sent: false, count: 0, detail: `知らせるものが無いので送らなかった（スイッチ 着手 ${s.length}・期限 ${o.length}）` };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.RESEND_FROM_EMAIL, to: [env.RESEND_TO_EMAIL], subject: mail.subject, html: mail.html, text: mail.text }),
  });
  if (!res.ok) throw new Error(`メールを送れませんでした（Resend ${res.status}：${(await res.text().catch(() => "")).slice(0, 200)}）`);
  return { sent: true, count: p.starts.length + p.overdue.length, detail: `着手 ${p.starts.length}・期限切れ ${p.overdue.length} を送った` };
}

