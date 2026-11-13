/**
 * shia2n-mcp / src/seminar-tasks.ts / 新設（2026-11-13 開発部・セミナー管理の流れ 便2）
 *
 * コンテンツくんの「セミナー」の回（1 回＝1 行・開催日時は posts.datetime）から、
 * TaskMaster に「構成・告知・スライド」の 3 つのタスクを入れ、開催日が動いたら期限もついていかせる。
 * 作る前の 1 枚に Naoki OK（2026-11-13 19:02）。正本はコンテンツくん。TaskMaster はその写し。
 *
 * 決まり
 *   ・見るのは、今日から 60 日先までに開催日がある「セミナー」の回だけ（ゴミ箱・アーカイブは見ない）
 *   ・期限は開催日から数える：構成＝3 日前・告知＝2 日前・スライド＝前日（STEPS の 1 か所で決める）
 *   ・入れる先は TaskMaster のプロジェクト「シアラボ｜運営」。タスクにはコンテンツくんの回へのリンクを付ける
 *   ・開催日が動いたら期限を写す。ただし、Naoki が TaskMaster で期限を動かしたタスク（前に写した日と違う）は触らない
 *   ・済み・アーカイブのタスクは触らない。TaskMaster で消したタスクは作り直さない（消したのは Naoki の判断のため）
 *   ・回を消しても、開催日を外しても、タスクは消さない（消すのは Naoki）
 *   ・どのタスクを入れたかは KV の 1 か所（seminar_tasks_v1）に持つ。タスクは id で読むだけ（全部は読まない・Firestore の無料枠を守るため）
 */
import type { Env } from "./index.js";
import { getFirestoreToken, handleTaskmasterAddTask, handleTaskmasterUpdateTask } from "./taskmaster.js";
import { readTasksById, type TaskNow } from "./taskmaster-by-id.js";

export const STORE_KEY = "seminar_tasks_v1";
export const SHIARABO_UNEI_PROJECT = "63d412a7-3647-4a56-88d7-0db9d95f60c0"; // TaskMaster「シアラボ｜運営」
export const CONTENT_OS = "https://content-os.shia2n.jp";
export const LOOK_AHEAD_DAYS = 60;
/** 開催日から何日前を期限にするか（並びは期限の早い順） */
export const STEPS = [
  { step: "構成", before: 3 },
  { step: "告知", before: 2 },
  { step: "スライド", before: 1 },
] as const;
export type Step = (typeof STEPS)[number]["step"];

export type Mark = { taskId: string; deadline: string; gone?: boolean };
export type Store = { v: 1; posts: Record<string, Partial<Record<Step, Mark>>> };
export type SeminarPost = { id: string; title: string; date: string };

/** 日本時間の今日（YYYY-MM-DD） */
export function jstToday(now = new Date()): string {
  return new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
}
/** YYYY-MM-DD に日を足す */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function parseStore(v: unknown): Store {
  if (v == null) return { v: 1, posts: {} };
  if (typeof v !== "object" || (v as Store).v !== 1 || typeof (v as Store).posts !== "object" || !(v as Store).posts) {
    throw new Error(STORE_KEY + " の形が読めません。止めました");
  }
  return v as Store;
}
/** 回の題（日付つきの題でもそのまま）から、タスクの名前を作る */
export function taskTitle(step: Step, title: string): string {
  return `セミナー｜${step}｜${(title || "（題なし）").trim().slice(0, 120)}`;
}

export type Add = { postId: string; step: Step; title: string; deadline: string; url: string };
export type Move = { postId: string; step: Step; taskId: string; from: string; to: string };
export type Plan = { adds: Add[]; moves: Move[] };

/** 何を入れて何を動かすかを決める（書かない・試験しやすいように中身だけ） */
export function planSeminarTasks(posts: SeminarPost[], store: Store): Plan {
  const adds: Add[] = [], moves: Move[] = [];
  for (const p of posts) {
    const have = store.posts[p.id] || {};
    for (const s of STEPS) {
      const deadline = addDays(p.date, -s.before);
      const m = have[s.step];
      if (!m) adds.push({ postId: p.id, step: s.step, title: taskTitle(s.step, p.title), deadline, url: `${CONTENT_OS}/?post=${encodeURIComponent(p.id)}` });
      else if (!m.gone && m.deadline !== deadline) moves.push({ postId: p.id, step: s.step, taskId: m.taskId, from: m.deadline, to: deadline });
    }
  }
  return { adds, moves };
}

export type MoveDecision = "move" | "naoki" | "closed" | "gone";
/** 動かしてよいかを、タスクの今から決める */
export function decideMove(m: Move, now: TaskNow | undefined): MoveDecision {
  if (!now || !now.exists) return "gone";
  if (now.completed || now.archived) return "closed";
  const cur = typeof now.deadline === "string" ? now.deadline.slice(0, 10) : "";
  return cur === m.from ? "move" : "naoki";
}

