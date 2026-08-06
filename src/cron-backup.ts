/**
 * データの控え v2.1.0（2026-08-06）
 *
 * ── v2.1.0 の変更：履歴の印が付いた 13 本を対象から外す ──
 *   控えの目的を「全部消えたときに事業を復旧できること」に絞った結果、
 *   量だけが増える表（動きの記録・配信の記録・取り込みの記録など）は
 *   控えの対象から外すと決まった。控えの大きさの 69% がこの 13 本だった。
 *   表そのものは消さない。控えに入れないだけ。
 *   外した名前は目録に残す（黙って欠けるのを防ぐため）。
 *   あわせて、書き出した大きさを目録と記録の文面に載せる。
 *   保管庫の画面を見に行かなくても 1 日分の大きさが分かるようにするため。
 *
 * 判断記録：置き場を Cloudflare に統一し、データの控えを毎日とる
 *   データは 1 日前まで戻せれば足りるとする。控えは毎日 1 回、Supabase の外に置く。
 *   控えに環境変数の値は含めない。
 *
 * 対象は 3 つ。どれか 1 つが壊れても、残りから取り出せる形にする。
 *   1. Supabase   … 全アプリのデータ（環境変数の「値」だけ除く）
 *   2. Notion     … 経営 OS の 7 つの管理表（履歴が 7 日で消えるため）
 *   3. Firestore  … TaskMaster のタスクとプロジェクト
 *
 * 置き場は Cloudflare の保管庫（R2）。Supabase の外に置くことが要件なので、
 * Supabase Storage には置かない。
 *
 * ── v2.0.0 の変更：1 回で全部やるのをやめ、分けて取る ──
 *   2026-08-06 の実測で、対象 181 件のうち 40〜49 件までしか書けず、
 *   残りが全部「1 回の実行での外部呼び出しが多すぎる」で落ちていた。
 *   これは 1 回の実行あたりの上限なので、実行を分ければ回避できる。
 *   設定の変更も費用もかからない。
 *
 *   進み具合は KV に残し、15 分おきの発火のたびに続きから処理する。
 *   その日ぶんが全部そろって初めて成功として記録する。
 *   途中の回は記録を残さない（毎回記録すると 5 件の枠が 1 日で埋まるため）。
 *   時間内に終わらなかった場合は、最後の回で失敗として記録する。
 *
 * ── v2.0.0 の変更：2 万件を超える表を分けて取る ──
 *   audit_logs が 2 万件を超えており、控えに入り切っていなかった。
 *   超える分は .part2 .part3 … と分けて書き出す。
 *   1 つの塊にまとめないのは、大きな中身を一度に抱えると実行そのものが
 *   落ちるため。戻すときは part を順に読む。
 *
 * 設計上の要点：
 *   - 取得した中身は解釈せずそのまま書き出す。読み替えると、そこで壊れる。
 *   - 途中で 1 つ失敗しても他は続ける。全部止めると 1 つの不調で全滅する。
 *   - 取り切れなかった場合は必ず控えの目録に残す。黙って欠けるのが最悪。
 */

import { Env } from "./index.js";
import { getFirestoreToken } from "./taskmaster.js";
import { runAndRecord } from "./cron-log.js";

/**
 * 控えの対象から外す表（2026-08-06 決定）。
 *
 * 控えの目的は「全部消えたときに事業を復旧できること」に絞られている。
 * 下の 13 本は仕分けで「履歴」の印が付いたもの。量だけが増え、
 * 消えても事業は止まらない。控えの大きさの 69% をこの 13 本が占めていた。
 *
 * 表そのものは消さない。控えに入れないだけ。
 * 外したことは目録にも残す（黙って欠けるのを防ぐため）。
 */
const EXCLUDED_TABLES = new Set<string>([
  "audit_logs",
  "sync_run_logs",
  "pay_webhook_logs",
  "daily_logs",
  "entitlement_logs",
  "hs_deliveries",
  "hs_events",
  "ic_status_logs",
  "mm_import_log",
  "cnt_notion_sync_log",
  "dv_deploy_logs",
  "mn_view_logs",
  "xm_analytics",
]);

/** 1 回の取得で取る行数。これを超える表は part に分けて書き出す */
const ROWS_PER_PART = 20000;

