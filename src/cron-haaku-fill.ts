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
 *   着金（入金された月）        … 売上管理の当月の確定のうち、X広告収益・メンシプ・しあらぼ新規・しあらぼ継続の
 *                                  4 区分の合計を万円に直す（円 ÷ 10000・小数第 1 位）
 *   しあらぼ50名（入会と継続）  … 売上管理の当月の契約の行のうち、しあらぼ新規・しあらぼ継続の人数
 *
 * 2026-10-11（v1.8.0）：数え方だけを替えた（統括の判断・依頼 https://www.notion.so/3f69c6c1c439817d8135cc5b430cfa22）。
 *   着金は当月の確定の全部（CW案件も入っていた）から 4 区分の合計へ。
 *   しあらぼは、しあらぼ管理の生徒の人数（アーカイブを除く）から、売上管理の当月の契約の行の人数へ。
 *   当月は日本の時刻で決める（JST 03:30 に走るので、1 日の夜は新しい月を数える）。
 *   数え方は src/haaku-goal-count.ts（試験 test/haaku-goal-count.test.ts）。欄の名前は統括が替える。
 *   手で 1 回動かす口：haAku__fill_now（tools-munikis.ts）。
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
import { getMonthlyByBusiness } from "./tools-sales-manager.js";
import { fetchPaymentsMonth } from "./tools-sales-manager-ledger.js";
import { applyKgiCurrents } from "./tools-haaku.js";
import { CHAKKIN_BUSINESSES, countShiaraboContracts, sumConfirmed, jstYearMonth, toManYen } from "./haaku-goal-count.js";

/** 上位の目標の id。把握くんの画面と同じ値（2026-08-16 実測で確認） */
const KGI_ID_CHAKKIN  = "id_1776467718963_1mkx9"; // 着金（入金された月）・単位は万円
const KGI_ID_SHIARABO = "id_1776468364364_h612e"; // しあらぼ50名（入会と継続）・単位は名

export async function handleHaakuFill(
  env: Env
): Promise<{ count: number | null; detail: string }> {
  const ym = jstYearMonth();

  // ① 先に 2 つとも取る。片方でも取れなければ、ここで止めて何も書かない。
  const [monthly, payments] = await Promise.all([
    getMonthlyByBusiness(env, ym, ym, [...CHAKKIN_BUSINESSES]),
    fetchPaymentsMonth(env, ym),
  ]);

  const byBusiness = (monthly as { months?: { by_business?: Record<string, { confirmed: number }> }[] })?.months?.[0]?.by_business ?? {};
  const confirmedYen = sumConfirmed(byBusiness);
  const chakkinMan = toManYen(confirmedYen);
  const students = countShiaraboContracts(payments.rows);

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

  const parts = CHAKKIN_BUSINESSES.map((n) => `${n} ${(byBusiness[n]?.confirmed ?? 0).toLocaleString("ja-JP")}`).join("・");
  return {
    count: 2,
    detail:
      `${ym}：着金 ${chakkinMan} 万円（4 区分の確定 ${confirmedYen.toLocaleString("ja-JP")} 円＝${parts}）・` +
      `しあらぼ ${students} 名（売上管理の当月の契約の行・しあらぼ新規と継続）を入れました`,
  };
}
