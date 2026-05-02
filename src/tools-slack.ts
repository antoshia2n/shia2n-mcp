import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./index.js";

/**
 * Slack 投稿ツールを登録する。
 * Slack Incoming Webhook への POST のみ。双方向通信なし。
 * 命名規約：`slack__<action>`
 *
 * チャンネル → Webhook URL 対応（Cloudflare Workers Secrets）：
 *   SLACK_WEBHOOK_01 → #01-戦略室
 *   SLACK_WEBHOOK_02 → #02-秘書室
 *   SLACK_WEBHOOK_03 → #03-開発部
 *   SLACK_WEBHOOK_04 → #04-コンテンツ部
 */

const CHANNEL_MAP: Record<string, keyof Env> = {
  "01-戦略室":    "SLACK_WEBHOOK_01",
  "02-秘書室":    "SLACK_WEBHOOK_02",
  "03-開発部":    "SLACK_WEBHOOK_03",
  "04-コンテンツ部": "SLACK_WEBHOOK_04",
};

// # プレフィックスを除去して正規化
function normalizeChannel(channel: string): string {
  return channel.startsWith("#") ? channel.slice(1) : channel;
}

export function registerSlackTools(server: McpServer, env: Env): void {
  server.tool(
    "slack_post_message",
    `指定したSlackチャンネルにメッセージを投稿する。各Claudeがセッション末・完了時に使う。利用可能チャンネル：${Object.keys(CHANNEL_MAP).map(c => `#${c}`).join("、")}。戻り値は { ok: true } または { error: string }。`,
    {
      channel: z
        .string()
        .describe(`投稿先チャンネル名。例: "01-戦略室" または "#02-秘書室"。利用可能: ${Object.keys(CHANNEL_MAP).join(", ")}`),
      message: z
        .string()
        .describe("投稿するメッセージ本文。Slack mrkdwn 記法可（*太字*、\`コード\`、改行は \\n）"),
    },
    async (args) => {
      const channelKey = normalizeChannel(args.channel);
      const webhookEnvKey = CHANNEL_MAP[channelKey];

      if (!webhookEnvKey) {
        const available = Object.keys(CHANNEL_MAP).join(", ");
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: `Unknown channel: "${args.channel}". Available: ${available}`,
            }),
          }],
        };
      }

      const webhookUrl = env[webhookEnvKey] as string | undefined;
      if (!webhookUrl) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: `${webhookEnvKey} not configured` }),
          }],
        };
      }

      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: args.message }),
      });

      if (!res.ok) {
        const body = await res.text();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: `Slack API error ${res.status}`, body }),
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ok: true, channel: `#${channelKey}` }),
        }],
      };
    }
  );
}
