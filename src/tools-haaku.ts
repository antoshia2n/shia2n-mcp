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
  period?: string;
  deadline?: string;
  // 2026-08-17 追加：画面側で上位の目標を 2 段に分けたため、その 2 欄を読めるようにした。
  //   parentKgiId … 空なら 1 段目（最終目標）、他の目標の id が入っていれば 2 段目（事業の目標）
  //   hidden      … true ならホームと一覧から外している（数字と過去の記録は残っている）
  // どちらもこの道具からは書き換えない。書き換えるのは画面だけ。
  parentKgiId?: string;
  hidden?: boolean;
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

// ─── 目標値の書き換え用（2026-08-05 追加） ───────────────────────────────────
//
// 依頼書：3b39c6c1-c439-815f-817f-f690ff7fdd39
// 日報の口では実績と現在値しか書けず、目標値は画面からしか直せなかった。
// 人も AI も直せる状態にするため、目標値を書き換える口を分けて足す。
//
// 消す口は作らない。目標を消すと、そこにぶら下がる手前の数字の行き先が
// 黙って無くなるため。置き直すときは名前と値の書き換えで足りる。

const KGI_PERIODS = ["annual", "monthly", "weekly", "daily"];

// 手前の数字が取れる期間。画面の選択肢と同じ（2026-08-17 実測：
// 登録されている 8 本はすべて daily / weekly / monthly のいずれか）。
const KPI_PERIODS = ["daily", "weekly", "monthly"];

/**
 * 日ごとの記録は年ごとの文書（os_daily_{年}）に分かれている。
 * 欄を消す前に「その欄の数字がすでに入っていないか」を数えるとき、
 * どの年まで遡って見るかの下限。これより前の年は見ていないため、
 * 数えた年の一覧を戻り値に入れて、どこまで見たかが分かるようにしてある。
 */
const DAILY_SCAN_FROM_YEAR = 2024;

/**
 * 把握くんの画面が付けているのと同じ形の id を作る。
 * 形：id_{協定世界時のミリ秒}_{英数字5文字}
 * 2026-08-17 実測：登録されている 8 本すべてがこの形（例 id_1786027582369_5v247）。
 */
function makeHaakuId(): string {
  const tail = Math.random().toString(36).slice(2, 7).padEnd(5, "0");
  return `id_${Date.now()}_${tail}`;
}

interface KgiGoalPatch {
  id?: string;
  title?: string;
  new_title?: string;
  target?: string;
  unit?: string;
  period?: string;
  deadline?: string;
}

interface KpiGoalPatch {
  id?: string;
  title?: string;
  new_title?: string;
  monthly_target?: string; // "" ＝ 目標を外す
  unit?: string;
}

function parseJsonArray(raw: string, field: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${field} が JSON として読めません（受け取った値: ${raw}）`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${field} は配列で渡してください`);
  }
  return parsed.map((item, i) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`${field} の ${i + 1} 件目が読めません`);
    }
    return item as Record<string, unknown>;
  });
}

/** 数値でも文字列でも受け取り、保存の形（文字列）にそろえる */
function toTargetString(v: unknown, label: string): string {
  if (v === null) return "";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`${label} の値が数値として読めません`);
    return String(v);
  }
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return "";
    if (!Number.isFinite(Number(t))) {
      throw new Error(`${label} は数値で渡してください（受け取った値: ${v}）`);
    }
    return t;
  }
  throw new Error(`${label} の値が読めません`);
}

