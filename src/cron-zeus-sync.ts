/**
 * Cron ジョブ：Zeus（Notion → Zeus 同期）の起動
 *
 * cron `0,30 * * * *` の UTC 18:00（JST 03:00）分岐からのみ呼ばれる。
 * zeus-worker の `POST /sync-all` を Bearer 認証で叩き、同期を開始させる。
 *
 * 背景（2026-08-03）：
 *   Cloudflare Free プランの Cron Triggers はアカウントあたり 5 本が上限で、
 *   すでに 5 本（shia2n-mcp × 2 / shr-webhook / booking-kun-cron /
 *   high-shin-cron）が埋まっており、zeus-worker 側の cron 登録が拒否され
 *   デプロイが失敗し続けていた。
 *   そこで zeus-worker の cron を廃止し、この枝から HTTP で起動する方式へ
 *   切り替えた（cron 枠を 1 本も増やさない）。
 *
 * 注意：
 *   zeus-worker 側は ctx.waitUntil で本処理を継続し、レスポンスは即返す。
 *   したがってここでの成功は「起動できた」ことの確認であって、同期完了では
 *   ない。同期結果は zeus-worker 側の Workers Logs に記録される。
 *
 * 失敗時は throw で Cloudflare Cron Events に失敗として表示させる
 * （cron-auto-mapping.ts のパターン踏襲）。
 */

import type { Env } from "./index.js";

export interface ZeusSyncStartResponse {
  ok?: boolean;
  message?: string;
  user_id?: string;
  force_full?: boolean;
  error?: string;
}

export async function handleZeusSync(env: Env): Promise<void> {
  const base = (env.ZEUS_WORKER_URL || "").replace(/\/+$/, "");
  const secret = env.ZEUS_WORKER_SECRET;

  if (!base || !secret) {
    throw new Error(
      `[cron-zeus-sync] not configured: ${JSON.stringify({
        ZEUS_WORKER_URL: !!base,
        ZEUS_WORKER_SECRET: !!secret,
      })}`
    );
  }

  const started = Date.now();
  let res: Response;

  try {
    res = await fetch(`${base}/sync-all`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({}),
    });
  } catch (e) {
    throw new Error(
      `[cron-zeus-sync] fetch failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  const text = await res.text().catch(() => "");

  if (!res.ok) {
    throw new Error(`[cron-zeus-sync] ${res.status}: ${text.slice(0, 300)}`);
  }

  let body: ZeusSyncStartResponse = {};
  try {
    body = JSON.parse(text) as ZeusSyncStartResponse;
  } catch {
    // JSON でなくても 2xx なら起動自体は成立しているため throw しない
  }

  console.log(
    "[cron-zeus-sync] started",
    JSON.stringify({
      status: res.status,
      ok: body.ok ?? null,
      message: body.message ?? text.slice(0, 120),
      elapsed_ms: Date.now() - started,
    })
  );
}
