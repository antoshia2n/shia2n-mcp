/**
 * note攻略くんのレポートに、haAku の「メンシプ在籍数」を月ごとに出す受け口（2026-10-26 v1.53.0 開発部・note攻略くん 4便目）。
 * Naoki「レポートの残り（haAku の在籍数）」→ 在籍数の正本は haAku。note攻略くんは読むだけで、同じ数を 2 か所に書かない。
 *
 *   GET /notekoryaku/members … 今年と去年の、月ごとの在籍数（その月の最新の値・haAku の「最新」の集計と同じ）と、KPI の目標・KGI の目標
 *
 * 守り方は TaskMaster へ送る口（xkoryaku-task-http.ts）と同じ
 *   ・呼べるのは note攻略くんの住所（https://note-koryaku.shia2n.jp）から開いた画面だけ
 *   ・Firebase のログインの札を確かめ、Naoki 本人（NAOKI_UID）のときだけ読む
 *   ・読むだけ。haAku には書かない
 *   ・読めなかったときは空で返さず、理由の文を返す（0 名と読めなかったを取り違えない）
 */
import type { Env } from "./index.js";
import { verifyIdToken } from "./gate.js";
import { fromVal, fsGet, getFirestoreToken, type FVal } from "./taskmaster.js";

export const NOTEKORYAKU_ORIGIN = "https://note-koryaku.shia2n.jp";
export const NOTEKORYAKU_MEMBERS_PATH = "/notekoryaku/members";

const headers = { "Access-Control-Allow-Origin": NOTEKORYAKU_ORIGIN, "Vary": "Origin", "Cache-Control": "no-store" };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers });

type Kpi = { id?: unknown; title?: unknown; unit?: unknown; monthlyTarget?: unknown; kgiId?: unknown };
type Kgi = { id?: unknown; title?: unknown; target?: unknown; unit?: unknown };
type Daily = Record<string, { kpiValues?: Record<string, unknown> }>;

/** haAku の KPI から「メンシプ在籍数」を探す（題に「メンシプ」と「在籍」の両方が入るもの・最初の 1 つ） */
export function findMembersKpi(kpis: Kpi[]): Kpi | null {
  return kpis.find(k => typeof k?.title === "string" && k.title.includes("メンシプ") && k.title.includes("在籍")) || null;
}

/** 日ごとの記録から、月ごとの最新の値（0 と空は数えない）。haAku の aggregation: "latest" と同じ数え方 */
export function monthlyLatest(daily: Daily, kpiId: string): Record<string, number> {
  const best: Record<string, [string, number]> = {};
  for (const [date, rec] of Object.entries(daily || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const v = rec?.kpiValues?.[kpiId];
    if (typeof v !== "number" || !Number.isFinite(v) || v === 0) continue;
    const m = date.slice(0, 7);
    if (!best[m] || date > best[m][0]) best[m] = [date, v];
  }
  return Object.fromEntries(Object.entries(best).sort(([a], [b]) => (a < b ? -1 : 1)).map(([m, [, v]]) => [m, v]));
}

// 文書が無い（404）＝空。ほかの失敗は投げる（空と取り違えない）
async function readValue(token: string, path: string): Promise<unknown> {
  try {
    const doc = await fsGet(token, path);
    const f = doc.fields ?? {};
    return "value" in f ? fromVal(f["value"] as FVal) : null;
  } catch (e) {
    if (String((e as Error)?.message ?? e).includes("404")) return null;
    throw e;
  }
}

const jstYear = () => Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric" }).format(new Date()));

export async function handleNotekoryakuMembers(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Origin") !== NOTEKORYAKU_ORIGIN) return Response.json({ error: "origin_not_allowed" }, { status: 403 });
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...headers,
      "Access-Control-Allow-Methods": "GET,OPTIONS", "Access-Control-Allow-Headers": "Authorization", "Access-Control-Max-Age": "300" } });
  }
  if (request.method !== "GET") return reply({ error: "method_not_allowed" }, 405);

  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return reply({ error: "missing_firebase_token", message: "ログインの札がありません。開き直してください" }, 401);
  let identity;
  try { identity = await verifyIdToken(auth.slice(7)); }
  catch { return reply({ error: "firebase_auth_failed", message: "ログインを確かめられませんでした。少しおいてもう一度" }, 503); }
  if (!identity || !env.NAOKI_UID || identity.uid !== env.NAOKI_UID) {
    return reply({ error: "not_authorized_owner", message: "Naoki 本人のログインではありません" }, 403);
  }
  if (!env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) return reply({ error: "env_not_configured", message: "haAku へつなぐ設定がありません" }, 500);

  try {
    const token = await getFirestoreToken(env), uid = env.NAOKI_UID, y = jstYear();
    const [kpis, kgis, dNow, dPrev] = await Promise.all([
      readValue(token, `users/${uid}/app_data/os_kpis`), readValue(token, `users/${uid}/app_data/os_kgis`),
      readValue(token, `users/${uid}/app_data/os_daily_${y}`), readValue(token, `users/${uid}/app_data/os_daily_${y - 1}`),
    ]);
    const kpi = findMembersKpi(Array.isArray(kpis) ? (kpis as Kpi[]) : []);
    if (!kpi || typeof kpi.id !== "string") return reply({ error: "kpi_not_found", message: "haAku に「メンシプ在籍数」の KPI が見つかりません" }, 404);
    const kgi = (Array.isArray(kgis) ? (kgis as Kgi[]) : []).find(g => g && g.id === kpi.kgiId) || null;
    const months = { ...monthlyLatest((dPrev || {}) as Daily, kpi.id), ...monthlyLatest((dNow || {}) as Daily, kpi.id) };
    return reply({ ok: true,
      kpi: { title: String(kpi.title), unit: String(kpi.unit ?? ""), target: Number(kpi.monthlyTarget) || 0 },
      kgi: kgi ? { title: String(kgi.title ?? ""), target: Number(kgi.target) || 0, unit: String(kgi.unit ?? "") } : null,
      months });
  } catch (error) {
    // 中身（Firestore の札など）は出さない。理由の文だけ返す
    return reply({ error: "notekoryaku_members_failed", message: "haAku を読めませんでした。少しおいてもう一度" }, 502);
  }
}
