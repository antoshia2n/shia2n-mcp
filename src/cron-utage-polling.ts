/**
 * UTAGE ポーリング Scheduled Handler v2.0.0
 *
 * cron 0,30 * * * * で発火。
 * UTAGE REST API から最新読者を取得し、会員管理くん内部 API にPOSTする。
 *
 * 注意:
 * - MCPではなくREST APIを使う
 * - UTAGE_API_KEY は Cloudflare Secret に保存する
 * - fatal error / partial failure は再throwして Cron Events に失敗として残す
 */

import type { Env } from "./index.js";
import { listUtageAccounts, listReadersForAccount } from "./utage-client.js";
import { postSyncUtageBatch } from "./members-client.js";

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

export async function handleUtagePolling(env: Env): Promise<void> {
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
      return;
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
          };
        }

        const result = await postSyncUtageBatch(
          membersApiBase,
          membersInternalSecret,
          {
            utage_account_id: account.id,
            utage_account_name: account.name,
            readers,
          }
        );

        return {
          account,
          skipped: false,
          result,
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

      await notifyDevSlack(
        env,
        `UTAGE polling 一部失敗（${failed.length}/${accounts.length} アカウント）\n\`\`\`\n${errorText}\n\`\`\``
      );

      throw new Error(`UTAGE polling partial failure: ${failed.length}/${accounts.length}`);
    }
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

    await notifyDevSlack(
      env,
      `UTAGE polling 全体失敗\n\`\`\`\n${errText}\n\`\`\``
    );

    throw error;
  }
}

/**
 * Slack #03-開発部 に通知（SLACK_WEBHOOK_03）
 */
async function notifyDevSlack(env: Env, text: string): Promise<void> {
  try {
    if (!env.SLACK_WEBHOOK_03) return;

    await fetch(env.SLACK_WEBHOOK_03, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
  } catch (error) {
    console.error("[utage-polling] slack notify failed", error);
  }
}
