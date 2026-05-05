import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { getFirestoreToken, fsGet, fromVal, type FVal } from "./taskmaster.js";

/**
 * haAku（集約ダッシュボード）読み取りツール群。
 * Firestore を直接参照（既存 FIREBASE_SA_EMAIL / FIREBASE_SA_PRIVATE_KEY / NAOKI_UID を流用）。
 *
 * Firestoreコレクション構造（確認済み）：
 *   users/{uid}/app_data/os_kpis    → { value: KPI[] }
 *   users/{uid}/app_data/os_kgis    → { value: KGI[] }
 *   users/{uid}/app_data/os_daily_{year} → { value: { "YYYY-MM-DD": { kpiValues, report } } }
 *
 * 命名規約：`haAku__<action>`
 * v0.18.0 で追加（依頼書：3579c6c1-c439-81ea-928b-dcb455ad4bb1）
 */

// ─── 型定義 ───────────────────────────────────────────────────────────────────

interface KpiDef {
  id: string;
  title: string;
  unit: string;
  monthlyTarget: string;
  period: string;
  color: string;
  kgiId: string;
}

interface KgiDef {
  id: string;
  title: string;
  target: string;
  unit: string;
  color: string;
  current?: number;
}

interface DailyRecord {
  kpiValues?: Record<string, number>;
  report?: {
    goal?: string;
    achieved?: string;
    reflection?: string;
    improvement?: string;
  };
}

// ─── Firestore 読み取りヘルパー ───────────────────────────────────────────────

async function loadArrayDoc<T>(
  token: string,
  uid: string,
  key: string
): Promise<T[]> {
  try {
    const doc = await fsGet(token, `users/${uid}/app_data/${key}`);
    const fields = doc.fields ?? {};
    if (!("value" in fields)) return [];
    const expanded = fromVal(fields["value"] as FVal);
    if (!Array.isArray(expanded)) return [];
    return expanded as T[];
  } catch {
    return [];
  }
}

async function loadDailyYear(
  token: string,
  uid: string,
  year: string
): Promise<Record<string, DailyRecord>> {
  try {
    const doc = await fsGet(token, `users/${uid}/app_data/os_daily_${year}`);
    const fields = doc.fields ?? {};
    if (!("value" in fields)) return {};
    const expanded = fromVal(fields["value"] as FVal);
    if (typeof expanded !== "object" || expanded === null) return {};
    return expanded as Record<string, DailyRecord>;
  } catch {
    return {};
  }
}

// ─── 日付ヘルパー ──────────────────────────────────────────────────────────────

function toJstDateStr(d: Date): string {
  // JST = UTC+9
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

function todayJst(): string {
  return toJstDateStr(new Date());
}

function yesterdayJst(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return toJstDateStr(d);
}

// ─── ツール登録 ───────────────────────────────────────────────────────────────

export function registerHaakuTools(server: McpServer, env: Env): void {

  // ─── 1. haAku__get_kpi_progress ───────────────────────────────────────────
  server.tool(
    "haAku__get_kpi_progress",
    "haAku の KPI 進捗を取得する。秘書室の朝レポートで当月の KPI 達成状況を確認するときに使う。各 KPI の月次目標・当月累計実績・達成率・当日実績を返す。戻り値: { ok, date, month, kpis: [{id, title, unit, period, monthlyTarget, monthly_actual, today_actual, pct, kgiId}], kgis: [{id, title, target, unit, current}] }",
    {
      date: z
        .string()
        .optional()
        .describe(
          "基準日（ISO 日付 例: 2026-05-05）。省略時は今日（JST）"
        ),
    },
    async (args) => {
      const uid = env.NAOKI_UID;
      if (!uid || !env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
        throw new Error("Firebase env not configured (NAOKI_UID / FIREBASE_SA_EMAIL / FIREBASE_SA_PRIVATE_KEY)");
      }

      const targetDate = args.date ?? todayJst();
      const year  = targetDate.slice(0, 4);
      const month = targetDate.slice(0, 7); // "YYYY-MM"

      const token = await getFirestoreToken(env);

      // KPI定義・KGI定義・当年の日次データを並行取得
      const [kpis, kgis, dailyByDate] = await Promise.all([
        loadArrayDoc<KpiDef>(token, uid, "os_kpis"),
        loadArrayDoc<KgiDef>(token, uid, "os_kgis"),
        loadDailyYear(token, uid, year),
      ]);

      // 当月累計・当日実績を計算
      const kpiResults = kpis.map((kpi) => {
        let monthlyActual = 0;
        let todayActual = 0;

        for (const [date, rec] of Object.entries(dailyByDate)) {
          const val = rec.kpiValues?.[kpi.id] ?? 0;
          if (date.startsWith(month)) monthlyActual += val;
          if (date === targetDate) todayActual = val;
        }

        const mo  = Number(kpi.monthlyTarget) || 0;
        const pct = mo > 0 ? Math.round((monthlyActual / mo) * 100) : null;

        return {
          id:             kpi.id,
          title:          kpi.title,
          unit:           kpi.unit,
          period:         kpi.period,
          monthlyTarget:  mo,
          monthly_actual: monthlyActual,
          today_actual:   todayActual,
          pct:            pct,
          kgiId:          kpi.kgiId,
        };
      });

      return asMcpTextResult({
        ok:    true,
        date:  targetDate,
        month,
        kpis:  kpiResults,
        kgis:  kgis.map((g) => ({
          id:      g.id,
          title:   g.title,
          target:  g.target,
          unit:    g.unit,
          current: g.current ?? null,
        })),
      });
    }
  );

  // ─── 2. haAku__get_daily_report ───────────────────────────────────────────
  server.tool(
    "haAku__get_daily_report",
    "haAku の指定日の日報を取得する。秘書室の朝レポートで前日の振り返り（目標・達成・反省・改善策）と KPI 実績を確認するときに使う。戻り値: { ok, date, report: {goal, achieved, reflection, improvement}, kpi_values: {kpiId: number}, kpi_labels: {kpiId: {title, unit}} }",
    {
      date: z
        .string()
        .optional()
        .describe(
          "対象日（ISO 日付 例: 2026-05-04）。省略時は昨日（JST）"
        ),
    },
    async (args) => {
      const uid = env.NAOKI_UID;
      if (!uid || !env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
        throw new Error("Firebase env not configured (NAOKI_UID / FIREBASE_SA_EMAIL / FIREBASE_SA_PRIVATE_KEY)");
      }

      const targetDate = args.date ?? yesterdayJst();
      const year = targetDate.slice(0, 4);

      const token = await getFirestoreToken(env);

      // KPI定義・当年日次データを並行取得
      const [kpis, dailyByDate] = await Promise.all([
        loadArrayDoc<KpiDef>(token, uid, "os_kpis"),
        loadDailyYear(token, uid, year),
      ]);

      const rec = dailyByDate[targetDate] ?? {};

      // KPIラベルマップ（秘書Claudeが kpi_values を読めるように）
      const kpiLabels: Record<string, { title: string; unit: string }> = {};
      for (const kpi of kpis) {
        kpiLabels[kpi.id] = { title: kpi.title, unit: kpi.unit };
      }

      return asMcpTextResult({
        ok:   true,
        date: targetDate,
        report: {
          goal:        rec.report?.goal        ?? null,
          achieved:    rec.report?.achieved    ?? null,
          reflection:  rec.report?.reflection  ?? null,
          improvement: rec.report?.improvement ?? null,
        },
        kpi_values: rec.kpiValues ?? {},
        kpi_labels: kpiLabels,
      });
    }
  );
}
