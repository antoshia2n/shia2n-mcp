/**
 * Cron ジョブ：数字の 1 画面（把握くん）を毎晩 1 回入れる
 *
 * cron `0,30 * * * *` の UTC 18:30（JST 03:30）分岐からのみ呼ばれる。
 * cron の枠は増やしていない（既存の 2 本に相乗り）。
 *
 * 依頼書：https://www.notion.so/3be9c6c1c439818992dccf7adb533c5a
 * 判断記録：https://www.notion.so/3be9c6c1c439811880f1f73726d4bae2
 *
 * 入れるのは 3 つ。
 *   着金（入金された月）        … 売上管理の当月の確定を万円に直す（円 ÷ 10000・小数第 1 位）
 *   しあらぼ50名（入会と継続）  … しあらぼ管理の生徒のうち、アーカイブを除いた人数
 *   インプ（日次）              … Buffer の「その日に出した投稿の表示回数」（2026-08-17 追加）
 *
 * 2026-08-17 変更：インプ（日次）を足した。
 *   2026-08-16 の時点では「ContentOS は投稿ごとの累計しか持たず、日ごとの増分を
 *   作れない」として人が入れる側に残していた。その後、Buffer の側が日付の範囲で
 *   返せることを実測で確かめたため、そちらから入れる形にした。
 *   ContentOS に日次を返す口（/api/internal/daily-impressions）を新しく置き、
 *   Buffer の鍵はこれまでどおり ContentOS の設定にだけ置く（2 か所に増やさない）。
 *
 *   入れ直す範囲を 21 日にした理由：Buffer 側の数字は投稿から 19〜20 日ほど
 *   更新が続き、そのあと止まる（2026-08-09 実測・sync-buffer-metrics と同じ根拠）。
 *   前の日ぶんだけを 1 回入れると、翌日以降に伸びた分が入らない。
 *   上書きなので、同じ日を何度入れ直しても二重にはならない。
 *
 *   当日（日本時間）は入れない。03:30 の時点ではその日の投稿がまだ出ていないか、
 *   出ていても数字が 0 のため。前の日までを対象にする。
 *
 * 時刻を JST 03:30 にした理由：
 *   Zeus の取り込み（JST 03:00）とデータの控え（JST 04:00〜06:45）に挟まれた空きで、
 *   翌朝までに必ず終わる。ContentOS の数字の取り込み（JST 12:00）とも重ならない。
 *
 * 失敗したときの扱い（2026-08-17 に決めた）：
 *   着金としあらぼの 2 つは、これまでどおり片方でも取れなければ書かずに throw する。
 *   インプ（日次）は、取れなくても throw しない。理由を記録の文に残して先へ進む。
 *   後から足した欄の不調で、すでに動いている 2 欄が止まるほうが害が大きいため。
 *   欄そのものがまだ無い場合も同じ扱いにする（欄を作る前に仕組みだけ先に入るため）。
 */

import type { Env } from "./index.js";
import { getRevenueSummary } from "./tools-sales-manager.js";
import { applyKgiCurrents, applyKpiDailyValues, listKpiDefs } from "./tools-haaku.js";
import { callContentOsInternalApi } from "./tools-content-os.js";

/** 上位の目標の id。把握くんの画面と同じ値（2026-08-16 実測で確認） */
const KGI_ID_CHAKKIN  = "id_1776467718963_1mkx9"; // 着金（入金された月）・単位は万円
const KGI_ID_SHIARABO = "id_1776468364364_h612e"; // しあらぼ50名（入会と継続）・単位は名

/** 手前の数字の名前。id ではなく名前で引く（欄を作る前でもこの処理を入れておけるため） */
const KPI_TITLE_IMP_DAILY = "インプ（日次）";

/** 何日ぶんを入れ直すか。Buffer 側の数字が伸びなくなるまでの日数に合わせる */
const IMP_BACKFILL_DAYS = 21;

/** 日本時間は協定世界時より 9 時間進んでいる */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

interface ShrStudentRow {
  id: number;
}

interface DailyImpressionsResponse {
  ok?: boolean;
  error?: string;
  date_from?: string;
  date_to?: string;
  days?: { date: string; post_count: number; impressions: number }[];
}

/**
 * しあらぼ管理の生徒のうち、アーカイブを除いた人数を数える。
 * 道具（shiarabo__list_students）と同じ表・同じ絞り込みを使う。
 */