/** 1 つの表を何 part まで追いかけるか（20 × 2 万 = 40 万行まで） */
const MAX_PARTS = 20;

/**
 * 1 回の発火で行う外部とのやり取りの上限。
 * 実測で 40〜49 件（取得 + 書き出しで倍）まで通っていたので、
 * 半分以下にして余裕を持たせる。ここを増やすと再発する。
 */
const MAX_OPS_PER_SLOT = 40;

/** 進み具合を置いておく期間（3 日）。翌日の分は別の鍵になる */
const PROGRESS_TTL_SECONDS = 3 * 24 * 60 * 60;

const NOTION_PAGE_SIZE = 100;
const NOTION_MAX_PAGES = 50;
const NOTION_VERSION = "2025-09-03";
const NOTION_API_BASE = "https://api.notion.com/v1";

// 経営 OS の管理表（2026-08-05 に経営 OS 親ページの一覧で確認）
const NOTION_DATA_SOURCES: { name: string; id: string }[] = [
  { name: "apps",      id: "4221e186-2918-4a44-b6b5-767ad3ed8a9d" },
  { name: "projects",  id: "bed67e0d-e5de-4086-8a87-6b3e23c523f1" },
  { name: "tasks",     id: "dc631523-3b8e-4be4-a9dc-02a3cdf7b6d7" },
  { name: "decisions", id: "b5c89aef-e029-4c0f-9f3a-d30b7dff71fd" },
  { name: "sessions",  id: "bd92c72f-44d8-40d7-87db-b052e3b292ab" },
  { name: "systems",   id: "f4132219-976e-48ba-ad3a-452108a6ee30" },
  { name: "clients",   id: "1fe38dba-0e09-40f0-8920-6d67e9a90f77" },
];

// 値を控えに含めない表と列。判断記録どおり、環境変数の「値」は持ち出さない
const MASKED_COLUMNS: Record<string, string[]> = {
  dv_env_vars: ["value"],
};

// Firestore（TaskMaster）。接続先は taskmaster.ts と同じ
const FIREBASE_PROJECT_ID = "gen-lang-client-0371348401";
const FIREBASE_DB_ID = "ai-studio-622b9a97-52df-425a-85c6-1a2670c54e0a";
const FIRESTORE_BASE =
  `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}` +
  `/databases/${FIREBASE_DB_ID}/documents`;

interface Entry {
  /** 保管庫の中での場所 */
  key: string;
  /** 書けたか */
  ok: boolean;
  /** 何件取れたか（分からないものは null） */
  rows: number | null;
  /** その表の全件数（分かる場合のみ） */
  total: number | null;
  /** 上限に当たって取り切れていないか */
  truncated: boolean;
  /** 分けて書き出した数（1 なら分けていない） */
  parts?: number;
  /** 書き出した大きさ（バイト） */
  bytes?: number;
  /** 失敗の理由 */
  error?: string;
}

type ItemKind = "supabase" | "notion" | "firestore";

interface Item {
  kind: ItemKind;
  /** 表の名前 / 管理表の名前 / 文書の名前 */
  name: string;
  /** Notion の場合のみ使う */
  id?: string;
}

interface Progress {
  版: string;
  対象日: string;
  開始時刻: string;
  items: Item[];
  /** 次に処理する位置 */
  次の位置: number;
  /** 発火して処理した回数 */
  回数: number;
  entries: Entry[];
  表の一覧の取得: string;
  /** 控えの対象から外した表（履歴の印が付いたもの） */
  外した表: string[];
}

/** 1 回の発火で使った外部とのやり取りを数える */
interface Budget {
  used: number;
}

/** 書き出す中身の大きさ（バイト）を数える */
function byteSize(body: string): number {
  return new TextEncoder().encode(body).byteLength;
}

/** 日本時間での日付（YYYY-MM-DD）。朝に動くので、その日の日付で残す */
function jstDate(now: Date): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

function progressKey(date: string): string {
  return `backup:progress:${date}`;
}

// ─────────────────────────────────────────────
// Supabase
// ─────────────────────────────────────────────

/** 表の一覧を取る。定義の一覧はデータベース側が返してくれるので、決め打ちしない */
async function listSupabaseTables(env: Env, budget: Budget): Promise<string[]> {
  budget.used += 1;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`表の一覧を取得できませんでした（${res.status}）`);
  }
  const spec = (await res.json()) as { definitions?: Record<string, unknown> };
  const names = Object.keys(spec.definitions ?? {});
  if (names.length === 0) {
    throw new Error("表の一覧が空でした（取得の仕方が変わった可能性があります）");
  }
  return names.sort();
}

