/**
 * shia2n-mcp / src/task-remind.ts / 新設（2026-11-13 開発部・v1.92.0）
 *
 * TaskMaster のリマインド。30 分ごとに見て、その時刻に知らせるものがあれば 1 通送る。
 *   ・「着手日にメール」（remindStart）が入っていて、着手日が今日で、時刻（remindAt・空なら 07:00）が今の 30 分のタスク
 *   ・「期限を過ぎたら毎朝 7:00 にメール」（remindOverdue）が入っていて、期限が昨日より前のタスク（済むまで毎朝・7:00 の回だけ）
 *   v1.93.0（2026-11-13 20:48 Naoki「リマインドの時間は決めたい。期限超過は 7 時でいい」）で 8:00 の 1 回から変えた
 *   済み・アーカイブは出さない。どちらも無い朝は送らない（記録は「送らなかった」で残す）
 * Naoki「リマインド設定みたいにしておいて、着手の通知と、期限漏れの通知ってイメージ」（2026-11-13 20:27）
 * 読むのはスイッチの入ったタスクだけ（runQuery で欄の値が true のもの・全部は読まない）
 */
import type { Env } from "./index.js";
import { getFirestoreToken, queryTasks, readLayout, toFVal, fsGetOrNull, expandValue, readTemplates } from "./taskmaster.js";
import { jstToday, dayLabel } from "./seminar-tasks.js";

export const TASKMASTER = "https://taskmaster.shia2n.jp";
type T = Record<string, unknown>;
export type RemindDetail = {
  project?: string; start?: string; deadline?: string;
  why?: string; doneWhen?: string; howto?: string; notes?: string;
  checks?: { title: string; done: boolean }[]; links?: string[];
};
export type RemindRow = { id: string; title: string; day: string; late: number; detail?: RemindDetail };

const day10 = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : "");
const open = (t: T) => t.completed !== true && t.status !== "done" && t.archived !== true;
const diffDays = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 864e5);

