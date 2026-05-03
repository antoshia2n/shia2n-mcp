/**
 * /diag 公開診断エンドポイント v0.14.0
 *
 * - 認証不要（機密情報は一切返さない）
 * - レート制限: IPベース・1分あたり5回（OAUTH_KV使用）
 * - 環境変数の存在状態のみ返す（値は返さない）
 * - 各サービスへのHEAD疎通確認（並列・タイムアウト2秒）
 */
import type { Env } from "./index.js";

const VERSION = "0.14.0";
const RATE_LIMIT_PER_MINUTE = 5;

function isPresent(val: unknown): boolean {
  if (val === undefined || val === null) return false;
  if (typeof val === "string") return val !== "";
  return true; // KVNamespace など object 型
}

async function checkRateLimit(request: Request, env: Env): Promise<boolean> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const key = `ratelimit:diag:${ip}`;
  try {
    const current = await env.OAUTH_KV.get(key);
    const count = current ? parseInt(current, 10) : 0;
    if (count >= RATE_LIMIT_PER_MINUTE) return false;
    await env.OAUTH_KV.put(key, String(count + 1), { expirationTtl: 60 });
    return true;
  } catch {
    // KV 障害時はスルー（可用性優先）
    return true;
  }
}

async function pingService(
  base: string
): Promise<{ ok: boolean; latency_ms: number; http_status?: number; error?: string }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 2000);
    const resp = await fetch(base, { method: "HEAD", signal: controller.signal });
    clearTimeout(id);
    return { ok: resp.status < 500, latency_ms: Date.now() - start, http_status: resp.status };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown";
    return {
      ok: false,
      latency_ms: Date.now() - start,
      error: msg.includes("abort") ? "timeout" : "unreachable",
    };
  }
}

const ENV_KEYS: (keyof Env)[] = [
  "MCP_SERVER_SECRET",
  "MCP_DEFAULT_USER_ID",
  "OAUTH_KV",
  "HIGH_SHIN_API_BASE",
  "HIGH_SHIN_INTERNAL_SECRET",
  "ZEUS_API_BASE",
  "ZEUS_INTERNAL_SECRET",
  "ZEUS_EXTERNAL_SECRET",
  "FORM_KUN_API_BASE",
  "FORM_KUN_INTERNAL_SECRET",
  "PAY_KUN_API_BASE",
  "PAY_KUN_INTERNAL_SECRET",
  "FIREBASE_SA_EMAIL",
  "FIREBASE_SA_PRIVATE_KEY",
  "NAOKI_UID",
  "SALES_MANAGER_API_BASE",
  "SLACK_WEBHOOK_01",
  "SLACK_WEBHOOK_02",
  "SLACK_WEBHOOK_03",
  "SLACK_WEBHOOK_04",
];

const SERVICES: { name: string; envKey: keyof Env }[] = [
  { name: "high_shin",     envKey: "HIGH_SHIN_API_BASE"     },
  { name: "zeus",          envKey: "ZEUS_API_BASE"          },
  { name: "form_kun",      envKey: "FORM_KUN_API_BASE"      },
  { name: "pay_kun",       envKey: "PAY_KUN_API_BASE"       },
  { name: "sales_manager", envKey: "SALES_MANAGER_API_BASE" },
];

export async function handleDiag(request: Request, env: Env): Promise<Response> {
  // レート制限チェック
  const allowed = await checkRateLimit(request, env);
  if (!allowed) {
    return Response.json(
      { error: "rate_limit_exceeded", retry_after_seconds: 60 },
      { status: 429 }
    );
  }

  // 環境変数の存在確認（値は絶対に返さない）
  const envStatus: Record<string, "present" | "missing"> = {};
  for (const key of ENV_KEYS) {
    envStatus[key] = isPresent(env[key]) ? "present" : "missing";
  }

  // 各サービスへの疎通確認（並列）
  const connectivityEntries = await Promise.all(
    SERVICES.map(async ({ name, envKey }) => {
      const base = env[envKey] as string | undefined;
      if (!isPresent(base)) {
        return [name, { ok: false, reason: "env_missing" }] as const;
      }
      return [name, await pingService(base!)] as const;
    })
  );
  const connectivity = Object.fromEntries(connectivityEntries);

  return Response.json(
    {
      app: "shia2n-mcp",
      version: VERSION,
      timestamp: new Date().toISOString(),
      db_tables: "n/a (mcp wrapper - no direct db)",
      recent_errors: [],
      env: envStatus,
      connectivity,
    },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    }
  );
}
