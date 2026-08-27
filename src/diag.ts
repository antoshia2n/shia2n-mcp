/**
 * /diag 公開診断エンドポイント
 *
 * 版番号は version.ts の APP_VERSION 1 か所だけを見る（2026-08-08 v0.44.0）。
 * それまでこのファイルは独自の版番号を持っており、点検画面が返す値が
 * 本体の版と食い違っていた。
 *
 * - 認証不要（機密情報は一切返さない）
 * - レート制限: IPベース・1分あたり5回（OAUTH_KV使用）
 * - 環境変数の存在状態のみ返す（値は返さない）
 * - 各サービスへのHEAD疎通確認（並列・タイムアウト2秒）
 * - v0.15.0：入切スイッチの現在値（switches）を追加。
 *   未設定が正常な状態のスイッチを ENV_KEYS に混ぜると missing 表示になり、
 *   設定漏れと見分けが付かなくなるため、別欄で on / off として返す。
 * - v0.16.0：自動で動くものの直近の実行結果（last_runs）を追加。
 *   いつ・成否・件数・失敗原因の 4 点。値そのものではなく結果だけなので
 *   認証なしのままで問題ない（金額・個人情報は含まない）。
 * - v0.17.0：連絡ツールの宛先 4 件（SLACK_WEBHOOK_01〜04）を項目から削除。
 *   通知も投稿の道具も廃止済みで、どこからも読まれていないことを全件確認した。
 *   残しておくと「未設定＝直すべきもの」と読めてしまい、本当の設定漏れが埋もれる。
 * - v0.18.0：疎通確認で叩く先を対象ごとに指定できるようにした（SERVICES の path）。
 *   sales_manager だけ入口が画面のページで、HEAD でも画面を丸ごと作るため 2 秒に
 *   間に合わず timeout になっていた。軽い口 /api/diag へ向ける。
 *   path を指定した対象は 4xx も失敗として扱う（口が消えたことを取りこぼさないため）。
 */
import type { Env } from "./index.js";
import { readAllRuns } from "./cron-log.js";
import { APP_VERSION } from "./version.js";
import { cfAccessHeaders } from "./cf-access.js";
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
  base: string,
  path?: string,
  headers?: Record<string, string>
): Promise<{ ok: boolean; latency_ms: number; http_status?: number; error?: string }> {
  const start = Date.now();
  const target = path ? base.replace(/\/+$/, "") + path : base;
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 2000);
    const resp = await fetch(target, {
      method: "HEAD",
      signal: controller.signal,
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    });
    clearTimeout(id);
    // path を指定した場合は「その口が実在すること」まで見たいので 4xx も失敗にする。
    // path なし（入口を叩く従来どおりの4件）は挙動を変えない。
    const limit = path ? 400 : 500;
    return { ok: resp.status < limit, latency_ms: Date.now() - start, http_status: resp.status };
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
  "ZEUS_API_BASE",
  "ZEUS_INTERNAL_SECRET",
  "ZEUS_EXTERNAL_SECRET",
  // 2026-08-03：zeus-worker の cron 廃止に伴い追加。
  // 本 Worker の 0,30 cron（UTC 18:00 分岐）から POST /sync-all を叩くため、
  // この 2 つが未設定だと毎晩の Zeus 取り込みが動かない。
  "ZEUS_WORKER_URL",
  "ZEUS_WORKER_SECRET",
  "FORM_KUN_API_BASE",
  "FORM_KUN_INTERNAL_SECRET",
  "PAY_KUN_API_BASE",
  "PAY_KUN_INTERNAL_SECRET",
  "FIREBASE_SA_EMAIL",
  "FIREBASE_SA_PRIVATE_KEY",
  "NAOKI_UID",
  "SALES_MANAGER_API_BASE",
  // 2026-08-03：Sales Manager の取得口の合言葉（段階1で追加）。
  // 未設定だと合言葉なしで取りに行くため、段階4（必須化）の前に present を確認する。
  "SALES_MANAGER_INTERNAL_SECRET",
  // 2026-08-12：Cloudflare Access（入口の関門）を機械から通るためのサービス用の合言葉。
  // 2 つそろっていないと、関門をかけた住所への呼び出しがログイン画面に跳ね返される。
  // 値そのものは出さず、有無だけを返す。
  "CF_ACCESS_CLIENT_ID",
  "CF_ACCESS_CLIENT_SECRET",
];

