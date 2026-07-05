/**
 * 会員管理くん内部 API HTTP クライアント v1.1.0
 *
 * shia2n-mcp から会員管理くんの内部 API に Bearer 認証で POST する。
 * Supabase 直接アクセスはせず、必ずこの HTTP 経由（High-Shin パターン踏襲）。
 *
 * v1.0.0：postSyncUtageBatch（Phase 3 ③）
 * v1.1.0 (2026-07-05)：Phase 4 スコープ A の members__* 関数 3 本を追加
 *   - postMembersSearch / postMembersGet / postMembersUpdate
 *   - 認証は MEMBERS_INTERNAL_TOKEN
 *     （sync-utage-batch 用の MEMBERS_INTERNAL_SECRET とは別 Secret：スコープ分離）
 */

import type { UtageReader } from "./utage-client.js";

// ============================================================
// 既存：sync-utage-batch（Phase 3 ③）
// ============================================================

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

// ============================================================
// Phase 4 スコープ A：members__* 3 本（2026-07-05 新設）
//   認証は MEMBERS_INTERNAL_TOKEN（MEMBERS_INTERNAL_SECRET とは別 Secret）
// ============================================================

export type MembersSearchQueryType = "display_name" | "email" | "sor_id";

export interface MembersSearchPayload {
  query_type: MembersSearchQueryType;
  query: string;
  limit?: number;
}

export interface MembersSearchResult {
  member_id: string;
  display_name: string;
  entitlements_count: number;
  payment_status_keys: string[];
  updated_at: string;
}

export interface MembersSearchResponse {
  ok: boolean;
  results: MembersSearchResult[];
  count: number;
}

export interface MembersGetPayload {
  member_id: string;
}

export interface MembersGetMember {
  member_id: string;
  firebase_uid: string | null;
  display_name: string;
  email: string | null;
  legal_name: string | null;
  line_name: string | null;
  note_name: string | null;
  other_names: Record<string, unknown> | null;
  entitlements: unknown[];
  payment_status: Record<string, unknown> | null;
  shr_member_id: string | null;
  shr_student_id: string | null;
  note_account: string | null;
  consult_case_ids: unknown[];
  meta: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface MembersGetResponse {
  ok: boolean;
  member: MembersGetMember;
}

export interface MembersUpdatePayload {
  member_id: string;
  updates: Record<string, unknown>;
  reason: string;
  preview?: boolean;
}

export interface MembersUpdateResponse {
  ok: boolean;
  preview?: boolean;
  member_id: string;
  before: Record<string, unknown>;
  after?: Record<string, unknown> | null;
  would_change?: Record<string, unknown>;
  would_write_logs?: string[];
  changed_fields?: string[];
  logs_written?: { audit_logs: number; entitlement_logs: number };
  run_id?: string;
  warning?: string;
}

/**
 * 共通：内部 API POST helper（Phase 4 members__* 3 本で共有）
 */
async function postMembersInternal<T>(
  apiBase: string,
  internalToken: string,
  path: string,
  payload: unknown
): Promise<T> {
  const url = `${apiBase.replace(/\/$/, "")}${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${internalToken}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`members API HTTP ${response.status}: ${errText}`);
  }

  return (await response.json()) as T;
}

/**
 * /api/internal/members-search に POST（Phase 4）
 */
export async function postMembersSearch(
  apiBase: string,
  internalToken: string,
  payload: MembersSearchPayload
): Promise<MembersSearchResponse> {
  return postMembersInternal<MembersSearchResponse>(
    apiBase,
    internalToken,
    "/api/internal/members-search",
    payload
  );
}

/**
 * /api/internal/members-get に POST（Phase 4）
 */
export async function postMembersGet(
  apiBase: string,
  internalToken: string,
  payload: MembersGetPayload
): Promise<MembersGetResponse> {
  return postMembersInternal<MembersGetResponse>(
    apiBase,
    internalToken,
    "/api/internal/members-get",
    payload
  );
}

/**
 * /api/internal/members-update に POST（Phase 4）
 */
export async function postMembersUpdate(
  apiBase: string,
  internalToken: string,
  payload: MembersUpdatePayload
): Promise<MembersUpdateResponse> {
  return postMembersInternal<MembersUpdateResponse>(
    apiBase,
    internalToken,
    "/api/internal/members-update",
    payload
  );
}
