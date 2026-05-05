import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";

/**
 * inbox_review_assist：Notion inbox レコードを Claude で PIOA 分類提案するツール。
 *
 * 処理フロー：
 *   1. Notion DB（inbox）を期間フィルターでクエリ
 *   2. 各ページのブロックを取得してテキスト化
 *   3. Claude API（Haiku）に全レコードを一括投げて分類
 *   4. { id, title, url, destination_db, topic_tags, ... } の JSON 配列を返す
 *
 * v0.17.0 で追加（依頼書：3579c6c1-c439-8132-adf8-f5da13eea6d4）
 */

const INBOX_DB_ID = "31c9c6c1-c439-800f-8093-dd4e9dca241c";
const NOTION_API_BASE = "https://api.notion.com/v1";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const CLASSIFY_MODEL = "claude-haiku-4-5-20251001";

// ─── Notion API ヘルパー ─────────────────────────────────────────────────────

async function notionGet(token: string, path: string): Promise<unknown> {
  const res = await fetch(`${NOTION_API_BASE}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `notion_get_error: ${res.status} ${res.statusText} — ${text.slice(0, 300)}`
    );
  }
  return res.json();
}

async function notionPost(
  token: string,
  path: string,
  body: unknown
): Promise<unknown> {
  const res = await fetch(`${NOTION_API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `notion_post_error: ${res.status} ${res.statusText} — ${text.slice(0, 300)}`
    );
  }
  return res.json();
}

// ─── Notion ブロック → テキスト変換 ─────────────────────────────────────────

type NotionRichText = { plain_text?: string }[];

function extractRichText(richText: NotionRichText): string {
  return richText.map((r) => r.plain_text ?? "").join("");
}

type NotionBlock = {
  type: string;
  [key: string]: unknown;
};

function extractBlocksText(blocks: NotionBlock[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    const content = block[block.type] as { rich_text?: NotionRichText } | undefined;
    if (!content?.rich_text) continue;
    const text = extractRichText(content.rich_text).trim();
    if (text) lines.push(text);
  }
  // 長すぎる場合は 2000 文字で切り詰め（Claude API のトークン節約）
  return lines.join("\n").slice(0, 2000);
}

// ─── inbox レコード取得 ───────────────────────────────────────────────────────

interface InboxRecord {
  id: string;
  title: string;
  created_time: string;
  date: string | null;
  url: string;
  body: string;
}

async function queryInboxRecords(
  token: string,
  dateFrom: string | undefined,
  dateTo: string | undefined,
  limit: number
): Promise<InboxRecord[]> {
  // Notion クエリフィルター構築
  const filters: unknown[] = [];
  if (dateFrom) {
    filters.push({ property: "日付", date: { on_or_after: dateFrom } });
  }
  if (dateTo) {
    filters.push({ property: "日付", date: { on_or_before: dateTo } });
  }

  const queryBody: Record<string, unknown> = {
    page_size: Math.min(limit, 100),
    sorts: [{ property: "日付", direction: "descending" }],
  };
  if (filters.length === 1) {
    queryBody.filter = filters[0];
  } else if (filters.length >= 2) {
    queryBody.filter = { and: filters };
  }

  const result = (await notionPost(
    token,
    `/databases/${INBOX_DB_ID}/query`,
    queryBody
  )) as { results?: unknown[] };
  const pages = (result.results ?? []) as Array<{
    id: string;
    created_time: string;
    url: string;
    properties: Record<string, unknown>;
  }>;

  // 各ページのブロックを取得してテキスト化
  const records: InboxRecord[] = [];
  for (const page of pages.slice(0, limit)) {
    // タイトル取得
    const titleProp = page.properties?.title as
      | { title?: NotionRichText }
      | undefined;
    const title = titleProp?.title
      ? extractRichText(titleProp.title)
      : "(無題)";

    // 日付取得
    const dateProp = page.properties?.["日付"] as
      | { date?: { start?: string } }
      | undefined;
    const date = dateProp?.date?.start ?? null;

    // ページブロック取得（本文）
    let body = "";
    try {
      const blocksRes = (await notionGet(
        token,
        `/blocks/${page.id}/children`
      )) as { results?: NotionBlock[] };
      body = extractBlocksText(blocksRes.results ?? []);
    } catch {
      // ブロック取得失敗はスキップ（タイトルのみで分類）
      body = "";
    }

    records.push({
      id: page.id,
      title,
      created_time: page.created_time,
      date,
      url: page.url,
      body,
    });
  }
  return records;
}

// ─── Claude による一括分類 ────────────────────────────────────────────────────

interface ClassificationResult {
  id: string;
  title: string;
  url: string;
  destination_db: "Project" | "Input" | "Asset" | "廃棄";
  topic_tags: string[];
  asset_type?: string;
  source_type?: string;
  project_goal?: string;
  suggested_title?: string;
  reason: string;
}

