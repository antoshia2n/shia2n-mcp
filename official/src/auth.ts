/**
 * つなぐ画面（外向けの窓口）。shia2n-mcp の src/auth-handler.ts と同じ守りを、会員向けに置き直したもの。
 *
 *   ・同意の画面で Google ログインし、送られてきた札を shia2n-mcp の門番（OfficialGate.login）で確かめる
 *   ・会員の台帳にいて、開くものに mcp_official がある人だけ「つなぐ」を通す
 *   ・つなぎ先（client_id）と戻り先（redirect_uri）が登録どおりかを、画面を出すときと許可のときの両方で確かめる
 *   ・戻り先は決まった住所（claude.ai・claude.com・chatgpt.com・chat.openai.com・手元の localhost）だけ
 *   ・ログインの札は「いまこの画面でログインした」ものだけ受ける（10 分以内）
 *   ・許可の札に入れるのは member の番号だけ（名前・メールは入れない）。権利は札に入れず、使うたびに読み直す
 */

import type { GateBinding } from "./server.js";
import { canConnect } from "./rights.js";

interface OAuthHelpers {
  lookupClient(clientId: string): Promise<{ redirectUris: string[]; clientName?: string } | null>;
  completeAuthorization(opts: {
    request: {
      clientId: string; redirectUri: string; state?: string | null; codeChallenge: string;
      codeChallengeMethod: string; scope?: string | null; responseType: string;
    };
    userId: string;
    props: Record<string, unknown>;
    scope?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<{ redirectTo: string }>;
}

export interface AuthEnv {
  GATE: Pick<GateBinding, "login">;
  MCP_ALLOWED_REDIRECT_HOSTS?: string;
  OAUTH_PROVIDER: OAuthHelpers;
}

/** 画面で使う Firebase の公開の設定（ポータル・学ぶくんと同じログイン） */
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

export const DEFAULT_REDIRECT_HOSTS = ["claude.ai", "claude.com", "chatgpt.com", "chat.openai.com"];
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export function redirectAllowed(env: Pick<AuthEnv, "MCP_ALLOWED_REDIRECT_HOSTS">, redirectUri: string): boolean {
  let u: URL;
  try { u = new URL(redirectUri); } catch { return false; }
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (LOCAL_HOSTS.includes(host)) return u.protocol === "http:" || u.protocol === "https:";
  if (u.protocol !== "https:") return false;
  const extra = (env.MCP_ALLOWED_REDIRECT_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return [...DEFAULT_REDIRECT_HOSTS, ...extra].includes(host);
}

export const MAX_SIGNIN_AGE_SEC = 600;

/** 札の auth_time（ログインした時刻）が新しいか。署名の確かめは門番が済ませる */
export function freshSignIn(token: string, nowSec: number = Math.floor(Date.now() / 1000)): boolean {
  const part = token.split(".")[1];
  if (!part) return false;
  let payload: Record<string, unknown>;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
    payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch { return false; }
  const t = payload.auth_time;
  if (typeof t !== "number") return false;
  return t <= nowSec + 60 && nowSec - t <= MAX_SIGNIN_AGE_SEC;
}

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

export function buildConsentHtml(p: {
  clientId: string; clientName: string; redirectUri: string; state: string;
  codeChallenge: string; codeChallengeMethod: string; scope: string;
}): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>シアラボの AI 窓口へのつなぎ</title>
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
    <h1>シアラボの AI 窓口へつなぎますか？</h1>
    <p class="client">つなぎ先の名乗り：${esc(p.clientName || p.clientId)}<br>戻る先：<b>${esc(hostOf(p.redirectUri))}</b></p>
    <div class="info">
      つなぐと、この AI が<b>あなたの会員の権利で使える道具</b>だけを使えるようになります。<br>
      シアラボに登録した Google のアカウントでログインしてください。
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

const DENY_TEXT: Record<string, string> = {
  not_found: "このアカウントは会員の台帳に見つかりませんでした。シアラボに登録した Google のアカウントでログインしてください",
  no_email: "このアカウントは確認済みのメールが無いため、会員を確かめられません",
  multiple: "同じ方の会員の記録が 2 つあるため、つなげません。運営へお知らせください",
  lookup_failed: "いま会員の台帳を確かめられませんでした。少し待ってからやり直してください",
};

export function createAuthHandler() {
  return {
    async fetch(request: Request, env: AuthEnv): Promise<Response> {
      const url = new URL(request.url);

      if (url.pathname === "/" || url.pathname === "/health") {
        return Response.json({ name: "shia2n-mcp-official", status: "ok", mcp_endpoint: "/mcp" });
      }

      if (url.pathname === "/authorize" && request.method === "GET") {
        const p = url.searchParams;
        const clientId = p.get("client_id") ?? "";
        const redirectUri = p.get("redirect_uri") ?? "";
        const state = p.get("state") ?? "";
        const codeChallenge = p.get("code_challenge") ?? "";
        const codeChallengeMethod = p.get("code_challenge_method") ?? "S256";
        const scope = p.get("scope") ?? "";
        if (!clientId || !redirectUri || !codeChallenge) {
          return new Response("invalid_request: missing required OAuth parameters", { status: 400 });
        }
        const bad = await checkClient(env, clientId, redirectUri);
        if (bad) return messagePage("つなげません", bad, 400);
        let clientName = "";
        try { clientName = (await env.OAUTH_PROVIDER.lookupClient(clientId))?.clientName ?? ""; } catch { /* 名前は無くてよい */ }
        return new Response(buildConsentHtml({ clientId, clientName, redirectUri, state, codeChallenge, codeChallengeMethod, scope }), { headers: PAGE_HEADERS });
      }

      if (url.pathname === "/authorize" && request.method === "POST") {
        let body: FormData;
        try { body = await request.formData(); } catch { return new Response("invalid_request: cannot parse form body", { status: 400 }); }
        const str = (k: string) => { const v = body.get(k); return typeof v === "string" ? v : ""; };
        const clientId = str("client_id");
        const redirectUri = str("redirect_uri");
        const state = str("state");
        const codeChallenge = str("code_challenge");
        const codeChallengeMethod = str("code_challenge_method") || "S256";
        const scope = str("scope");
        const approved = str("approved");
        const idToken = str("id_token");

        const bad = await checkClient(env, clientId, redirectUri);
        if (bad) return messagePage("つなげません", bad, 400);

        if (approved !== "true") {
          const deniedUrl = new URL(redirectUri);
          deniedUrl.searchParams.set("error", "access_denied");
          if (state) deniedUrl.searchParams.set("state", state);
          return Response.redirect(deniedUrl.toString(), 302);
        }
        if (!codeChallenge) return new Response("invalid_request: missing code_challenge", { status: 400 });
        if (!idToken) return messagePage("つなげません", "先に「Google でログイン」を押してください", 401);
        if (!freshSignIn(idToken)) {
          return messagePage("つなげません", "ログインから時間がたっています。ページを開き直し、「Google でログイン」からやり直してください", 401);
        }

        let r: Awaited<ReturnType<AuthEnv["GATE"]["login"]>>;
        try { r = await env.GATE.login(idToken); } catch { r = { ok: false, reason: "lookup_failed" }; }
        if (!r.ok) {
          if (r.reason === "no_token" || r.reason === "bad_token") {
            return messagePage("つなげません", "ログインを確かめられませんでした。ページを開き直し、「Google でログイン」からやり直してください", 401);
          }
          return messagePage("つなげません", DENY_TEXT[r.reason] ?? "このアカウントではつなげません", r.reason === "lookup_failed" ? 503 : 403);
        }
        if (!canConnect(r.targets)) {
          return messagePage("つなげません", "いまの会員の権利では、AI の窓口は使えません", 403);
        }

        try {
          const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
            request: { clientId, redirectUri, state: state || null, codeChallenge, codeChallengeMethod, scope: scope || null, responseType: "code" },
            userId: r.member_id,
            props: { memberId: r.member_id },
            scope: scope ? scope.split(" ") : [],
            metadata: { login: "firebase", at: new Date().toISOString() },
          });
          return Response.redirect(redirectTo, 302);
        } catch (e) {
          return new Response(`Authorization failed: ${e instanceof Error ? e.message : String(e)}`, { status: 400 });
        }
      }

      return new Response("Not Found", { status: 404 });
    },
  };
}
