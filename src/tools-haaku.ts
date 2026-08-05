import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { getFirestoreToken, fsGet, fsPatch, toFVal, fromVal, type FVal, type FSDoc } from "./taskmaster.js";

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
 *
 * 2026-08-05：日報の書き込み口 haAku__update_daily_report を追加。
 *   根拠：判断記録「日報の書き込みだけ先に開ける」（3b39c6c1-c439-817a-8a62-f0ca9719dd2a）
 *   開ける範囲は日報4欄・KPI 実績・KGI 現在値のみ。
 *   しあらぼ・会員データ・決済に紐づく更新は凍結のまま（この口では触れない）。
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

// ─── 書き込み用ヘルパー（読めなかったら書かない） ─────────────────────────────
//
// 読み取り側の loadArrayDoc / loadDailyYear は、失敗しても空を返す作りになっている。
// 書き込みでは同じ作りを使えない。読み取りに失敗したことに気づかず空を書き戻すと、
// 1年分の日報や KGI 定義がまるごと消えるため、ここでは
// 「文書がまだ無い（404）＝空」と「読めなかった＝中断」を分ける。

async function fsGetOrNull(token: string, path: string): Promise<FSDoc | null> {
  try {
    return await fsGet(token, path);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (msg.includes("404")) return null; // まだ1件も無い状態
    throw new Error(`把握くんの保存先を読めませんでした。書き込みは行っていません（${msg}）`);
  }
}

async function loadArrayDocStrict<T>(token: string, uid: string, key: string): Promise<T[]> {
  const doc = await fsGetOrNull(token, `users/${uid}/app_data/${key}`);
  if (!doc) return [];
  const fields = doc.fields ?? {};
  if (!("value" in fields)) return [];
  const expanded = fromVal(fields["value"] as FVal);
  return Array.isArray(expanded) ? (expanded as T[]) : [];
}

async function loadDailyYearStrict(
  token: string,
  uid: string,
  year: string
): Promise<Record<string, DailyRecord>> {
  const doc = await fsGetOrNull(token, `users/${uid}/app_data/os_daily_${year}`);
  if (!doc) return {};
  const fields = doc.fields ?? {};
  if (!("value" in fields)) return {};
  const expanded = fromVal(fields["value"] as FVal);
  if (typeof expanded !== "object" || expanded === null || Array.isArray(expanded)) return {};
  return expanded as Record<string, DailyRecord>;
}

// ─── 入力の解釈（保存先を触る前に落とす） ────────────────────────────────────

function parseKpiValues(raw?: string): Record<string, number> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`kpi_values_json が JSON として読めません（受け取った値: ${raw}）`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error('kpi_values_json は {"KPIのid": 数値} の形で渡してください');
  }
  const out: Record<string, number> = {};
  for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) {
      throw new Error(`KPI「${id}」の値が数値ではありません（受け取った値: ${String(v)}）`);
    }
    out[id] = n;
  }
  return out;
}

