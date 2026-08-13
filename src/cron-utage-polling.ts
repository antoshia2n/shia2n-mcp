/**
 * UTAGE ポーリング Scheduled Handler v2.1.0
 *
 * cron 0,30 * * * * で発火。
 * UTAGE REST API から最新読者を取得し、会員管理くん内部 API にPOSTする。
 *
 * 注意:
 * - MCPではなくREST APIを使う
 * - UTAGE_API_KEY は Cloudflare Secret に保存する
 * - fatal error / partial failure は再throwして Cron Events に失敗として残す
 *
 * v2.1.0（2026-08-04）：連絡ツール（Slack #03-開発部）への異常通知を削除。
 *   判断記録：https://www.notion.so/3b29c6c1c4398113bc59df5a566ea591
 *   異常は実行記録（cron-log.ts）に残り、GET /diag の last_runs と
 *   munikis__get_context の recent_runs で確認する。
 *   あわせて、部分失敗のときに投げるエラーへ失敗したアカウントと理由を載せた。
 *   通知文にしか入っていなかった情報を記録側へ移すため。
 *   SLACK_WEBHOOK_03 はこのファイルからは参照しなくなった。
 */

import type { Env } from "./index.js";
import { listUtageAccounts, listReadersForAccount } from "./utage-client.js";
import { postSyncUtageBatch } from "./members-client.js";
import { cfAccessHeaders } from "./cf-access.js";

const DEFAULT_UTAGE_API_BASE = "https://api.utage-system.com/v1";

function requireEnv(name: string, value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function getUtageApiKey(env: Env): string {
  /**
   * 原則は UTAGE_API_KEY を使う。
   * 既存運用で UTAGE_MCP_TOKEN に REST APIキーを入れてしまっている場合だけ暫定フォールバックする。
   * MCP接続キーやOAuthアクセストークンを入れてもREST APIで401になる可能性が高い。
   */
  const apiKey = env.UTAGE_API_KEY || env.UTAGE_MCP_TOKEN;
  return requireEnv("UTAGE_API_KEY", apiKey);
}

/** 実行記録に載せるための件数。呼び出し側（index.ts）が使う */
export interface UtagePollingSummary {
  accounts: number;
  readers_total: number;
}

export async function handleUtagePolling(env: Env): Promise<UtagePollingSummary> {
  const startedAt = Date.now();
  const runId = `utage_${new Date().toISOString()}`;

  console.log(
    "[utage-polling] started",
    JSON.stringify({
      run_id: runId,
      started_at: new Date(startedAt).toISOString(),
    })
  );

  try {
    const utageApiBase = env.UTAGE_API_BASE || DEFAULT_UTAGE_API_BASE;
    const utageApiKey = getUtageApiKey(env);
    const membersApiBase = requireEnv("MEMBERS_API_BASE", env.MEMBERS_API_BASE);
    const membersInternalSecret = requireEnv(
      "MEMBERS_INTERNAL_SECRET",
      env.MEMBERS_INTERNAL_SECRET
    );

    const accounts = await listUtageAccounts(utageApiBase, utageApiKey);

    console.log(
      "[utage-polling] accounts fetched",
      JSON.stringify({
        run_id: runId,
        accounts_count: accounts.length,
        accounts: accounts.map((account) => ({
          id: account.id,
          name: account.name,
          type: account.type,
        })),
      })
    );

    if (accounts.length === 0) {
      console.warn(
        "[utage-polling] no accounts found",
        JSON.stringify({ run_id: runId })
      );
      return { accounts: 0, readers_total: 0 };
    }

    const results = await Promise.allSettled(
      accounts.map(async (account) => {
        const readers = await listReadersForAccount(
          utageApiBase,
          utageApiKey,
          account.id,
          100,
          1
        );

        console.log(
          "[utage-polling] readers fetched",
          JSON.stringify({
            run_id: runId,
            account_id: account.id,
            account_name: account.name,
            readers_count: readers.length,
          })
        );

        if (readers.length === 0) {
          return {
            account,
            skipped: true,
            reason: "no_readers",
            readers_count: 0,
          };
        }

        const result = await postSyncUtageBatch(
          membersApiBase,
          membersInternalSecret,
          {
            utage_account_id: account.id,
            utage_account_name: account.name,
            readers,
          },
          // 2026-08-13：会員管理くんの住所の手前に入口の関門を置くため、
          // サービス用の合言葉を載せる。合言葉が未設定なら空で、今までどおり。
          cfAccessHeaders(env)
        );

        return {
          account,
          skipped: false,
          result,
          readers_count: readers.length,
        };
      })
    );

    const summary = results.map((result, index) => {
      const account = accounts[index];

      if (result.status === "fulfilled") {
        return {
          account_id: account.id,
          account_name: account.name,
          status: "fulfilled" as const,
          value: result.value,
        };
      }

      return {
        account_id: account.id,
        account_name: account.name,
        status: "rejected" as const,
        reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
      };
    });

    console.log(
      "[utage-polling] completed",
      JSON.stringify({
        run_id: runId,
        duration_ms: Date.now() - startedAt,
        summary,
      })
    );

    const failed = results.filter((result) => result.status === "rejected");

    if (failed.length > 0) {
      const errorText = summary
        .filter((item) => item.status === "rejected")
        .map((item) => `${item.account_name}: ${item.reason}`)
        .join("\n");

      // 2026-08-04：連絡ツールへの通知をやめ、失敗の原因を投げるエラーに載せる。
      // ここで載せないと、実行記録には「何アカウント落ちたか」しか残らず、
      // 「どのアカウントがなぜ落ちたか」が失われる（依頼書の完了条件2を満たさない）。
      throw new Error(
        `UTAGE polling partial failure: ${failed.length}/${accounts.length}\n${errorText}`
      );
    }

    // 2026-08-04：実行記録に載せる件数を返す。
    // 送った読者の数を合計する（読者が 0 件で飛ばしたアカウントは 0 として数える）。
    const readersTotal = results.reduce((total, result) => {
      if (result.status !== "fulfilled") return total;
      return total + (result.value.readers_count ?? 0);
    }, 0);

    return { accounts: accounts.length, readers_total: readersTotal };
  } catch (error) {
    const errText =
      error instanceof Error
        ? `${error.message}\n${error.stack ?? ""}`
        : String(error);

    console.error(
      "[utage-polling] fatal error",
      JSON.stringify({
        run_id: runId,
        duration_ms: Date.now() - startedAt,
        error: errText,
      })
    );

    // 2026-08-04：連絡ツールへの通知をやめた。
    // 全体失敗は投げ直され、呼び出し側（index.ts の runAndRecord）が
    // 原因つきで実行記録に残す。
    throw error;
  }
}