function parseKgiGoals(raw?: string): KgiGoalPatch[] {
  if (!raw) return [];
  return parseJsonArray(raw, "kgi_goals_json").map((o, i) => {
    const nth = `kgi_goals_json の ${i + 1} 件目`;
    const patch: KgiGoalPatch = {};
    if (typeof o.id === "string") patch.id = o.id;
    if (typeof o.title === "string") patch.title = o.title;
    if (!patch.id && !patch.title) throw new Error(`${nth} に id も title もありません`);

    if ("new_title" in o) {
      if (typeof o.new_title !== "string" || o.new_title.trim() === "") {
        throw new Error(`${nth} の new_title が空です`);
      }
      patch.new_title = o.new_title;
    }
    if ("target" in o) patch.target = toTargetString(o.target, `${nth} の target`);
    if ("unit" in o) {
      if (typeof o.unit !== "string") throw new Error(`${nth} の unit は文字で渡してください`);
      patch.unit = o.unit;
    }
    if ("period" in o) {
      if (typeof o.period !== "string" || !KGI_PERIODS.includes(o.period)) {
        throw new Error(`${nth} の period は ${KGI_PERIODS.join(" / ")} のいずれかで渡してください`);
      }
      patch.period = o.period;
    }
    if ("deadline" in o) {
      if (typeof o.deadline !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.deadline)) {
        throw new Error(`${nth} の deadline は YYYY-MM-DD 形式で渡してください`);
      }
      patch.deadline = o.deadline;
    }
    const touched = ["new_title", "target", "unit", "period", "deadline"].some((k) => k in patch);
    if (!touched) throw new Error(`${nth} に変更する項目がありません`);
    return patch;
  });
}

function parseKpiGoals(raw?: string): KpiGoalPatch[] {
  if (!raw) return [];
  return parseJsonArray(raw, "kpi_goals_json").map((o, i) => {
    const nth = `kpi_goals_json の ${i + 1} 件目`;
    const patch: KpiGoalPatch = {};
    if (typeof o.id === "string") patch.id = o.id;
    if (typeof o.title === "string") patch.title = o.title;
    if (!patch.id && !patch.title) throw new Error(`${nth} に id も title もありません`);

    if ("new_title" in o) {
      if (typeof o.new_title !== "string" || o.new_title.trim() === "") {
        throw new Error(`${nth} の new_title が空です`);
      }
      patch.new_title = o.new_title;
    }
    if ("monthly_target" in o) {
      patch.monthly_target = toTargetString(o.monthly_target, `${nth} の monthly_target`);
    }
    if ("unit" in o) {
      if (typeof o.unit !== "string") throw new Error(`${nth} の unit は文字で渡してください`);
      patch.unit = o.unit;
    }
    const touched = ["new_title", "monthly_target", "unit"].some((k) => k in patch);
    if (!touched) throw new Error(`${nth} に変更する項目がありません`);
    return patch;
  });
}

/**
 * 書き換える相手を1件に絞る。
 * 見つからない・同じ名前が2件ある、のどちらも書き込まずに止める。
 */
function findOneByIdOrTitle<T extends { id: string; title: string }>(
  list: T[],
  patch: { id?: string; title?: string },
  kind: string
): T {
  const names = list.map((x) => x.title).join(" / ");
  if (patch.id) {
    const hit = list.find((x) => x.id === patch.id);
    if (!hit) {
      throw new Error(`${kind}「${patch.id}」が見つかりません。登録されているのは: ${names}。書き込みは行っていません`);
    }
    return hit;
  }
  const hits = list.filter((x) => x.title === patch.title);
  if (hits.length === 0) {
    throw new Error(`${kind}「${patch.title}」が見つかりません。登録されているのは: ${names}。書き込みは行っていません`);
  }
  if (hits.length > 1) {
    throw new Error(`${kind}「${patch.title}」が ${hits.length} 件あります。id で指定してください。書き込みは行っていません`);
  }
  return hits[0];
}

