/**
 * GET /place-check  置き場が生きているかを 1 画面で見る口
 *
 * タスク：https://www.notion.so/3b99c6c1c43981ea86cde8be9a14c1bf
 *
 * 何をするか
 *   置き場の一覧（Systems）の全行を読み、本番の住所が入っている行だけを順に叩いて、
 *   名前と「開くか」を並べて返す。Naoki が開くのはこの住所 1 つだけで済む。
 *
 * 設計の理由
 *   - 住所の一覧をこのファイルに持たない。一覧を 2 か所に置くと必ず食い違うため、
 *     置き場の一覧そのものを毎回読む。行が増減しても直す場所は無い。
 *   - 認証は付けない。返すのはアプリの名前と公開されている住所、それが開いたかだけで、
 *     鍵・件数・中身は一切返さない（2026-07-31 の決定「認証の外に置く点検画面は
 *     表示を存在確認だけに削る」に沿う）。代わりに /diag と同じ回数制限を付ける。
 *   - 判定を 3 つに分ける。応答が返ること（開く）と、応答はあるが中身が出ないこと
 *     （400 番台・500 番台）は別の事実で、混ぜると消えた置き場を取りこぼす。
 *   - 1 回の実行で外へ出せる呼び出しの本数には上限がある（無料の枠は 50 本）。
 *     2026-08-10 に Zeus の取り込みがこの上限で落ちているため、叩く先を
 *     MAX_TARGETS 本で頭打ちにし、超えた分は「今回は調べていない」と明示して返す。
 *
 * v0.48.0（2026-08-11）の直し：2 回叩く形にした
 *   1 回目は HEAD（軽い叩き方）。ここで 200 番台が返らなかった行だけ、
 *   2 回目にふつうの叩き方（GET）でもう一度確かめる。
 *   きっかけ：記録くんが HEAD にだけ 500 を返す作りで、画面は普通に出るのに
 *   「応答はあるが開かない」と並んだ。呼ぶたびに同じ確かめをやり直すことになるため。
 *   2 回目の本数は MAX_RETRIES で頭打ちにし、外への呼び出しが上限に当たらないようにする
 *   （最悪でも 一覧の取り込み 2 ＋ MAX_TARGETS ＋ MAX_RETRIES で 44 本）。
 */
import type { Env } from "./index.js";
import { APP_VERSION } from "./version.js";

const RATE_LIMIT_PER_MINUTE = 5;

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2025-09-03";
const NOTION_PAGE_SIZE = 100;

/** 置き場の一覧（Systems）。cron-backup.ts が持っているものと同じ */
const SYSTEMS_DATA_SOURCE_ID = "f4132219-976e-48ba-ad3a-452108a6ee30";

/** 住所 1 つあたりの待ち時間 */
const PING_TIMEOUT_MS = 4000;

/**
 * 1 回の実行で叩く住所の上限。
 * 無料の枠は 1 回の実行につき外への呼び出し 50 本まで。
 * 一覧の取り込みで 1〜2 本、確かめ直しで最大 MAX_RETRIES 本を使うため 30 本で止める。
 * 2026-08-11 時点で住所が入っている行は 20 行（実測）。
 */
const MAX_TARGETS = 30;

/** 200 番台が返らなかった行を、ふつうの叩き方で確かめ直す本数の上限 */
const MAX_RETRIES = 12;

/**
 * 対照に置く行の名前。
 * この住所はいまこの応答を返している当のサーバーなので、
 * ここが「開かない」と出たら調べ方そのものが壊れている。
 */
const CONTROL_NAME = "shia2n-mcp";

type Verdict = "開く" | "応答はあるが開かない" | "開かない" | "住所の登録が無い";

interface Row {
  名前: string;
  使用: string | null;
  本番URL: string | null;
}

interface Result {
  名前: string;
  使用: string | null;
  本番URL: string | null;
  判定: Verdict;
  状況番号?: number;
  応答時間ms?: number;
  叩き方?: string;
  理由?: string;
}

