import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { KINDS, LAYERS, METRICS, type Row, actsSummary, goalsFor, inMonth, layerName, layersOf, mergeMetrics, pickWeek, weekDays } from "./xbunseki-core.js";

/**
 * X分析くん（x-koryaku.shia2n.jp・Naoki の X の定点観測）の道具。
 * Supabase の xa_weeks・xa_obs・xa_accounts・xa_items を直接見る（思考整理くんの道具と同じ形）。
 * 命名規約：xbunseki__<action>
 *
 * 2026-10-23 新設（開発部・Naoki「残りを進めておこう」18:51）。画面の右上「AI の使い方」の 1・2・4・5 のための口。
 *   ・分析は Naoki が手で書く。Claude は読むことと、自分の数字（アナリティクスのスクショ）を写すことだけ
 *   ・書くのは xbunseki__put_metrics の 1 本だけ。渡した欄だけを足し、層・分析結果・仮説には書かない
 *   ・読むのは Naoki の行だけ（user_id で絞る）
 */

const APP_URL = "https://x-koryaku.shia2n.jp";
/** 画面に入る 1 人（思考整理くんと同じ Firebase の印。秘密ではない）。表に 1 人しかいないときはその人を使う */
const OWNER_FALLBACK = "VrMwzeSceqWeXVQOrm8kpu4uVR33";