function newHaakuId(): string {
  // 画面が作る id と同じ形（id_ミリ秒_5文字）にそろえる
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
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
    "haAku の KPI 進捗を取得する。秘書室の朝レポートで当月の KPI 達成状況を確認するときに使う。各 KPI の月次目標・当月累計実績・達成率・当日実績を返す。戻り値: { ok, date, month, kpis: [{id, title, unit, period, monthlyTarget, monthly_actual, today_actual, pct, kgiId}], kgis: [{id, title, target, unit, current, parent_kgi_id, hidden}] }。parent_kgi_id が空なら 1 段目（最終目標）、他の目標の id が入っていれば 2 段目（事業の目標）。hidden が true ならホームと一覧から外している（数字は残っている）",
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
          parent_kgi_id: g.parentKgiId ?? null,
          hidden:        g.hidden === true,
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
    "haAku の指定日の日報を書き込む（部分更新）。Naoki が話した内容を4欄と数値に振り分けて記録するときに使う。渡した項目だけ更新し、渡さなかった項目はもとの値を保つ。同じ日に2回目を送っても行は増えず上書きになる。KGI の現在値（メンシプ会員数など）も同じ道具で更新できる。戻り値: { ok, date, updated, report: {goal, achieved, reflection, improvement}, kpi_values: {kpiId: number}, kpi_labels: {kpiId: {title, unit}}, kgis: [{id, title, target, unit, current, parent_kgi_id, hidden}] }（すべて書き込んだあとに読み直した値）",
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
          parent_kgi_id: g.parentKgiId ?? null,
          hidden:        g.hidden === true,
        })),
      });
    }
  );

  // ─── 4. haAku__update_goals ───────────────────────────────────────────────
  server.tool(
    "haAku__update_goals",
    "haAku の目標値（上位の目標の目標値・手前の数字の月次目標）を書き換える。実績や現在値ではなく「目標そのもの」を直すときに使う。日報の口（haAku__update_daily_report）では目標値は変えられないため、こちらを使う。渡した項目だけ更新し、渡さなかった項目はもとの値を保つ。対象が見つからない・同じ名前が複数ある場合は、何も書かずに止める。月次目標を外すときは monthly_target に null を渡す。戻り値: { ok, updated, kgis: [{id, title, target, unit, period, deadline, current}], kpis: [{id, title, unit, monthlyTarget, kgiId}] }（すべて書き込んだあとに読み直した値）",
    {
      kgi_goals_json: z
        .string()
        .optional()
        .describe(
          '上位の目標の書き換え。JSON 配列で渡す。例: [{"title":"月商150万","new_title":"着金 月100万","target":100,"unit":"万円"}]。' +
          "id か title のどちらかで相手を指定する。変えられるのは new_title / target / unit / period / deadline。" +
          "period は annual / monthly / weekly / daily。target に空文字を渡すと値なし（未設定）になる"
        ),
      kpi_goals_json: z
        .string()
        .optional()
        .describe(
          '手前の数字の月次目標の書き換え。JSON 配列で渡す。例: [{"title":"しあらぼ新規契約","monthly_target":2}]。' +
          "id か title のどちらかで相手を指定する。変えられるのは new_title / monthly_target / unit。" +
          "monthly_target に null を渡すと月次目標を外す（実績だけをためる形になる）"
        ),
    },
    async (args) => {
      const uid = env.NAOKI_UID;
      if (!uid || !env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
        throw new Error("Firebase env not configured (NAOKI_UID / FIREBASE_SA_EMAIL / FIREBASE_SA_PRIVATE_KEY)");
      }

      // 入力の解釈を先に済ませる（保存先を触る前に落とす）
      const kgiPatches = parseKgiGoals(args.kgi_goals_json);
      const kpiPatches = parseKpiGoals(args.kpi_goals_json);
      if (kgiPatches.length === 0 && kpiPatches.length === 0) {
        throw new Error("更新する項目が1つもありません（kgi_goals_json か kpi_goals_json のどちらかを渡してください）");
      }

      const token = await getFirestoreToken(env);
      const kgiPath = `users/${uid}/app_data/os_kgis`;
      const kpiPath = `users/${uid}/app_data/os_kpis`;
      const updated: string[] = [];

      // ─ 上位の目標 ─
      if (kgiPatches.length > 0) {
        const kgis = await loadArrayDocStrict<KgiDef>(token, uid, "os_kgis");
        if (kgis.length === 0) {
          throw new Error("上位の目標が1件も読み取れませんでした。書き込みは行っていません");
        }
        const next = kgis.map((g) => ({ ...g }));
        for (const patch of kgiPatches) {
          const hit = findOneByIdOrTitle(next, patch, "上位の目標");
          const before = hit.title;
          if (patch.new_title !== undefined) hit.title = patch.new_title;
          if (patch.target !== undefined) hit.target = patch.target;
          if (patch.unit !== undefined) hit.unit = patch.unit;
          if (patch.period !== undefined) hit.period = patch.period;
          if (patch.deadline !== undefined) hit.deadline = patch.deadline;
          updated.push(`kgi:${before}${patch.new_title !== undefined ? ` → ${hit.title}` : ""}`);
        }
        await fsPatch(token, kgiPath, { value: toFVal(next) }, ["value"]);
      }

      // ─ 手前の数字 ─
      if (kpiPatches.length > 0) {
        const kpis = await loadArrayDocStrict<KpiDef>(token, uid, "os_kpis");
        if (kpis.length === 0) {
          throw new Error("手前の数字が1件も読み取れませんでした。書き込みは行っていません");
        }
        const next = kpis.map((k) => ({ ...k }));
        for (const patch of kpiPatches) {
          const hit = findOneByIdOrTitle(next, patch, "手前の数字");
          const before = hit.title;
          if (patch.new_title !== undefined) hit.title = patch.new_title;
          if (patch.monthly_target !== undefined) hit.monthlyTarget = patch.monthly_target;
          if (patch.unit !== undefined) hit.unit = patch.unit;
          updated.push(
            `kpi:${before}${patch.monthly_target === "" ? "（月次目標を外した）" : ""}`
          );
        }
        await fsPatch(token, kpiPath, { value: toFVal(next) }, ["value"]);
      }

      // ─ 書いたあとに読み直して、その値をそのまま返す ─
      const [kgisAfter, kpisAfter] = await Promise.all([
        loadArrayDoc<KgiDef>(token, uid, "os_kgis"),
        loadArrayDoc<KpiDef>(token, uid, "os_kpis"),
      ]);

      return asMcpTextResult({
        ok: true,
        updated,
        kgis: kgisAfter.map((g) => ({
          id:       g.id,
          title:    g.title,
          target:   g.target,
          unit:     g.unit,
          period:   g.period ?? null,
          deadline: g.deadline ?? null,
          current:  g.current ?? null,
          parent_kgi_id: g.parentKgiId ?? null,
          hidden:        g.hidden === true,
        })),
        kpis: kpisAfter.map((k) => ({
          id:            k.id,
          title:         k.title,
          unit:          k.unit,
          monthlyTarget: k.monthlyTarget ?? "",
          kgiId:         k.kgiId,
        })),
      });
    }
  );

  // ─── 5. haAku__add_kgi ────────────────────────────────────────────────────
  server.tool(
    "haAku__add_kgi",
    "haAku に上位の目標（KGI）を1本追加する。目標の器を作るときに使う。値がまだ決まっていない場合は target を渡さなければ空のまま作れる。同じ名前がすでにある場合は、何も書かずに止める。戻り値: { ok, added: {id, title}, kgis: [{id, title, target, unit, period, deadline, current, parent_kgi_id, hidden}] }（書き込んだあとに読み直した値）",
    {
      title: z
        .string()
        .describe("上位の目標の名前。必須。すでに同じ名前があるときは追加しない"),
      target: z
        .string()
        .optional()
        .describe("目標値。数字を文字で渡す（例: 100）。渡さなければ空のまま作る"),
      unit: z
        .string()
        .optional()
        .describe("単位（例: 万円 / 名）。渡さなければ空のまま作る"),
      period: z
        .string()
        .optional()
        .describe("期間。annual / monthly / weekly / daily のいずれか。省略時は monthly"),
      deadline: z
        .string()
        .optional()
        .describe("期限（ISO 日付 例: 2026-12-31）。渡さなければ設定しない"),
      color: z
        .string()
        .optional()
        .describe("画面での色（例: #41C9A2）。渡さなければ画面の既定の色で表示される"),
    },
    async (args) => {
      const uid = env.NAOKI_UID;
      if (!uid || !env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
        throw new Error("Firebase env not configured (NAOKI_UID / FIREBASE_SA_EMAIL / FIREBASE_SA_PRIVATE_KEY)");
      }

      const title = args.title.trim();
      if (title === "") throw new Error("title が空です");

      const period = args.period ?? "monthly";
      if (!KGI_PERIODS.includes(period)) {
        throw new Error(`period は ${KGI_PERIODS.join(" / ")} のいずれかで渡してください（受け取った値: ${period}）`);
      }
      if (args.deadline !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(args.deadline)) {
        throw new Error(`deadline は YYYY-MM-DD 形式で渡してください（受け取った値: ${args.deadline}）`);
      }
      const target = args.target === undefined ? "" : toTargetString(args.target, "target");

      const token = await getFirestoreToken(env);
      const kgiPath = `users/${uid}/app_data/os_kgis`;

      const kgis = await loadArrayDocStrict<KgiDef>(token, uid, "os_kgis");
      if (kgis.some((g) => g.title === title)) {
        throw new Error(`「${title}」はすでにあります。追加は行っていません（値を変えるなら haAku__update_goals を使う）`);
      }

      const created: KgiDef = {
        id:     newHaakuId(),
        title,
        target,
        unit:   args.unit ?? "",
        color:  args.color ?? "",
        period,
      };
      if (args.deadline !== undefined) created.deadline = args.deadline;

      await fsPatch(token, kgiPath, { value: toFVal([...kgis, created]) }, ["value"]);

      const kgisAfter = await loadArrayDoc<KgiDef>(token, uid, "os_kgis");

      return asMcpTextResult({
        ok: true,
        added: { id: created.id, title: created.title },
        kgis: kgisAfter.map((g) => ({
          id:       g.id,
          title:    g.title,
          target:   g.target,
          unit:     g.unit,
          period:   g.period ?? null,
          deadline: g.deadline ?? null,
          current:  g.current ?? null,
          parent_kgi_id: g.parentKgiId ?? null,
          hidden:        g.hidden === true,
        })),
      });
    }
  );

  // ─── 6. haAku__add_kpi ────────────────────────────────────────────────────
  //
  // 2026-08-17 追加。これまで手前の数字（KPI）を新しく作る口が無く、
  // 画面からしか足せなかった。毎晩の自動で埋める欄を足すたびに Naoki の手が
  // 1 回増えるため、作る側も道具から通す。
  //
  // 消す口は 2026-08-17 に足した（下の haAku__remove_kpi）。
  // 同じ日の午前に「消す口は作らない・要らなくなったら名前と月次目標の
  // 書き換えで足りる」と書いたが、これは当たっていなかった。
  // 名前や月次目標を書き換えても、欄は画面に出続けるため。
  server.tool(
    "haAku__add_kpi",
    "haAku に手前の数字（KPI）を 1 本追加する。日ごとに実績を積む欄の器を作るときに使う。" +
      "同じ名前がすでにあるときは、何も書かずに止める。ぶら下げる上位の目標は kgi_id か kgi_title の" +
      "どちらかで指定し、指定が無いときは何も書かずに止める（行き先の無い欄を作らないため）。" +
      "月次目標は省略できる（実績だけをためる形になる）。" +
      "戻り値: { ok, added: {id, title}, kpis: [{id, title, unit, period, monthlyTarget, kgiId}] }（書き込んだあとに読み直した値）",
    {
      title: z.string().describe("手前の数字の名前。必須。すでに同じ名前があるときは追加しない"),
      kgi_id: z
        .string()
        .optional()
        .describe("ぶら下げる上位の目標の id。haAku__get_kpi_progress の kgis で確認する"),
      kgi_title: z
        .string()
        .optional()
        .describe("ぶら下げる上位の目標の名前。id の代わりに使える。同じ名前が複数あるときは止まる"),
      unit: z.string().optional().describe("単位（例: 名 / インプ / 本）。渡さなければ空のまま作る"),
      period: z
        .string()
        .optional()
        .describe("期間。daily / weekly / monthly のいずれか。省略時は daily"),
      monthly_target: z
        .string()
        .optional()
        .describe("月次目標。数字を文字で渡す（例: 30）。渡さなければ目標なしで作る"),
      color: z.string().optional().describe("画面での色（例: #41C9A2）。渡さなければ空のまま作る"),
    },
    async (args) => {
      const uid = env.NAOKI_UID;
      if (!uid || !env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
        throw new Error("Firebase env not configured (NAOKI_UID / FIREBASE_SA_EMAIL / FIREBASE_SA_PRIVATE_KEY)");
      }

      const title = args.title.trim();
      if (!title) throw new Error("title が空です。書き込みは行っていません");

      const period = args.period ?? "daily";
      if (!KPI_PERIODS.includes(period)) {
        throw new Error(
          `period は ${KPI_PERIODS.join(" / ")} のいずれかで渡してください（受け取った値: ${period}）`
        );
      }

      if (!args.kgi_id && !args.kgi_title) {
        throw new Error(
          "ぶら下げる上位の目標が指定されていません（kgi_id か kgi_title のどちらかが要ります）。書き込みは行っていません"
        );
      }

      const token = await getFirestoreToken(env);
      const kpiPath = `users/${uid}/app_data/os_kpis`;

      const [kpis, kgis] = await Promise.all([
        loadArrayDocStrict<KpiDef>(token, uid, "os_kpis"),
        loadArrayDocStrict<KgiDef>(token, uid, "os_kgis"),
      ]);

      if (kgis.length === 0) {
        throw new Error("上位の目標が 1 件も読み取れませんでした。書き込みは行っていません");
      }

      // 行き先の上位の目標を決める
      let kgiId: string;
      if (args.kgi_id) {
        const hit = kgis.find((g) => g.id === args.kgi_id);
        if (!hit) {
          const names = kgis.map((g) => `${g.title}(${g.id})`).join(" / ");
          throw new Error(
            `指定された上位の目標が見つかりません（id=${args.kgi_id}）。登録されているもの: ${names}。書き込みは行っていません`
          );
        }
        kgiId = hit.id;
      } else {
        const hits = kgis.filter((g) => g.title === args.kgi_title);
        if (hits.length === 0) {
          const names = kgis.map((g) => g.title).join(" / ");
          throw new Error(
            `指定された上位の目標が見つかりません（title=${args.kgi_title}）。登録されているもの: ${names}。書き込みは行っていません`
          );
        }
        if (hits.length > 1) {
          throw new Error(
            `上位の目標「${args.kgi_title}」が ${hits.length} 件あります。id で指定してください。書き込みは行っていません`
          );
        }
        kgiId = hits[0].id;
      }

      // 同じ名前があるなら足さない
      const dup = kpis.find((k) => k.title === title);
      if (dup) {
        throw new Error(
          `手前の数字「${title}」はすでにあります（id=${dup.id}）。書き込みは行っていません`
        );
      }

      const newKpi: KpiDef = {
        id: makeHaakuId(),
        title,
        unit: args.unit ?? "",
        monthlyTarget: args.monthly_target ?? "",
        period,
        color: args.color ?? "",
        kgiId,
      };

      const next = [...kpis.map((k) => ({ ...k })), newKpi];
      await fsPatch(token, kpiPath, { value: toFVal(next) }, ["value"]);

      // 書いたあとに読み直して、入ったことを確かめてから返す
      const after = await loadArrayDoc<KpiDef>(token, uid, "os_kpis");
      const saved = after.find((k) => k.id === newKpi.id);
      if (!saved) {
        throw new Error(
          `書いたあとの読み直しで「${title}」が見つかりませんでした（id=${newKpi.id}）。保存されていない可能性があります`
        );
      }

      return asMcpTextResult({
        ok: true,
        added: { id: saved.id, title: saved.title },
        kpis: after.map((k) => ({
          id: k.id,
          title: k.title,
          unit: k.unit,
          period: k.period,
          monthlyTarget: k.monthlyTarget,
          kgiId: k.kgiId,
        })),
      });
    }
  );

  // ─── 7. haAku__remove_kpi ─────────────────────────────────────────────────
  //
  // 2026-08-17 追加。手前の数字を画面から 1 本外すための口。
  //
  // 外す印（hidden）を持っているのは上位の目標だけで、手前の数字は持っていない。
  // 画面は登録されている手前の数字をそのまま並べるため、名前を変えても
  // 月次目標を外しても出続ける。親ごと隠す手も、親を使い続けているときは
  // 使えない（例：インプ（日次）の親は X収益で、X収益は残す）。
  // したがって画面から外す道は「欄そのものを消す」しかない。
  //
  // ただし「消すと日ごとの記録の行き先が黙って無くなる」という心配は残る。
  // そこで、その欄の数字が日ごとの記録に 1 件でも入っていれば既定では消さず、
  // 件数を添えて止める。それでも消すときだけ remove_anyway を渡してもらう。
  // 消すのは欄の定義だけで、日ごとの記録には手を触れない（数字は残る）。
  server.tool(
    "haAku__remove_kpi",
    "haAku から手前の数字（KPI）を 1 本消す。画面に出さなくするときに使う。" +
      "消すのは欄の定義だけで、日ごとの記録に入っている数字には触れない（数字はそのまま残る）。" +
      "既定では、日ごとの記録にその欄の数字が 1 件でも入っていれば、件数を添えて何も書かずに止める。" +
      "それでも消すときは remove_anyway に true を渡す。" +
      "相手は id か title のどちらかで指定し、見つからない・同じ名前が複数あるときは何も書かずに止める。" +
      "戻り値: { ok, removed: {id, title, value_count, scanned_years}, kpis: [{id, title, unit, period, monthlyTarget, kgiId}] }（書き込んだあとに読み直した値）",
    {
      id: z
        .string()
        .optional()
        .describe("消す手前の数字の id。haAku__get_kpi_progress の kpis で確認する"),
      title: z
        .string()
        .optional()
        .describe("消す手前の数字の名前。id の代わりに使える。同じ名前が複数あるときは止まる"),
      remove_anyway: z
        .boolean()
        .optional()
        .describe(
          "日ごとの記録に数字が入っていても消すときだけ true を渡す。省略時は false（数字があれば消さずに止める）"
        ),
    },
    async (args) => {
      const uid = env.NAOKI_UID;
      if (!uid || !env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
        throw new Error("Firebase env not configured (NAOKI_UID / FIREBASE_SA_EMAIL / FIREBASE_SA_PRIVATE_KEY)");
      }

      if (!args.id && !args.title) {
        throw new Error(
          "消す相手が指定されていません（id か title のどちらかが要ります）。書き込みは行っていません"
        );
      }

      const token = await getFirestoreToken(env);
      const kpiPath = `users/${uid}/app_data/os_kpis`;

      const kpis = await loadArrayDocStrict<KpiDef>(token, uid, "os_kpis");
      if (kpis.length === 0) {
        throw new Error("手前の数字が 1 件も読み取れませんでした。書き込みは行っていません");
      }

      const target = findOneByIdOrTitle(kpis, { id: args.id, title: args.title }, "手前の数字");

      // 日ごとの記録に、この欄の数字がすでに入っていないかを先に数える
      const thisYear = Number(todayJst().slice(0, 4));
      const scannedYears: string[] = [];
      let valueCount = 0;
      for (let y = DAILY_SCAN_FROM_YEAR; y <= thisYear; y++) {
        const year = String(y);
        scannedYears.push(year);
        const daily = await loadDailyYearStrict(token, uid, year);
        for (const rec of Object.values(daily)) {
          if (typeof rec?.kpiValues?.[target.id] === "number") valueCount++;
        }
      }

      if (valueCount > 0 && args.remove_anyway !== true) {
        throw new Error(
          `手前の数字「${target.title}」には日ごとの記録が ${valueCount} 件あります` +
            `（${scannedYears.join(" / ")} 年を確認）。欄を消すと、この数字の行き先が無くなります。` +
            "それでも消すときは remove_anyway に true を渡してください。書き込みは行っていません"
        );
      }

      const next = kpis.filter((k) => k.id !== target.id).map((k) => ({ ...k }));
      await fsPatch(token, kpiPath, { value: toFVal(next) }, ["value"]);

      // 書いたあとに読み直して、消えたことと本数を確かめてから返す
      const after = await loadArrayDoc<KpiDef>(token, uid, "os_kpis");
      if (after.some((k) => k.id === target.id)) {
        throw new Error(
          `書いたあとの読み直しで「${target.title}」がまだ残っています（id=${target.id}）。消えていない可能性があります`
        );
      }
      if (after.length !== kpis.length - 1) {
        throw new Error(
          `書いたあとの読み直しで本数が合いません（消す前 ${kpis.length} 本 / 消したあと ${after.length} 本）`
        );
      }

      return asMcpTextResult({
        ok: true,
        removed: {
          id: target.id,
          title: target.title,
          value_count: valueCount,
          scanned_years: scannedYears,
        },
        kpis: after.map((k) => ({
          id: k.id,
          title: k.title,
          unit: k.unit,
          period: k.period,
          monthlyTarget: k.monthlyTarget,
          kgiId: k.kgiId,
        })),
      });
    }
  );
}

