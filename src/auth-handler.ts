/**
 * OAuth 2.1 認可ハンドラー（shia2n-mcp 個人利用版）
 *
 * このハンドラーは OAuthProvider の defaultHandler として動作し、
 * /authorize エンドポイントの同意画面と認可完了処理を担う。
 *
 * 設計方針：
 * - Naoki 個人利用。付ける userId は常に env.MCP_DEFAULT_USER_ID（Naoki の Firebase UID）
 * - v1.54.0（2026-10-27 開発部）：同意の画面に Google のログインを置き、
 *   Naoki 本人（NAOKI_UID か MCP_DEFAULT_USER_ID と同じ番号）のときだけ「許可する」を通す。
 *   それまでは住所を知っている人なら誰でも「許可する」を押せ、Naoki として道具を使えた。
 *   ・ログインの札（Firebase の券）は画面で取り、送られてきた札をこちらで検証する（gate.ts の verifyIdToken）
 *   ・つなぎ先（client_id）と戻り先（redirect_uri）が登録どおりかを、画面を出すときと許可のときの両方で確かめる
 *   ・すでにつながっている Claude（発行済みの札）には触らない。効くのは、これから許可するときだけ
 *   ・戻り先は決まった住所（claude.ai・claude.com・chatgpt.com・chat.openai.com・手元の localhost）だけ。
 *     足すときは MCP_ALLOWED_REDIRECT_HOSTS（カンマ区切り）。画面にも戻り先の住所を出す
 *     （つなぎ先の名前は登録した人が自由に名乗れるため、名前だけでは偽物と見分けられない）
 *   ・ログインの札は「いまこの画面でログインした」ものだけ受ける（ログインから 10 分以内）。
 *     ほかのアプリで取った札を流し込んで、長く使える MCP の許可へ格上げされるのを防ぐ
 *   ・この形でつないだ許可には metadata.login = "firebase" を付ける（直す前の許可と見分けるため）
 */

import { verifyIdToken as defaultVerify, type VerifiedUser } from "./gate.js";

