/**
 * 会員の門番 v1.1.0
 *
 * 【2026-09-05 変更】旧の番号（legacy_shr_id）も返すようにした。
 *   学ぶくんの 4 つの表（mn_member_curriculums / mn_favorites / mn_view_logs /
 *   mn_purchases）は、人の番号として shr_members.id を持っている。門番が返す
 *   member.id とは別の値なので、これを返さないと「入れるが中身が空」になる。
 *   mn_ の表の番号を付け替えるのは 10 月の段（台帳を 1 本にする）。そのときに
 *   この列ごと落とす。
 *
 *
 * 新しい会員の仕組みの「1 口」。アプリは自分で判定せず、この口が返した
 * 権利の一覧に自分の名前が入っているかだけを見る。
 *
 * 設計の正本：会員の仕組み ― 業務マニュアルの【新】の節
 * https://www.notion.so/3d19c6c1c43981579dc0ded0a37f53ab
 *
 * 読む表（2026-09-05 に作った 4 本のうち 3 本）：
 *   member / member_entitlement / auth_attempt
 * 旧の表（members・shr_members）には 1 列も触らない。
 *
 * 口は 3 つ。
 *   POST /gate/resolve   本人の券を受け取り、人と権利を返す（認証＝券そのもの）
 *   GET  /gate/attempts  入ろうとした記録の件数を返す（認証＝合言葉）
 *   GET  /gate/diag      仕組みが立っているかだけを返す（認証不要・値は返さない）
 *
 * 旧との違いで一番大事なところ：
 *   ・住所や本文に付いてきた番号やメールを一切見ない。使うのは券を検証して
 *     取り出した値だけ（他人になりすませないようにするため）。
 *   ・「見つからない」と「引けなかった」を別の符号にする。旧はここを混ぜたため、
 *     壊れているのか居ないのかが分からず 2 日かかった。
 */

import type { Env } from "./index.js";

const FIREBASE_PROJECT_ID = "gen-lang-client-0371348401";

/** Google が公開している、券の署名を確かめるための鍵の置き場 */
const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

/** 券の時計のずれをどこまで許すか（秒） */
const CLOCK_SKEW_SEC = 60;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

/** 断り方の符号。旧の 4 種を引き継ぎ、lookup_failed を必ず分ける */
export type GateReason =
  | "no_token"        // 券が付いていない
  | "bad_token"       // 券の中身が確かめられない
  | "no_email"        // 券に確認済みのメールが無い
  | "not_found"       // 台帳にいない
  | "multiple"        // 同じ人が 2 行ある（別人をつぶさないため断る）
  | "lookup_failed";  // 台帳に問い合わせられなかった（居ないのとは違う）

type Row = Record<string, unknown>;

// ───────── Supabase（既存の呼び方に合わせる） ─────────

async function sbGet(env: Env, path: string): Promise<Row[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase GET ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as Row[];
}

async function sbPatch(env: Env, path: string, body: Row): Promise<Row[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Supabase PATCH ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as Row[];
}

async function sbInsert(env: Env, table: string, body: Row): Promise<void> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Supabase INSERT ${res.status}: ${await res.text()}`);
  }
}

// ───────── 券の検証 ─────────

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    s.length + ((4 - (s.length % 4)) % 4),
    "=",
  );
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson(s: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

interface Jwk {
  kid: string;
  n: string;
  e: string;
  kty: string;
  alg?: string;
}

/** 鍵は取るたびに 1 回だけ問い合わせる（Workers の fetch の控えに任せる） */
async function fetchJwks(): Promise<Jwk[]> {
  const res = await fetch(JWKS_URL, { cf: { cacheTtl: 3600 } } as RequestInit);
  if (!res.ok) throw new Error(`jwks HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  return body.keys ?? [];
}

export interface VerifiedUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
}

/**
 * Firebase の券を検証して、番号と確認済みのメールを取り出す。
 * 検証できなければ null を返す（理由は呼び出し側で符号にする）。
 */
