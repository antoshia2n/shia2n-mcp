/**
 * 学ぶくん A: YouTube → レッスン自動作成
 * tools-manabu.ts
 * v0.2.0 (2026-05-08) - transcript 任意化・手動入力対応
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Env } from "./index.js";

function mnExtractYouTubeVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function mnParseIsoDuration(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (
    parseInt(m[1] ?? "0") * 3600 +
    parseInt(m[2] ?? "0") * 60 +
    parseInt(m[3] ?? "0")
  );
}

async function mnFetchTranscript(videoId: string): Promise<string | null> {
  for (const lang of ["ja", "en", "ja-JP"]) {
    try {
      const res = await fetch(
        `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=json3`
      );
      if (!res.ok) continue;
      const data = await res.json() as { events?: Array<{ segs?: Array<{ utf8?: string }> }> };
      if (!data?.events) continue;

      const text = data.events
        .filter((e) => Array.isArray(e.segs))
        .map((e) => (e.segs ?? []).map((s) => s.utf8 ?? "").join(""))
        .join(" ")
        .replace(/\n/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (text.length > 50) return text;
    } catch {
      continue;
    }
  }
  return null;
}

interface SummaryJson {
  overview: string;
  chapters: Array<{ title: string; summary: string }>;
  key_points: string[];
  takeaways: string[];
}

async function mnGenerateSummary(
  title: string,
  transcript: string,
  anthropicKey: string
): Promise<SummaryJson | null> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      system: `あなたは教育コンテンツ構造化の専門家です。
YouTube動画の文字起こしから学習効率の高い構造化サマリを作ります。
以下のJSON形式のみで返答してください。マークダウンやコードブロック記号は含めないでください。
{"overview":"動画全体の概要（2〜3文）","chapters":[{"title":"章タイトル","summary":"この章の要点（1〜2文）"}],"key_points":["重要ポイント（5〜8個）"],"takeaways":["実践できる行動・次のステップ（2〜5個）"]}`,
      messages: [
        {
          role: "user",
          content: `動画タイトル：${title}\n\n文字起こし：\n${transcript.slice(0, 6000)}`,
        },
      ],
    }),
  });

  if (!res.ok) return null;
  const data = await res.json() as { content: Array<{ text: string }> };
  try {
    return JSON.parse(data.content[0].text) as SummaryJson;
  } catch {
    return {
      overview: "構造化処理に失敗しました。文字起こし全文を直接参照してください。",
      chapters: [],
      key_points: [],
      takeaways: [],
    };
  }
}

export function registerManabuTools(server: McpServer, env: Env): void {
  server.tool(
    "mn__create_lesson_from_youtube",
    "YouTube URLからレッスンページを自動作成する。動画タイトル・文字起こし・構造化サマリ（章立て・主要ポイント）を生成し、mn_lessonsテーブルに保存する。30分以下の動画が対象。字幕がない場合はtranscriptを手動で渡すことも可能。",
    {
      youtube_url: z
        .string()
        .describe("YouTube動画のURL（youtube.com または youtu.be 形式）"),
      course_id: z
        .string()
        .optional()
        .describe("所属コースID（任意。省略可・後付けでも可）"),
      transcript: z
        .string()
        .optional()
        .describe("文字起こしテキスト（任意）。指定した場合は自動取得をスキップしてこのテキストを使用する。字幕がない動画に手動で文字起こしを渡す場合に使う。"),
    },
    async ({ youtube_url, course_id, transcript: manualTranscript }) => {
      // 1. 動画ID抽出
      const videoId = mnExtractYouTubeVideoId(youtube_url);
      if (!videoId) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            error: "YouTube URLから動画IDを取得できませんでした。URLを確認してください。",
          }) }],
        };
      }

      // 2. YouTube Data API v3 でメタ情報取得
      const ytRes = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=snippet,contentDetails&key=${env.YOUTUBE_API_KEY}`
      );
      if (!ytRes.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            error: `YouTube API エラー: ${ytRes.status} — YOUTUBE_API_KEY を Bindings タブで確認してください。`,
          }) }],
        };
      }

      const ytData = await ytRes.json() as {
        items?: Array<{
          snippet: { title: string; channelTitle: string };
          contentDetails: { duration: string };
        }>;
      };

      if (!ytData.items || ytData.items.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            error: "動画が見つかりませんでした。URLまたは公開設定を確認してください。",
          }) }],
        };
      }

      const snippet = ytData.items[0].snippet;
      const title = snippet.title;
      const channelTitle = snippet.channelTitle;
      const durationSec = mnParseIsoDuration(ytData.items[0].contentDetails.duration);

      // 3. 30分上限チェック
      if (durationSec > 1800) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            error: `動画が長すぎます（${Math.floor(durationSec / 60)}分）。現在の運用制限は30分以下です。`,
            video_title: title,
          }) }],
        };
      }

      // 4. 文字起こし取得（手動指定 > 自動取得 > null で続行）
      let transcript: string | null = manualTranscript ?? null;
      if (!transcript) {
        transcript = await mnFetchTranscript(videoId);
      }

      // 5. サマリ生成（transcript がある場合のみ）
      let summaryJson: SummaryJson | null = null;
      if (transcript) {
        summaryJson = await mnGenerateSummary(title, transcript, env.ANTHROPIC_API_KEY);
      }

      // 6. Supabase mn_lessons に INSERT
      const insertRes = await fetch(`${env.SUPABASE_URL}/rest/v1/mn_lessons`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          title,
          video_url: youtube_url,
          video_id: videoId,
          channel_title: channelTitle,
          duration_seconds: durationSec,
          transcript: transcript ?? null,
          summary_json: summaryJson ?? null,
          course_id: course_id ?? null,
        }),
      });

      if (!insertRes.ok) {
        const errText = await insertRes.text();
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `Supabase 保存失敗: ${errText}` }) }],
        };
      }

      const [lesson] = await insertRes.json() as Array<{ id: string; title: string; video_url: string }>;

      return {
        content: [{ type: "text", text: JSON.stringify({
          lesson_id: lesson.id,
          title: lesson.title,
          video_url: lesson.video_url,
          duration_minutes: Math.round(durationSec / 60),
          transcript_status: transcript ? `取得済み（${transcript.length}文字）` : "なし（後から追加可能）",
          key_points_count: summaryJson?.key_points?.length ?? 0,
          overview: summaryJson?.overview ?? "（transcript がないためサマリ未生成）",
          message: `レッスンページを作成しました。lesson_id: ${lesson.id}`,
        }) }],
      };
    }
  );
}