function parseKgiCurrents(raw?: string): { id?: string; title?: string; current: number }[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`kgi_currents_json が JSON として読めません（受け取った値: ${raw}）`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('kgi_currents_json は [{"title":"名前","current":数値}] の形で渡してください');
  }
  return parsed.map((item, i) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`kgi_currents_json の ${i + 1} 件目が読めません`);
    }
    const o = item as Record<string, unknown>;
    const id    = typeof o.id    === "string" ? o.id    : undefined;
    const title = typeof o.title === "string" ? o.title : undefined;
    if (!id && !title) {
      throw new Error(`kgi_currents_json の ${i + 1} 件目に id も title もありません`);
    }
    const n = typeof o.current === "number" ? o.current : Number(o.current);
    if (!Number.isFinite(n)) {
      throw new Error(`kgi_currents_json の ${i + 1} 件目の current が数値ではありません`);
    }
    return { id, title, current: n };
  });
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

  // ─── 3. haAku__update_daily_report ────────────────────────────────────────
  server.tool(
    "haAku__update_daily_report",
    "haAku の指定日の日報を書き込む（部分更新）。Naoki が話した内容を4欄と数値に振り分けて記録するときに使う。渡した項目だけ更新し、渡さなかった項目はもとの値を保つ。同じ日に2回目を送っても行は増えず上書きになる。KGI の現在値（メンシプ会員数など）も同じ道具で更新できる。戻り値: { ok, date, updated, report: {goal, achieved, reflection, improvement}, kpi_values: {kpiId: number}, kpi_labels: {kpiId: {title, unit}}, kgis: [{id, title, target, unit, current}] }（すべて書き込んだあとに読み直した値）",
    {
      date: z
        .string()
        .describe("対象日（ISO 日付 例: 2026-08-04）。必須。省略や曖昧な指定は受け付けない"),
      goal: z
        .string()
        .optional()
        .describe("今日の目標。渡さなければ既存の値を保つ"),
      achieved: z
        .string()
        .optional()
        .describe("達成したこと。渡さなければ既存の値を保つ"),
      reflection: z
        .string()
        .optional()
        .describe("反省。渡さなければ既存の値を保つ"),
      improvement: z
        .string()
        .optional()
        .describe("改善策。渡さなければ既存の値を保つ"),
      kpi_values_json: z
        .string()
        .optional()
        .describe(
          'KPI の実績。JSON 文字列で渡す。例: {"id_1776468471861_29p4q": 3}。' +
          "渡した KPI だけ更新し、渡さなかった KPI の値は残る。id は haAku__get_kpi_progress で確認する"
        ),
      kgi_currents_json: z
        .string()
        .optional()
        .describe(
          'KGI の現在値。JSON 配列で渡す。例: [{"title":"メンシプ会員数","current":30}]。' +
          "id か title のどちらかで指定する。渡した KGI だけ更新する"
        ),
    },
    async (args) => {
      const uid = env.NAOKI_UID;
      if (!uid || !env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
        throw new Error("Firebase env not configured (NAOKI_UID / FIREBASE_SA_EMAIL / FIREBASE_SA_PRIVATE_KEY)");
      }

      const targetDate = args.date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
        throw new Error(`date は YYYY-MM-DD 形式で渡してください（受け取った値: ${targetDate}）`);
      }
      const year = targetDate.slice(0, 4);

      // 入力の JSON を先に解釈する（保存先を触る前に落とす）
      const kpiPatch = parseKpiValues(args.kpi_values_json);
      const kgiPatch = parseKgiCurrents(args.kgi_currents_json);

      const hasReportPatch =
        args.goal        !== undefined ||
        args.achieved    !== undefined ||
        args.reflection  !== undefined ||
        args.improvement !== undefined;

      if (!hasReportPatch && Object.keys(kpiPatch).length === 0 && kgiPatch.length === 0) {
        throw new Error("更新する項目が1つもありません（4欄・KPI・KGI のいずれかを渡してください）");
      }

      const token = await getFirestoreToken(env);

      const dailyPath = `users/${uid}/app_data/os_daily_${year}`;
      const kgiPath   = `users/${uid}/app_data/os_kgis`;

      const updated: string[] = [];

      // ─ 日報（4欄・KPI 実績）─
      if (hasReportPatch || Object.keys(kpiPatch).length > 0) {
        // 既存の1年分をまるごと読み、その日の分だけ差し替えて書き戻す。
        // 読めなかった場合は書き込まない（空で上書きして1年分を消さないため）。
        const dailyByDate = await loadDailyYearStrict(token, uid, year);

        const prev       = dailyByDate[targetDate] ?? {};
        const prevReport = prev.report ?? {};

        const nextReport = { ...prevReport };
        if (args.goal        !== undefined) { nextReport.goal        = args.goal;        updated.push("goal"); }
        if (args.achieved    !== undefined) { nextReport.achieved    = args.achieved;    updated.push("achieved"); }
        if (args.reflection  !== undefined) { nextReport.reflection  = args.reflection;  updated.push("reflection"); }
        if (args.improvement !== undefined) { nextReport.improvement = args.improvement; updated.push("improvement"); }

        const nextKpiValues = { ...(prev.kpiValues ?? {}), ...kpiPatch };
        for (const id of Object.keys(kpiPatch)) updated.push(`kpi:${id}`);

        const nextRecord: DailyRecord = { ...prev };
        if (Object.keys(nextReport).length > 0) nextRecord.report = nextReport;
        nextRecord.kpiValues = nextKpiValues;

        const nextDaily = { ...dailyByDate, [targetDate]: nextRecord };

        await fsPatch(token, dailyPath, { value: toFVal(nextDaily) }, ["value"]);
      }

      // ─ KGI の現在値 ─
      if (kgiPatch.length > 0) {
        const kgis = await loadArrayDocStrict<KgiDef>(token, uid, "os_kgis");
        if (kgis.length === 0) {
          throw new Error("KGI が1件も読み取れませんでした。現在値の書き込みは行っていません");
        }

        const nextKgis = kgis.map((g) => ({ ...g }));
        for (const patch of kgiPatch) {
          const hit = nextKgis.find(
            (g) => (patch.id && g.id === patch.id) || (patch.title && g.title === patch.title)
          );
          if (!hit) {
            const names = nextKgis.map((g) => g.title).join(" / ");
            throw new Error(
              `指定された KGI が見つかりません（id=${patch.id ?? "なし"} / title=${patch.title ?? "なし"}）。` +
              `登録されている KGI: ${names}。書き込みは行っていません`
            );
          }
          hit.current = patch.current;
          updated.push(`kgi:${hit.title}`);
        }

        await fsPatch(token, kgiPath, { value: toFVal(nextKgis) }, ["value"]);
      }

      // ─ 書いたあとに読み直して、その値をそのまま返す ─
      const [kpis, kgisAfter, dailyAfter] = await Promise.all([
        loadArrayDoc<KpiDef>(token, uid, "os_kpis"),
        loadArrayDoc<KgiDef>(token, uid, "os_kgis"),
        loadDailyYearStrict(token, uid, year),
      ]);

      const recAfter = dailyAfter[targetDate] ?? {};

      const kpiLabels: Record<string, { title: string; unit: string }> = {};
      for (const kpi of kpis) {
        kpiLabels[kpi.id] = { title: kpi.title, unit: kpi.unit };
      }

      return asMcpTextResult({
        ok:      true,
        date:    targetDate,
        updated,
        report: {
          goal:        recAfter.report?.goal        ?? null,
          achieved:    recAfter.report?.achieved    ?? null,
          reflection:  recAfter.report?.reflection  ?? null,
          improvement: recAfter.report?.improvement ?? null,
        },
        kpi_values: recAfter.kpiValues ?? {},
        kpi_labels: kpiLabels,
        kgis: kgisAfter.map((g) => ({
          id:      g.id,
          title:   g.title,
          target:  g.target,
          unit:    g.unit,
          current: g.current ?? null,
        })),
      });
    }
  );
}
