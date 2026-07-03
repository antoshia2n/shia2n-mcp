/**
 * UTAGE ポーリング Scheduled Handler v1.0.0
 *
 * cron 5,35 * * * * で発火。shia2n の全 UTAGE アカウントから最新読者を fetch し、
 * 会員管理くん内部 API に POST する（4 アカウント並列）。
 *
 * per_page=100・page=1 のみ取得（最新登録者の反映用）。
 * 全件バックフィルは /utage/backfill エンドポイントを使う。
 */

import type { Env } from "./index.js";
import { listUtageAccounts, listReadersForAccount } from "./utage-client.js";
import { postSyncUtageBatch } from "./members-client.js";

export async function handleUtagePolling(env: Env): Promise<void> {
  const startedAt = Date.now();

  try {
    // 1. shia2n の UTAGE アカウント一覧取得
    const accounts = await listUtageAccounts(env.UTAGE_MCP_URL, env.UTAGE_MCP_TOKEN);
    if (accounts.length === 0) {
      console.warn("[utage-polling] no accounts found");
      return;
    }

    // 2. 全アカウント並列で最新読者 fetch → 会員管理くん内部 API POST
    const results = await Promise.allSettled(
      accounts.map(async (account) => {
        const readers = await listReadersForAccount(
          env.UTAGE_MCP_URL,
          env.UTAGE_MCP_TOKEN,
          account.id,
          100,
          1
        );

        if (readers.length === 0) {
          return { account, skipped: true };
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

        return { account, result };
      })
    );

    // 3. 結果ログ（Cloudflare Workers 標準ログに残る・observability 有効）
    const summary = results.map((r, i) => ({
      account: accounts[i].name,
      status: r.status,
      ...(r.status === "fulfilled" ? { result: r.value } : { reason: String(r.reason) }),
    }));
    console.log("[utage-polling] completed", JSON.stringify({
      duration_ms: Date.now() - startedAt,
      summary,
    }));

    // 4. 失敗があれば Slack #03-開発部 に通知
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      const errorText = failed
        .map((r) => (r.status === "rejected" ? String(r.reason) : ""))
        .join("\n");
      await notifyDevSlack(env, `UTAGE polling 一部失敗（${failed.length}/${accounts.length} アカウント）\n\`\`\`\n${errorText}\n\`\`\``);
    }
  } catch (e) {
    const errText = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
    console.error("[utage-polling] fatal error", errText);
    await notifyDevSlack(env, `UTAGE polling 全体失敗\n\`\`\`\n${errText}\n\`\`\``);
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.error("[utage-polling] slack notify failed", e);
  }
}