/** v1.95.0：メールの本文に出すタスクの中身（画面の 5W1H・チェック・メモ・リンク）。長い欄は頭だけ */
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const clip = (v: string, n: number) => (v.length > n ? v.slice(0, n) + "…" : v);
export function detailOf(t: T, ctx: { projects?: Map<string, string>; howtoOf?: Map<string, string> } = {}): RemindDetail {
  const d: RemindDetail = {};
  const pj = ctx.projects?.get(str(t.projectId)); if (pj) d.project = pj;
  if (day10(t.startDate)) d.start = day10(t.startDate);
  if (day10(t.deadline)) d.deadline = day10(t.deadline);
  for (const k of ["why", "doneWhen", "notes"] as const) { const v = str(t[k]); if (v) d[k] = clip(v, 400); }
  const howto = (str(t.templateId) && ctx.howtoOf?.get(str(t.templateId))) || str(t.howto); if (howto) d.howto = clip(howto, 600);
  const subs = Array.isArray(t.subtasks) ? t.subtasks : [];
  const checks = subs.map((s) => {
    if (typeof s === "string") return { title: s.trim(), done: false };
    const o = (s || {}) as T; return { title: str(o.title) || str(o.text) || str(o.name), done: !!(o.done ?? o.completed) };
  }).filter((c) => c.title);
  if (checks.length) d.checks = checks.slice(0, 15);
  const links = (Array.isArray(t.links) ? t.links : []).map((l) => (typeof l === "string" ? l : str((l as T)?.url))).filter((u) => /^https?:\/\//.test(u));
  if (links.length) d.links = links.slice(0, 5);
  return d;
}

/** 今朝知らせるタスクを選ぶ（書かない・試験しやすいように中身だけ） */
export const OVERDUE_AT = "07:00";
/** 時刻を 30 分の枠にそろえる（"7:00"・"07:15" → "07:00"・形が違えば null） */
export function slotOf(v: unknown): string | null {
  const m = typeof v === "string" ? v.match(/^(\d{1,2}):(\d{2})$/) : null;
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return `${m[1].padStart(2, "0")}:${+m[2] < 30 ? "00" : "30"}`;
}
/** 日本時間の今の 30 分の枠 */
export function jstSlot(now = new Date()): string {
  const d = new Date(now.getTime() + 9 * 3600e3);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${d.getUTCMinutes() < 30 ? "00" : "30"}`;
}
export function pickReminders(startOn: T[], overdueOn: T[], today: string, slot: string = OVERDUE_AT): { starts: RemindRow[]; overdue: RemindRow[] } {
  const row = (t: T, day: string): RemindRow => ({ id: String(t.id ?? ""), title: String(t.title || "（題なし）"), day, late: diffDays(today, day), detail: detailOf(t) });
  const starts = startOn.filter(t => t.remindStart === true && open(t) && day10(t.startDate) === today && (slotOf(t.remindAt) || OVERDUE_AT) === slot).map(t => row(t, today));
  if (slot !== OVERDUE_AT) return { starts, overdue: [] };
  const overdue = overdueOn.filter(t => t.remindOverdue === true && open(t) && day10(t.deadline) && day10(t.deadline) < today)
    .map(t => row(t, day10(t.deadline))).sort((a, b) => b.late - a.late || a.title.localeCompare(b.title));
  return { starts, overdue };
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const link = (id: string) => `${TASKMASTER}/?task=${encodeURIComponent(id)}`;

/** 件名：1 件ならそのタスクの名前、2 件以上は先頭の名前＋ほか N 件（v1.95.0 Naoki「件名とか、本文に詳細載せたりできる？」） */
export function remindSubject(p: { starts: RemindRow[]; overdue: RemindRow[] }): string {
  const all = [...p.overdue.map((r) => ({ r, k: `期限切れ ${r.late} 日` })), ...p.starts.map((r) => ({ r, k: "今日から" }))];
  const head = all[0];
  return `【${head.k}】${head.r.title}${all.length > 1 ? ` ほか ${all.length - 1} 件` : ""}`;
}

function detailText(d: RemindDetail | undefined): string[] {
  if (!d) return [];
  const out: string[] = [];
  const when = [d.start && `着手 ${dayLabel(d.start)}`, d.deadline && `期限 ${dayLabel(d.deadline)}`].filter(Boolean).join("・");
  if (d.project || when) out.push([d.project && `プロジェクト：${d.project}`, when].filter(Boolean).join("　"));
  if (d.why) out.push(`なんのために：${d.why}`);
  if (d.doneWhen) out.push(`完了条件：${d.doneWhen}`);
  if (d.howto) out.push(`進め方：\n${d.howto}`);
  if (d.checks) out.push(`チェック（${d.checks.filter((c) => c.done).length}/${d.checks.length}）：\n${d.checks.map((c) => `${c.done ? "☑" : "☐"} ${c.title}`).join("\n")}`);
  if (d.notes) out.push(`メモ：\n${d.notes}`);
  if (d.links) out.push(`リンク：\n${d.links.join("\n")}`);
  return out;
}
const nl = (s: string) => esc(s).replace(/\n/g, "<br>");

export function buildRemindMail(p: { starts: RemindRow[]; overdue: RemindRow[] }, today: string): { subject: string; html: string; text: string } | null {
  if (!p.starts.length && !p.overdue.length) return null;
  const subject = remindSubject(p);
  const sec = (head: string, rows: RemindRow[], note: (r: RemindRow) => string) => rows.length ? { head, rows, note } : null;
  const secs = [
    sec("期限を過ぎたもの", p.overdue, r => `${dayLabel(r.day)}が期限・${r.late} 日過ぎ`),
    sec("今日から始めるもの", p.starts, () => "着手日が今日"),
  ].filter(Boolean) as { head: string; rows: RemindRow[]; note: (r: RemindRow) => string }[];
  const text = secs.map(s => `■ ${s.head}\n${s.rows.map(r => [`◆ ${r.title}（${s.note(r)}）`, ...detailText(r.detail), `開く：${link(r.id)}`].join("\n")).join("\n\n")}`).join("\n\n")
    + `\n\n止めるときは、タスクを済みにするか、日付の「リマインド」を外す。（${dayLabel(today)}）`;
  const html = `<div style="font-family:sans-serif;font-size:14px;line-height:1.7;color:#222">`
    + secs.map(s => `<p style="margin:16px 0 6px"><b>${esc(s.head)}</b></p>` + s.rows.map(r => `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px;margin:0 0 10px">`
      + `<div><a href="${link(r.id)}" style="font-weight:bold;font-size:15px">${esc(r.title)}</a> <span style="color:${s.head.startsWith("期限") ? "#b91c1c" : "#555"}">（${esc(s.note(r))}）</span></div>`
      + detailText(r.detail).map((line) => { const [h, ...rest] = line.split("：\n"); return rest.length ? `<div style="margin-top:6px"><span style="color:#666">${esc(h)}</span><br>${nl(rest.join("：\n"))}</div>` : `<div style="margin-top:4px;color:#444">${nl(line)}</div>`; }).join("")
      + `</div>`).join("")).join("")
    + `<p style="margin-top:20px;color:#666;font-size:12px">止めるときは、タスクを済みにするか、日付の「リマインド」を外す。</p></div>`;
  return { subject, html, text };
}