/** Content-Range の "0-99/1234" から全件数を取り出す */
function totalFromContentRange(header: string | null): number | null {
  if (!header) return null;
  const slash = header.lastIndexOf("/");
  if (slash < 0) return null;
  const tail = header.slice(slash + 1);
  if (tail === "*" || tail === "") return null;
  const n = Number(tail);
  return Number.isFinite(n) ? n : null;
}

/** 1 回ぶんの取得。offset から ROWS_PER_PART 件を取る */
async function fetchTablePage(
  env: Env,
  table: string,
  offset: number,
  budget: Budget
): Promise<{ body: string; rows: number | null; total: number | null }> {
  budget.used += 1;
  const url =
    `${env.SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}` +
    `?select=*&limit=${ROWS_PER_PART}&offset=${offset}`;

  const res = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json",
      // 全件数を返してもらう（取り切れたかの判定に使う）
      Prefer: "count=exact",
    },
  });

  if (!res.ok) {
    throw new Error(`取得に失敗（${res.status}）`);
  }

  const total = totalFromContentRange(res.headers.get("content-range"));
  const masked = MASKED_COLUMNS[table];

  if (masked) {
    // 値を持ち出さない表だけは中身を読んで、対象の列を落としてから書く
    const parsed = (await res.json()) as Record<string, unknown>[];
    for (const row of parsed) {
      for (const column of masked) {
        if (column in row) row[column] = null;
      }
    }
    return { body: JSON.stringify(parsed), rows: parsed.length, total };
  }

  // それ以外は読み替えずにそのまま書く（解釈しないので壊れない・速い）
  return { body: await res.text(), rows: null, total };
}

