/**
 * Cron ジョブ：数字の 1 画面（把握くん）を毎晩 1 回入れる
 *
 * cron `0,30 * * * *` の UTC 18:30（JST 03:30）分岐からのみ呼ばれる。
 * cron の枠は増やしていない（既存の 2 本に相乗り）。
 *
 * 依頼書：https://www.notion.so/3be9c6c1c439818992dccf7adb533c5a
 * 判断記録：https://www.notion.so/3be9c6c1c439811880f1f73726d4bae2
 *
 * 入れるのは 2 つ。
 *   着金（入金された月）        … 売上管理の当月の確定を万円に直す（円 ÷ 10000・小数第 1 位）
 *   しあらぼ50名（入会と継続）  … しあらぼ管理の生徒のうち、アーカイブを除いた人数
 *
 * 2026-08-17（同日 2 回目の変更）：インプ（日次）を外した。
 *   同じ日の午前に「Buffer の日ごとの表示回数を毎晩 21 日ぶん入れ直す」形で足したが、
 *   その日のうちに取り下げになった。理由は不具合ではなく、入れていた数字を
 *   見る予定が無いこと（Naoki 判断）。インプは「インプ（月間）」の欄だけを残し、
 *   月に 1 回 X の画面から人が入れる。
 *   足した側は 1 度も動いていない（初回は翌日 03:30 の予定で、それより前に外した）。
 *   したがって把握くんの日ごとの記録に、この欄の数字は 1 件も入っていない。
 *
 *   ContentOS 側の日ごとの表示回数を返す口（/api/internal/daily-impressions）は
 *   残してある。ここから呼ばなくなるだけで、置いてあること自体の害が無く、
 *   消すと Naoki の手が 1 回増えるため。使っていない口として 8/24 の仕分けに載せる。
 *
 * 時刻を JST 03:30 にした理由：
 *   Zeus の取り込み（JST 03:00）とデータの控え（JST 04:00〜06:45）に挟まれた空きで、
 *   翌朝までに必ず終わる。ContentOS の数字の取り込み（JST 12:00）とも重ならない。
 *
 * 失敗したときの扱い：
 *   2 つとも先に取り、片方でも取れなければ書かずに throw する。
 *   片方だけが入った状態を残さないため。
 */

import type { Env } from "./index.js";
import { getRevenueSummary } from "./tools-sales-manager.js";
import { applyKgiCurrents } from "./tools-haaku.js";

/** 上位の目標の id。把握くんの画面と同じ値（2026-08-16 実測で確認） */
const KGI_ID_CHAKKIN  = "id_1776467718963_1mkx9"; // 着金（入金された月）・単位は万円
const KGI_ID_SHIARABO = "id_1776468364364_h612e"; // しあらぼ50名（入会と継続）・単位は名

interface ShrStudentRow {
  id: number;
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

  return {
    count: 2,
    detail:
      `着金 ${chakkinMan} 万円（売上管理の当月の確定 ${confirmedYen.toLocaleString("ja-JP")} 円）・` +
      `しあらぼ ${students} 名（アーカイブを除く）を入れました（インプは 2026-08-17 に外しました）`,
  };
}
