/**
 * X攻略くんの画面から TaskMaster へタスクを送る受け口（2026-10-26 v1.50.0 開発部・X攻略くん 4便目）。
 * Naoki「戦略と計画から、タスクマスター連携でタスクに落とし込む」→ 週の計画 1 件から「タスクにする」で TaskMaster に入れる。
 *
 *   GET  /xkoryaku/tasks?ids=a,b … 送り先に選べるプロジェクト（active だけ）と、名指しのタスクの今（済み・廃案・消えた）
 *                                   タスクは id で読むだけ（全部は読まない・Firestore の無料枠を守るため）
 *   POST /xkoryaku/tasks         … { title, projectId, deadline } を 1 件。taskmaster__add_task と同じ 1 本（handleTaskmasterAddTask）を通す
 *
 * 守り方は TaskMaster の受け口（haaku-task-link-http.ts）・案件くんの受け口（anken-sheet-http.ts）と同じ
 *   ・呼べるのは X攻略くんの住所（https://x-koryaku.shia2n.jp）から開いた画面だけ
 *   ・Firebase のログインの札を確かめ、Naoki 本人（NAOKI_UID）のときだけ読む・書く
 *   ・失敗は黙らずに理由の文を返す（画面はそのまま出す）
 */
import type { Env } from "./index.js";
import { verifyIdToken } from "./gate.js";
import { expandValue, fsGet, getFirestoreToken, handleTaskmasterAddTask, readLayout } from "./taskmaster.js";
import { readTasksById } from "./taskmaster-by-id.js";

export const XKORYAKU_ORIGIN = "https://x-koryaku.shia2n.jp";
export const XKORYAKU_TASKS_PATH = "/xkoryaku/tasks";

const headers = { "Access-Control-Allow-Origin": XKORYAKU_ORIGIN, "Vary": "Origin", "Cache-Control": "no-store" };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers });

export type SendBody = { title: string; projectId: string | null; deadline: string | null };

/** POST の中身を確かめる。title・projectId・deadline の 3 つだけ（ほかの欄は断る） */
export function parseSendBody(raw: string): SendBody {
  if (raw.length > 2048) throw new Error("body_too_large");
  let d: unknown;
  try { d = JSON.parse(raw); } catch { throw new Error("invalid_json"); }
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error("invalid_body");
  const o = d as Record<string, unknown>;
  if (Object.keys(o).some(k => !["title", "projectId", "deadline"].includes(k))) throw new Error("invalid_body");
  const title = typeof o.title === "string" ? o.title.trim() : "";
  if (!title || title.length > 300) throw new Error("invalid_title");
  const projectId = o.projectId ?? null;
  if (projectId !== null && (typeof projectId !== "string" || !projectId || projectId.length > 100)) throw new Error("invalid_project");
  const deadline = o.deadline ?? null;
  if (deadline !== null && (typeof deadline !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(deadline))) throw new Error("invalid_deadline");
  return { title, projectId: projectId as string | null, deadline: deadline as string | null };
}

/** ?ids= を読む（空・重複は落とす・50 件まで） */
export function parseIds(q: string | null): string[] {
  const ids = [...new Set((q || "").split(",").map(s => s.trim()).filter(s => s && s.length <= 100))];
  if (ids.length > 50) throw new Error("too_many_ids");
  return ids;
}

const MESSAGES: Record<string, string> = {
  body_too_large: "送った中身が大きすぎます", invalid_json: "送った中身の形が違います", invalid_body: "送った中身の形が違います",
  invalid_title: "タスクの題が空か、長すぎます", invalid_project: "プロジェクトの指定が違います", invalid_deadline: "期限の形が違います（年-月-日）",
  too_many_ids: "一度に見られるタスクは 50 件までです", unknown_project: "TaskMaster に無いか、動いていないプロジェクトです",
};

type Proj = { id: string; title: string };
async function activeProjects(env: Env, token: string): Promise<Proj[]> {
  const doc = await fsGet(token, `users/${env.NAOKI_UID}/app_data/projects`);
  return expandValue(doc)
    .filter(p => p && p.status === "active" && !p.archived)
    .map(p => ({ id: String(p.id ?? ""), title: String(p.title ?? "") }))
    .filter(p => p.id);
}

export async function handleXkoryakuTasks(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Origin") !== XKORYAKU_ORIGIN) return Response.json({ error: "origin_not_allowed" }, { status: 403 });
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...headers,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Authorization,Content-Type", "Access-Control-Max-Age": "300" } });
  }
  if (!["GET", "POST"].includes(request.method)) return reply({ error: "method_not_allowed" }, 405);

  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return reply({ error: "missing_firebase_token", message: "ログインの札がありません。開き直してください" }, 401);
  let identity;
  try { identity = await verifyIdToken(auth.slice(7)); }
  catch { return reply({ error: "firebase_auth_failed", message: "ログインを確かめられませんでした。少しおいてもう一度" }, 503); }
  if (!identity || !env.NAOKI_UID || identity.uid !== env.NAOKI_UID) {
    return reply({ error: "not_authorized_owner", message: "Naoki 本人のログインではありません" }, 403);
  }
  if (!env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) return reply({ error: "env_not_configured", message: "TaskMaster へつなぐ設定がありません" }, 500);

  try {
    const token = await getFirestoreToken(env);
    if (request.method === "GET") {
      let ids: string[];
      try { ids = parseIds(new URL(request.url).searchParams.get("ids")); }
      catch (e) { const m = (e as Error).message; return reply({ error: m, message: MESSAGES[m] || m }, 400); }
      const projects = await activeProjects(env, token);
      const tasks: Record<string, { exists: boolean; completed: boolean; archived: boolean }> = {};
      // 1 本ずつの置き場（v2）のときだけ id で読める。前の形のときは「わからない」として返さない
      if (ids.length && (await readLayout(token, env.NAOKI_UID)) === "v2") {
        const now = await readTasksById({ token, uid: env.NAOKI_UID }, ids);
        for (const [id, t] of now) tasks[id] = { exists: t.exists, completed: t.completed, archived: t.archived };
      }
      return reply({ ok: true, projects, tasks });
    }

    if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json") return reply({ error: "content_type_required" }, 415);
    let body: SendBody;
    try { body = parseSendBody(await request.text()); }
    catch (e) { const m = (e as Error).message; return reply({ error: m, message: MESSAGES[m] || m }, 400); }
    if (body.projectId && !(await activeProjects(env, token)).some(p => p.id === body.projectId)) {
      return reply({ error: "unknown_project", message: MESSAGES.unknown_project }, 400);
    }
    // taskmaster__add_task と同じ 1 本を通す（新しいタスクの形・置き場の見分け・移している途中の断りが同じになる）
    const res = await handleTaskmasterAddTask(new Request("https://internal/taskmaster/tasks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: body.title, projectId: body.projectId, deadline: body.deadline }),
    }), env);
    const out = (await res.json()) as { ok?: boolean; task?: unknown; error?: string };
    if (!res.ok || !out.ok) return reply({ error: "add_failed", message: out.error || "TaskMaster に入れられませんでした" }, res.status === 503 ? 503 : 409);
    return reply({ ok: true, task: out.task }, 201);
  } catch (error) {
    // 中身（Firestore の札など）は出さない。理由の文だけ返す
    return reply({ error: "xkoryaku_tasks_failed", message: String((error as Error).message || "TaskMaster とつなげませんでした") }, 409);
  }
}
