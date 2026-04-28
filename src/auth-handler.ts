/**
 * OAuth 2.1 認可ハンドラー（shia2n-mcp 個人利用版）
 *
 * このハンドラーは OAuthProvider の defaultHandler として動作し、
 * /authorize エンドポイントの同意画面と認可完了処理を担う。
 *
 * 設計方針（選択肢A）：
 * - Naoki 個人利用のため、認証プロバイダーは持たない
 * - /authorize GET で同意確認画面を表示
 * - /authorize POST でユーザーが承認した場合、completeAuthorization を呼ぶ
 * - userId は常に env.MCP_DEFAULT_USER_ID（Naoki の Firebase UID）を返す
 */

// OAuthProvider がランタイムに env へ注入するヘルパーの最小型定義
interface OAuthHelpers {
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
  }): Promise<{ redirectTo: string }>;
}

interface AuthEnv {
  MCP_DEFAULT_USER_ID: string;
  OAUTH_PROVIDER: OAuthHelpers;
}

// 同意画面 HTML
function buildConsentHtml(
  clientId: string,
  redirectUri: string,
  state: string,
  codeChallenge: string,
  codeChallengeMethod: string,
  scope: string
): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>shia2n-mcp へのアクセスを許可しますか？</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f5f5f5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1rem;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      padding: 2rem;
      max-width: 440px;
      width: 100%;
      box-shadow: 0 2px 16px rgba(0,0,0,0.1);
    }
    h1 {
      font-size: 1.25rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
      color: #111;
    }
    .client {
      font-size: 0.875rem;
      color: #555;
      margin-bottom: 1.5rem;
      word-break: break-all;
    }
    .info {
      background: #f0f4ff;
      border-radius: 8px;
      padding: 1rem;
      font-size: 0.875rem;
      color: #333;
      margin-bottom: 1.5rem;
      line-height: 1.5;
    }
    .actions {
      display: flex;
      gap: 0.75rem;
      justify-content: flex-end;
    }
    button {
      padding: 0.625rem 1.25rem;
      border-radius: 8px;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      border: none;
    }
    .allow {
      background: #1a56db;
      color: #fff;
    }
    .allow:hover { background: #1240a8; }
    .deny {
      background: #e5e7eb;
      color: #374151;
    }
    .deny:hover { background: #d1d5db; }
  </style>
</head>
<body>
  <div class="card">
    <h1>shia2n-mcp へのアクセスを許可しますか？</h1>
    <div class="client">クライアント: ${esc(clientId)}</div>
    <div class="info">
      このクライアントは shia2n エコシステムの MCP ツール（High-Shin・Zeus・Pay-kun 等）への
      アクセスを要求しています。<br><br>
      あなた（Naoki）のアカウントとして操作が実行されます。
    </div>
    <form method="POST" action="/authorize">
      <input type="hidden" name="client_id" value="${esc(clientId)}">
      <input type="hidden" name="redirect_uri" value="${esc(redirectUri)}">
      <input type="hidden" name="state" value="${esc(state)}">
      <input type="hidden" name="code_challenge" value="${esc(codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${esc(codeChallengeMethod)}">
      <input type="hidden" name="scope" value="${esc(scope)}">
      <input type="hidden" name="approved" value="true">
      <div class="actions">
        <button type="button" class="deny" onclick="window.close()">キャンセル</button>
        <button type="submit" class="allow">許可する</button>
      </div>
    </form>
  </div>
</body>
</html>`;
}

export const AuthHandler = {
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
    // 同意確認画面を表示する
    if (url.pathname === "/authorize" && request.method === "GET") {
      const p = url.searchParams;
      const clientId           = p.get("client_id") ?? "";
      const redirectUri        = p.get("redirect_uri") ?? "";
      const state              = p.get("state") ?? "";
      const codeChallenge      = p.get("code_challenge") ?? "";
      const codeChallengeMethod = p.get("code_challenge_method") ?? "S256";
      const scope              = p.get("scope") ?? "";

      if (!clientId || !redirectUri || !codeChallenge) {
        return new Response("invalid_request: missing required OAuth parameters", { status: 400 });
      }

      return new Response(
        buildConsentHtml(clientId, redirectUri, state, codeChallenge, codeChallengeMethod, scope),
        { headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    // ─── POST /authorize ──────────────────────────────────────────────
    // ユーザーが「許可する」を押した後の処理。completeAuthorization を呼んでリダイレクト。
    if (url.pathname === "/authorize" && request.method === "POST") {
      let body: FormData;
      try {
        body = await request.formData();
      } catch {
        return new Response("invalid_request: cannot parse form body", { status: 400 });
      }

      const clientId           = (body.get("client_id") as string) ?? "";
      const redirectUri        = (body.get("redirect_uri") as string) ?? "";
      const state              = (body.get("state") as string) ?? "";
      const codeChallenge      = (body.get("code_challenge") as string) ?? "";
      const codeChallengeMethod = (body.get("code_challenge_method") as string) ?? "S256";
      const scope              = (body.get("scope") as string) ?? "";
      const approved           = body.get("approved");

      // キャンセルされた場合（フォームの hidden field が改ざんされた場合も含む）
      if (approved !== "true") {
        const deniedUrl = new URL(redirectUri);
        deniedUrl.searchParams.set("error", "access_denied");
        if (state) deniedUrl.searchParams.set("state", state);
        return Response.redirect(deniedUrl.toString(), 302);
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