export async function verifyIdToken(token: string): Promise<VerifiedUser | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = b64urlToJson(parts[0]);
    payload = b64urlToJson(parts[1]);
  } catch {
    return null;
  }

  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

  const now = Math.floor(Date.now() / 1000);
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  const iat = typeof payload.iat === "number" ? payload.iat : 0;
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  if (exp <= now - CLOCK_SKEW_SEC) return null;
  if (iat > now + CLOCK_SKEW_SEC) return null;
  if (!sub) return null;
  if (payload.aud !== FIREBASE_PROJECT_ID) return null;
  if (payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`) {
    return null;
  }

  const keys = await fetchJwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) return null;

  const email = typeof payload.email === "string" ? payload.email : null;
  return {
    uid: sub,
    email,
    emailVerified: payload.email_verified === true,
  };
}

// ───────── 記録（見る手 1） ─────────

interface AttemptLog {
  auth_uid: string | null;
  email: string | null;
  matched_by: string | null;
  member_id: string | null;
  result: string;
  app: string | null;
  detail: Record<string, unknown> | null;
}

/**
 * 入ろうとした記録を 1 件残す。
 * 残せなかったときは握りつぶさず、返事の logged を false にして外から見えるようにする。
 */
async function logAttempt(env: Env, row: AttemptLog): Promise<boolean> {
  try {
    await sbInsert(env, "auth_attempt", row as unknown as Row);
    return true;
  } catch (e) {
    console.error("[gate] auth_attempt insert failed:", e);
    return false;
  }
}

function deny(
  reason: GateReason,
  status: number,
  logged: boolean,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json(
    { ok: false, role: "none", reason, logged, ...extra },
    { status, headers: CORS },
  );
}

// ───────── POST /gate/resolve ─────────

export async function handleGateResolve(request: Request, env: Env): Promise<Response> {
  const app = request.headers.get("X-App") ?? null;

  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) {
    const logged = await logAttempt(env, {
      auth_uid: null, email: null, matched_by: null, member_id: null,
      result: "no_token", app, detail: null,
    });
    return deny("no_token", 401, logged);
  }

  let user: VerifiedUser | null;
  try {
    user = await verifyIdToken(token);
  } catch (e) {
    // 鍵が取れない・問い合わせが落ちたなど。券が悪いのとは別に扱う
    const logged = await logAttempt(env, {
      auth_uid: null, email: null, matched_by: null, member_id: null,
      result: "lookup_failed", app,
      detail: { at: "verify", message: String(e) },
    });
    return deny("lookup_failed", 503, logged);
  }
  if (!user) {
    const logged = await logAttempt(env, {
      auth_uid: null, email: null, matched_by: null, member_id: null,
      result: "bad_token", app, detail: null,
    });
    return deny("bad_token", 401, logged);
  }

  const verifiedEmail = user.emailVerified && user.email
    ? user.email.toLowerCase().trim()
    : null;

  // 1. 番号で引く
  let rows: Row[];
  try {
    rows = await sbGet(
      env,
      `/member?select=id,name,auth_uid,email,legacy_shr_id&auth_uid=eq.${encodeURIComponent(user.uid)}&limit=2`,
    );
  } catch (e) {
    const logged = await logAttempt(env, {
      auth_uid: user.uid, email: verifiedEmail, matched_by: null, member_id: null,
      result: "lookup_failed", app, detail: { at: "by_uid", message: String(e) },
    });
    return deny("lookup_failed", 503, logged);
  }

  let matchedBy: "auth_uid" | "email" | null = null;
  let member: Row | null = null;

  if (rows.length > 1) {
    const logged = await logAttempt(env, {
      auth_uid: user.uid, email: verifiedEmail, matched_by: "auth_uid", member_id: null,
      result: "multiple", app, detail: { count: rows.length },
    });
    return deny("multiple", 409, logged);
  }
  if (rows.length === 1) {
    member = rows[0];
    matchedBy = "auth_uid";
  }

  // 2. 番号で見つからなければ、確認済みのメールで引く
  if (!member) {
    if (!verifiedEmail) {
      const logged = await logAttempt(env, {
        auth_uid: user.uid, email: null, matched_by: null, member_id: null,
        result: "no_email", app, detail: null,
      });
      return deny("no_email", 403, logged);
    }

    let byEmail: Row[];
    try {
      byEmail = await sbGet(
        env,
        `/member?select=id,name,auth_uid,email,legacy_shr_id&email=eq.${encodeURIComponent(verifiedEmail)}&limit=2`,
      );
    } catch (e) {
      const logged = await logAttempt(env, {
        auth_uid: user.uid, email: verifiedEmail, matched_by: null, member_id: null,
        result: "lookup_failed", app, detail: { at: "by_email", message: String(e) },
      });
      return deny("lookup_failed", 503, logged);
    }

    if (byEmail.length > 1) {
      const logged = await logAttempt(env, {
        auth_uid: user.uid, email: verifiedEmail, matched_by: "email", member_id: null,
        result: "multiple", app, detail: { count: byEmail.length },
      });
      return deny("multiple", 409, logged);
    }
    if (byEmail.length === 0) {
      const logged = await logAttempt(env, {
        auth_uid: user.uid, email: verifiedEmail, matched_by: null, member_id: null,
        result: "not_found", app, detail: null,
      });
      return deny("not_found", 403, logged);
    }

    member = byEmail[0];
    matchedBy = "email";

    // 3. 番号を 1 回だけ書く（空のときだけ。上書きはしない）
    if (!member.auth_uid) {
      try {
        await sbPatch(env, `/member?id=eq.${encodeURIComponent(String(member.id))}&auth_uid=is.null`, {
          auth_uid: user.uid,
          updated_at: new Date().toISOString(),
        });
      } catch (e) {
        // 書けなくても入場は妨げない。次の回にまた書きに来る
        console.error("[gate] auth_uid bind failed:", e);
      }
    }
  }

  // 4. 権利の一覧を返す（期限切れは外す）
  const memberId = String(member.id);
  const nowIso = new Date().toISOString();
  let ents: Row[];
  try {
    ents = await sbGet(
      env,
      `/member_entitlement?select=key,source,expires_at&member_id=eq.${encodeURIComponent(memberId)}` +
        `&or=(expires_at.is.null,expires_at.gt.${encodeURIComponent(nowIso)})`,
    );
  } catch (e) {
    const logged = await logAttempt(env, {
      auth_uid: user.uid, email: verifiedEmail, matched_by: matchedBy, member_id: memberId,
      result: "lookup_failed", app, detail: { at: "entitlements", message: String(e) },
    });
    return deny("lookup_failed", 503, logged);
  }

  const keys = [...new Set(ents.map((e) => String(e.key)))];

  const logged = await logAttempt(env, {
    auth_uid: user.uid, email: verifiedEmail, matched_by: matchedBy, member_id: memberId,
    result: "ok", app, detail: { entitlements: keys.length },
  });

  return Response.json(
    {
      ok: true,
      role: "member",
      member: {
        id: memberId,
        name: member.name ?? null,
        // 旧の番号。学ぶくんはこれを人の番号として使う（上の説明を見る）。
        // まだ埋まっていない人は null で返る。呼ぶ側はそれを見て断ること。
        legacy_id: member.legacy_shr_id ?? null,
      },
      entitlements: keys,
      matched_by: matchedBy,
      logged,
    },
    { headers: CORS },
  );
}

// ───────── GET /gate/attempts（見る手 2・3） ─────────

/**
 * 入ろうとした記録を、日ごと・符号ごとに数えて返す。
 * 人に「入れましたか」と聞かないための口。個人のメールはここでは返さない。
 */
export async function handleGateAttempts(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? "7"), 1), 90);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  let rows: Row[];
  try {
    rows = await sbGet(
      env,
      `/auth_attempt?select=occurred_at,result,app&occurred_at=gte.${encodeURIComponent(since)}` +
        `&order=occurred_at.desc&limit=10000`,
    );
  } catch (e) {
    return Response.json(
      { ok: false, error: "lookup_failed", message: String(e) },
      { status: 503, headers: CORS },
    );
  }

  const byDay: Record<string, Record<string, number>> = {};
  const byResult: Record<string, number> = {};
  for (const r of rows) {
    const day = String(r.occurred_at ?? "").slice(0, 10);
    const result = String(r.result ?? "unknown");
    byDay[day] ??= {};
    byDay[day][result] = (byDay[day][result] ?? 0) + 1;
    byResult[result] = (byResult[result] ?? 0) + 1;
  }

  return Response.json(
    { ok: true, days, total: rows.length, by_result: byResult, by_day: byDay },
    { headers: CORS },
  );
}

// ───────── GET /gate/diag（立っているかだけ・値は返さない） ─────────

export async function handleGateDiag(env: Env): Promise<Response> {
  const out: Record<string, unknown> = { ok: true, version: "gate v1.1.0" };

  out.supabase_configured = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
  out.firebase_project_id = FIREBASE_PROJECT_ID;

  // 券を確かめるための鍵が取れるか（取れないと誰も入れない）
  try {
    const keys = await fetchJwks();
    out.jwks_keys = keys.length;
  } catch (e) {
    out.ok = false;
    out.jwks_keys = 0;
    out.jwks_error = String(e);
  }

  // 読む表が 3 本とも届くか（件数だけ・中身は返さない）
  const tables = ["member", "member_entitlement", "auth_attempt"];
  const reach: Record<string, string> = {};
  for (const t of tables) {
    try {
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${t}?select=id&limit=1`, {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: "count=exact",
          Range: "0-0",
        },
      });
      reach[t] = res.ok
        ? `ok (${res.headers.get("content-range") ?? "?"})`
        : `HTTP ${res.status}`;
      if (!res.ok) out.ok = false;
    } catch (e) {
      reach[t] = `error: ${String(e)}`;
      out.ok = false;
    }
  }
  out.tables = reach;

  return Response.json(out, { headers: CORS });
}