async function countShiaraboStudents(env: Env): Promise<number> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase env not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
  }

  const url = `${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/shr_students?select=id&archived=eq.false`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`しあらぼ管理への接続に失敗しました: ${msg}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`しあらぼ管理の読み取りに失敗しました: ${res.status} ${text.slice(0, 200)}`);
  }

  const rows = (await res.json()) as ShrStudentRow[];
  if (!Array.isArray(rows)) {
    throw new Error("しあらぼ管理の返り値が一覧の形ではありません");
  }
  return rows.length;
}

/** 円を万円に直す。小数第 1 位まで（259000 → 25.9） */
function toManYen(yen: number): number {
  return Math.round((yen / 10000) * 10) / 10;
}

/** 協定世界時のミリ秒を、日本時間の YYYY-MM-DD に直す */
function toJstDateStr(ms: number): string {
  const shifted = new Date(ms + JST_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * インプ（日次）を入れる。
 * 入ったら本数と最後の日の値を、入れられなかったら理由を返す（throw しない）。
 */
async function fillDailyImpressions(env: Env): Promise<{ written: number; note: string }> {
  // ① 欄があるかを先に見る。無ければ何も呼ばずに戻る（Buffer を無駄に叩かない）
  let kpiId: string;
  try {
    const kpis = await listKpiDefs(env);
    const hits = kpis.filter((k) => k.title === KPI_TITLE_IMP_DAILY);
    if (hits.length === 0) {
      return { written: 0, note: "インプ（日次）は欄がまだ無いため入れていません" };
    }
    if (hits.length > 1) {
      return {
        written: 0,
        note: `インプ（日次）の欄が ${hits.length} 個あるため入れていません（1 つに整理が要ります）`,
      };
    }
    kpiId = hits[0].id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      written: 0,
      note: `インプ（日次）は欄を読めなかったため入れていません（${msg.slice(0, 120)}）`,
    };
  }

  // ② 前の日までの 21 日ぶんの範囲を作る（日本時間）
  const now = Date.now();
  const dateTo = toJstDateStr(now - 86400000);
  const dateFrom = toJstDateStr(now - 86400000 * IMP_BACKFILL_DAYS);

  // ③ ContentOS の口から日ごとの数字を取る
  let res: DailyImpressionsResponse;
  try {
    res = await callContentOsInternalApi<DailyImpressionsResponse>(env, "daily-impressions", {
      date_from: dateFrom,
      date_to: dateTo,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      written: 0,
      note: `インプ（日次）は数字を取れなかったため入れていません（${msg.slice(0, 120)}）`,
    };
  }

  if (!res?.ok || !Array.isArray(res.days) || res.days.length === 0) {
    return {
      written: 0,
      note: `インプ（日次）は数字を取れなかったため入れていません（${String(
        res?.error ?? "返り値が空"
      ).slice(0, 120)}）`,
    };
  }

  // ④ 書く。転んでもここで止めず、理由を記録の文に残す
  const entries = res.days.map((d) => ({
    date: d.date,
    kpiId,
    value: Number(d.impressions) || 0,
  }));

  let after: { date: string; kpiId: string; value: number }[];
  try {
    after = await applyKpiDailyValues(env, entries);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { written: 0, note: `インプ（日次）は書き込みに失敗しました（${msg.slice(0, 160)}）` };
  }

  // ⑤ 書いたあとに読み直した値と、入れた値が全件そろっているかを見る
  const mismatched = entries.filter((e) => {
    const hit = after.find((a) => a.date === e.date);
    return !hit || hit.value !== e.value;
  });
  if (mismatched.length > 0) {
    return {
      written: entries.length - mismatched.length,
      note: `インプ（日次）は ${mismatched.length} 日ぶんが読み直しで一致しませんでした（最初の不一致: ${mismatched[0].date}）`,
    };
  }

  const last = entries[entries.length - 1];
  return {
    written: entries.length,
    note:
      `インプ（日次）${dateFrom}〜${dateTo} の ${entries.length} 日ぶんを入れました` +
      `（${last.date} は ${last.value.toLocaleString("ja-JP")}）`,
  };
}

export async function handleHaakuFill(
  env: Env
): Promise<{ count: number | null; detail: string }> {
  // ① 先に 2 つとも取る。片方でも取れなければ、ここで止めて何も書かない。
  const [summary, students] = await Promise.all([
    getRevenueSummary(env),
    countShiaraboStudents(env),
  ]);

  const confirmedYen = summary?.month?.confirmed;
  if (typeof confirmedYen !== "number" || !Number.isFinite(confirmedYen)) {
    throw new Error(
      `売上管理から当月の確定が数値で取れませんでした（受け取った値: ${String(confirmedYen)}）。書き込みは行っていません`
    );
  }

  const chakkinMan = toManYen(confirmedYen);

  // ② 2 つまとめて書く（1 件でも id が見つからなければ何も書かない）
  const after = await applyKgiCurrents(env, [
    { id: KGI_ID_CHAKKIN,  current: chakkinMan },
    { id: KGI_ID_SHIARABO, current: students },
  ]);

  // ③ 書いたあとに読み直した値で、入ったことを確かめてから記録に残す
  const chakkinAfter  = after.find((g) => g.id === KGI_ID_CHAKKIN);
  const shiaraboAfter = after.find((g) => g.id === KGI_ID_SHIARABO);

  if (chakkinAfter?.current !== chakkinMan || shiaraboAfter?.current !== students) {
    throw new Error(
      `書いたあとの読み直しで値が合いませんでした（着金: 入れた ${chakkinMan} / 読めた ${String(chakkinAfter?.current)}、` +
      `しあらぼ: 入れた ${students} / 読めた ${String(shiaraboAfter?.current)}）`
    );
  }

  // ④ インプ（日次）。ここで転んでも上の 2 つは止めない（理由は文で残す）
  const imp = await fillDailyImpressions(env);

  return {
    count: 2 + (imp.written > 0 ? 1 : 0),
    detail:
      `着金 ${chakkinMan} 万円（売上管理の当月の確定 ${confirmedYen.toLocaleString("ja-JP")} 円）・` +
      `しあらぼ ${students} 名（アーカイブを除く）を入れました。${imp.note}`,
  };
}
