/**
 * Cron ジョブ：毎朝ネタ9本メール送信
 *
 * フロー：
 *   1. ContentOS /api/internal/list-posts（score_desc・20件）で直近投稿を取得
 *   2. Claude API（Haiku）に渡してネタ9本生成
 *      - 30代向け 3本
 *      - 心理テク 3本
 *      - ホルモン 3本
 *   3. Resend API でメール送信（HTML 形式）
 *
 * v0.20.0 で追加（依頼書：3194c8d4-3517-4ad9-b996-fe53ca9cfe71）
 */

import type { Env } from "./index.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const GENERATE_MODEL    = "claude-haiku-4-5-20251001";
const RESEND_API_URL    = "https://api.resend.com/emails";

// ─── 型定義 ────────────────────────────────────────────────────────────────────

interface ContentOsPost {
  id: number;
  title: string;
  body_text: string;
  score: "S" | "A" | "B" | "C" | "D" | null;
  platform: string;
  datetime: string | null;
}

interface ContentOsListResponse {
  ok: boolean;
  count: number;
  posts: ContentOsPost[];
}

interface NetaItem {
  theme: string;      // ネタの軸・タイトル案
  hook: string;       // 冒頭フック（1文）
  angle: string;      // 切り口・差別化ポイント
}

interface NetaResult {
  category_30dai: NetaItem[];   // 30代向け 3本
  category_shinri: NetaItem[];  // 心理テク 3本
  category_hormone: NetaItem[]; // ホルモン 3本
}

// ─── ContentOS 投稿取得 ────────────────────────────────────────────────────────

async function fetchRecentPosts(env: Env): Promise<ContentOsPost[]> {
  const url = `${env.CONTENT_OS_API_BASE.replace(/\/$/, "")}/api/internal/list-posts`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CONTENT_OS_INTERNAL_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      user_id: env.MCP_DEFAULT_USER_ID,
      limit: 20,
      sort: "score_desc",
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ContentOS fetch failed: ${res.status} — ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as ContentOsListResponse;
  if (!data.ok) throw new Error("ContentOS returned ok:false");
  return data.posts ?? [];
}

// ─── Claude API でネタ生成 ─────────────────────────────────────────────────────

async function generateNeta(env: Env, posts: ContentOsPost[]): Promise<NetaResult> {
  // 投稿サマリーをテキスト化（スコア高い順・本文は最初の200文字のみ）
  const postsSummary = posts
    .slice(0, 15)
    .map((p, i) => {
      const score = p.score ?? "未評価";
      const body  = (p.body_text ?? "").slice(0, 200).replace(/\s+/g, " ");
      return `[${i + 1}] スコア:${score} / ${p.platform} / ${p.title}\n${body}`;
    })
    .join("\n\n");

  const today = new Date().toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const systemPrompt = `あなたはシアニン（X フォロワー向けコンテンツの発信を支援するアシスタント）です。
過去投稿の傾向を参考にしながら、今日使えるネタを9本提案してください。

## 出力形式
以下の JSON のみ返してください（コードブロック不要）：
{
  "category_30dai": [
    {"theme": "タイトル案", "hook": "冒頭フック1文", "angle": "切り口・差別化ポイント"},
    {"theme": "...", "hook": "...", "angle": "..."},
    {"theme": "...", "hook": "...", "angle": "..."}
  ],
  "category_shinri": [ ... 同形式で3本 ... ],
  "category_hormone": [ ... 同形式で3本 ... ]
}

## カテゴリ定義
- category_30dai：30代特有の悩み・転換点・仕事と家庭の両立・キャリア・お金・体の変化
- category_shinri：認知バイアス・行動心理・モチベーション・習慣化・説得・コミュニケーション
- category_hormone：テストステロン・コルチゾール・セロトニン・オキシトシン・成長ホルモン等と生活習慣・パフォーマンスの関係

## 制約
- hook は「〜だと思ってませんか？」「実は〜」「〜する人が増えています」など読者を引き込む形式
- angle は既存投稿と被らない新しい切り口を意識
- 具体的な数字・期間・固有名詞を含めると強い
- 各項目は JSON の文字列値として返す（改行不要）`;

  const userPrompt = `今日（${today}）のネタ9本を提案してください。\n\n## 過去のスコア高投稿（参考）\n\n${postsSummary}`;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GENERATE_MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Claude API failed: ${res.status} — ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const rawText = data.content?.find((c) => c.type === "text")?.text ?? "{}";

  try {
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned) as NetaResult;
  } catch {
    throw new Error(`Claude parse failed — raw: ${rawText.slice(0, 500)}`);
  }
}

