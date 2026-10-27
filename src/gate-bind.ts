/**
 * gate__bind_login の決め方（計算だけ・通信なし）。2026-10-28 開発部（統括の依頼 00:05・Naoki「OK」00:34）。
 *
 * 門番（src/gate.ts）は人を「ログインの番号（member.auth_uid）」か「登録のメールと同じ確認済みの Google のメール」で見つける。
 * 登録のメールと違う Google で入る人は、どちらにも当たらず not_found になる。
 * そこで、その人の Google のログインの番号を、会員の行の空の auth_uid に書く。次から門番は番号で見つける。
 * 1 人につき Google 1 つ（auth_uid は 1 つだけ）。2 つ目を足すのは表の作りを変える話なので、ここではしない。
 */
export type BindPlan =
  | { ok: true; action: "write" | "already"; uid: string }
  | { ok: false; reason: "member_not_found" | "google_not_found" | "uid_taken" | "member_has_other_login"; detail?: string };

/**
 * member：その会員の行（無ければ null）／uid：Firebase で引いたその Google のログインの番号（無ければ null）
 * holders：その uid を auth_uid に持つ会員の行（0〜複数）
 */
export function planBind(
  member: { id: string; auth_uid?: string | null } | null,
  uid: string | null,
  holders: { id: string }[],
): BindPlan {
  if (!member) return { ok: false, reason: "member_not_found" };
  if (!uid) return { ok: false, reason: "google_not_found" };
  const others = holders.filter((h) => String(h.id) !== String(member.id));
  if (others.length) return { ok: false, reason: "uid_taken", detail: String(others[0].id) };
  const cur = member.auth_uid ? String(member.auth_uid) : "";
  if (cur === uid) return { ok: true, action: "already", uid };
  if (cur) return { ok: false, reason: "member_has_other_login" };
  return { ok: true, action: "write", uid };
}

export const BIND_REASON_TEXT: Record<string, string> = {
  member_not_found: "その番号の会員の行が無い",
  google_not_found: "Firebase に、その Google のメールの利用者が居ない（その Google で一度もログインしていない）。本人に一度どれかのアプリへその Google でログインしてもらってから呼び直す",
  uid_taken: "その Google のログインは、もうほかの会員の行に結ばれている。書かない",
  member_has_other_login: "この会員の行には、もう別のログインが結ばれている。1 人につき Google 1 つなので書かない",
};
