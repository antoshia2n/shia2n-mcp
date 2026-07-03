/**
 * 会員管理くん内部 API HTTP クライアント v1.0.0
 *
 * shia2n-mcp Scheduled Handler から会員管理くんの内部 API に Bearer 認証で POST する。
 * Supabase 直接アクセスはせず、必ずこの HTTP 経由（High-Shin パターン踏襲）。
 */

import type { UtageReader } from "./utage-client.js";

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

/**
 * /api/internal/sync-utage-batch に POST
 */
export async function postSyncUtageBatch(
  apiBase: string,
  internalSecret: string,
  payload: SyncUtageBatchPayload
): Promise<SyncUtageBatchResponse> {
  const url = `${apiBase.replace(/\/$/, "")}/api/internal/sync-utage-batch`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${internalSecret}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`members API HTTP ${response.status}: ${errText}`);
  }

  return (await response.json()) as SyncUtageBatchResponse;
}
