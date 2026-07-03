/**
 * UTAGE バックフィル HTTP Handler v1.0.0
 *
 * POST /utage/backfill で発火。指定アカウント（or 全アカウント）の
 * 全読者を per_page=200 ページングで取得して会員管理くん内部 API に POST する。
 *
 * Bearer 認証は index.ts の isAuthorized 内で実施済。
 *
 * リクエストボディ（任意）：
 *   { "account_id": "cAPzyVy8v3Lf", "max_pages": 100 }
 *   account_id 省略時は全アカウント。max_pages 省略時は 100。
 */

import type { Env } from "./index.js";
import { listUtageAccounts, listReadersForAccount } from "./utage-client.js";
import { postSyncUtageBatch } from "./members-client.js";

interface BackfillBody {
  account_id?: string;
  max_pages?: number;
}

interface AccountResult {
  account_id: string;
  account_name: string;
  pages_processed: number;
  total_readers_sent: number;
  total_matched: number;
  total_pending: number;
  error?: string;
}

export async function handleUtageBackfill(request: Request, env: Env): Promise<Response> {
  const startedAt = Date.now();
  let body: BackfillBody = {};
  try {
    body = (await request.json()) as BackfillBody;
  } catch {
    // 空ボディも OK
  }

  const maxPages = body.max_pages ?? 100;
  const perPage = 200;

  try {
    const allAccounts = await listUtageAccounts(env.UTAGE_MCP_URL, env.UTAGE_MCP_TOKEN);
    const targetAccounts = body.account_id
      ? allAccounts.filter((a) => a.id === body.account_id)
      : allAccounts;

    if (targetAccounts.length === 0) {
      return Response.json(
        { error: "no_target_accounts", specified: body.account_id ?? "all" },
        { status: 400 }
      );
    }

    const results: AccountResult[] = [];

    for (const account of targetAccounts) {
      let pagesProcessed = 0;
      let totalReadersSent = 0;
      let totalMatched = 0;
      let totalPending = 0;
      let accountError: string | undefined;

      try {
        for (let page = 1; page <= maxPages; page++) {
          const readers = await listReadersForAccount(
            env.UTAGE_MCP_URL,
            env.UTAGE_MCP_TOKEN,
            account.id,
            perPage,
            page
          );

          if (readers.length === 0) {
            break;
          }

          const result = await postSyncUtageBatch(
            env.MEMBERS_API_BASE,
            env.MEMBERS_INTERNAL_SECRET,
            {
              utage_account_id: account.id,
              utage_account_name: account.name,
              readers,
            }
          );

          pagesProcessed++;
          totalReadersSent += readers.length;
          totalMatched += result.items_matched;
          totalPending += result.items_pending;

          // per_page 未満なら最終ページ（早期終了）
          if (readers.length < perPage) {
            break;
          }
        }
      } catch (e) {
        accountError = e instanceof Error ? e.message : String(e);
      }

      results.push({
        account_id: account.id,
        account_name: account.name,
        pages_processed: pagesProcessed,
        total_readers_sent: totalReadersSent,
        total_matched: totalMatched,
        total_pending: totalPending,
        ...(accountError ? { error: accountError } : {}),
      });
    }

    return Response.json({
      ok: true,
      duration_ms: Date.now() - startedAt,
      results,
    });
  } catch (e) {
    const errText = e instanceof Error ? e.message : String(e);
    return Response.json(
      { ok: false, error: errText, duration_ms: Date.now() - startedAt },
      { status: 500 }
    );
  }
}