function sbHeaders(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    ...(/^eyJ/.test(String(env.SUPABASE_SERVICE_ROLE_KEY || "")) ? { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } : {}),
    "Content-Type": "application/json",
    ...extra,
  };
}
async function sbGet(env: Env, path: string): Promise<Row[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, { headers: sbHeaders(env) });
  if (!res.ok) throw new Error(`Supabase error ${res.status}: ${await res.text()}`);
  return (await res.json()) as Row[];
}
async function sbPatch(env: Env, path: string, body: Row): Promise<Row[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, { method: "PATCH", headers: sbHeaders(env, { Prefer: "return=representation" }), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Supabase error ${res.status}: ${await res.text()}`);
  return (await res.json()) as Row[];
}

async function ownerOf(env: Env): Promise<string> {
  const rows = await sbGet(env, `/xa_weeks?select=user_id&limit=200`);
  const ids = [...new Set(rows.map(r => r.user_id).filter(Boolean))];
  return ids.length === 1 ? String(ids[0]) : OWNER_FALLBACK;
}
async function loadBase(env: Env) {
  const uid = await ownerOf(env); const own = `user_id=eq.${encodeURIComponent(uid)}`;
  const [weeks, accounts] = await Promise.all([
    sbGet(env, `/xa_weeks?select=*&${own}&order=sort.desc`),
    sbGet(env, `/xa_accounts?select=*&${own}&order=sort.asc`),
  ]);
  return { uid, own, weeks, accounts };
}
const accName = (accounts: Row[], h: string) => accounts.find(a => a.handle === h)?.name || h;
const metricsOut = (m: Row | null | undefined) => Object.fromEntries(Object.entries(METRICS).filter(([k]) => m && m[k] != null).map(([k, l]) => [l, m![k]]));
const itemOut = (i: Row) => ({ id: i.id, 層: layerName(i.layer), 段: KINDS[i.kind] || i.kind, 中身: i.body, いつから: i.from_month, アーカイブ: !!i.archived, ...(i.archived_why ? { やめた理由: i.archived_why } : {}) });

export function registerXbunsekiTools(server: McpServer, env: Env): void {

  // ─── 1. xbunseki__list_weeks ─────────────────────────────────────
  server.tool(
    "xbunseki__list_weeks",
    "X分析くんの回（週）の一覧を新しい順で返す。各回の方針・全体の仮説の有無・書いた相手の数・自分の数字。1 回の中身は xbunseki__get_week で読む。戻り値: { ok, 件数, 一覧: [{ id, 週, 月, 方針, 全体の仮説, 書いた相手, 自分の数字 }] }。",
    { limit: z.number().int().min(1).max(60).optional().describe("何回分まで（省略時 12）") },
    async ({ limit }) => {
      try {
        const { own, weeks } = await loadBase(env);
        const obs = await sbGet(env, `/xa_obs?select=week_id&${own}`);
        const n = new Map<string, number>(); obs.forEach(o => n.set(o.week_id, (n.get(o.week_id) || 0) + 1));
        const list = weeks.slice(0, limit ?? 12);
        return asMcpTextResult({ ok: true, 件数: weeks.length, 一覧: list.map(w => ({ id: w.id, 週: w.label, 月: w.month, 方針: w.policy || "", 全体の仮説: (w.overall || "").trim() ? "あり" : "なし", 書いた相手: n.get(w.id) || 0, 自分の数字: metricsOut(w.metrics) })), 住所: APP_URL });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 2. xbunseki__get_week ───────────────────────────────────────
  server.tool(
    "xbunseki__get_week",
    "X分析くんの 1 回（週）の中身を返す：方針・タイムラインの気づき・全体の仮説・自分の数字・行動（X分析くんパネルで押した他人の引用・セルフ引用・リプの数と 1 日の目標・達成・日ごと・相手ごと）・相手ごとの評価と 5 つの層（アカウントの目的・意図／運用のスタイル／運用の内容／投稿のスタイル／投稿の内容）と分析結果・生かすなら・この回に足した仮説。週は「10月4週」「2026-10 10月4週」「今週」か id。省略でいちばん新しい回。全体の仮説に問いを返す・生徒向けに言い回しを整えるときの材料。",
    { week: z.string().max(40).optional().describe("「10月4週」「今週」など。省略でいちばん新しい回") },
    async ({ week }) => {
      try {
        const { own, weeks, accounts } = await loadBase(env);
        const w = pickWeek(weeks, week);
        if (!w) return asMcpTextResult({ ok: false, message: `週「${week}」が見つかりません`, 週: weeks.slice(0, 12).map(x => x.label) });
        const [obs, items] = await Promise.all([
          sbGet(env, `/xa_obs?select=*&${own}&week_id=eq.${w.id}`),
          sbGet(env, `/xa_items?select=*&${own}&week_id=eq.${w.id}&order=sort.asc`),
        ]);
        const days = weekDays(w.month, w.label);
        let 行動: Row | null = null;
        try {
          const acts = days.length ? await sbGet(env, `/xa_acts?select=day,kind,account,n&${own}&day=gte.${days[0]}&day=lte.${days[days.length - 1]}`) : [];
          const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
          行動 = actsSummary(acts, days, goalsFor(weeks, w), today, h => accounts.find(x => x.handle.toLowerCase() === h.toLowerCase())?.name || `@${h}`);
        } catch (_) { 行動 = null; } // 表がまだ無いときは行動だけ出さない
        const order = new Map(accounts.map((a, i) => [a.handle, a.is_self ? -1 : i]));
        obs.sort((a, b) => (order.get(a.account) ?? 999) - (order.get(b.account) ?? 999));
        return asMcpTextResult({
          ok: true, id: w.id, 週: w.label, 月: w.month, 方針: w.policy || "", タイムラインの気づき: w.timeline || "", 全体の仮説: w.overall || "", 自分の数字: metricsOut(w.metrics), 行動,
          相手: obs.map(o => { const a = accounts.find(x => x.handle === o.account); return { 名前: accName(accounts, o.account), "@": o.account, 自分: !!a?.is_self, ラベル: a?.labels || [], 評価: o.score, 層: layersOf(o.ly), ...(o.memo ? { 層に分ける前のメモ: o.memo } : {}), 分析結果: o.ana || "", 生かすなら: o.use_text || "" }; }),
          この回に足した仮説: items.map(itemOut),
          住所: APP_URL,
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 3. xbunseki__get_account ────────────────────────────────────
  server.tool(
    "xbunseki__get_account",
    "X分析くんで見ている相手 1 人の記録を返す：基本情報（どんな人か・ジャンル・誘導先・フォロワー数・メモ）・ラベル・回ごとの評価と層と分析結果（新しい順）・その人が根拠になっている打ち手。分析を書く前に「前の自分」を呼び出すときに使う（前に同じことを書いた／逆を書いた、を知らせる材料）。handle は @ を付けても付けなくてもよい。名前でも引ける。",
    { handle: z.string().max(60).describe("相手の @ID か名前（例: ushi_butyo／うし部長）"), limit: z.number().int().min(1).max(60).optional().describe("何回分まで（省略時 12）") },
    async ({ handle, limit }) => {
      try {
        const { own, weeks, accounts } = await loadBase(env);
        const h = handle.replace(/^@/, "").trim();
        const a = accounts.find(x => x.handle.toLowerCase() === h.toLowerCase()) || accounts.find(x => (x.name || "") === h);
        if (!a) return asMcpTextResult({ ok: false, message: `「${handle}」は見る相手にいません`, 見る相手: accounts.map(x => `${x.name}（@${x.handle}）`) });
        const [obs, items] = await Promise.all([
          sbGet(env, `/xa_obs?select=*&${own}&account=eq.${encodeURIComponent(a.handle)}`),
          sbGet(env, `/xa_items?select=*&${own}&order=sort.asc`),
        ]);
        const wk = new Map(weeks.map(w => [w.id, w]));
        const recs = obs.filter(o => wk.has(o.week_id)).sort((p, q) => (wk.get(q.week_id)!.sort ?? 0) - (wk.get(p.week_id)!.sort ?? 0)).slice(0, limit ?? 12);
        const info = a.info || {};
        return asMcpTextResult({
          ok: true, 名前: a.name, "@": a.handle, 自分: !!a.is_self, 休んでいる: !!a.archived, ラベル: a.labels || [],
          基本情報: { どんな人か: info.who || "", ジャンル: info.genre || "", 誘導先: info.dest || "", フォロワー数: info.fol ?? null, フォロワー数を入れた日: info.fol_at || "", メモ: info.memo || "" },
          記録: recs.map(o => ({ 週: wk.get(o.week_id)!.label, 評価: o.score, 層: layersOf(o.ly), ...(o.memo ? { 層に分ける前のメモ: o.memo } : {}), 分析結果: o.ana || "", 生かすなら: o.use_text || "" })),
          根拠の打ち手: items.filter(i => (i.src || []).some((s: Row) => s.account === a.handle)).map(itemOut),
          X: `https://x.com/${a.handle}`,
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 4. xbunseki__get_strategy ───────────────────────────────────
  server.tool(
    "xbunseki__get_strategy",
    "X分析くんの「戦略と計画」を、5 つの層ごとに 分析 → 仮説 → 戦略 → 計画 の順で返す。month（例 2026-10）の時点で使っている打ち手。省略で今月。include_archived で、やめた打ち手（アーカイブ）も一緒に返す。",
    { month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("例 2026-10。省略で今月（日本時間）"), include_archived: z.boolean().optional() },
    async ({ month, include_archived }) => {
      try {
        const { own } = await loadBase(env);
        const d = new Date(Date.now() + 9 * 3600 * 1000);
        const m = month || `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
        const items = await sbGet(env, `/xa_items?select=*&${own}&order=sort.asc`);
        const live = items.filter(i => inMonth(i, m) && !(i.archived && m >= String(i.until_month || "")));
        const byLayer = LAYERS.map(([id, name]) => ({ 層: name, ...Object.fromEntries(Object.entries(KINDS).map(([k, l]) => [l, live.filter(i => i.layer === id && i.kind === k).map(i => i.body)])) }));
        return asMcpTextResult({ ok: true, 月: m, 件数: live.length, 層ごと: byLayer, ...(include_archived ? { アーカイブ: items.filter(i => i.archived).map(itemOut) } : {}), 住所: APP_URL });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 5. xbunseki__put_metrics ────────────────────────────────────
  server.tool(
    "xbunseki__put_metrics",
    "X分析くんの 1 回（週）に、自分のアカウントの数字を写す（X のアナリティクスのスクショを Claude が読んだときに使う）。渡した欄だけを入れ、ほかの欄・層・分析結果には触らない。数字は実物の写しだけ（推定しない）。欄：imp 平均インプ／fol フォロワー／kiji 記事の本数／qt 引用された数。週は省略で今週（無ければ止まる）。戻り値: { ok, 週, 前, 後, 直した欄 }。",
    {
      week: z.string().max(40).optional().describe("「10月4週」「今週」など。省略で今週"),
      imp: z.number().min(0).optional(), fol: z.number().min(0).optional(), kiji: z.number().min(0).optional(), qt: z.number().min(0).optional(),
    },
    async ({ week, imp, fol, kiji, qt }) => {
      try {
        const { own, weeks } = await loadBase(env);
        const w = pickWeek(weeks, week ?? "今週");
        if (!w) return asMcpTextResult({ ok: false, message: `週「${week ?? "今週"}」が X分析くんにまだありません。画面で開くと今週のページができます`, 住所: APP_URL });
        const { next, changed } = mergeMetrics(w.metrics, { imp, fol, kiji, qt });
        if (!changed.length) return asMcpTextResult({ ok: true, 週: w.label, 直した欄: [], 前: metricsOut(w.metrics), message: "入れる数字がありませんでした（同じ値か、欄の指定が無い）" });
        const rows = await sbPatch(env, `/xa_weeks?id=eq.${w.id}&${own}&select=id,metrics`, { metrics: next, updated_at: new Date().toISOString() });
        if (!rows.length) return asMcpTextResult({ ok: false, message: "書けませんでした（行が見つからない）" });
        return asMcpTextResult({ ok: true, 週: w.label, 前: metricsOut(w.metrics), 後: metricsOut(rows[0].metrics), 直した欄: changed.map(k => METRICS[k]), 住所: APP_URL });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );
}
