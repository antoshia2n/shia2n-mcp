/**
 * shia2n-mcp / src/haaku-goal-count.ts / 新設（2026-10-11 v1.8.0 開発部）
 *
 * 把握くんの目標欄 2 本に入れる数の数え方だけをここに置く（外に触らないので試験で回せる）。
 * 依頼：https://www.notion.so/3f69c6c1c439817d8135cc5b430cfa22（統括 2026-10-11 20:05 の判断）
 *
 *   1 本目（着金）      … 当月の確定のうち、X広告収益・メンシプ・しあらぼ新規・しあらぼ継続の 4 区分の合計
 *   2 本目（しあらぼ）  … 売上管理の当月の契約の行のうち、区分がしあらぼ新規・しあらぼ継続のものの人数
 *                          （同じ契約が 2 行あっても 1 人。単発の売上の行は数えない）
 */

/** 1 本目に足す区分。売上管理に登録済みの名前と 1 文字も違わないこと（違えば売上管理が断って止まる） */
export const CHAKKIN_BUSINESSES = ["X広告収益", "メンシプ", "しあらぼ新規", "しあらぼ継続"] as const;

/** 2 本目に数える区分 */
export const SHIARABO_BUSINESSES = ["しあらぼ新規", "しあらぼ継続"] as const;

export interface PaymentMonthRow {
  source: string; // contract / planned / single
  contract_id: number | string | null;
  business: string | null;
}

/** 当月の契約の行（contract=支払いの行 / planned=行がまだ無い有効な契約）から、しあらぼの人数を数える */
export function countShiaraboContracts(rows: PaymentMonthRow[]): number {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.source !== "contract" && r.source !== "planned") continue;
    if (!r.business || !(SHIARABO_BUSINESSES as readonly string[]).includes(r.business)) continue;
    if (r.contract_id === null || r.contract_id === undefined) continue;
    ids.add(String(r.contract_id));
  }
  return ids.size;
}

/** 区分ごとの確定（円）を足す。区分が返ってこなければ 0 にせず止める（数字の抜けを見落とさないため） */
export function sumConfirmed(
  byBusiness: Record<string, { confirmed: number } | undefined>,
  names: readonly string[] = CHAKKIN_BUSINESSES
): number {
  let total = 0;
  for (const n of names) {
    const v = byBusiness[n]?.confirmed;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`売上管理の当月の確定に、区分「${n}」が数値で入っていませんでした（受け取った値: ${String(v)}）`);
    }
    total += v;
  }
  return total;
}

/** 日本の時刻での年月（YYYY-MM）。Worker の時計は UTC なので 9 時間足して読む */
export function jstYearMonth(now: Date = new Date()): string {
  const j = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${j.getUTCFullYear()}-${String(j.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** 円を万円に直す。小数第 1 位まで（37000 → 3.7） */
export function toManYen(yen: number): number {
  return Math.round((yen / 10000) * 10) / 10;
}
