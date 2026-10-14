/**
 * shia2n-mcp / src/haaku-task-link-http.ts / 新設（2026-10-14 v1.17.0 開発部）
 *
 * TaskMaster の画面から、タスクを haAku のマイルストーンに結ぶ受け口。
 * 依頼：https://www.notion.so/3f99c6c1c43981a3898fdd4d436535fa
 *
 *   GET  /haaku/task-links … 選び欄に出すもの（結び・マイルストーン・取り組みとプロジェクトの組）。読むのは 3 文書だけ
 *   POST /haaku/task-links … { task_id, milestone_id | null } を 1 件。道具 haAku__link_tasks と同じ 1 本（linkAndCopyDeadlines）を通す
 *                            （1 タスク 0〜1 個・付け替えと外しも記録・続けて期限と着手日を写す）。記録の行には by: "taskmaster" が付く
 *
 * 守り方は haAku の承認の受け口（haaku-human-approval.ts）と同じ
 *   ・呼べるのは TaskMaster の住所（https://taskmaster.shia2n.jp）から開いた画面だけ
 *   ・Firebase のログインの札（ID トークン）を確かめ、Naoki 本人（NAOKI_UID）のときだけ読む・書く
 *   ・失敗は黙らずに理由を返す（画面は選び欄の下にそのまま出す）
 */
import type { Env } from "./index.js";
import { verifyIdToken } from "./gate.js";
import { ctxOf, linkAndCopyDeadlines } from "./tools-haaku-home.js";
import { readLinkOptions } from "./haaku-home-store.js";

export const TASKMASTER_ORIGIN = "https://taskmaster.shia2n.jp";
export const TASK_LINKS_PATH = "/haaku/task-links";

const headers = {
  "Access-Control-Allow-Origin": TASKMASTER_ORIGIN, "Vary": "Origin", "Cache-Control": "no-store",
};
const response = (body: unknown, status = 200) => Response.json(body, { status, headers });

/** POST の中身を確かめる。task_id と milestone_id の 2 つだけ（ほかの欄は断る） */
export function parseLinkBody(raw: string): { taskId: string; milestoneId: string | null } {
  if (raw.length > 1024) throw new Error("body_too_large");
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new Error("invalid_json"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid_body");
  const d = data as Record<string, unknown>;
  const keys = Object.keys(d).sort().join(",");
  if (keys !== "milestone_id,task_id") throw new Error("invalid_body");
  if (typeof d.task_id !== "string" || !d.task_id) throw new Error("invalid_task_id");
  if (d.milestone_id !== null && (typeof d.milestone_id !== "string" || !d.milestone_id)) throw new Error("invalid_milestone_id");
  return { taskId: d.task_id, milestoneId: d.milestone_id as string | null };
}

export async function handleHaakuTaskLinks(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Origin") !== TASKMASTER_ORIGIN) return Response.json({ error: "origin_not_allowed" }, { status: 403 });
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...headers,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Authorization,Content-Type",
      "Access-Control-Max-Age": "300" } });
  }
  if (!["GET", "POST"].includes(request.method)) return response({ error: "method_not_allowed" }, 405);

  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return response({ error: "missing_firebase_token", message: "ログインの札がありません。開き直してください" }, 401);
  let identity;
  try { identity = await verifyIdToken(auth.slice(7)); }
  catch { return response({ error: "firebase_auth_failed", message: "ログインを確かめられませんでした。少しおいてもう一度" }, 503); }
  if (!identity || !env.NAOKI_UID || identity.uid !== env.NAOKI_UID) {
    return response({ error: "not_authorized_owner", message: "Naoki 本人のログインではありません" }, 403);
  }

  try {
    if (request.method === "GET") return response(await readLinkOptions(await ctxOf(env)));
    if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json") return response({ error: "content_type_required" }, 415);
    let change;
    try { change = parseLinkBody(await request.text()); }
    catch (e) { return response({ error: (e as Error).message, message: "送った中身の形が違います" }, 400); }
    const r = await linkAndCopyDeadlines(env, [change], "taskmaster");
    return response({ ok: true, result: r.results[0], links_total: r.links_total, history_total: r.history_total, deadlines: r.deadlines });
  } catch (error) {
    // 中身（Firestore の札など）は出さない。理由の文だけ返す
    return response({ error: "task_link_failed", message: String((error as Error).message || "結べませんでした") }, 409);
  }
}
