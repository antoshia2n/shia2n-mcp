import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { jstDay, prevMonthOf, type NoteIn } from "./notekoryaku-core.js";
import { enoughOlder, nextAccount, picksOf, skiEmpty, skiOf, targetMonths } from "./notekoryaku-core.js";

/**
 * note攻略くん：見る相手（自分以外）の月の数字とスワイプ候補を、note の公開の数字（ログイン不要）から入れる（2026-11-10 開発部・作業 73・Naoki「OK」21:41）。
 *
 * 動き：cron の 30 分ごと（15 分・45 分）に 1 人ずつ進める（Workers の 1 回あたりの外への呼び出しの上限に収めるため）。
 *   対象の月は、初回の遡り 2026-08〜10 と、毎月 2 日からは前の月（notekoryaku-others-core の targetMonths）。
 *   済んだ相手と月は保管庫 notekoryaku/others-state.json に残し、全員済んだ月は「閉じた」にして、以後は読むだけで終わる。
 * 書くもの：
 *   na_obs … 種類ごとの [本数, スキ] は、その月の欄が空（全部 0）のときだけ入れる。フォロワー数は前の月の行で、空のときだけ（取った日の数）。
 *            Naoki が書いた評価・集客ルート・施策の特徴・分析・仮説・メンシプ人数には触らない
 *   na_picks … 近い 10 本のスキの真ん中の 1.2 倍以上の記事。同じ記事が既にあれば触らない（Naoki が入れた・見送った印を残す）
 * 持ち主は Naoki の自分の場所（user_id）。
 */

const OWNER = "VrMwzeSceqWeXVQOrm8kpu4uVR33";
const STATE_KEY = "notekoryaku/others-state.json";
const MAX_PAGES = 20; // 1 ページ 6 本前後。同じ回のほかの処理と合わせて外への呼び出しの上限に収める
type State = { done: Record<string, string[]>; closed: string[]; errors?: Record<string, string>; at?: string; rule?: number };
const RULE = 2; // 数え方の版。上がったら済みの印を消して数え直す（v1.79.0：メンシプを先に見る）

function sbh(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: env.SUPABASE_SERVICE_ROLE_KEY, ...(/^eyJ/.test(String(env.SUPABASE_SERVICE_ROLE_KEY || "")) ? { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } : {}), "Content-Type": "application/json", ...extra };
}
async function sb(env: Env, path: string, init: RequestInit = {}, extra: Record<string, string> = {}): Promise<any> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, { ...init, headers: sbh(env, extra) });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}
const NOTE_H = { "User-Agent": "Mozilla/5.0 (compatible; shia2n-mcp/1.0)", Accept: "application/json" };

async function readState(env: Env): Promise<State> {
  const o = await env.BACKUP_BUCKET.get(STATE_KEY);
  const s = o ? (JSON.parse(await o.text()) as State) : null;
  if (!s || s.rule !== RULE) return { done: {}, closed: [], errors: {}, rule: RULE };
  return { done: s.done ?? {}, closed: s.closed ?? [], errors: s.errors ?? {}, rule: RULE };
}
const writeState = (env: Env, s: State) => env.BACKUP_BUCKET.put(STATE_KEY, JSON.stringify({ ...s, at: new Date().toISOString() }), { httpMetadata: { contentType: "application/json" } });

/** 相手の記事を新しい順に、足りるところまで読む */
async function fetchArticles(urlname: string, firstMonth: string): Promise<{ arts: NoteIn[]; pages: number; capped: boolean }> {
  const arts: NoteIn[] = []; const seen = new Set<string>();
  let p = 1;
  for (; p <= MAX_PAGES; p++) {
    const res = await fetch(`https://note.com/api/v2/creators/${encodeURIComponent(urlname)}/contents?kind=note&page=${p}`, { headers: NOTE_H, signal: AbortSignal.timeout(10000) });
    if (res.status === 404) throw new Error("note にこのアカウントが見つかりません");
    if (!res.ok) throw new Error(`note が ${res.status} を返しました（${p} ページ目）`);
    const d = ((await res.json()) as any)?.data ?? {};
    const cs = (d.contents ?? []) as any[];
    for (const c of cs) {
      if (!c?.key || !c?.publishAt || seen.has(c.key)) continue; seen.add(c.key);
      arts.push({ key: String(c.key), title: String(c.name ?? ""), published_at: String(c.publishAt), price: +(c.price ?? 0) || 0, membership: !!c.isMembershipConnected,
        likes: typeof c.likeCount === "number" ? c.likeCount : 0, comments: typeof c.commentCount === "number" ? c.commentCount : null, views: null });
    }
    if (d.isLastPage !== false || !cs.length) return { arts, pages: p, capped: false };
    if (enoughOlder(arts, cs[cs.length - 1]?.publishAt ?? null, firstMonth)) return { arts, pages: p, capped: false };
  }
  return { arts, pages: p - 1, capped: true };
}