// ─── HTML メール生成 ───────────────────────────────────────────────────────────

function buildEmailHtml(neta: NetaResult, today: string): string {
  const categoryLabels: Array<{ key: keyof NetaResult; label: string; color: string }> = [
    { key: "category_30dai",   label: "30代向け",  color: "#4A90D9" },
    { key: "category_shinri",  label: "心理テク",  color: "#7B68EE" },
    { key: "category_hormone", label: "ホルモン",  color: "#E8844A" },
  ];

  const categorySections = categoryLabels
    .map(({ key, label, color }) => {
      const items = (neta[key] ?? []) as NetaItem[];
      const rows = items
        .map(
          (item, i) => `
        <div style="margin-bottom:18px; padding:14px 16px; background:#fafafa; border-left:3px solid ${color}; border-radius:4px;">
          <div style="font-size:15px; font-weight:bold; color:#1a1a1a; margin-bottom:6px;">${i + 1}. ${item.theme}</div>
          <div style="font-size:13px; color:#555; margin-bottom:4px;"><span style="color:${color}; font-weight:bold;">フック：</span>${item.hook}</div>
          <div style="font-size:13px; color:#555;"><span style="color:${color}; font-weight:bold;">切り口：</span>${item.angle}</div>
        </div>`
        )
        .join("");

      return `
      <div style="margin-bottom:32px;">
        <h2 style="font-size:16px; color:${color}; border-bottom:2px solid ${color}; padding-bottom:6px; margin-bottom:14px;">
          ${label}（3本）
        </h2>
        ${rows}
      </div>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0; padding:0; background:#f0eee7; font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans',sans-serif;">
  <div style="max-width:600px; margin:32px auto; background:#fff; border-radius:8px; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,.08);">
    <div style="background:#1a1a1a; padding:20px 28px;">
      <div style="font-size:12px; color:#aaa; margin-bottom:4px;">しあらぼ 毎朝ネタ便</div>
      <div style="font-size:20px; font-weight:bold; color:#fff;">${today} のネタ9本</div>
    </div>
    <div style="padding:28px;">
      ${categorySections}
      <div style="margin-top:24px; padding:12px 16px; background:#f5f5f5; border-radius:4px; font-size:12px; color:#888; text-align:center;">
        このメールは shia2n-mcp Cron ジョブが自動生成しました
      </div>
    </div>
  </div>
</body>
</html>`;
}

// ─── Resend でメール送信 ────────────────────────────────────────────────────────

async function sendEmail(env: Env, html: string, today: string): Promise<void> {
  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from:    env.RESEND_FROM_EMAIL,   // 例: neta@shia2n.jp
      to:      [env.RESEND_TO_EMAIL],   // Naoki のアドレス
      subject: `${today} のネタ9本`,
      html,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Resend failed: ${res.status} — ${text.slice(0, 300)}`);
  }
}

// ─── Cron エントリーポイント ───────────────────────────────────────────────────

export async function handleScheduled(env: Env): Promise<void> {
  // 必須環境変数チェック
  const missing = (
    ["CONTENT_OS_API_BASE", "CONTENT_OS_INTERNAL_SECRET", "MCP_DEFAULT_USER_ID",
     "ANTHROPIC_API_KEY", "RESEND_API_KEY", "RESEND_FROM_EMAIL", "RESEND_TO_EMAIL"] as Array<keyof Env>
  ).filter((k) => !env[k]);

  if (missing.length > 0) {
    throw new Error(`Cron abort: missing env vars: ${missing.join(", ")}`);
  }

  const today = new Date().toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  // 1. ContentOS から直近投稿を取得
  const posts = await fetchRecentPosts(env);

  // 2. Claude でネタ9本生成
  const neta = await generateNeta(env, posts);

  // 3. HTML メール生成 → Resend で送信
  const html = buildEmailHtml(neta, today);
  await sendEmail(env, html, today);
}