// ── 読み書き ──
function sbHeaders(env: Env) {
  const k = env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: k, ...(/^eyJ/.test(String(k || "")) ? { Authorization: `Bearer ${k}` } : {}) };
}
/** そのアカウントの種類のうち、名前が「セミナー」のものの鍵（コンテンツくんの ext/ideas と同じ探し方） */
export function seminarKeys(accounts: { custom_post_types?: unknown }[]): string[] {
  const out: string[] = [];
  for (const a of accounts) for (const c of Array.isArray(a.custom_post_types) ? a.custom_post_types : []) {
    if (c && typeof c.key === "string" && String(c.label || "").trim() === "セミナー") out.push(c.key);
  }
  return [...new Set(out)];
}
async function readSeminarPosts(env: Env, today: string): Promise<SeminarPost[]> {
  const uid = encodeURIComponent(env.NAOKI_UID);
  const ra = await fetch(`${env.SUPABASE_URL}/rest/v1/accounts?select=custom_post_types&user_id=eq.${uid}`, { headers: sbHeaders(env) });
  if (!ra.ok) throw new Error(`コンテンツくんのアカウントを読めませんでした（${ra.status}）`);
  const keys = seminarKeys(await ra.json());
  if (!keys.length) return [];
  const inList = keys.map(k => `"${k.replace(/"/g, "")}"`).join(",");
  const until = addDays(today, LOOK_AHEAD_DAYS);
  const q = `select=id,title,datetime,labels&user_id=eq.${uid}&post_type=in.(${encodeURIComponent(inList)})&datetime=gte.${today}&datetime=lt.${until}`;
  const rp = await fetch(`${env.SUPABASE_URL}/rest/v1/posts?${q}`, { headers: sbHeaders(env) });
  if (!rp.ok) throw new Error(`セミナーの回を読めませんでした（${rp.status}）`);
  const rows = await rp.json() as { id: number | string; title: string | null; datetime: string | null; labels: string[] | null }[];
  return rows
    .filter(r => !(r.labels || []).some(l => l === "ゴミ箱" || l === "アーカイブ"))
    .filter(r => typeof r.datetime === "string" && /^\d{4}-\d{2}-\d{2}/.test(r.datetime))
    .map(r => ({ id: String(r.id), title: r.title || "", date: (r.datetime as string).slice(0, 10) }));
}

const fakeReq = (body: unknown) => new Request("https://shia2n-mcp.internal/", { method: "POST", body: JSON.stringify(body) });

export type RunResult = { posts: number; added: number; moved: number; naoki: number; closed: number; gone: number; failed: number };

export async function runSeminarTasks(env: Env, now = new Date()): Promise<RunResult> {
  const today = jstToday(now);
  const store = parseStore(await env.OAUTH_KV.get(STORE_KEY, "json"));
  const posts = await readSeminarPosts(env, today);
  const plan = planSeminarTasks(posts, store);
  const r: RunResult = { posts: posts.length, added: 0, moved: 0, naoki: 0, closed: 0, gone: 0, failed: 0 };
  if (!plan.adds.length && !plan.moves.length) return r;

  const put = (postId: string, step: Step, m: Mark) => { (store.posts[postId] ||= {})[step] = m; };
  try {
    for (const a of plan.adds) {
      const res = await handleTaskmasterAddTask(fakeReq({
        title: a.title, deadline: a.deadline, projectId: SHIARABO_UNEI_PROJECT, priority: "high",
        links: [{ title: "コンテンツくんのセミナーの回", url: a.url }],
      }), env);
      const j = await res.json().catch(() => ({})) as { ok?: boolean; task?: { id?: string } };
      if (res.ok && j.ok && j.task?.id) { put(a.postId, a.step, { taskId: j.task.id, deadline: a.deadline }); r.added++; }
      else r.failed++;
    }
    if (plan.moves.length) {
      const token = await getFirestoreToken(env);
      const nowById = await readTasksById({ token, uid: env.NAOKI_UID }, plan.moves.map(m => m.taskId));
      for (const m of plan.moves) {
        const d = decideMove(m, nowById.get(m.taskId));
        if (d === "move") {
          const res = await handleTaskmasterUpdateTask(fakeReq({ task_id: m.taskId, deadline: m.to }), env);
          if (res.ok) { put(m.postId, m.step, { taskId: m.taskId, deadline: m.to }); r.moved++; } else r.failed++;
        } else if (d === "gone") { put(m.postId, m.step, { taskId: m.taskId, deadline: m.from, gone: true }); r.gone++; }
        else if (d === "naoki") r.naoki++;
        else r.closed++;
      }
    }
  } finally {
    // 途中で止まっても、入れた分は覚えておく（次の回に 2 本目を作らないため）
    await env.OAUTH_KV.put(STORE_KEY, JSON.stringify(store));
  }
  return r;
}

export function describe(r: RunResult): string {
  return `回 ${r.posts}・入れた ${r.added}・期限を写した ${r.moved}・Naoki の日なので写さなかった ${r.naoki}・済みで見送り ${r.closed}・消されていた ${r.gone}・失敗 ${r.failed}`;
}

