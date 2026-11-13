import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { KINDS, LAYERS, METRICS, STOCK_KIND, type Row, actsSummary, featOf, inMonth, itemsFor, layerName, layersOf, mergeMetrics, movesOf, pickWeek, weekDays, xbStockOf, xbStockRow } from "./xbunseki-core.js";

/**
 * X攻略くん（x-koryaku.shia2n.jp・Naoki の X の定点観測）の道具。
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
const VERDICT: Record<string, string> = { keep: "続ける", fix: "直す", stop: "やめる" };
// KPI（作業 36）：{ items: [{ l, goal, m, now }] }。m があれば実績は自分の数字のその欄、無ければ手入力の now
const kpiOut = (k: Row | null | undefined, metrics: Row | null | undefined) => { const xs: Row[] = Array.isArray(k?.items) ? k!.items : []; return xs.length ? xs.map(x => ({ 名前: x.l || "", 目標: x.goal ?? "", 実績: x.m ? (metrics?.[x.m] ?? null) : (x.now ?? ""), 実績の出どころ: x.m ? (METRICS[x.m] || x.m) : "手入力" })) : null; };
// 参考ポスト（スワイプくん）と TaskMaster へ送ったタスクは src の中に 1 件ずつ入る（2026-10-26 4便目・画面の data.js と同じ形）
const refsOf = (i: Row) => (i.src || []).filter((s: Row) => s && s.ref).map((s: Row) => ({ 題: s.ref.title || "", 投稿者: s.ref.author || "", URL: s.ref.url || "" }));
const tasksOf = (i: Row) => (i.src || []).filter((s: Row) => s && s.task).map((s: Row) => ({ id: s.task.id, 題: s.task.title || "", 期限: s.task.deadline || null }));
const itemOut = (i: Row) => ({ id: i.id, 層: layerName(i.layer), 段: KINDS[i.kind] || i.kind, 中身: i.body, ...(String(i.memo || "").trim() ? { メモ: i.memo } : {}), ...(i.grade ? { 見込み: i.grade } : {}), ...(i.verdict ? { 振り返り: VERDICT[i.verdict] || i.verdict } : {}), ...(refsOf(i).length ? { 参考ポスト: refsOf(i) } : {}), ...(tasksOf(i).length ? { TaskMasterへ送ったタスク: tasksOf(i) } : {}), いつから: i.from_month, アーカイブ: !!i.archived, ...(i.archived_why ? { やめた理由: i.archived_why } : {}) });

export function registerXbunsekiTools(server: McpServer, env: Env): void {

  // ─── 1. xbunseki__list_weeks ─────────────────────────────────────
  server.tool(
    "xbunseki__list_weeks",
    "X攻略くんの回（週）の一覧を新しい順で返す。各回の方針・全体の仮説の有無・書いた相手の数・自分の数字。1 回の中身は xbunseki__get_week で読む。戻り値: { ok, 件数, 一覧: [{ id, 週, 月, 方針, 全体の仮説, 書いた相手, 自分の数字 }] }。",
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
    "X攻略くんの 1 回（週）の中身を返す：方針・タイムラインの気づき・全体の仮説・自分の数字・行動（サイドパネルで押した数を、その回の行動の項目ごとに。1 日の目標・達成・日ごと・確かめる仮説・相手ごと）・相手ごとの評価と、書く窓の 3 段（施策の特徴・分析・仮説。2026-10-26 から。前の回の「層に分ける前のメモ」は施策の特徴、「分析結果」は分析、「生かすなら」は仮説として返す。層ごとに書いた分があれば添える）・この回に足した仮説・今週の計画（参考ポストと TaskMaster へ送ったタスクを添える）・今週の KPI・アナリティクスのスクショの住所（あれば）。週は「10月4週」「2026-10 10月4週」「今週」か id。省略でいちばん新しい回。全体の仮説に問いを返す・生徒向けに言い回しを整えるときの材料。",
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
          const its = itemsFor(weeks, w), hyIds = its.map(x => x.hy).filter(Boolean);
          const hyRows = hyIds.length ? await sbGet(env, `/xa_items?select=id,body&${own}&id=in.(${hyIds.map(encodeURIComponent).join(",")})`) : [];
          行動 = actsSummary(acts, days, its, today, h => accounts.find(x => x.handle.toLowerCase() === h.toLowerCase())?.name || `@${h}`, id => hyRows.find(x => x.id === id)?.body || "");
        } catch (_) { 行動 = null; } // 表がまだ無いときは行動だけ出さない
        const order = new Map(accounts.map((a, i) => [a.handle, a.is_self ? -1 : i]));
        obs.sort((a, b) => (order.get(a.account) ?? 999) - (order.get(b.account) ?? 999));
        return asMcpTextResult({
          ok: true, id: w.id, 週: w.label, 月: w.month, 方針: w.policy || "", タイムラインの気づき: w.timeline || "", 全体の仮説: w.overall || "", 自分の数字: metricsOut(w.metrics), ...(Array.isArray(w.shots) && w.shots.length ? { スクショ: w.shots.map((x: Row) => x && x.url).filter(Boolean) } : {}), 行動,
          相手: obs.map(o => { const a = accounts.find(x => x.handle === o.account); return { 名前: accName(accounts, o.account), "@": o.account, 自分: !!a?.is_self, ラベル: a?.labels || [], 評価: o.score, 施策の特徴: featOf(o), 分析: o.ana || "", 仮説: o.use_text || "", ...(Object.keys(layersOf(o.ly)).length ? { 層ごとに書いた分: layersOf(o.ly) } : {}) }; }),
          この回に足した仮説: items.filter(i => i.kind !== "pl").map(itemOut),
          今週の計画: items.filter(i => i.kind === "pl").map(itemOut),
          ...(kpiOut(w.kpi, w.metrics) ? { 今週のKPI: kpiOut(w.kpi, w.metrics) } : {}),
          住所: APP_URL,
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 3. xbunseki__get_account ────────────────────────────────────
  server.tool(
    "xbunseki__get_account",
    "X攻略くんで見ている相手 1 人の記録を返す：基本情報（どんな人か・ジャンル・誘導先・フォロワー数・メモ）・ラベル・回ごとの評価と施策の特徴・分析・仮説（新しい順）・その人が根拠になっている打ち手。分析を書く前に「前の自分」を呼び出すときに使う（前に同じことを書いた／逆を書いた、を知らせる材料）。handle は @ を付けても付けなくてもよい。名前でも引ける。",
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
          記録: recs.map(o => ({ 週: wk.get(o.week_id)!.label, 評価: o.score, 施策の特徴: featOf(o), 分析: o.ana || "", 仮説: o.use_text || "", ...(Object.keys(layersOf(o.ly)).length ? { 層ごとに書いた分: layersOf(o.ly) } : {}) })),
          根拠の打ち手: items.filter(i => (i.src || []).some((s: Row) => s.account === a.handle)).map(itemOut),
          X: `https://x.com/${a.handle}`,
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 4. xbunseki__get_strategy ───────────────────────────────────
  server.tool(
    "xbunseki__get_strategy",
    "X攻略くんの「戦略と計画」を、5 つの層ごとに 分析 → 仮説 → 戦略 → 計画 の順で返す。month（例 2026-10）の時点で使っている打ち手。省略で今月。include_archived で、やめた打ち手（アーカイブ）も一緒に返す。",
    { month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("例 2026-10。省略で今月（日本時間）"), include_archived: z.boolean().optional() },
    async ({ month, include_archived }) => {
      try {
        const { own } = await loadBase(env);
        const d = new Date(Date.now() + 9 * 3600 * 1000);
        const m = month || `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
        const items = await sbGet(env, `/xa_items?select=*&${own}&order=sort.asc`);
        const live = items.filter(i => inMonth(i, m) && !(i.archived && m >= String(i.until_month || "")));
        const byLayer = LAYERS.map(([id, name]) => ({ 層: name, ...Object.fromEntries(Object.entries(KINDS).map(([k, l]) => [l, live.filter(i => i.layer === id && i.kind === k).map(i => i.body)])) }));
        // 月の方針と KPI（作業 36）。表がまだ無いときは出さない。KPI の実績は、その月の週の自分の数字のうち新しいもの
        let mon: Row | null = null, mm: Row = {};
        try { mon = (await sbGet(env, `/xa_months?select=*&${own}&month=eq.${m}`))[0] || null; (await sbGet(env, `/xa_weeks?select=metrics,sort&${own}&month=eq.${m}&order=sort.asc`)).forEach((w: Row) => Object.entries(w.metrics || {}).forEach(([k, v]) => { if (v !== null && v !== "") mm[k] = v; })); } catch (_) { mon = null; }
        return asMcpTextResult({ ok: true, 月: m, ...(mon ? { 月の方針: mon.policy || "", ...(kpiOut(mon.kpi, mm) ? { 月のKPI: kpiOut(mon.kpi, mm) } : {}) } : {}), 件数: live.length, 層ごと: byLayer, ...(include_archived ? { アーカイブ: items.filter(i => i.archived).map(itemOut) } : {}), 住所: APP_URL });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 4b. xbunseki__get_moves（2026-11-12）───────────────────────
  server.tool(
    "xbunseki__get_moves",
    "X攻略くんの打ち手ごとの材料をまとめて返す。各打ち手の中身・状態（今週オン／控え／停止）・本数・つながる仮説・お手本（スワイプくんで結んだポスト・記事の題と URL と画像）・その週の評価（最高〜最悪）・その週にコンテンツくんで予約・公開した投稿（打ち手の種類と同じもの。日・題・状態、入っていれば評価と URL）。下書きや振り返りを頼まれたときに読む。week は「今週」「11月2週」「2026-11 11月2週」か id。省略で今週。読むだけ。",
    { week: z.string().optional().describe("省略で今週") },
    async ({ week }) => {
      try {
        const { uid, own, weeks } = await loadBase(env);
        const w = pickWeek(weeks, week || "今週") || pickWeek(weeks);
        if (!w) return asMcpTextResult({ ok: false, message: "回がまだない" });
        const [items, sets, accs] = await Promise.all([
          sbGet(env, `/xa_items?select=*&${own}&order=sort.asc`),
          sbGet(env, `/xa_settings?select=ladder&${own}&limit=1`).catch(() => []),
          sbGet(env, `/accounts?select=id,default_platform,is_active,sort_order&user_id=eq.${encodeURIComponent(uid)}&is_active=eq.true&order=sort_order.asc`).catch(() => []),
        ]);
        const acc = accs.find(a => a.default_platform === "x");
        const days = weekDays(w.month, w.label);
        const posts = acc && days.length ? await sbGet(env, `/posts?select=title,post_type,status,datetime,platform,x_url,score&user_id=eq.${encodeURIComponent(uid)}&account_id=eq.${encodeURIComponent(acc.id)}&status=in.(reserved,published)&datetime=gte.${days[0]}&datetime=lt.${days[days.length - 1]}T99`).catch(() => []) : [];
        const moves = movesOf(items, w.month, w, sets[0]?.ladder || null, posts.filter(p => (p.platform || "x") === "x"));
        return asMcpTextResult({ ok: true, 週: w.label, 月: w.month, 件数: moves.length, 打ち手: moves, 画面: `${APP_URL}/` });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 5. xbunseki__put_metrics ────────────────────────────────────
  server.tool(
    "xbunseki__put_metrics",
    "X攻略くんの 1 回（週）に、自分のアカウントの数字を写す（X のアナリティクスのスクショを Claude が読んだときに使う）。渡した欄だけを入れ、ほかの欄・層・分析結果には触らない。数字は実物の写しだけ（推定しない）。欄：imp 平均インプ／fol フォロワー／kiji 記事の本数／qt 引用された数。週は省略で今週（無ければ止まる）。戻り値: { ok, 週, 前, 後, 直した欄 }。",
    {
      week: z.string().max(40).optional().describe("「10月4週」「今週」など。省略で今週"),
      imp: z.number().min(0).optional(), fol: z.number().min(0).optional(), kiji: z.number().min(0).optional(), qt: z.number().min(0).optional(),
    },
    async ({ week, imp, fol, kiji, qt }) => {
      try {
        const { own, weeks } = await loadBase(env);
        const w = pickWeek(weeks, week ?? "今週");
        if (!w) return asMcpTextResult({ ok: false, message: `週「${week ?? "今週"}」が X攻略くんにまだありません。画面で開くと今週のページができます`, 住所: APP_URL });
        const { next, changed } = mergeMetrics(w.metrics, { imp, fol, kiji, qt });
        if (!changed.length) return asMcpTextResult({ ok: true, 週: w.label, 直した欄: [], 前: metricsOut(w.metrics), message: "入れる数字がありませんでした（同じ値か、欄の指定が無い）" });
        const rows = await sbPatch(env, `/xa_weeks?id=eq.${w.id}&${own}&select=id,metrics`, { metrics: next, updated_at: new Date().toISOString() });
        if (!rows.length) return asMcpTextResult({ ok: false, message: "書けませんでした（行が見つからない）" });
        return asMcpTextResult({ ok: true, 週: w.label, 前: metricsOut(w.metrics), 後: metricsOut(rows[0].metrics), 直した欄: changed.map(k => METRICS[k]), 住所: APP_URL });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 仮説とノウハウのストック（2026-11-13・X攻略くん 便4・note攻略くんの notekoryaku__get_stock／put_stock と同じ形）───
  server.tool(
    "xbunseki__get_stock",
    "X攻略くんの「仮説とノウハウのストック」（右上の「ストック」）を返す（読むだけ）。評価（C 根拠が薄い・B 手応えあり・A 自分で証明できた・S 証明できて効果も大きい）・層・フォルダ・登録日・評価の変化・ここまで通用（評価を下げた日）・出どころ・リンク・メモ・使っている立ち回り。足す前に重なりと既存のフォルダを見るとき、ポストや記事の材料を探すときに読む。",
    { kind: z.enum(["仮説", "ノウハウ"]).optional().describe("省略で両方"), folder: z.string().max(30).optional().describe("フォルダの名前。未分類は空文字") },
    async ({ kind, folder }) => {
      try {
        const { own, weeks, accounts } = await loadBase(env);
        const items = await sbGet(env, `/xa_items?select=*&${own}&kind=in.(hy,kn,st)`);
        const list = xbStockOf(items, weeks, accounts, kind ? STOCK_KIND[kind] : undefined, folder);
        const folders = [...new Set(list.map(x => x.フォルダ).filter(f => f && f !== "未分類"))];
        return asMcpTextResult({ ok: true, 件数: list.length, フォルダ: folders, ストック: list, 画面: APP_URL, 見る場所: "右上の「ストック」" });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );
  server.tool(
    "xbunseki__put_stock",
    "X攻略くんの「仮説とノウハウのストック」へ足す（足すだけ。直す・消す・評価を上げるはしない）。チャットで「この分析（マップ・ポスト）から仮説とノウハウを抜いて」と頼まれたときに使う。1 回 30 件まで。評価は C（根拠が薄い）で入り、評価の変化に今日が残る。層は 5 つ（アカウントの目的・意図／運用のスタイル／運用の内容／投稿のスタイル／投稿の内容）から 1 つ。同じ種類で同じ文がもうあれば足さない。出どころの住所を map_url か links に入れる。足す前に xbunseki__get_stock で重なりと既存のフォルダを見る。",
    { items: z.array(z.object({
        kind: z.enum(["仮説", "ノウハウ"]), text: z.string().min(1).max(500).describe("1 文で言い切る"),
        layer: z.enum(["アカウントの目的・意図", "運用のスタイル", "運用の内容", "投稿のスタイル", "投稿の内容"]).optional().describe("省略で運用の内容"),
        folder: z.string().max(30).optional().describe("フォルダの名前（既存に合わせる。無ければ新しく）"),
        note: z.string().max(4000).optional().describe("根拠や補足。「- 」の箇条書き"),
        map_url: z.string().max(300).optional().describe("出どころの思考整理くんのマップの住所"),
        links: z.array(z.object({ url: z.string().max(500), title: z.string().max(80).optional() })).max(5).optional(),
      })).min(1).max(30) },
    async ({ items: input }) => {
      try {
        const { uid, own } = await loadBase(env);
        const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
        const have = await sbGet(env, `/xa_items?select=id,kind,body,archived&${own}&kind=in.(hy,kn)`);
        const rows: Row[] = [], skipped: string[] = [];
        for (const x of input) { const row = xbStockRow(x, uid, today, [...have, ...rows]); if (row) rows.push(row); else skipped.push(x.text); }
        if (!rows.length) return asMcpTextResult({ ok: true, 足した: 0, 足さなかった: skipped, 理由: "同じ文がもうある", 画面: APP_URL });
        const ins = await fetch(`${env.SUPABASE_URL}/rest/v1/xa_items`, { method: "POST", headers: sbHeaders(env, { Prefer: "return=representation" }), body: JSON.stringify(rows) });
        if (!ins.ok) throw new Error(`足せませんでした（${ins.status}）：${(await ins.text()).slice(0, 200)}`);
        const got = (await ins.json()) as Row[];
        return asMcpTextResult({ ok: true, 足した: got.length, 足したもの: got.map(g => ({ id: g.id, 種類: g.kind === "kn" ? "ノウハウ" : "仮説", 文: g.body, 層: layerName(g.layer), フォルダ: g.src?.[0]?.sk?.folder || "未分類" })), ...(skipped.length ? { 足さなかった: skipped } : {}), 画面: `${APP_URL}/`, 見る場所: "右上の「ストック」" });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );
}
