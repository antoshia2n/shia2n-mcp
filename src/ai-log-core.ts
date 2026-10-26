/**
 * shia2n-mcp / src/ai-log-core.ts / 新設（2026-10-26 v1.45.0 開発部・AI の利用ログ）
 *
 * AI の利用ログ（Supabase の ai_log）の計算だけの部品（外に触らない・試験で回す）。
 * 依頼：https://www.notion.so/4059c6c1c43981ec88d5cfdedb66132a
 *
 *   ・1 件＝AI の会話 1 本の始まり。各役割が会話の最初に ai_log__add を 1 回呼ぶ
 *   ・使った場所（where）は 4 つに固定する（数えるときに表記がぶれないため）
 *   ・役割（role）は自由に書ける。決まった一覧に無い名前も残し、注意だけ返す（新しい役割で記録が止まらないため）
 *   ・時刻は書いた瞬間のサーバーの時刻（at）。返すときは日本時間に直す。1 日の区切りは日本時間の 0 時
 */

type Row = Record<string, any>;

/** 使った場所：表に入る値（左）と、受け付ける書き方（右・小文字で空白なし） */
export const WHERES: ReadonlyArray<[string, string[]]> = [
  ["claude.ai", ["claude.ai", "claudeai", "claude"]],
  ["Claude Code", ["claudecode"]],
  ["GPT", ["gpt", "chatgpt"]],
  ["予約タスク", ["予約タスク", "予約", "scheduled", "schedule"]],
];
export const WHERE_VALUES = WHERES.map(([v]) => v);

/** 決まった役割（ここに無い名前は残すが注意を返す） */
export const KNOWN_ROLES = ["統括", "秘書", "開発部", "るーみん", "おかぜり", "予約タスク", "シアニン担当", "経理系", "案件系"];

export const MAX_DAYS = 31;
const JST_MS = 9 * 60 * 60 * 1000;

export function normWhere(s: unknown): string | null {
  const k = String(s ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!k) return null;
  for (const [v, alts] of WHERES) if (alts.includes(k)) return v;
  return null;
}

export type AddCheck =
  | { ok: true; row: { role: string; surface: string; title: string }; warnings: string[] }
  | { ok: false; message: string };

/** ai_log__add の引数を確かめて、表に入れる 1 行にする */
export function checkAdd(input: { role?: unknown; where?: unknown; title?: unknown }): AddCheck {
  const role = String(input.role ?? "").trim();
  const title = String(input.title ?? "").trim().replace(/\s+/g, " ");
  if (!role) return { ok: false, message: "role が空です（例：統括・開発部・予約タスク）" };
  if (role.length > 30) return { ok: false, message: "role は 30 字までです" };
  const surface = normWhere(input.where);
  if (!surface) return { ok: false, message: `where は ${WHERE_VALUES.join("・")} のどれかです` };
  if (!title) return { ok: false, message: "title が空です（その会話の要件を短く）" };
  if (title.length > 200) return { ok: false, message: "title は 200 字までです" };
  const warnings: string[] = [];
  if (!KNOWN_ROLES.includes(role)) warnings.push(`role「${role}」は決まった一覧（${KNOWN_ROLES.join("・")}）に無い名前です。残しましたが、週間レポートでは別の役割として数えます`);
  return { ok: true, row: { role, surface, title }, warnings };
}

/** ISO の時刻 → 日本時間の "YYYY-MM-DDTHH:mm:ss+09:00" */
export function toJst(iso: string): string {
  const d = new Date(new Date(iso).getTime() + JST_MS);
  return d.toISOString().slice(0, 19) + "+09:00";
}
/** ISO の時刻 → 日本時間の日付 "YYYY-MM-DD" */
export function jstDate(iso: string): string {
  return toJst(iso).slice(0, 10);
}
/** 今の日本時間の日付 */
export function todayJst(now: Date = new Date()): string {
  return jstDate(now.toISOString());
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function addDays(s: string, n: number): string {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export type Range =
  | { ok: true; from: string; to: string; days: string[]; startIso: string; endIso: string }
  | { ok: false; message: string };

/** 日本時間の from〜to（両端を含む）を、表を引く UTC の範囲 [startIso, endIso) にする。from 省略＝今日、to 省略＝from */
export function jstRange(from?: string, to?: string, now: Date = new Date()): Range {
  const f = (from ?? "").trim() || todayJst(now);
  const t = (to ?? "").trim() || f;
  if (!validDate(f)) return { ok: false, message: `from は YYYY-MM-DD の形です（受け取った値：${f}）` };
  if (!validDate(t)) return { ok: false, message: `to は YYYY-MM-DD の形です（受け取った値：${t}）` };
  if (t < f) return { ok: false, message: "to が from より前です" };
  const days: string[] = [];
  for (let d = f; d <= t; d = addDays(d, 1)) {
    days.push(d);
    if (days.length > MAX_DAYS) return { ok: false, message: `期間は ${MAX_DAYS} 日までです` };
  }
  const startIso = new Date(new Date(`${f}T00:00:00Z`).getTime() - JST_MS).toISOString();
  const endIso = new Date(new Date(`${addDays(t, 1)}T00:00:00Z`).getTime() - JST_MS).toISOString();
  return { ok: true, from: f, to: t, days, startIso, endIso };
}

const inc = (o: Record<string, number>, k: string) => { o[k] = (o[k] || 0) + 1; };

/** 表の行を、一覧と日ごと・役割ごと・場所ごとの回数にまとめる。期間の日は 0 回でも並べる */
export function summarize(rows: Row[], days: string[]) {
  const sorted = [...rows].filter(r => r && r.at).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const byRole: Record<string, number> = {};
  const byWhere: Record<string, number> = {};
  const perDay = new Map<string, { 日: string; 回数: number; 役割ごと: Record<string, number> }>();
  for (const d of days) perDay.set(d, { 日: d, 回数: 0, 役割ごと: {} });
  const list = sorted.map(r => {
    const role = String(r.role ?? "");
    const where = String(r.surface ?? "");
    const day = jstDate(String(r.at));
    inc(byRole, role); inc(byWhere, where);
    const pd = perDay.get(day);
    if (pd) { pd.回数++; inc(pd.役割ごと, role); }
    return { 時刻: toJst(String(r.at)), role, where, title: String(r.title ?? "") };
  });
  return { 件数: list.length, 役割ごと: byRole, 場所ごと: byWhere, 日ごと: [...perDay.values()], 一覧: list };
}
