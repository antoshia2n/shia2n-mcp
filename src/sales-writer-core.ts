/**
 * shia2n-mcp / src/sales-writer-core.ts / 新設（2026-10-25 v1.44.0 開発部・決済受け口 便 1）
 *
 * B（マーケくん）が「定期の課金が通った月を売上管理で入金済みにする」ときの、引数の確かめだけの部品
 * （外に触らない・試験で回す）。呼ぶ口そのものは src/sales-writer.ts の SalesWriter。
 * 依頼：https://app.notion.com/p/4049c6c1c439812595c5d1f0975e6dcb
 */

export type MarkArgs = { contract_id: string; year_month: string; paid_date: string; actual_amount: number };

/** 確かめて形をそろえる。だめなら error に理由（英小文字の印）を返す */
export function checkMarkArgs(a: unknown): { ok: true; args: MarkArgs } | { ok: false; error: string } {
  const o = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
  const contract = String(o.contract_id ?? "").trim();
  if (!/^\d{1,9}$/.test(contract)) return { ok: false, error: "bad_contract_id" };
  const ym = String(o.year_month ?? "");
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m || Number(m[1]) < 2026 || Number(m[2]) < 1 || Number(m[2]) > 12) return { ok: false, error: "bad_year_month" };
  const d = String(o.paid_date ?? "");
  const t = Date.parse(d + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== d) return { ok: false, error: "bad_paid_date" };
  const amt = Number(o.actual_amount);
  if (!Number.isInteger(amt) || amt < 0 || amt > 10_000_000) return { ok: false, error: "bad_amount" };
  return { ok: true, args: { contract_id: contract, year_month: ym, paid_date: d, actual_amount: amt } };
}