async function followers(urlname: string): Promise<number | null> {
  try {
    const res = await fetch(`https://note.com/api/v2/creators/${encodeURIComponent(urlname)}`, { headers: NOTE_H, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const f = ((await res.json()) as any)?.data?.followerCount;
    return typeof f === "number" ? f : null;
  } catch { return null; }
}

export type OthersResult = { did: string | null; months: string[]; detail: string; left: number };

/** 1 人ぶん進める（cron と道具から呼ぶ）。only を渡すとその相手だけ（済んでいても入れ直さない） */
export async function othersTick(env: Env, now = Date.now(), only?: string): Promise<OthersResult> {
  const today = jstDay(new Date(now).toISOString());
  const months = targetMonths(today);
  const st = await readState(env);
  const open = months.filter(m => !st.closed.includes(m));
  if (!open.length) return { did: null, months: [], detail: "対象の月はすべて済み", left: 0 };
  const accs = (await sb(env, `/na_accounts?select=handle&user_id=eq.${OWNER}&is_self=eq.false&archived=eq.false&order=sort.asc`)) as { handle: string }[];
  const handles = accs.map(a => a.handle).filter(h => !only || h === only);
  const nx = nextAccount(handles, st.done, open);
  if (!nx) {
    if (!only) { st.closed = [...new Set([...st.closed, ...open])]; await writeState(env, st); }
    return { did: null, months: open, detail: only ? `${only} は済み` : `${open.join("・")} を閉じた（全員済み）`, left: 0 };
  }
  const h = nx.account;
  const mark = async (err?: string) => {
    for (const m of nx.months) st.done[m] = [...new Set([...(st.done[m] ?? []), h])];
    if (err) st.errors = { ...(st.errors ?? {}), [h]: err }; else if (st.errors) delete st.errors[h];
    await writeState(env, st);
  };
  let got;
  try { got = await fetchArticles(h, nx.months[0]); }
  catch (e) { const msg = e instanceof Error ? e.message : String(e); await mark(msg); return { did: h, months: nx.months, detail: `${h}：${msg}`, left: handles.length }; }

  // 月の行（無ければ作る）と、その相手の分析の行
  await sb(env, `/na_months?on_conflict=user_id,month`, { method: "POST", body: JSON.stringify(nx.months.map(m => ({ user_id: OWNER, month: m }))) }, { Prefer: "resolution=ignore-duplicates,return=minimal" });
  const mrows = (await sb(env, `/na_months?select=id,month&user_id=eq.${OWNER}&month=in.(${nx.months.join(",")})`)) as { id: string; month: string }[];
  const idOf = new Map(mrows.map(r => [r.month, r.id]));
  const obs = (await sb(env, `/na_obs?select=id,month_id,ski,counts&user_id=eq.${OWNER}&account=eq.${encodeURIComponent(h)}&month_id=in.(${mrows.map(r => r.id).join(",")})`)) as { id: string; month_id: string; ski: unknown; counts: Record<string, unknown> }[];
  const prev = prevMonthOf(today);
  const fol = nx.months.includes(prev) ? await followers(h) : null;
  const notes: string[] = [];
  for (const m of nx.months) {
    const mid = idOf.get(m); if (!mid) continue;
    const ski = skiOf(got.arts, m);
    const o = obs.find(x => x.month_id === mid);
    const putFol = m === prev && fol != null;
    if (!o) {
      await sb(env, `/na_obs`, { method: "POST", body: JSON.stringify({ user_id: OWNER, month_id: mid, account: h, ski, counts: { mem: null, fol: putFol ? fol : null } }) }, { Prefer: "return=minimal" });
      notes.push(`${m} 新規`);
    } else {
      const patch: Record<string, unknown> = {};
      if (skiEmpty(o.ski)) patch.ski = ski;
      const c = o.counts && typeof o.counts === "object" ? o.counts : {};
      if (putFol && (c.fol == null || c.fol === "")) patch.counts = { ...c, fol };
      if (Object.keys(patch).length) { await sb(env, `/na_obs?id=eq.${o.id}&user_id=eq.${OWNER}`, { method: "PATCH", body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }) }, { Prefer: "return=minimal" }); notes.push(`${m} 空欄を埋めた`); }
      else notes.push(`${m} 手入力ありで触らず`);
    }
  }
  const picks = picksOf(h, h, got.arts, nx.months, today);
  if (picks.length) {
    await sb(env, `/na_picks?on_conflict=user_id,note_key`, { method: "POST", body: JSON.stringify(picks.map(p => ({ user_id: OWNER, ...p }))) }, { Prefer: "resolution=ignore-duplicates,return=minimal" });
  }
  await mark(got.capped ? `ページの上限（${MAX_PAGES}）で止めた・古い月は数え切れていないかも` : undefined);
  const left = handles.filter(x => nx.months.some(m => !(st.done[m] ?? []).includes(x))).length;
  return { did: h, months: nx.months, left, detail: `${h}：記事 ${got.arts.length} 本（${got.pages} ページ）・${notes.join("・")}・候補 ${picks.length}${got.capped ? "・上限で止めた" : ""}` };
}

export function registerNotekoryakuOthersTools(server: McpServer, env: Env): void {
  server.tool(
    "notekoryaku__others",
    "note攻略くんの見る相手（自分以外）の月の数字（種類ごとの本数とスキ・前の月のフォロワー数）とスワイプ候補（近い 10 本のスキの真ん中の 1.2 倍以上）を、note の公開の数字から入れる処理の様子を見る・1 人ぶん手で進める。ふだんは cron が 30 分ごとに 1 人ずつ進める（初回は 2026-08〜10、以後は毎月 2 日から前の月）。分析の文・評価・メンシプ人数には書かない。数字の欄は空のときだけ埋める。戻り値: { ok, 対象の月, 済み: { 月: 人数 }, 閉じた月, 止まった相手, 進めた }。",
    { run: z.boolean().optional().describe("true で 1 人ぶん進める"), account: z.string().max(80).optional().describe("この相手だけを進める（run と一緒に）") },
    async ({ run, account }) => {
      try {
        const ran = run ? await othersTick(env, Date.now(), account) : null;
        const st = await readState(env);
        const months = targetMonths(jstDay(new Date().toISOString()));
        return asMcpTextResult({ ok: true, 対象の月: months, 済み: Object.fromEntries(months.map(m => [m, (st.done[m] ?? []).length])), 閉じた月: st.closed, 止まった相手: st.errors ?? {}, ...(ran ? { 進めた: ran } : {}), 住所: "https://note-koryaku.shia2n.jp（分析・レポート › スワイプ候補）" });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );
}
