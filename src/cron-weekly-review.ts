/**
 * 週次レビュー起動テキスト自動投稿 cron
 *
 * 運用効率化パッケージ v1.0（Decision 3959c6c1-c439-818b-b56d-ddce1d9fe776 / 2026-07-06）：
 *   日曜 09:00 JST = 日曜 00:00 UTC に発火し、
 *   #01-戦略室 Slack Webhook に週次レビュー起動テキストを投稿する。
 *   Naoki は Slack に届いたテキストを Claude 統括ハブに貼るだけ。
 *
 * 呼び出し：既存 cron trigger "0,30 * * * *" の scheduled ハンドラ内で、
 *   曜日 = 日曜 && UTC hour = 0 && UTC minute = 0 の条件で index.ts から発火。
 *   （ネタ9本メール cron 発火と同じ相乗り方式・Free 枠 5 本上限厳守）
 */

interface WeeklyReviewEnv {
  SLACK_WEBHOOK_01: string;
}

export async function handleWeeklyReviewCron(
  env: WeeklyReviewEnv
): Promise<void> {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10); // YYYY-MM-DD

  // 統括ハブに貼るだけで週次レビューが起動するテキストを組む。
  // 内容変更は本ファイルの編集のみで完結（Notion 側との二重管理を避ける）。
  const message = [
    `週次レビュー起動（${dateStr} 日曜 09:00 JST）`,
    "",
    "統括ハブよろしく。今週の週次レビュー実施お願いします。",
    "",
    "以下の順で状態把握 → 1 枚圧縮報告書（① 現状 / ② 成果 / ③ 課題 / ④ 次アクション / ⑤ リスク）を作成してください。",
    "",
    '1. `munikis__get_context({chat_type: "統括ハブ", n_sessions: 3})` で直近 Sessions・オープン Decisions・進行中 Tasks を一括取得',
    "2. 現 Stage 確認（MUNIKIS_VISION 冒頭「現在の Stage」）",
    "3. 直近 Sessions 申し送りの未消化事項を洗い出し",
    "4. Tasks DB 凍結中タスクの俯瞰",
    "5. 1 枚圧縮報告書を Sessions DB「週次レビュー」チャット種別で起票",
  ].join("\n");

  const res = await fetch(env.SLACK_WEBHOOK_01, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: message }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Slack webhook error ${res.status}: ${text.slice(0, 200)}`
    );
  }

  console.log(
    "[weekly-review] posted",
    JSON.stringify({ date: dateStr, status: res.status })
  );
}
