/**
 * UTAGE の読者を、データベースへ直接写す（2026-10-07 開発部・旧の 2 本を落とす行の 9 便の 7 番目）
 *
 * それまでは会員管理くんの受け口 /api/internal/sync-utage-batch を経由し、
 * その先で関数 sync_utage_readers_batch（旧の members でメールを突き合わせる）を呼んでいた。
 * 会員管理くんの画面を畳む（2026-10-07 Naoki 判断）のに合わせ、
 * 同じ仕事を shia2n-mcp から直接行う：
 *   1. 実行記録 sync_run_logs に running を 1 行入れる（source は前と同じ utage_polling）
 *   2. 関数 sync_utage_readers_batch_v2 を呼ぶ（新しい表 member でメールを突き合わせ、
 *      member_utage_readers.member_new_id に結ぶ）
 *   3. 実行記録を success／error で閉じる
 * 返す形は前の受け口と同じ（ok・run_id・items_processed・items_matched・items_pending）。
 * 設定の追加は 0 個（SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY は既存）。
 */

import type { UtageReader } from "./utage-client.js";

interface DbEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

export interface SyncUtageBatchPayload {
  utage_account_id: string;
  utage_account_name: string;
  readers: UtageReader[];
}

export interface SyncUtageBatchResponse {
  ok: boolean;
  run_id: string;
  items_processed: number;
  items_matched: number;
  items_pending: number;
}

function headers(env: DbEnv, prefer?: string): Record<string, string> {
  const h: Record<string, string> = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  if (prefer) h.Prefer = prefer;
  return h;
}

async function closeRun(env: DbEnv, runId: string, body: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/sync_run_logs?id=eq.${encodeURIComponent(runId)}`, {
      method: "PATCH",
      headers: headers(env, "return=minimal"),
      body: JSON.stringify({ ...body, finished_at: new Date().toISOString() }),
    });
  } catch {
    // 記録の閉じ損ねで取り込みそのものは失敗にしない
  }
}

export async function syncUtageBatchToDb(
  env: DbEnv,
  payload: SyncUtageBatchPayload
): Promise<SyncUtageBatchResponse> {
  const { utage_account_id, utage_account_name, readers } = payload;

  const runRes = await fetch(`${env.SUPABASE_URL}/rest/v1/sync_run_logs?select=id`, {
    method: "POST",
    headers: headers(env, "return=representation"),
    body: JSON.stringify({
      source: "utage_polling",
      utage_account_id,
      status: "running",
      meta: { utage_account_name, readers_count: readers.length, via: "shia2n-mcp" },
    }),
  });
  if (!runRes.ok) {
    throw new Error(`sync_run_logs insert HTTP ${runRes.status}: ${await runRes.text()}`);
  }
  const runRows = (await runRes.json()) as Array<{ id: string }>;
  const runId = String(runRows[0]?.id ?? "");

  const rpcRes = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/sync_utage_readers_batch_v2`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({
      p_utage_account_id: utage_account_id,
      p_utage_account_name: utage_account_name,
      p_readers: readers,
    }),
  });
  if (!rpcRes.ok) {
    const detail = await rpcRes.text();
    if (runId) await closeRun(env, runId, { status: "error", error_message: detail.slice(0, 1000) });
    throw new Error(`sync_utage_readers_batch_v2 HTTP ${rpcRes.status}: ${detail}`);
  }
  const result = (await rpcRes.json()) as {
    items_processed: number;
    items_matched: number;
    items_pending: number;
  };

  if (runId) {
    await closeRun(env, runId, {
      status: "success",
      items_processed: result.items_processed,
      items_matched: result.items_matched,
      items_pending: result.items_pending,
    });
  }

  return {
    ok: true,
    run_id: runId,
    items_processed: result.items_processed,
    items_matched: result.items_matched,
    items_pending: result.items_pending,
  };
}
