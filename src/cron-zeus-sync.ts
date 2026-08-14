/**
 * Cron ジョブ：Zeus（Notion → Zeus 同期）の起動
 *
 * cron `0,30 * * * *` の UTC 18:00（JST 03:00）分岐からのみ呼ばれる。
 *
 * 背景（2026-08-03）：
 *   Cloudflare Free プランの Cron Triggers はアカウントあたり 5 本が上限で、
 *   すでに 5 本（shia2n-mcp × 2 / shr-webhook / booking-kun-cron /
 *   high-shin-cron）が埋まっており、zeus-worker 側の cron 登録が拒否され
 *   デプロイが失敗し続けていた。
 *   そこで zeus-worker の cron を廃止し、この枝から HTTP で起動する方式へ
 *   切り替えた（cron 枠を 1 本も増やさない）。
 *
 * 変更（2026-08-14）：`POST /sync-all` を 1 回叩く形をやめ、
 *   取り込み元 5 つを 1 つずつ `POST /sync-db`（async: true）で起動する。
 *
 *   理由：5 本を 1 回の実行でまとめて処理していたため、1 回あたりの上限に
 *   収まらず、アウトプットDB から先が入らないまま 2026-08-09 以降ずっと
 *   止まっていた。8/14 03:00 の実行では inbox とインプットDB を終えた
 *   ところで実行そのものが終わり、実行記録も残らなかった（記録は 5 本を
 *   回し終えたあとに 1 回だけ書く作りだったため）。
 *
 *   1 本ずつ別の実行にすれば、1 本ぶんの重さで済み、どの本がどの理由で
 *   落ちたかも 1 本ごとに記録へ残る。
 *
 * 注意：
 *   zeus-worker 側は ctx.waitUntil で本処理を継続し、レスポンスは即返す。
 *   したがってここでの成功は「5 本とも起動できた」ことの確認であって、
 *   同期完了ではない。何件入ったかは zeus-worker が自分で書く実行記録
 *   （cronlog:zeus_import・1 本につき 1 行）に残る。
 *
 * 1 本でも起動に失敗したら throw する。起動できなかった本があることを
 * 成功として残すと、欠けたまま気づけなくなるため。
 */

import type { Env } from "./index.js";

export interface ZeusSyncStartResponse {
  ok?: boolean;
  message?: string;
  source?: string;
  user_id?: string;
  force_full?: boolean;
  error?: string;
}

/**
 * 取り込み元。zeus-worker の src/index.js の NOTION_DBS と同じ並び・同じ source。
 * 上から順に起動する（軽いものから先に始まるようにするため）。
 */
const ZEUS_SOURCES: { source: string; label: string }[] = [
  { source: "notion-inbox", label: "inbox" },
  { source: "notion-input", label: "インプットDB" },
  { source: "notion-output", label: "アウトプットDB" },
  { source: "notion-asset", label: "アセットDB" },
  { source: "notion-project", label: "プロジェクトDB" },
];

interface StartResult {
  /** 起動できたか */
  ok: boolean;
  /** 起動できなかったときの理由。成功時は空文字 */
  reason: string;
}

/** 1 本ぶんの起動。起動できたかどうかだけを返す */
async function startOne(
  base: string,
  secret: string,
  source: string
): Promise<StartResult> {
  let res: Response;

  try {
    res = await fetch(`${base}/sync-db`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ source, async: true }),
    });
  } catch (e) {
    return {
      ok: false,
      reason: `fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const text = await res.text().catch(() => "");

  if (!res.ok) {
    return { ok: false, reason: `${res.status}: ${text.slice(0, 200)}` };
  }

  let body: ZeusSyncStartResponse = {};
  try {
    body = JSON.parse(text) as ZeusSyncStartResponse;
  } catch {
    // JSON でなくても 2xx なら起動自体は成立しているため失敗にしない
  }

  if (body.error) {
    return { ok: false, reason: String(body.error).slice(0, 200) };
  }

  return { ok: true, reason: "" };
}

export async function handleZeusSync(
  env: Env
): Promise<{ count: number; detail: string }> {
  const base = (env.ZEUS_WORKER_URL || "").replace(/\/+$/, "");
  const secret = env.ZEUS_WORKER_SECRET;

  if (!base || !secret) {
    throw new Error(
      `[cron-zeus-sync] not configured: ${JSON.stringify({
        ZEUS_WORKER_URL: !!base,
        ZEUS_WORKER_SECRET: !!secret,
      })}`
    );
  }

  const started = Date.now();
  const startedSources: string[] = [];
  const failedSources: string[] = [];

  for (const db of ZEUS_SOURCES) {
    const result = await startOne(base, secret, db.source);

    if (result.ok) {
      startedSources.push(db.label);
    } else {
      failedSources.push(`${db.label}：${result.reason}`);
    }
  }

  console.log(
    "[cron-zeus-sync] started",
    JSON.stringify({
      started: startedSources.length,
      failed: failedSources.length,
      elapsed_ms: Date.now() - started,
    })
  );

  if (failedSources.length > 0) {
    throw new Error(
      `[cron-zeus-sync] ${failedSources.length}/${ZEUS_SOURCES.length} 本が起動できませんでした：${failedSources.join(" ／ ")}`
    );
  }

  return {
    count: startedSources.length,
    detail: `取り込みを ${startedSources.length} 本ぶん起動しました（${startedSources.join(" / ")}）。何件入ったかは 1 本ごとの記録に残ります`,
  };
}