async function backupOneTable(
  env: Env,
  table: string,
  prefix: string,
  budget: Budget
): Promise<Entry> {
  const key = `${prefix}supabase/${table}.json`;

  try {
    const first = await fetchTablePage(env, table, 0, budget);

    budget.used += 1;
    await env.BACKUP_BUCKET.put(key, first.body, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });

    const total = first.total;

    // 2 万件以内なら 1 つの場所に収まっている
    let bytes = byteSize(first.body);

    if (total === null || total <= ROWS_PER_PART) {
      return {
        key,
        ok: true,
        rows: first.rows ?? total,
        total,
        truncated: false,
        parts: 1,
        bytes,
      };
    }

    // 超える分は .part2 .part3 … と分けて書き出す
    let parts = 1;
    let offset = ROWS_PER_PART;

    while (offset < total && parts < MAX_PARTS) {
      const page = await fetchTablePage(env, table, offset, budget);
      parts += 1;
      bytes += byteSize(page.body);

      budget.used += 1;
      await env.BACKUP_BUCKET.put(
        `${prefix}supabase/${table}.part${parts}.json`,
        page.body,
        { httpMetadata: { contentType: "application/json; charset=utf-8" } }
      );

      offset += ROWS_PER_PART;
    }

    return {
      key,
      ok: true,
      rows: Math.min(offset, total),
      total,
      truncated: offset < total,
      parts,
      bytes,
    };
  } catch (error) {
    return {
      key, ok: false, rows: null, total: null, truncated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─────────────────────────────────────────────
// Notion
// ─────────────────────────────────────────────

async function backupOneNotionSource(
  env: Env,
  source: { name: string; id: string },
  prefix: string,
  budget: Budget
): Promise<Entry> {
  const key = `${prefix}notion/${source.name}.json`;

  try {
    const pages: unknown[] = [];
    let cursor: string | undefined;
    let loops = 0;
    let truncated = false;

    while (loops < NOTION_MAX_PAGES) {
      loops += 1;
      budget.used += 1;

      const res = await fetch(
        `${NOTION_API_BASE}/data_sources/${source.id}/query`,
        {
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
        }
      );

      if (!res.ok) {
        return {
          key, ok: false, rows: null, total: null, truncated: false,
          error: `取得に失敗（${res.status}）`,
        };
      }

      const json = (await res.json()) as {
        results?: unknown[];
        has_more?: boolean;
        next_cursor?: string | null;
      };

      if (Array.isArray(json.results)) pages.push(...json.results);

      if (json.has_more && json.next_cursor) {
        cursor = json.next_cursor;
        if (loops === NOTION_MAX_PAGES) truncated = true;
      } else {
        break;
      }
    }

    const body = JSON.stringify(pages);

    budget.used += 1;
    await env.BACKUP_BUCKET.put(key, body, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });

    return {
      key, ok: true, rows: pages.length, total: pages.length,
      truncated, parts: 1, bytes: byteSize(body),
    };
  } catch (error) {
    return {
      key, ok: false, rows: null, total: null, truncated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─────────────────────────────────────────────
// Firestore（TaskMaster）
// ─────────────────────────────────────────────

async function backupOneFirestoreDoc(
  env: Env,
  name: string,
  prefix: string,
  budget: Budget
): Promise<Entry> {
  const key = `${prefix}firestore/${name}.json`;

  try {
    budget.used += 1;
    const token = await getFirestoreToken(env);

    budget.used += 1;
    const res = await fetch(
      `${FIRESTORE_BASE}/users/${env.NAOKI_UID}/app_data/${name}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!res.ok) {
      return {
        key, ok: false, rows: null, total: null, truncated: false,
        error: `取得に失敗（${res.status}）`,
      };
    }

    const body = await res.text();

    budget.used += 1;
    await env.BACKUP_BUCKET.put(key, body, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });

    return {
      key, ok: true, rows: null, total: null,
      truncated: false, parts: 1, bytes: byteSize(body),
    };
  } catch (error) {
    return {
      key, ok: false, rows: null, total: null, truncated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─────────────────────────────────────────────
// 進み具合
// ─────────────────────────────────────────────

async function loadProgress(env: Env, date: string): Promise<Progress | null> {
  try {
    const raw = await env.OAUTH_KV.get(progressKey(date));
    return raw ? (JSON.parse(raw) as Progress) : null;
  } catch {
    return null;
  }
}

async function saveProgress(env: Env, progress: Progress): Promise<void> {
  await env.OAUTH_KV.put(progressKey(progress.対象日), JSON.stringify(progress), {
    expirationTtl: PROGRESS_TTL_SECONDS,
  });
}

/** その日の対象を組み立てる。並びは Supabase → Notion → Firestore の順 */
async function buildItems(
  env: Env,
  budget: Budget
): Promise<{ items: Item[]; 表の一覧の取得: string; 外した表: string[] }> {
  let tables: string[] = [];
  let 表の一覧の取得 = "成功";

  try {
    tables = await listSupabaseTables(env, budget);
  } catch (error) {
    表の一覧の取得 = `失敗：${error instanceof Error ? error.message : String(error)}`;
  }

  // 履歴の印が付いた表を落とす。落とした名前は目録に残す
  const 外した表 = tables.filter((name) => EXCLUDED_TABLES.has(name));
  const 残す表 = tables.filter((name) => !EXCLUDED_TABLES.has(name));

  const items: Item[] = [
    ...残す表.map((name) => ({ kind: "supabase" as const, name })),
    ...NOTION_DATA_SOURCES.map((s) => ({ kind: "notion" as const, name: s.name, id: s.id })),
    { kind: "firestore" as const, name: "tasks" },
    { kind: "firestore" as const, name: "projects" },
  ];

  return { items, 表の一覧の取得, 外した表 };
}

async function processItem(
  env: Env,
  item: Item,
  prefix: string,
  budget: Budget
): Promise<Entry> {
  if (item.kind === "supabase") {
    return backupOneTable(env, item.name, prefix, budget);
  }
  if (item.kind === "notion") {
    return backupOneNotionSource(env, { name: item.name, id: item.id! }, prefix, budget);
  }
  return backupOneFirestoreDoc(env, item.name, prefix, budget);
}

// ─────────────────────────────────────────────
// 目録と締め
// ─────────────────────────────────────────────

async function finalize(
  env: Env,
  progress: Progress,
  prefix: string,
  時間切れ: boolean
): Promise<{ count: number; detail: string }> {
  const entries = progress.entries;
  const succeeded = entries.filter((e) => e.ok);
  const failed = entries.filter((e) => !e.ok);
  const truncated = entries.filter((e) => e.truncated);
  const 未処理 = progress.items.length - progress.次の位置;

  // 失敗の理由を文言ごとに数える。1 件ずつ並べると長くなりすぎるため、
  // 同じ理由はまとめて件数で示す。文言は 80 字で切る（置き場が KV のため）。
  const reasonCounts = new Map<string, number>();
  for (const entry of failed) {
    const reason = (entry.error ?? "理由なし").slice(0, 80);
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  const reasonBreakdown = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason} × ${count}`);

  const lastOkKey = succeeded.length > 0 ? succeeded[succeeded.length - 1].key : null;
  const firstFailedKey = failed.length > 0 ? failed[0].key : null;
  const truncatedKeys = truncated.map((e) => e.key);
  const 分けて書いたもの = succeeded
    .filter((e) => (e.parts ?? 1) > 1)
    .map((e) => `${e.key}（${e.parts} 分割）`);

  const 合計の大きさ = succeeded.reduce((a, e) => a + (e.bytes ?? 0), 0);

  // 対象から外した表について、前の版が同じ日に書き出したものが残っていれば消す。
  // 残したままだと保管庫の使用量が減らず、外した効果が数字に出ないため。
  // 何回動かしても同じ結果になる（無ければ何もしない）。
  let 片づけた数 = 0;
  try {
    const listed = await env.BACKUP_BUCKET.list({ prefix: `${prefix}supabase/` });
    for (const obj of listed.objects) {
      const base = obj.key
        .slice(`${prefix}supabase/`.length)
        .replace(/\.json$/, "")
        .replace(/\.part\d+$/, "");
      if (EXCLUDED_TABLES.has(base)) {
        await env.BACKUP_BUCKET.delete(obj.key);
        片づけた数 += 1;
      }
    }
  } catch (error) {
    console.log("[backup] 片づけに失敗", String(error));
  }

  const manifest = {
    版: "2.1.0",
    対象日: progress.対象日,
    開始時刻: progress.開始時刻,
    完了時刻: new Date().toISOString(),
    発火回数: progress.回数,
    表の一覧の取得: progress.表の一覧の取得,
    件数: {
      対象: progress.items.length,
      書けた: succeeded.length,
      失敗: failed.length,
      未処理,
      取り切れていない: truncated.length,
    },
    合計の大きさ: `${(合計の大きさ / 1024 / 1024).toFixed(2)} MB`,
    控えの対象から外した表: progress.外した表,
    古い控えを片づけた数: 片づけた数,
    失敗の理由の内訳: reasonBreakdown,
    分けて書き出したもの: 分けて書いたもの,
    最後に書けた場所: lastOkKey,
    最初に失敗した場所: firstFailedKey,
    取り切れていない場所: truncatedKeys,
    除外: "環境変数の値（dv_env_vars.value）は控えに含めていません",
    明細: entries,
  };

  await env.BACKUP_BUCKET.put(
    `${prefix}manifest.json`,
    JSON.stringify(manifest, null, 2),
    { httpMetadata: { contentType: "application/json; charset=utf-8" } }
  );

  const 欠けあり =
    progress.表の一覧の取得 !== "成功" ||
    failed.length > 0 ||
    truncated.length > 0 ||
    未処理 > 0;

  // 1 つでも欠けたら失敗として記録に残す。全部そろって初めて「戻せる」ため
  if (欠けあり) {
    const reasons: string[] = [];
    if (progress.表の一覧の取得 !== "成功") {
      reasons.push(`表の一覧を取得できず（${progress.表の一覧の取得}）`);
    }
    if (時間切れ && 未処理 > 0) {
      reasons.push(`時間内に終わらず ${未処理} 件が未処理`);
    }
    if (failed.length > 0) {
      reasons.push(`対象 ${progress.items.length} 件のうち ${failed.length} 件が書けませんでした`);
    }
    if (truncated.length > 0) {
      reasons.push(`${truncated.length} 件が取り切れていません（${truncatedKeys.join("、")}）`);
    }
    if (reasonBreakdown.length > 0) {
      const top = reasonBreakdown.slice(0, 3).join("、");
      const rest = reasonBreakdown.length > 3 ? `、ほか ${reasonBreakdown.length - 3} 種` : "";
      reasons.push(`理由の内訳：${top}${rest}`);
    }
    if (lastOkKey) reasons.push(`最後に書けた場所：${lastOkKey}`);
    if (firstFailedKey) reasons.push(`最初に失敗した場所：${firstFailedKey}`);

    throw new Error(
      `控えに欠けがあります：${reasons.join(" / ")}。詳しくは ${prefix}manifest.json`
    );
  }

  const 分割注記 =
    分けて書いたもの.length > 0 ? `（うち ${分けて書いたもの.length} 件は分割）` : "";

  return {
    count: succeeded.length,
    detail:
      `${progress.対象日} の控えを ${succeeded.length} 件・` +
      `${(合計の大きさ / 1024 / 1024).toFixed(2)} MB 書き出しました${分割注記}。` +
      `${progress.回数} 回に分けて実行。` +
      `履歴として対象から外した表 ${progress.外した表.length} 本（データ・管理表・タスク）`,
  };
}

// ─────────────────────────────────────────────
// 本体：1 回ぶんの発火
// ─────────────────────────────────────────────

export interface SlotResult {
  /** その日ぶんが全部そろったか */
  finished: boolean;
  /** 出番が無かった（その日は開始前、またはすでに終わっている） */
  skipped: boolean;
  処理済み: number;
  対象: number;
}

/**
 * 1 回ぶんの発火。続きから処理して、終わったら記録を残す。
 *
 * @param isStart      その日の最初の回か（true なら新しく組み立てる）
 * @param isLastChance その日の最後の回か（true なら終わっていなくても記録に残す）
 */
export async function runBackupSlot(
  env: Env,
  isStart: boolean,
  isLastChance: boolean
): Promise<SlotResult> {
  if (!env.BACKUP_BUCKET) {
    throw new Error("保管庫（R2）が結び付いていません。設定を確認してください。");
  }

  const now = new Date();
  const date = jstDate(now);
  const prefix = `backup/${date}/`;
  const budget: Budget = { used: 0 };

  let progress = await loadProgress(env, date);

  if (!progress) {
    // 開始の回でなければ出番なし。途中から始めても中途半端な控えになるため
    if (!isStart) {
      return { finished: false, skipped: true, 処理済み: 0, 対象: 0 };
    }
    const built = await buildItems(env, budget);
    progress = {
      版: "2.0.0",
      対象日: date,
      開始時刻: now.toISOString(),
      items: built.items,
      次の位置: 0,
      回数: 0,
      entries: [],
      表の一覧の取得: built.表の一覧の取得,
      外した表: built.外した表,
    };
  }

  // すでにその日ぶんが終わっている
  if (progress.次の位置 >= progress.items.length) {
    return {
      finished: true,
      skipped: true,
      処理済み: progress.次の位置,
      対象: progress.items.length,
    };
  }

  progress.回数 += 1;

  // 上限に当たる手前で止める。1 件ごとに使った回数を見て判断する
  while (progress.次の位置 < progress.items.length && budget.used < MAX_OPS_PER_SLOT) {
    const item = progress.items[progress.次の位置];
    progress.entries.push(await processItem(env, item, prefix, budget));
    progress.次の位置 += 1;
  }

  const finished = progress.次の位置 >= progress.items.length;

  await saveProgress(env, progress);

  console.log(
    "[backup] slot done",
    JSON.stringify({
      対象日: date,
      回数: progress.回数,
      処理済み: progress.次の位置,
      対象: progress.items.length,
      使った回数: budget.used,
      finished,
    })
  );

  // 途中の回は記録を残さない。毎回残すと 5 件の枠が 1 日で埋まり、
  // 前の日の結果が見えなくなるため。
  if (!finished && !isLastChance) {
    return {
      finished: false,
      skipped: false,
      処理済み: progress.次の位置,
      対象: progress.items.length,
    };
  }

  await runAndRecord(env, "backup", async () =>
    finalize(env, progress!, prefix, !finished)
  );

  return {
    finished,
    skipped: false,
    処理済み: progress.次の位置,
    対象: progress.items.length,
  };
}

/**
 * 手で動かすとき用。その日の進み具合を捨てて最初からやり直す。
 * 何回呼んでも同じ日の同じ場所へ書き出す。
 */
export async function resetBackupProgress(env: Env): Promise<void> {
  const date = jstDate(new Date());
  await env.OAUTH_KV.delete(progressKey(date));
}