async function classifyRecords(
  apiKey: string,
  records: InboxRecord[]
): Promise<ClassificationResult[]> {
  if (records.length === 0) return [];

  // レコードをテキスト化
  const recordsText = records
    .map(
      (r, i) =>
        `[${i + 1}] id:${r.id}\nタイトル：${r.title}\n日付：${r.date ?? r.created_time}\n本文：${r.body || "(なし)"}`
    )
    .join("\n\n---\n\n");

  const systemPrompt = `あなたはシアニン（Naoki）の知的生産システムのアシスタントです。
inbox に溜まった素材を PIOA フレームで振り分けします。

## PIOA 振り分けルール
- Project：プロジェクト化すべき具体的な取り組み・企画・依頼・アクションが必要なもの
- Input：他者の情報・学び・参考素材（書籍/記事/セミナー/他者の話）
- Asset：シアニン自身の知見・ノウハウ・思考・体験（再利用できる自家産コンテンツ）
- 廃棄：重複・古い・価値なし・メモの走り書きで再利用不可

## 出力形式
以下の JSON 配列のみを返してください（コードブロック不要）：
[
  {
    "id": "ページID（[N]のidをそのまま使う）",
    "destination_db": "Project" または "Input" または "Asset" または "廃棄",
    "topic_tags": ["タグ1", "タグ2"],
    "asset_type": "Asset のときのみ：ノウハウ / 思考法 / 体験談 / テンプレート / その他",
    "source_type": "Input のときのみ：書籍 / 記事 / セミナー / 会話 / SNS / その他",
    "project_goal": "Project のときのみ：ゴールを1文で",
    "suggested_title": "より検索しやすいタイトル改善案（元と同じなら省略）",
    "reason": "振り分け理由を20文字以内で"
  }
]

topic_tags は3個以内、具体的なキーワードで（例：X攻略 / 思考法 / AI活用 / ビジネス / コミュニティ / 発信戦略）。
全件必ず出力してください。件数を合わせること。`;

  const userPrompt = `以下の inbox レコード ${records.length} 件を振り分けてください：\n\n${recordsText}`;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CLASSIFY_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
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
  const rawText = data.content?.find((c) => c.type === "text")?.text ?? "[]";

  // JSON パース
  let parsed: Array<{
    id: string;
    destination_db: string;
    topic_tags?: string[];
    asset_type?: string;
    source_type?: string;
    project_goal?: string;
    suggested_title?: string;
    reason?: string;
  }>;
  try {
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(
      `claude_parse_error: JSON パース失敗 — raw: ${rawText.slice(0, 500)}`
    );
  }

  // records とマージして url / title を補完
  return parsed.map((item) => {
    const orig = records.find((r) => r.id === item.id);
    return {
      id: item.id,
      title: orig?.title ?? "(不明)",
      url: orig?.url ?? "",
      destination_db: item.destination_db as ClassificationResult["destination_db"],
      topic_tags: Array.isArray(item.topic_tags)
        ? item.topic_tags.slice(0, 3)
        : [],
      ...(item.asset_type ? { asset_type: item.asset_type } : {}),
      ...(item.source_type ? { source_type: item.source_type } : {}),
      ...(item.project_goal ? { project_goal: item.project_goal } : {}),
      ...(item.suggested_title ? { suggested_title: item.suggested_title } : {}),
      reason: item.reason ?? "",
    };
  });
}

// ─── ツール登録 ───────────────────────────────────────────────────────────────

export function registerInboxReviewTools(server: McpServer, env: Env): void {
  server.tool(
    "inbox_review_assist",
    "Notion inbox の素材を Claude が読んで、PIOA 4 DB（Project / Input / Asset）または廃棄への振り分け候補を提案する。秘書 Claude の週次レビュー時に使う。戻り値: { ok, count, date_from, date_to, records: [{id, title, url, destination_db, topic_tags, asset_type?, source_type?, project_goal?, suggested_title?, reason}] }",
    {
      date_from: z
        .string()
        .optional()
        .describe(
          "取得開始日（ISO 日付 例: 2026-05-01）。省略時は全件対象"
        ),
      date_to: z
        .string()
        .optional()
        .describe(
          "取得終了日（ISO 日付 例: 2026-05-31）。省略時は全件対象"
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("処理件数の上限（既定20・上限50）"),
    },
    async (args) => {
      if (!env.NOTION_TOKEN) {
        throw new Error("NOTION_TOKEN is not configured in Worker Bindings");
      }
      if (!env.ANTHROPIC_API_KEY) {
        throw new Error("ANTHROPIC_API_KEY is not configured in Worker Bindings");
      }

      const limit = args.limit ?? 20;

      // 1. inbox レコード取得
      const records = await queryInboxRecords(
        env.NOTION_TOKEN,
        args.date_from,
        args.date_to,
        limit
      );

      if (records.length === 0) {
        return asMcpTextResult({
          ok: true,
          count: 0,
          date_from: args.date_from ?? null,
          date_to: args.date_to ?? null,
          records: [],
          message: "該当期間の inbox レコードがありません",
        });
      }

      // 2. Claude で一括分類
      const classified = await classifyRecords(env.ANTHROPIC_API_KEY, records);

      return asMcpTextResult({
        ok: true,
        count: classified.length,
        date_from: args.date_from ?? null,
        date_to: args.date_to ?? null,
        records: classified,
      });
    }
  );
}
