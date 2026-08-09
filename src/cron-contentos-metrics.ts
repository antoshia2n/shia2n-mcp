/**
 * Cron ジョブ：Buffer の反応の数字を ContentOS の成績へ戻す
 *
 * cron `0,30 * * * *` の UTC 03:00（JST 12:00）分岐からのみ呼ばれる。
 * ContentOS 側の `POST /api/internal/sync-buffer-metrics` を Bearer 認証で叩く。
 *
 * なぜ ContentOS 側に本体を置いたか（2026-08-09）：
 *   投稿の表（posts）を持っているのは ContentOS だけで、この Worker からは
 *   直接触らない作りになっている。こちらに本体を置くと、表を触るための鍵を
 *   もう 1 本増やすことになるため、起動だけをこちらが担当する。
 *   Zeus 同期（cron-zeus-sync.ts）と同じ形。
 *
 * なぜ JST 12:00 か：
 *   Buffer 側の数字は 1 日 1 回まとめて更新される。2026-08-09 の実測では
 *   更新時刻は JST 10:52 だった。その後に取りに行く時刻として正午を選んだ。
 *   Zeus 同期（JST 03:00）・データの控え（JST 04:00〜06:45）とも重ならない。
 *   cron の枠は増やしていない（既存の 2 本に相乗り）。
 *
 * 失敗時は throw で Cloudflare Cron Events に失敗として表示させる。
 */

import type { Env } from "./index.js";
import { callContentOsInternalApi } from "./tools-content-os.js";

export interface SyncBufferMetricsSummary {
  /** Buffer から取れた送信済みの投稿の本数 */
  buffer_posts: number;
  /** ContentOS 側で見に行った投稿の本数 */
  contentos_posts: number;
  /** 突き合わせができた本数 */
  matched: number;
  /** 投稿当日のため取り込まなかった本数 */
  too_new: number;
  /** 21 日を過ぎているので触らなかった本数 */
  finalized: number;
  /** ContentOS 側に対応する投稿が見つからなかった本数 */
  unmatched: number;
  /** 数字を書き込んだ本数 */
  numbers_written: number;
  /** 成績を書き込んだ本数 */
  scores_written: number;
  /** 1 回の上限に当たって次回送りにした本数 */
  skipped_by_limit: number;
}

export interface SyncBufferMetricsResponse {
  ok?: boolean;
  summary?: SyncBufferMetricsSummary;
  errors?: string[];
  error?: string;
  detail?: string;
}

export async function handleContentOsMetricsSync(
  env: Env
): Promise<{ count: number | null; detail: string }> {
  const started = Date.now();

  const body = await callContentOsInternalApi<SyncBufferMetricsResponse>(
    env,
    "sync-buffer-metrics",
    {}
  );

  if (!body?.ok) {
    const reason =
      body?.error ??
      (body?.errors?.length ? body.errors.join(" / ") : "理由の記載なし");
    throw new Error(
      `[cron-contentos-metrics] ${String(reason).slice(0, 300)}`
    );
  }

  const s = body.summary;
  const detail = s
    ? `数字を入れた ${s.numbers_written} 件・成績を付けた ${s.scores_written} 件` +
      `（Buffer 側 ${s.buffer_posts} 件のうち突き合わせできたのは ${s.matched} 件。` +
      `当日のため見送り ${s.too_new} 件・確定済み ${s.finalized} 件・対応なし ${s.unmatched} 件）`
    : "取り込みは通ったが、内訳が返らなかった";

  console.log(
    "[cron-contentos-metrics] done",
    JSON.stringify({ ...s, elapsed_ms: Date.now() - started })
  );

  return { count: s ? s.numbers_written : null, detail };
}
