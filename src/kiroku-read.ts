/**
 * shia2n-mcp / src/kiroku-read.ts / 新設（2026-10-13 v1.15.0 開発部）
 *
 * 記録くん（kiroku.shia2n.jp）の記録を、日付の範囲で読む。書かない。
 * 依頼：https://www.notion.so/3f89c6c1c43981308c9dc4e780af3f0d（開発部でやること 1）
 *
 * 置き場：Supabase の表 daily_logs（1 日 1 行）・rule_checks（日ごとのチェック）・rules（決まりの名前）。
 *   記録くんの関門（Cloudflare Access）の内側の口は通らず、shia2n-mcp が控え（cron-backup）と同じ鍵で表を直接読む。
 * 欄の名前は決め打ちしない（2026-10-13 時点で開発部は記録くんのリポジトリを読めず、欄の一覧を手元で確かめられなかったため）。
 *   データベースが返す表の定義（/rest/v1/ の definitions）から、日付の欄（format: date）を毎回探す。
 *   行は全部の欄をそのまま返す（体調・食事・日記・ポモドーロの回数など、どの欄が増えても落とさない）。
 */
import type { Env } from "./index.js";

type Row = Record<string, unknown>;
type Spec = { definitions?: Record<string, { properties?: Record<string, { format?: string; type?: string; description?: string }> }> };

const DATE_NAMES = ["date", "log_date", "day", "target_date", "check_date", "recorded_on"];

function headers(env: Env): Record<string, string> {
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || "");
  return { apikey: key, ...(/^eyJ/.test(key) ? { Authorization: "Bearer " + key } : {}), Accept: "application/json" };
}

/** 表の日付の欄を、表の定義から決める。1 つに決まらなければ止める（推測で選ばない） */
export function dateColumnOf(spec: Spec, table: string): string {
  const props = spec.definitions?.[table]?.properties;
  if (!props) throw new Error("記録くんの表 " + table + " が見つかりません（表の定義に無い）");
  const dates = Object.entries(props).filter(([, p]) => p.format === "date").map(([k]) => k);
  if (dates.length === 1) return dates[0];
  const named = DATE_NAMES.find(n => dates.includes(n));
  if (named) return named;
  throw new Error("記録くんの表 " + table + " の日付の欄が 1 つに決まりません（日付の欄：" + (dates.join("・") || "なし") + "／全部の欄：" + Object.keys(props).join("・") + "）");
}

/** rule_checks → rules をつなぐ欄（表の定義の外部キーの印から探す。無ければ rule_id） */
export function ruleFkOf(spec: Spec): string | null {
  const props = spec.definitions?.rule_checks?.properties ?? {};
  for (const [k, p] of Object.entries(props)) if (/<fk table='rules' column='id'\/>/.test(p.description ?? "")) return k;
  return "rule_id" in props ? "rule_id" : null;
}

async function get(env: Env, path: string): Promise<unknown> {
  const res = await fetch(env.SUPABASE_URL + "/rest/v1/" + path, { headers: headers(env) });
  if (!res.ok) throw new Error("記録くんの表を読めませんでした（" + res.status + "）：" + path.split("?")[0]);
  return res.json();
}

export type KirokuRange = {
  columns: { daily_logs_date: string; rule_checks_date: string; rule_link: string | null; daily_logs: string[] };
  daily_logs: Row[];
  rule_checks: (Row & { rule?: Row | null })[];
};

/** from〜to（YYYY-MM-DD・両端を含む）の daily_logs と rule_checks（決まりの行つき）を返す */
export async function readKiroku(env: Env, from: string, to: string): Promise<KirokuRange> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase の設定がありません（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）");
  const spec = (await get(env, "")) as Spec;
  const dCol = dateColumnOf(spec, "daily_logs");
  const cCol = dateColumnOf(spec, "rule_checks");
  const fk = ruleFkOf(spec);
  const range = (col: string) => `${encodeURIComponent(col)}=gte.${from}&${encodeURIComponent(col)}=lte.${to}&order=${encodeURIComponent(col)}.asc`;
  const [daily, checks, rules] = await Promise.all([
    get(env, "daily_logs?select=*&" + range(dCol)) as Promise<Row[]>,
    get(env, "rule_checks?select=*&" + range(cCol)) as Promise<Row[]>,
    get(env, "rules?select=*") as Promise<Row[]>,
  ]);
  const byId = new Map(rules.map(r => [String(r.id), r]));
  return {
    columns: { daily_logs_date: dCol, rule_checks_date: cCol, rule_link: fk, daily_logs: Object.keys(spec.definitions?.daily_logs?.properties ?? {}) },
    daily_logs: daily,
    rule_checks: checks.map(c => ({ ...c, rule: fk && c[fk] !== undefined && c[fk] !== null ? byId.get(String(c[fk])) ?? null : null })),
  };
}
