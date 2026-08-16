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
 *   取り込み元 5 つを 1 つずつ `POST /sync-db`（async: true）で起動した。
 *   理由は、1 回の実行にまとめると上限に収まらないと考えていたことと、
 *   実行記録を 1 本ごとに残したかったこと。
 *
 * 変更（2026-08-16）：`POST /sync-all` を 1 回叩く形に戻した。
 *
 *   理由：5 本を同時に起動すると、ベクトルを作る先（Voyage）の
 *   「1 分あたり 3 回」の制限に当たり、件数の多い inbox 18 件と
 *   アウトプットDB 126 件が弾かれ続けていた（2026-08-16 の実行記録で判明）。
 *   zeus-worker 側を、1 本ずつ順番に流しながら 1 本につき 1 行の記録を残す形へ
 *   変えたので、こちらが 5 本に分けて起動する必要はなくなった。
 *
 *   2026-08-14 に書いた「1 回の実行にまとめると上限に収まらない」という前提は
 *   誤りだった。1 回の呼び出しにつき外への呼び出しは有料で 10,000 回まで許され、
 *   いちばん多いアウトプットDB でも 300 回台にとどまる（zeus-worker 側の
 *   コメントに出どころつきで残してある）。
 *
 * 注意：
 *   zeus-worker 側は ctx.waitUntil で本処理を継続し、レスポンスは即返す。
 *   したがってここでの成功は「起動できた」ことの確認であって、同期完了ではない。
 *   何件入ったかは zeus-worker が自分で書く実行記録
 *   （cronlog:zeus_import・取り込み元 1 本につき 1 行・1 日 5 行）に残る。
 *
 * 起動に失敗したら throw する。起動できなかったことを成功として残すと、
 * 取り込みが動いていないまま気づけなくなるため。
 */

import type { Env } from "./index.js";

export interface ZeusSyncStartResponse {
  ok?: boolean;
  message?: string;
  user_id?: string;
  force_full?: boolean;
  error?: string;
}

/**
 * 取り込み元の本数。zeus-worker の src/index.js の NOTION_DBS と同じ数。
 * ここでは起動しか行わないため並びは持たない（順番は zeus-worker が決める）。
 * 記録に「何本ぶんか」を書くためだけに使う。
 */
const ZEUS_SOURCE_COUNT = 5;

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

  let res: Response;

  try {
    res = await fetch(`${base}/sync-all`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({}),
    });
  } catch (e) {
    throw new Error(
      `[cron-zeus-sync] 起動できませんでした（接続に失敗）：${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }

  const text = await res.text().catch(() => "");

  if (!res.ok) {
    throw new Error(
      `[cron-zeus-sync] 起動できませんでした：${res.status}: ${text.slice(0, 200)}`
    );
  }

  let body: ZeusSyncStartResponse = {};
  try {
    body = JSON.parse(text) as ZeusSyncStartResponse;
  } catch {
    // JSON でなくても 2xx なら起動自体は成立しているため失敗にしない
  }

  if (body.error) {
    throw new Error(
      `[cron-zeus-sync] 起動できませんでした：${String(body.error).slice(0, 200)}`
    );
  }

  console.log(
    "[cron-zeus-sync] started",
    JSON.stringify({ elapsed_ms: Date.now() - started })
  );

  return {
    count: ZEUS_SOURCE_COUNT,
    detail: `取り込みを起動しました（取り込み元 ${ZEUS_SOURCE_COUNT} 本を順番に流します）。何件入ったかは 1 本ごとの記録に残ります`,
  };
}