export async function runTaskRemind(env: Env, now = new Date()): Promise<{ sent: boolean; count: number; detail: string }> {
  const today = jstToday(now), slot = jstSlot(now);
  const token = await getFirestoreToken(env);
  const layout = await readLayout(token, env.NAOKI_UID);
  if (layout !== "v2") return { sent: false, count: 0, detail: `TaskMaster の置き場が ${layout} のため見なかった` };
  const [s, o] = await Promise.all([
    queryTasks(token, env.NAOKI_UID, "remindStart", toFVal(true)),
    slot === OVERDUE_AT ? queryTasks(token, env.NAOKI_UID, "remindOverdue", toFVal(true)) : Promise.resolve([] as T[]),
  ]);
  const p = pickReminders(s, o, today, slot);
  if (p.starts.length || p.overdue.length) {
    // 送るときだけ、プロジェクトの名前とテンプレの進め方を読み足す（読めなくても送る）
    const [pj, tpls] = await Promise.all([
      fsGetOrNull(token, `users/${env.NAOKI_UID}/app_data/projects`).then((d) => (d ? expandValue(d) : [])).catch(() => [] as T[]),
      readTemplates(token, env.NAOKI_UID).catch(() => [] as T[]),
    ]);
    const ctx = {
      projects: new Map(pj.map((x) => [String(x.id ?? ""), String(x.title || "")] as [string, string]).filter(([k, v]) => k && v)),
      howtoOf: new Map(tpls.map((x) => [String(x.id ?? ""), typeof x.howto === "string" ? x.howto.trim() : ""] as [string, string]).filter(([k, v]) => k && v)),
    };
    const byId = new Map([...s, ...o].map((t) => [String(t.id ?? ""), t]));
    for (const r of [...p.starts, ...p.overdue]) { const t = byId.get(r.id); if (t) r.detail = detailOf(t, ctx); }
  }
  const mail = buildRemindMail(p, today);
  if (!mail) return { sent: false, count: 0, detail: `${slot}：知らせるものが無いので送らなかった（スイッチ 着手 ${s.length}${slot === OVERDUE_AT ? `・期限 ${o.length}` : ""}）` };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.RESEND_FROM_EMAIL, to: [env.RESEND_TO_EMAIL], subject: mail.subject, html: mail.html, text: mail.text }),
  });
  if (!res.ok) throw new Error(`メールを送れませんでした（Resend ${res.status}：${(await res.text().catch(() => "")).slice(0, 200)}）`);
  return { sent: true, count: p.starts.length + p.overdue.length, detail: `${slot}：着手 ${p.starts.length}・期限切れ ${p.overdue.length} を送った` };
}

