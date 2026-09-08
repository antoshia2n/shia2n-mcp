/**
 * Google の通行証を、scope を引数に取って 1 か所で作る部品（2026-09-09 新設）
 *
 * それまで署名の手順は taskmaster.ts の getFirestoreToken と
 * google-calendar.ts の getCalendarToken の 2 か所に同じ形であった。
 * 3 つ目（Firebase の利用者を読む・identitytoolkit）が要ったので、
 * google-calendar.ts の注記どおり scope を引数に取る 1 つの部品へ寄せた。
 * 既存の 2 か所はこの回では触っていない（別の回で寄せる）。
 *
 * 合い言葉は増やしていない。FIREBASE_SA_EMAIL / FIREBASE_SA_PRIVATE_KEY の 2 つだけ。
 * 通行証が取れないときは、返ってきた番号と本文をそのまま載せて throw する。
 */

import type { Env } from "./index.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function getGoogleTokenForScope(env: Env, scope: string): Promise<string> {
  if (!env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
    throw new Error(
      "署名用の設定がありません（FIREBASE_SA_EMAIL / FIREBASE_SA_PRIVATE_KEY）"
    );
  }

  const now = Math.floor(Date.now() / 1000);

  const signingInput =
    `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
      iss: env.FIREBASE_SA_EMAIL,
      scope,
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
      `通行証が取れません（scope=${scope}・${tokenRes.status}）：${await tokenRes.text()}`
    );
  }

  const json = (await tokenRes.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error(`通行証が空で返りました（scope=${scope}）`);
  }
  return json.access_token;
}