// ─── 上位の目標の現在値だけを書き換える（2026-08-16 追加・毎晩の処理から使う） ──
//
// 依頼書：https://www.notion.so/3be9c6c1c439818992dccf7adb533c5a
// 判断記録：https://www.notion.so/3be9c6c1c439811880f1f73726d4bae2
//
// haAku__update_daily_report と同じ場所（users/{uid}/app_data/os_kgis）へ書く。
// 道具の側の作りは変えていない。毎晩の処理から同じ書き方を使い回すために、
// 現在値の書き換えだけを関数として切り出した。
//
// 日報の 4 欄と手前の数字には触れない。指定した id が見つからなければ、
// 1 件も書かずに止める（半分だけ入った状態を作らないため）。
export async function applyKgiCurrents(
  env: Env,
  patches: { id: string; current: number }[]
): Promise<{ id: string; title: string; current: number | null }[]> {
  if (patches.length === 0) return [];

  const uid = env.NAOKI_UID;
  if (!uid || !env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
    throw new Error(
      "Firebase env not configured (NAOKI_UID / FIREBASE_SA_EMAIL / FIREBASE_SA_PRIVATE_KEY)"
    );
  }

  const token   = await getFirestoreToken(env);
  const kgiPath = `users/${uid}/app_data/os_kgis`;

  const kgis = await loadArrayDocStrict<KgiDef>(token, uid, "os_kgis");
  if (kgis.length === 0) {
    throw new Error("上位の目標が 1 件も読み取れませんでした。書き込みは行っていません");
  }

  const next = kgis.map((g) => ({ ...g }));
  for (const patch of patches) {
    if (!Number.isFinite(patch.current)) {
      throw new Error(
        `上位の目標「${patch.id}」に渡された値が数値ではありません。書き込みは行っていません`
      );
    }
    const hit = next.find((g) => g.id === patch.id);
    if (!hit) {
      const names = next.map((g) => `${g.title}(${g.id})`).join(" / ");
      throw new Error(
        `指定された上位の目標が見つかりません（id=${patch.id}）。登録されているもの: ${names}。書き込みは行っていません`
      );
    }
    hit.current = patch.current;
  }

  await fsPatch(token, kgiPath, { value: toFVal(next) }, ["value"]);

  // 書いたあとに読み直して、入った値をそのまま返す
  const after = await loadArrayDoc<KgiDef>(token, uid, "os_kgis");
  return after
    .filter((g) => patches.some((p) => p.id === g.id))
    .map((g) => ({ id: g.id, title: g.title, current: g.current ?? null }));
}

// 手前の数字の実績を日ごとに書き込む口（applyKpiDailyValues）と、
// 名前から id を引く口（listKpiDefs）は 2026-08-17 に落とした。
// 同じ日の午前に足したもので、呼んでいたのは毎晩 3:30 のインプ（日次）だけ。
// その処理を外したため呼び元が 0 になった。
// 日ごとの実績を書く道は haAku__update_daily_report に残っている。