// path を書いた行だけ、入口ではなくその道を叩く。
// sales_manager：入口は画面のページで、HEAD でも画面を丸ごと作るため 2 秒に間に合わない。
// 軽い口（/api/diag・HEAD は即返し）へ向ける。原因と対処は 2026-05-04 に特定済みで、
// 3 か月そのままだったものを今回反映する。
//
// 2026-08-12：sales_manager は住所の手前に Access の関門があるため、
//   サービス用の合言葉を載せずに叩くとログイン画面へ跳ね返され、
//   アプリが生きていても「開かない」と出てしまう。accessGated を立てた行だけ
//   合言葉を載せて叩く。
const SERVICES: { name: string; envKey: keyof Env; path?: string; accessGated?: true }[] = [
  { name: "zeus",          envKey: "ZEUS_API_BASE"          },
  { name: "form_kun",      envKey: "FORM_KUN_API_BASE"      },
  { name: "pay_kun",       envKey: "PAY_KUN_API_BASE"       },
  { name: "sales_manager", envKey: "SALES_MANAGER_API_BASE", path: "/api/diag", accessGated: true },
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
    SERVICES.map(async ({ name, envKey, path, accessGated }) => {
      const base = env[envKey] as string | undefined;
      if (!isPresent(base)) {
        return [name, { ok: false, reason: "env_missing" }] as const;
      }
      const result = await pingService(
        base!,
        path,
        accessGated ? cfAccessHeaders(env) : undefined
      );
      // どの道を叩いたかを結果に載せる（住所そのものは載せない）。
      return [name, path ? { ...result, path } : result] as const;
    })
  );
  const connectivity = Object.fromEntries(connectivityEntries);

  // 入切スイッチの現在値（値そのものは返さず on / off のみ）
  // neta_mail：毎朝のネタ9本メール。off のときは cron が来ても送信処理を実行しない。
  const switches: Record<string, "on" | "off"> = {
    neta_mail: env.NETA_MAIL_ENABLED === "1" ? "on" : "off",
  };

  // 控えの置き場が結び付いているか。値そのものは出さず、有無だけを返す
  const storage: Record<string, "設定あり" | "未設定"> = {
    backup_bucket: env.BACKUP_BUCKET ? "設定あり" : "未設定",
  };

  // 自動で動くものの直近の実行結果（新しいものが先頭・処理ごとに最大 5 件）
  const last_runs = await readAllRuns(env);

  // 関門の合言葉の「形」だけを返す（2026-08-12 追加）。
  //   値そのものは絶対に出さない。出すのは 文字数・末尾の形・前後の空白の有無 の 3 つだけ。
  //   足した理由：あり／なし だけでは、貼り付けのときに一部が欠けた値も「あり」に見えるため、
  //   設定を正しく入れたのに関門を通れない状態を、画面から切り分けられなかった。
  //   Cloudflare が発行する Client ID は「32 文字＋.access」の 39 文字、
  //   Client Secret は 64 文字（2026-08-12 に公式の説明で確認した形）。
  const shapeOf = (v: string | undefined) =>
    v === undefined || v === ""
      ? { 設定: "なし" as const }
      : {
          設定: "あり" as const,
          文字数: v.length,
          前後の空白: v !== v.trim() ? "ある（要修正）" : "なし",
        };
  const idRaw = env.CF_ACCESS_CLIENT_ID;
  const access_token_shape = {
    CF_ACCESS_CLIENT_ID: {
      ...shapeOf(idRaw),
      末尾が_access: idRaw ? idRaw.trim().endsWith(".access") : false,
      想定の文字数: 39,
    },
    CF_ACCESS_CLIENT_SECRET: {
      ...shapeOf(env.CF_ACCESS_CLIENT_SECRET),
      想定の文字数: 64,
    },
  };

  return Response.json(
    {
      app: "shia2n-mcp",
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
      db_tables: "n/a (mcp wrapper - no direct db)",
      recent_errors: [],
      env: envStatus,
      switches,
      storage,
      access_token_shape,
      last_runs,
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