// ── 便3（2026-11-13）：日曜 20:00（日本時間）に、今週と来週のセミナーの回の「作るものと期限」を 1 通 ──
// 回が 1 つも無い週は送らない（記録は「送らなかった」で残す）。済みかどうかは TaskMaster のタスクを id で読んで出す
export const MAIL_DAYS = 14;
export type MailLine = { step: Step; deadline: string; done: boolean | null };
export type MailRow = { id: string; title: string; date: string; lines: MailLine[] };

const WD = ["日", "月", "火", "水", "木", "金", "土"];
export function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WD[d.getUTCDay()]}）`;
}
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

/** メールの中身（書かない・試験しやすいように中身だけ）。回が無ければ null */
export function buildSeminarMail(posts: SeminarPost[], store: Store, nowById: Map<string, TaskNow>, today: string): { subject: string; html: string; text: string } | null {
  const until = addDays(today, MAIL_DAYS);
  const rows: MailRow[] = posts.filter(p => p.date >= today && p.date < until).sort((a, b) => a.date.localeCompare(b.date)).map(p => ({
    id: p.id, title: p.title, date: p.date,
    lines: STEPS.map(s => {
      const m = store.posts[p.id]?.[s.step];
      const t = m && !m.gone ? nowById.get(m.taskId) : undefined;
      const dl = t && typeof t.deadline === "string" && t.deadline ? t.deadline.slice(0, 10) : (m?.deadline || addDays(p.date, -s.before));
      return { step: s.step, deadline: dl, done: t ? (t.completed === true) : null };
    }),
  }));
  if (!rows.length) return null;
  const mark = (l: MailLine) => l.done === true ? "済み" : l.done === false ? (l.deadline < today ? "期限切れ" : "まだ") : "TaskMaster に無い";
  const subject = `セミナーの段取り：${dayLabel(rows[0].date)}から ${rows.length} 回`;
  const text = rows.map(r => `■ ${dayLabel(r.date)} ${r.title || "（題なし）"}\n${r.lines.map(l => `  ${l.step}：${dayLabel(l.deadline)}まで（${mark(l)}）`).join("\n")}\n  ${CONTENT_OS}/?post=${r.id}`).join("\n\n")
    + "\n\n日付を変えるときは、コンテンツくんの回の開催日を直す（TaskMaster の期限は次の 0 分についていく）。";
  const html = `<div style="font-family:sans-serif;font-size:14px;line-height:1.7;color:#222">`
    + rows.map(r => `<p style="margin:16px 0 4px"><b>${esc(dayLabel(r.date))} ${esc(r.title || "（題なし）")}</b> ・ <a href="${CONTENT_OS}/?post=${encodeURIComponent(r.id)}">コンテンツくんで開く</a></p>`
      + `<table style="border-collapse:collapse">${r.lines.map(l => `<tr><td style="padding:2px 12px 2px 0">${esc(l.step)}</td><td style="padding:2px 12px 2px 0">${esc(dayLabel(l.deadline))}まで</td><td style="padding:2px 0;color:${l.done === true ? "#047857" : l.deadline < today ? "#b91c1c" : "#555"}">${esc(mark(l))}</td></tr>`).join("")}</table>`).join("")
    + `<p style="margin-top:20px;color:#666;font-size:12px">日付を変えるときは、コンテンツくんの回の開催日を直す（TaskMaster の期限は次の 0 分についていく）。</p></div>`;
  return { subject, html, text };
}

/** 日曜 20:00 の 1 通。送らなかったときは理由の文を返す */
export async function runSeminarMail(env: Env, now = new Date()): Promise<{ sent: boolean; rows: number; detail: string }> {
  const today = jstToday(now);
  const store = parseStore(await env.OAUTH_KV.get(STORE_KEY, "json"));
  const posts = (await readSeminarPosts(env, today)).filter(p => p.date < addDays(today, MAIL_DAYS));
  if (!posts.length) return { sent: false, rows: 0, detail: "今週と来週のセミナーの回が無いので送らなかった" };
  const ids = posts.flatMap(p => STEPS.map(s => store.posts[p.id]?.[s.step]).filter((m): m is Mark => !!m && !m.gone).map(m => m.taskId));
  const nowById = ids.length ? await readTasksById({ token: await getFirestoreToken(env), uid: env.NAOKI_UID }, ids) : new Map<string, TaskNow>();
  const mail = buildSeminarMail(posts, store, nowById, today);
  if (!mail) return { sent: false, rows: 0, detail: "今週と来週のセミナーの回が無いので送らなかった" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.RESEND_FROM_EMAIL, to: [env.RESEND_TO_EMAIL], subject: mail.subject, html: mail.html, text: mail.text }),
  });
  if (!res.ok) throw new Error(`メールを送れませんでした（Resend ${res.status}：${(await res.text().catch(() => "")).slice(0, 200)}）`);
  return { sent: true, rows: posts.length, detail: `${posts.length} 回の段取りを送った` };
}
