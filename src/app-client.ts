import type { Env } from "./index.js";
/**
 * アプリ別の接続設定。
 */
interface AppConfig {
  apiBase: string;
  secret: string;
  userId: string;
}
/**
 * 任意のアプリの /api/internal/{path} を叩く汎用関数。
 * 各アプリ用のラッパー（callInternalApi, callZeusInternalApi 等）から呼び出される。
 */
async function callAppInternalApi<TResult = unknown>(
  config: AppConfig,
  path: string,
  body: Record<string, unknown>
): Promise<TResult> {
  if (!config.apiBase) {
    throw new Error("apiBase is not configured");
  }
  if (!config.secret) {
    throw new Error("internal secret is not configured");
  }
  if (!config.userId) {
    throw new Error("userId is not configured");
  }
  const url = `${config.apiBase.replace(/\/$/, "")}/api/internal/${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: config.userId,
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
 * High-Shinくん本体の内部APIを叩く（後方互換シグネチャを維持）。
 */
export async function callInternalApi<TResult = unknown>(
  env: Env,
  path: string,
  body: Record<string, unknown>
): Promise<TResult> {
  return callAppInternalApi<TResult>(
    {
      apiBase: env.HIGH_SHIN_API_BASE,
      secret:  env.HIGH_SHIN_INTERNAL_SECRET,
      userId:  env.MCP_DEFAULT_USER_ID,
    },
    path,
    body
  );
}
/**
 * Zeus（ナレッジハブ）本体の内部APIを叩く。
 * ※ Zeus v2 移行後は callZeusExternalV1Compat に置き換え済み。
 *    このエクスポートは他コードが参照していないが、念のため残す。
 */
export async function callZeusInternalApi<TResult = unknown>(
  env: Env,
  path: string,
  body: Record<string, unknown>
): Promise<TResult> {
  return callAppInternalApi<TResult>(
    {
      apiBase: env.ZEUS_API_BASE,
      secret:  env.ZEUS_INTERNAL_SECRET,
      userId:  env.MCP_DEFAULT_USER_ID,
    },
    path,
    body
  );
}

/**
 * Zeus v2 の v1-compat エンドポイントを叩く（既存 zeus__* ツール用）。
 * Zeus v2 移行後も下位互換を維持するため、/api/external/v1-compat/* を使う。
 * 認証は ZEUS_EXTERNAL_SECRET。
 */
export async function callZeusExternalV1Compat<TResult = unknown>(
  env: Env,
  path: string,
  body: Record<string, unknown>
): Promise<TResult> {
  const url = `https://zeus.shia2n.jp/api/external/v1-compat/${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.ZEUS_EXTERNAL_SECRET}`,
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
    throw new Error(`upstream_error: ${res.status} ${res.statusText} — ${text.slice(0, 500)}`);
  }
  return (await res.json()) as TResult;
}
/**
 * APIレスポンスをMCPツールレスポンス形式に変換する。
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
/**
 * Form-kun 本体の内部APIを叩く。
 */
export async function callFormKunInternalApi<TResult = unknown>(
  env: Env,
  path: string,
  body: Record<string, unknown>
): Promise<TResult> {
  return callAppInternalApi<TResult>(
    {
      apiBase: env.FORM_KUN_API_BASE,
      secret:  env.FORM_KUN_INTERNAL_SECRET,
      userId:  env.MCP_DEFAULT_USER_ID,
    },
    path,
    body
  );
}
/**
 * 任意のアプリの /api/internal/{path} を GET で叩く汎用関数。
 * 読み取り系で GET エンドポイントを使うアプリ（High-Shin Phase 3 等）向け。
 * パラメータは user_id を含むクエリストリングとして URL に付加する。
 */
async function callAppInternalApiGet<TResult = unknown>(
  config: AppConfig,
  path: string,
  params: Record<string, unknown>
): Promise<TResult> {
  if (!config.apiBase) throw new Error("apiBase is not configured");
  if (!config.secret)  throw new Error("internal secret is not configured");
  if (!config.userId)  throw new Error("userId is not configured");

  const qs = new URLSearchParams();
  qs.set("user_id", config.userId);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) qs.set(k, String(v));
  }
  const url = `${config.apiBase.replace(/\/$/, "")}/api/internal/${path}?${qs.toString()}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.secret}` },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`upstream_network_error: ${msg}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`upstream_error: ${res.status} ${res.statusText} — ${text.slice(0, 500)}`);
  }
  return (await res.json()) as TResult;
}

/**
 * High-Shinくん本体の内部APIを GET で叩く（Phase 3 読み取り系）。
 */
export async function callHighShinInternalApiGet<TResult = unknown>(
  env: Env,
  path: string,
  params: Record<string, unknown>
): Promise<TResult> {
  return callAppInternalApiGet<TResult>(
    {
      apiBase: env.HIGH_SHIN_API_BASE,
      secret:  env.HIGH_SHIN_INTERNAL_SECRET,
      userId:  env.MCP_DEFAULT_USER_ID,
    },
    path,
    params
  );
}

/**
 * Pay-kun 本体の内部APIを叩く。
 */
export async function callPayKunInternalApi<TResult = unknown>(
  env: Env,
  path: string,
  body: Record<string, unknown>
): Promise<TResult> {
  return callAppInternalApi<TResult>(
    {
      apiBase: env.PAY_KUN_API_BASE,
      secret:  env.PAY_KUN_INTERNAL_SECRET,
      userId:  env.MCP_DEFAULT_USER_ID,
    },
    path,
    body
  );
}