// OAuthProvider がランタイムに env へ注入するヘルパーの最小型定義
interface OAuthHelpers {
  lookupClient(clientId: string): Promise<{ redirectUris: string[]; clientName?: string } | null>;
  completeAuthorization(opts: {
    request: {
      clientId: string;
      redirectUri: string;
      state?: string | null;
      codeChallenge: string;
      codeChallengeMethod: string;
      scope?: string | null;
      responseType: string;
    };
    userId: string;
    props: Record<string, unknown>;
    scope?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<{ redirectTo: string }>;
  listUserGrants?(userId: string, options?: { limit?: number; cursor?: string }): Promise<{ items: Array<{ id: string; clientId: string; createdAt: number; metadata?: any; scope?: string[] }>; cursor?: string }>;
  revokeGrant?(grantId: string, userId: string): Promise<void>;
}

export interface AuthEnv {
  MCP_DEFAULT_USER_ID: string;
  NAOKI_UID?: string;
  MCP_ALLOWED_REDIRECT_HOSTS?: string;
  OAUTH_PROVIDER: OAuthHelpers;
}

/** 画面で使う Firebase の公開の設定（ポータル・学ぶくん・haAku と同じログイン） */
const FIREBASE_WEB = {
  apiKey: "AIzaSyDKj5rhN6wg0k0OhCmY8J1r_8_2WfeBfYA",
  authDomain: "gen-lang-client-0371348401.firebaseapp.com",
  projectId: "gen-lang-client-0371348401",
};

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 通してよい人の番号（Naoki 本人）。どちらも無ければ空＝誰も通さない */
export function ownerUids(env: Pick<AuthEnv, "NAOKI_UID" | "MCP_DEFAULT_USER_ID">): string[] {
  return [env.NAOKI_UID, env.MCP_DEFAULT_USER_ID].filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** 戻り先として認める住所（https のもの）。手元の localhost は http も認める */
export const DEFAULT_REDIRECT_HOSTS = ["claude.ai", "claude.com", "chatgpt.com", "chat.openai.com"];
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export function redirectAllowed(env: Pick<AuthEnv, "MCP_ALLOWED_REDIRECT_HOSTS">, redirectUri: string): boolean {
  let u: URL;
  try { u = new URL(redirectUri); } catch { return false; }
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (LOCAL_HOSTS.includes(host)) return u.protocol === "http:" || u.protocol === "https:";
  if (u.protocol !== "https:") return false;
  const extra = (env.MCP_ALLOWED_REDIRECT_HOSTS ?? "").split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
  return [...DEFAULT_REDIRECT_HOSTS, ...extra].includes(host);
}

/** ログインからの経過（秒）の上限。これを超えた札は「いまログインした」とみなさない */
export const MAX_SIGNIN_AGE_SEC = 600;

/** 札の auth_time（ログインした時刻）が新しいか。署名の確かめは verify 側で済ませてから呼ぶ */
export function freshSignIn(token: string, nowSec: number = Math.floor(Date.now() / 1000)): boolean {
  const part = token.split(".")[1];
  if (!part) return false;
  let payload: Record<string, unknown>;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
    payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
  } catch { return false; }
  const t = payload.auth_time;
  if (typeof t !== "number") return false;
  return t <= nowSec + 60 && nowSec - t <= MAX_SIGNIN_AGE_SEC;
}

/** つなぎ先と戻り先が登録どおりか。違えば理由の文、合っていれば null */
export async function checkClient(env: AuthEnv, clientId: string, redirectUri: string): Promise<string | null> {
  if (!clientId || !redirectUri) return "つなぎ先の情報が足りません";
  if (!/^https?:\/\//.test(redirectUri)) return "戻り先の住所の形が正しくありません";
  if (!redirectAllowed(env, redirectUri)) {
    let host = "";
    try { host = new URL(redirectUri).host; } catch { /* 形が崩れている */ }
    return `戻り先（${host || "読めない住所"}）は、つなぐ先として認めている住所ではありません`;
  }
  let client: Awaited<ReturnType<OAuthHelpers["lookupClient"]>> = null;
  try { client = await env.OAUTH_PROVIDER.lookupClient(clientId); } catch { client = null; }
  if (!client) return "登録されていないつなぎ先です";
  if (!client.redirectUris.includes(redirectUri)) return "戻り先が登録と一致しません";
  return null;
}

function messagePage(title: string, body: string, status: number): Response {
  return new Response(
    `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(title)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif;background:#f5f0eb;color:#1a1a1a;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px}
.card{background:#fff;border:1px solid #e6dfd6;border-radius:14px;padding:28px;max-width:440px;width:100%}h1{font-size:18px;margin:0 0 12px}p{font-size:14px;line-height:1.7;color:#6b6259;margin:0}</style></head>
<body><main class="card"><h1>${esc(title)}</h1><p>${esc(body)}</p></main></body></html>`,
    { status, headers: PAGE_HEADERS },
  );
}

const hostOf = (u: string) => { try { return new URL(u).host; } catch { return u; } };

// 同意画面 HTML
export function buildConsentHtml(p: {
  clientId: string; clientName: string; redirectUri: string; state: string;
  codeChallenge: string; codeChallengeMethod: string; scope: string;
}): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>shia2n-mcp へのつなぎ</title>
  <style>
    :root { --bg:#f5f0eb; --panel:#fff; --line:#e6dfd6; --fg:#1a1a1a; --muted:#6b6259; --field:#a39a90; --ink:#b45309; }
    @media (prefers-color-scheme: dark) { :root { --bg:#1b1916; --panel:#24211d; --line:#38332c; --fg:#f1ece6; --muted:#b0a69b; --field:#6f665c; --ink:#fbbf24; } }
    * { box-sizing: border-box; }
    body { margin:0; padding:16px; min-height:100vh; display:flex; align-items:center; justify-content:center;
      background:var(--bg); color:var(--fg); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif; font-size:14px; }
    .card { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:28px; max-width:460px; width:100%; }
    h1 { font-size:20px; font-weight:800; margin:0 0 8px; }
    .client { color:var(--muted); margin:0 0 16px; word-break:break-all; }
    .info { border:1px solid var(--line); border-radius:12px; padding:14px; line-height:1.7; margin:0 0 16px; }
    .who { min-height:22px; margin:0 0 16px; line-height:1.6; }
    .who.err { color:#b91c1c; }
    @media (prefers-color-scheme: dark) { .who.err { color:#fca5a5; } }
    .actions { display:flex; gap:12px; justify-content:flex-end; flex-wrap:wrap; }
    button { min-height:44px; padding:0 18px; border-radius:8px; font-size:14px; font-weight:700; cursor:pointer; font-family:inherit; }
    .login { width:100%; background:var(--panel); color:var(--fg); border:1px solid var(--field); margin:0 0 16px; }
    .allow { background:#b45309; color:#fff; border:1px solid #b45309; }
    .deny { background:transparent; color:var(--fg); border:1px solid var(--field); }
    button:focus-visible { outline:3px solid var(--ink); outline-offset:2px; }
  </style>
</head>
<body>
  <main class="card">
    <h1>shia2n-mcp へつなぎますか？</h1>
    <p class="client">つなぎ先の名乗り：${esc(p.clientName || p.clientId)}<br>戻る先：<b>${esc(hostOf(p.redirectUri))}</b></p>
    <div class="info">
      つなぐと、この Claude が Naoki のアカウントとして shia2n の道具（会員・売上・TaskMaster・haAku など）を使えるようになります。<br>
      <b>Naoki 本人の Google でログインしたときだけ</b>つなげます。
    </div>
    <button type="button" class="login" id="login">Google でログイン</button>
    <p class="who" id="who" role="status" aria-live="polite"></p>
    <form method="POST" action="/authorize" id="form">
      <input type="hidden" name="client_id" value="${esc(p.clientId)}">
      <input type="hidden" name="redirect_uri" value="${esc(p.redirectUri)}">
      <input type="hidden" name="state" value="${esc(p.state)}">
      <input type="hidden" name="code_challenge" value="${esc(p.codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${esc(p.codeChallengeMethod)}">
      <input type="hidden" name="scope" value="${esc(p.scope)}">
      <input type="hidden" name="id_token" id="id_token" value="">
      <input type="hidden" name="approved" id="approved" value="true">
      <div class="actions">
        <button type="submit" class="deny" id="deny">つながない</button>
        <button type="submit" class="allow" id="allow">つなぐ</button>
      </div>
    </form>
  </main>
  <script src="https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js"></script>
  <script src="https://www.gstatic.com/firebasejs/10.12.5/firebase-auth-compat.js"></script>
  <script>
    (function () {
      var who = document.getElementById("who");
      var tokenField = document.getElementById("id_token");
      var loginBtn = document.getElementById("login");
      function say(text, isErr) { who.textContent = text; who.className = isErr ? "who err" : "who"; }
      var auth = null;
      try {
        firebase.initializeApp(${JSON.stringify(FIREBASE_WEB)});
        auth = firebase.auth();
        auth.setPersistence(firebase.auth.Auth.Persistence.NONE);
      } catch (e) { say("ログインの準備ができませんでした。ページを開き直してください", true); }
      loginBtn.addEventListener("click", function () {
        if (!auth) { say("ログインの準備ができませんでした。ページを開き直してください", true); return; }
        say("ログインの窓を開いています…", false);
        auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).then(function (res) {
          return res.user.getIdToken(true).then(function (t) {
            tokenField.value = t;
            say((res.user.email || "Google") + " でログインしました。「つなぐ」を押してください", false);
            document.getElementById("allow").focus();
          });
        }).catch(function (e) {
          var code = (e && e.code) || "";
          if (code === "auth/unauthorized-domain") say("このページの住所が、ログインを許す住所の一覧に入っていません（Firebase の承認済みドメイン）", true);
          else if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") say("ログインの窓が閉じられました。もう一度「Google でログイン」を押してください", true);
          else if (code === "auth/popup-blocked") say("ログインの窓がブラウザに止められました。窓を許可してからもう一度押してください", true);
          else say("ログインできませんでした（" + code + "）", true);
        });
      });
      document.getElementById("deny").addEventListener("click", function () { document.getElementById("approved").value = "false"; });
      document.getElementById("allow").addEventListener("click", function () { document.getElementById("approved").value = "true"; });
      document.getElementById("form").addEventListener("submit", function (ev) {
        if (document.getElementById("approved").value === "true" && !tokenField.value) {
          ev.preventDefault();
          say("先に「Google でログイン」を押してください", true);
          loginBtn.focus();
        }
      });
    })();
  </script>
</body>
</html>`;
}

type Verify = (token: string) => Promise<VerifiedUser | null>;

export function createAuthHandler(verify: Verify = defaultVerify) {
  return {
    async fetch(request: Request, env: AuthEnv): Promise<Response> {
      const url = new URL(request.url);

      // ─── GET / または /health ─────────────────────────────────────────
      if (url.pathname === "/" || url.pathname === "/health") {
        return new Response(
          JSON.stringify({ name: "shia2n-mcp", version: "0.7.0", status: "ok", mcp_endpoint: "/mcp" }),
          { headers: { "Content-Type": "application/json" } }
        );
      }

      // ─── GET /authorize ───────────────────────────────────────────────
      // 同意画面（Google のログインつき）を表示する
      if (url.pathname === "/authorize" && request.method === "GET") {
        const p = url.searchParams;
        const clientId            = p.get("client_id") ?? "";
        const redirectUri         = p.get("redirect_uri") ?? "";
        const state               = p.get("state") ?? "";
        const codeChallenge       = p.get("code_challenge") ?? "";
        const codeChallengeMethod = p.get("code_challenge_method") ?? "S256";
        const scope               = p.get("scope") ?? "";

        if (!clientId || !redirectUri || !codeChallenge) {
          return new Response("invalid_request: missing required OAuth parameters", { status: 400 });
        }
        const bad = await checkClient(env, clientId, redirectUri);
        if (bad) return messagePage("つなげません", bad, 400);
        let clientName = "";
        try { clientName = (await env.OAUTH_PROVIDER.lookupClient(clientId))?.clientName ?? ""; } catch { /* 名前は無くてよい */ }

        return new Response(
          buildConsentHtml({ clientId, clientName, redirectUri, state, codeChallenge, codeChallengeMethod, scope }),
          { headers: PAGE_HEADERS }
        );
      }

      // ─── POST /authorize ──────────────────────────────────────────────
      // 「つなぐ」を押した後の処理。Naoki 本人のログインを確かめてから completeAuthorization。
      if (url.pathname === "/authorize" && request.method === "POST") {
        let body: FormData;
        try {
          body = await request.formData();
        } catch {
          return new Response("invalid_request: cannot parse form body", { status: 400 });
        }

        const str = (k: string) => { const v = body.get(k); return typeof v === "string" ? v : ""; };
        const clientId            = str("client_id");
        const redirectUri         = str("redirect_uri");
        const state               = str("state");
        const codeChallenge       = str("code_challenge");
        const codeChallengeMethod = str("code_challenge_method") || "S256";
        const scope               = str("scope");
        const approved            = str("approved");
        const idToken             = str("id_token");

        // 戻り先は登録どおりのときだけ使う（断るときも、知らない住所へは飛ばさない）
        const bad = await checkClient(env, clientId, redirectUri);
        if (bad) return messagePage("つなげません", bad, 400);

        if (approved !== "true") {
          const deniedUrl = new URL(redirectUri);
          deniedUrl.searchParams.set("error", "access_denied");
          if (state) deniedUrl.searchParams.set("state", state);
          return Response.redirect(deniedUrl.toString(), 302);
        }
        if (!codeChallenge) {
          return new Response("invalid_request: missing code_challenge", { status: 400 });
        }

        const owners = ownerUids(env);
        if (owners.length === 0) {
          return messagePage("つなげません", "本人の番号の設定（NAOKI_UID）が無いため、誰もつなげない形で止めています", 503);
        }
        let user: VerifiedUser | null = null;
        if (idToken) {
          try { user = await verify(idToken); } catch { user = null; }
        }
        if (!user) {
          return messagePage("つなげません", "ログインを確かめられませんでした。ページを開き直し、「Google でログイン」からやり直してください", 401);
        }
        if (!owners.includes(user.uid)) {
          return messagePage("つなげません", "このアカウントではつなげません。shia2n-mcp は Naoki 本人のアカウントだけがつなげます", 403);
        }
        if (!freshSignIn(idToken)) {
          return messagePage("つなげません", "ログインから時間がたっています。ページを開き直し、「Google でログイン」からやり直してください", 401);
        }

        try {
          const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
            request: {
              clientId,
              redirectUri,
              state:              state || null,
              codeChallenge,
              codeChallengeMethod,
              scope:              scope || null,
              responseType:       "code",
            },
            userId: env.MCP_DEFAULT_USER_ID,
            props:  { userId: env.MCP_DEFAULT_USER_ID },
            scope:  scope ? scope.split(" ") : [],
            metadata: { login: "firebase", at: new Date().toISOString() },
          });
          return Response.redirect(redirectTo, 302);
        } catch (e) {
          return new Response(
            `Authorization failed: ${e instanceof Error ? e.message : String(e)}`,
            { status: 400 }
          );
        }
      }

      return new Response("Not Found", { status: 404 });
    },
  };
}

export const AuthHandler = createAuthHandler();
