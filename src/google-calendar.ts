/**
 * Google カレンダーを読む部品（サービスアカウントで通行証を取る）
 *
 * 2026-08-28 新設。面談の予定を毎日読んで、しあらぼ管理の最終面談日へ反映する
 * 処理（cron-shiarabo-mtg.ts）から呼ぶ。
 * 依頼書：https://www.notion.so/3ca9c6c1c43981fd9575e6e9fdb4059b
 *
 * ── 合い言葉は増やしていない ──
 *   TaskMaster（Firestore）で使っているサービスアカウントの鍵をそのまま使う。
 *   FIREBASE_SA_EMAIL / FIREBASE_SA_PRIVATE_KEY の 2 つで、新しい設定は無い。
 *   違うのは scope だけで、こちらは calendar.readonly（読むだけ・書けない）。
 *
 *   Naoki が 2026-08-28 に、面談の予定が入っているカレンダーを、このサービス
 *   アカウントのアドレス宛に「予定の詳細の表示」で共有した。権限が
 *   「予定の時間枠のみ表示」だと予定の名前が読めず、突き合わせが全件空振りする。
 *   そこは詳細の側でなければならない。
 *
 * ── 署名の手順が taskmaster.ts と同じ形であること ──
 *   getFirestoreToken とほぼ同じ 40 行になっている。まだ 2 か所なのでまとめていない。
 *   Google を読む先が 3 つ目になったら、scope を引数に取る 1 つの部品へ寄せる。
 *
 * ── 失敗したときに何が見えるか ──
 *   通行証が取れない・カレンダーが読めないときは、返ってきた番号と本文を
 *   そのままエラーに載せて throw する。呼び出し元（cron）はそれを実行記録へ
 *   書くので、GET /diag の last_runs と munikis__get_context の recent_runs の
 *   両方から、認証で落ちたのか口が無いのかを読み分けられる。
 *   とくに 403 は「カレンダーの口が有効になっていない」ことがあるため、
 *   その場合だけ何をすればよいかを日本語で足す。
 */

import type { Env } from "./index.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

/** 面談の予定が入っているカレンダー。省略時は Naoki の既定のカレンダー */
export const DEFAULT_MTG_CALENDAR_ID = "gameister1@gmail.com";

export interface CalendarEvent {
  /** カレンダー側の予定の識別子。同じ予定を 2 回書かないための鍵 */
  id: string;
  /** 予定の名前。空のことがある */
  summary: string;
  /** 開始日（日本時間・YYYY-MM-DD） */
  startDate: string;
}

// ─── 通行証 ──────────────────────────────────────────────────────────────────

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function getCalendarToken(env: Env): Promise<string> {
  if (!env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
    throw new Error(
      "署名用の設定がありません（FIREBASE_SA_EMAIL / FIREBASE_SA_PRIVATE_KEY）"
    );
  }

  const now = Math.floor(Date.now() / 1000);

  const signingInput =
    `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
      iss: env.FIREBASE_SA_EMAIL,
      scope: CALENDAR_SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })}`;

  const pem = env.FIREBASE_SA_PRIVATE_KEY.replace(/\\n/g, "\n");
  const pemBody = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer" +
      `&assertion=${signingInput}.${sigB64}`,
  });

  if (!tokenRes.ok) {
    throw new Error(
      `カレンダーの通行証が取れません（${tokenRes.status}）：${await tokenRes.text()}`
    );
  }

  const json = (await tokenRes.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error("カレンダーの通行証が空で返りました");
  }
  return json.access_token;
}

// ─── 日付（日本時間） ────────────────────────────────────────────────────────

/** 世界標準時の瞬間を、日本時間の YYYY-MM-DD に直す */
export function toJstDate(input: Date | string): string {
  const d = typeof input === "string" ? new Date(input) : input;
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

/** 日本時間の今日から n 日ずらした日の、世界標準時の瞬間（境界に使う） */
export function jstDayShift(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

// ─── 予定を読む ──────────────────────────────────────────────────────────────

/**
 * 指定した期間の予定を全部返す。
 * 繰り返しの予定は 1 回ずつに展開する（singleEvents）。
 * 取り消された予定は返さない。
 */
export async function listEvents(
  env: Env,
  calendarId: string,
  timeMin: Date,
  timeMax: Date
): Promise<CalendarEvent[]> {
  const token = await getCalendarToken(env);
  const out: CalendarEvent[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < 10; page++) {
    const url =
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events` +
      `?singleEvents=true&orderBy=startTime&maxResults=250` +
      `&timeMin=${encodeURIComponent(timeMin.toISOString())}` +
      `&timeMax=${encodeURIComponent(timeMax.toISOString())}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const body = await res.text();
      const hint =
        res.status === 403
          ? "（403 のときは、Google 側でカレンダーの口が有効になっていない可能性があります）"
          : res.status === 404
            ? "（404 のときは、カレンダーの住所が違うか、まだ共有されていない可能性があります）"
            : "";
      throw new Error(
        `カレンダーが読めません（${res.status}・カレンダー ${calendarId}）${hint}：${body}`
      );
    }

    const json = (await res.json()) as {
      items?: Array<{
        id?: string;
        status?: string;
        summary?: string;
        start?: { dateTime?: string; date?: string };
      }>;
      nextPageToken?: string;
    };

    for (const item of json.items ?? []) {
      if (!item.id) continue;
      if (item.status === "cancelled") continue;

      // 終日の予定は date（すでに日付そのもの）、時刻付きは dateTime（世界標準時へ直す）
      const startDate = item.start?.date
        ? item.start.date
        : item.start?.dateTime
          ? toJstDate(item.start.dateTime)
          : "";
      if (!startDate) continue;

      out.push({
        id: item.id,
        summary: (item.summary ?? "").trim(),
        startDate,
      });
    }

    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }

  return out;
}
