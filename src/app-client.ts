import type { Env } from "./index.js";

/**
 * High-Shinくん本体の内部APIを叩く共通関数。
 *
 * - HIGH_SHIN_INTERNAL_SECRET で認証（Authorization: Bearer ヘッダ）
 * - user_id を自動付与（env.MCP_DEFAULT_USER_ID から）
 * - エラー時は例外 throw → createMcpHandler が JSON-RPC error に変換
 */
export async function callInternalApi<TResult = unknown>(
  env: Env,
  path: string,
  body: Record<string, unknown>
): Promise<TResult> {
  // 環境変数の早期バリデーション
  if (!env.HIGH_SHIN_API_BASE) {
    throw new Error("HIGH_SHIN_API_BASE is not configured");
  }
  if (!env.HIGH_SHIN_INTERNAL_SECRET) {
    throw new Error("HIGH_SHIN_INTERNAL_SECRET is not configured");
  }
  if (!env.MCP_DEFAULT_USER_ID) {
    throw new Error("MCP_DEFAULT_USER_ID is not configured");
  }

  const url = `${env.HIGH_SHIN_API_BASE.replace(/\/$/, "")}/api/internal/${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.HIGH_SHIN_INTERNAL_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: env.MCP_DEFAULT_USER_ID,
        ...body,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`upstream_network_error: ${msg}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `upstream_error: ${res.status} ${res.statusText} — ${text.slice(0, 500)}`
    );
  }

  return (await res.json()) as TResult;
}

/**
 * APIレスポンスをMCPツールレスポンス形式に変換する。
 * MCPクライアント（Claude）は text ブロックを受け取り、JSON を解釈できる。
 */
export function asMcpTextResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}
