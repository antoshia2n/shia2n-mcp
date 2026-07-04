/**
 * 自動写像適用 Scheduled Handler v1.0.0
 *
 * cron `15,45 * * * *` で発火。会員管理くん内部 API
 * `/api/internal/apply-auto-mapping-batch` を Bearer 認証で POST し、
 * Supabase RPC `apply_auto_entitlement_mapping_batch()` を呼び出す。
 *
 * UTAGE ポーリング（cron `0,30 * * * *`）の 15 分後に走ることで、
 * payment_status 変更の reconciliation（トリガー漏れ・マスタ変更・
 * SQL 直接編集起因の変更の追い上げ）を担う。
 *
 * 失敗時は throw で Cloudflare Cron Events に表示（Phase 3 ③ パターン踏襲）。
 * items_pending > 0（会員単位失敗）は正常のリトライ対象のため throw せず
 * console.warn で記録のみ（次 cron で自然リトライ）。
 */

import type { Env } from "./index.js";

export interface ApplyAutoMappingBatchResponse {
  ok: boolean;
  run_id: string;
  status: string;
  items_processed: number;
  items_matched: number;
  items_pending: number;
  changes_applied: number;
  changes_none: number;
}

export async function handleAutoMappingCron(env: Env): Promise<void> {
  const startedAt = Date.now();

  const url = `${env.MEMBERS_API_BASE.replace(/\/$/, "")}/api/internal/apply-auto-mapping-batch`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.MEMBERS_INTERNAL_SECRET}`,
    },
    body: JSON.stringify({ trigger: "cron_scheduled" }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `[auto-mapping] members API HTTP ${response.status}: ${errText}`
    );
  }

  const result = (await response.json()) as ApplyAutoMappingBatchResponse;

  const durationMs = Date.now() - startedAt;
  console.log(
    `[auto-mapping] status=${result.status} processed=${result.items_processed} ` +
    `matched=${result.items_matched} pending=${result.items_pending} ` +
    `changes=${result.changes_applied} duration=${durationMs}ms run_id=${result.run_id}`
  );

  // items_pending > 0 は正常のリトライ対象。エラーではなく warn のみで通知。
  if (result.items_pending > 0) {
    console.warn(
      `[auto-mapping] ${result.items_pending} members failed ` +
      `(will retry next cron). run_id=${result.run_id}`
    );
  }
}