async function checkRateLimit(request: Request, env: Env): Promise<boolean> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const key = `ratelimit:place-check:${ip}`;
  try {
    const current = await env.OAUTH_KV.get(key);
    const count = current ? parseInt(current, 10) : 0;
    if (count >= RATE_LIMIT_PER_MINUTE) return false;
    await env.OAUTH_KV.put(key, String(count + 1), { expirationTtl: 60 });
    return true;
  } catch {
    // 保管庫が落ちているときは通す（点検の口が開けなくなる方が困るため）
    return true;
  }
}

/** Notion の 1 行から、必要な 3 つの値だけを取り出す */
function toRow(page: any): Row {
  const props = page?.properties ?? {};

  const titleParts = props["システム名"]?.title;
  const 名前 = Array.isArray(titleParts)
    ? titleParts.map((t: any) => t?.plain_text ?? "").join("").trim()
    : "";

  const url = props["本番URL"]?.url;
  const 使用 = props["使用"]?.select?.name ?? null;

  return {
    名前: 名前 || "（名前が空の行）",
    使用,
    本番URL: typeof url === "string" && url !== "" ? url : null,
  };
}

/** 置き場の一覧を全行取り込む */
async function fetchRows(env: Env): Promise<{ rows: Row[]; error?: string }> {
  const rows: Row[] = [];
  let cursor: string | undefined;

  // 上限に当たらないよう 2 回までにする（1 回 100 行・現在 35 行）
  for (let i = 0; i < 2; i++) {
    let res: Response;
    try {
      res = await fetch(`${NOTION_API_BASE}/data_sources/${SYSTEMS_DATA_SOURCE_ID}/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.NOTION_TOKEN}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          page_size: NOTION_PAGE_SIZE,
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
      });
    } catch (e) {
      return { rows, error: `一覧の取り込みに届かなかった（${String(e)}）` };
    }

    if (!res.ok) {
      return { rows, error: `一覧の取り込みに失敗（${res.status}）` };
    }

    const json = (await res.json()) as {
      results?: unknown[];
      has_more?: boolean;
      next_cursor?: string | null;
    };

    if (Array.isArray(json.results)) {
      for (const page of json.results) rows.push(toRow(page));
    }

    if (json.has_more && json.next_cursor) {
      cursor = json.next_cursor;
    } else {
      return { rows };
    }
  }

  return { rows };
}

/** 住所を 1 つ叩く */
async function ping(
  url: string,
  method: "HEAD" | "GET"
): Promise<{
  判定: Verdict;
  状況番号?: number;
  応答時間ms: number;
  理由?: string;
}> {
  const start = Date.now();
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, signal: controller.signal });
    clearTimeout(id);
    const 応答時間ms = Date.now() - start;
    if (res.status >= 200 && res.status < 400) {
      return { 判定: "開く", 状況番号: res.status, 応答時間ms };
    }
    return { 判定: "応答はあるが開かない", 状況番号: res.status, 応答時間ms };
  } catch (e) {
    clearTimeout(id);
    const 応答時間ms = Date.now() - start;
    const name = (e as { name?: string })?.name;
    return {
      判定: "開かない",
      応答時間ms,
      理由: name === "AbortError" ? `${PING_TIMEOUT_MS} ミリ秒で返らなかった` : String(e),
    };
  }
}

export async function handlePlaceCheck(request: Request, env: Env): Promise<Response> {
  const allowed = await checkRateLimit(request, env);
  if (!allowed) {
    return Response.json(
      { error: "rate_limit_exceeded", retry_after_seconds: 60 },
      { status: 429 }
    );
  }

  if (!env.NOTION_TOKEN) {
    return Response.json(
      {
        版: APP_VERSION,
        一覧の取り込み: "できない（Notion の合言葉が未設定）",
        結果: [],
      },
      { status: 500 }
    );
  }

  const { rows, error } = await fetchRows(env);

  if (error) {
    return Response.json(
      { 版: APP_VERSION, 一覧の取り込み: error, 結果: [] },
      { status: 502 }
    );
  }

  // 住所がある行 / 無い行に分ける
  const 住所あり = rows.filter((r) => r.本番URL !== null);
  const 住所なし = rows.filter((r) => r.本番URL === null);

  const 叩く = 住所あり.slice(0, MAX_TARGETS);
  const 見送り = 住所あり.slice(MAX_TARGETS);

  // 1 回目：HEAD（軽い叩き方）
  const 叩いた結果: Result[] = await Promise.all(
    叩く.map(async (r) => {
      const p = await ping(r.本番URL as string, "HEAD");
      return {
        名前: r.名前,
        使用: r.使用,
        本番URL: r.本番URL,
        判定: p.判定,
        状況番号: p.状況番号,
        応答時間ms: p.応答時間ms,
        叩き方: "HEAD",
        理由: p.理由,
      };
    })
  );

  // 2 回目：200 番台が返らなかった行だけ、ふつうの叩き方（GET）で確かめ直す。
  // HEAD にだけエラーを返す作りのサーバーがあるため（実例：記録くん・2026-08-11）。
  const 開かなかった行 = 叩いた結果.filter((r) => r.判定 !== "開く");
  const 確かめ直す = 開かなかった行.slice(0, MAX_RETRIES);
  const 確かめ直せなかった = 開かなかった行.length - 確かめ直す.length;

  await Promise.all(
    確かめ直す.map(async (r) => {
      const 前回の番号 = r.状況番号;
      const p = await ping(r.本番URL as string, "GET");
      r.判定 = p.判定;
      r.状況番号 = p.状況番号;
      r.応答時間ms = p.応答時間ms;
      r.理由 = p.理由;
      r.叩き方 =
        p.判定 === "開く"
          ? `HEAD では ${前回の番号 ?? "返らず"} だったが、ふつうの叩き方（GET）では開いた`
          : "HEAD とふつうの叩き方（GET）の両方で開かなかった";
    })
  );

  const 住所なしの結果: Result[] = 住所なし.map((r) => ({
    名前: r.名前,
    使用: r.使用,
    本番URL: null,
    判定: "住所の登録が無い" as Verdict,
  }));

  const 全結果 = [...叩いた結果, ...住所なしの結果];

  const 数える = (v: Verdict) => 全結果.filter((r) => r.判定 === v).length;

  const 対照行 = 叩いた結果.find((r) => r.名前 === CONTROL_NAME);
  const 対照 = 対照行
    ? {
        名前: 対照行.名前,
        結果: 対照行.判定,
        判定:
          対照行.判定 === "開く"
            ? "この結果は信頼できる"
            : "この結果は信頼できない（必ず開くはずの住所が開いていない）",
      }
    : {
        名前: CONTROL_NAME,
        結果: "一覧に見当たらない",
        判定: "この結果は信頼できない（対照が置けていない）",
      };

  return Response.json({
    版: APP_VERSION,
    取得時刻: new Date().toISOString(),
    一覧の取り込み: "OK",
    対照,
    件数: {
      一覧の全行: rows.length,
      叩いた: 叩いた結果.length,
      開く: 数える("開く"),
      応答はあるが開かない: 数える("応答はあるが開かない"),
      開かない: 数える("開かない"),
      住所の登録が無い: 数える("住所の登録が無い"),
      今回は調べていない: 見送り.length,
      ふつうの叩き方で確かめ直した: 確かめ直す.length,
    },
    結果: 全結果,
    今回は調べていない: 見送り.map((r) => r.名前),
    ...(確かめ直せなかった > 0
      ? { 確かめ直しの上限に当たった件数: 確かめ直せなかった }
      : {}),
  });
}
