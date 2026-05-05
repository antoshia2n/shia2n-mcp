import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";

/**
 * knowledge_tag_suggest：タイトル＋本文から topic_tag を最大3個提案する汎用ツール。
 * voice-memo / inbox / Whimsical / セミナー等の全入口で使い回し可能。
 *
 * topic_tag 9種（固定）：
 *   テクノロジー / 人生哲学 / デザイン / コミュニティ / 経営 / AI / 発信 / 自己変革 / 知的生産
 *
 * v0.19.0 で追加（依頼書：3579c6c1-c439-81ad-8aca-db6aef5ea2dc）
 */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const CLASSIFY_MODEL = "claude-haiku-4-5-20251001";

const TOPIC_TAGS = [
  "テクノロジー",
  "人生哲学",
  "デザイン",
  "コミュニティ",
  "経営",
  "AI",
  "発信",
  "自己変革",
  "知的生産",
] as const;

export function registerKnowledgeTagTools(server: McpServer, env: Env): void {
  server.tool(
    "knowledge_tag_suggest",
    `タイトルと本文から topic_tag を最大3個提案する汎用ツール。voice-memo / inbox / Whimsical / セミナー等どの入口でも使い回し可能。topic_tag の選択肢は固定9種（テクノロジー / 人生哲学 / デザイン / コミュニティ / 経営 / AI / 発信 / 自己変革 / 知的生産）。戻り値: { ok, tags: string[], reason: string }`,
    {
      title: z
        .string()
        .min(1)
        .describe("素材のタイトル"),
      body: z
        .string()
        .optional()
        .describe("素材の本文・メモ（省略可。省略時はタイトルのみで判定）"),
    },
    async (args) => {
      if (!env.ANTHROPIC_API_KEY) {
        throw new Error("ANTHROPIC_API_KEY is not configured in Worker Bindings");
      }

      const tagList = TOPIC_TAGS.join(" / ");
      const content = [
        `タイトル：${args.title}`,
        args.body ? `本文：${args.body.slice(0, 1500)}` : null,
      ]
        .filter(Boolean)
        .join("\n");

      const systemPrompt = `あなたはシアニン（Naoki）の知識整理アシスタントです。
以下の固定9種の topic_tag から、素材に最も合うものを最大3個選んでください。

## topic_tag 一覧
${tagList}

## 出力形式
以下の JSON のみを返してください（コードブロック不要）：
{"tags":["タグ1","タグ2"],"reason":"選定理由を30文字以内で"}

ルール：
- tags は必ず上記9種から選ぶ（表記を変えない）
- 1〜3個の範囲で選ぶ（0個は不可）
- 複数ある場合は関連度の高い順に並べる`;

      const res = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: CLASSIFY_MODEL,
          max_tokens: 256,
          system: systemPrompt,
          messages: [{ role: "user", content }],
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `anthropic_error: ${res.status} ${res.statusText} — ${text.slice(0, 300)}`
        );
      }

      const data = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const rawText =
        data.content?.find((c) => c.type === "text")?.text ?? "{}";

      let parsed: { tags?: string[]; reason?: string };
      try {
        parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());
      } catch {
        throw new Error(
          `parse_error: JSON パース失敗 — raw: ${rawText.slice(0, 200)}`
        );
      }

      // 9種以外のタグが混入した場合は除去
      const validTags = (parsed.tags ?? []).filter((t): t is string =>
        (TOPIC_TAGS as readonly string[]).includes(t)
      );

      return asMcpTextResult({
        ok: true,
        tags: validTags.slice(0, 3),
        reason: parsed.reason ?? "",
      });
    }
  );
}
