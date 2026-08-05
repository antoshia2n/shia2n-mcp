/**
 * データの控え v1.0.0（2026-08-05）
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
 * 設計上の要点：
 *   - 取得した中身は解釈せずそのまま書き出す。読み替えると、そこで壊れる。
 *   - 途中で 1 つ失敗しても他は続ける。全部止めると 1 つの不調で全滅する。
 *   - 取り切れなかった場合は必ず控えの目録に残す。黙って欠けるのが最悪。
 */

import { Env } from "./index.js";
import { getFirestoreToken } from "./taskmaster.js";

// 1 つの表から一度に取る上限。超えた分は目録に「取り切れていない」と残す
const MAX_ROWS_PER_TABLE = 20000;

// Notion の 1 回の取得件数と、繰り返しの上限
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
  /** 失敗の理由 */
  error?: string;
}

/** 日本時間での日付（YYYY-MM-DD）。朝に動くので、その日の日付で残す */
function jstDate(now: Date): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────
// Supabase
// ─────────────────────────────────────────────

/** 表の一覧を取る。定義の一覧はデータベース側が返してくれるので、決め打ちしない */
async function listSupabaseTables(env: Env): Promise<string[]> {
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

async function backupOneTable(
  env: Env,
  table: string,
  prefix: string
): Promise<Entry> {
  const key = `${prefix}supabase/${table}.json`;

  try {
    const url =
      `${env.SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}` +
      `?select=*&limit=${MAX_ROWS_PER_TABLE}`;

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
      return {
        key, ok: false, rows: null, total: null, truncated: false,
        error: `取得に失敗（${res.status}）`,
      };
    }

    const total = totalFromContentRange(res.headers.get("content-range"));
    const masked = MASKED_COLUMNS[table];

    let body: string;
    let rows: number | null;

    if (masked) {
      // 値を持ち出さない表だけは中身を読んで、対象の列を落としてから書く
      const parsed = (await res.json()) as Record<string, unknown>[];
      for (const row of parsed) {
        for (const column of masked) {
          if (column in row) row[column] = null;
        }
      }
      rows = parsed.length;
      body = JSON.stringify(parsed);
    } else {
      // それ以外は読み替えずにそのまま書く（解釈しないので壊れない・速い）
      body = await res.text();
      rows = null;
    }

    await env.BACKUP_BUCKET.put(key, body, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });

    const fetched = rows ?? (total !== null && total <= MAX_ROWS_PER_TABLE ? total : null);

    return {
      key,
      ok: true,
      rows: fetched,
      total,
      truncated: total !== null && total > MAX_ROWS_PER_TABLE,
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
  prefix: string
): Promise<Entry> {
  const key = `${prefix}notion/${source.name}.json`;

  try {
    const pages: unknown[] = [];
    let cursor: string | undefined;
    let loops = 0;
    let truncated = false;

    while (loops < NOTION_MAX_PAGES) {
      loops += 1;

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

    await env.BACKUP_BUCKET.put(key, JSON.stringify(pages), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });

    return { key, ok: true, rows: pages.length, total: pages.length, truncated };
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

async function backupFirestore(env: Env, prefix: string): Promise<Entry[]> {
  const documents = ["tasks", "projects"];

  let token: string;
  try {
    token = await getFirestoreToken(env);
  } catch (error) {
    return documents.map((name) => ({
      key: `${prefix}firestore/${name}.json`,
      ok: false, rows: null, total: null, truncated: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  const entries: Entry[] = [];

  for (const name of documents) {
    const key = `${prefix}firestore/${name}.json`;
    try {
      const res = await fetch(
        `${FIRESTORE_BASE}/users/${env.NAOKI_UID}/app_data/${name}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (!res.ok) {
        entries.push({
          key, ok: false, rows: null, total: null, truncated: false,
          error: `取得に失敗（${res.status}）`,
        });
        continue;
      }

      const body = await res.text();
      await env.BACKUP_BUCKET.put(key, body, {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });

      entries.push({ key, ok: true, rows: null, total: null, truncated: false });
    } catch (error) {
      entries.push({
        key, ok: false, rows: null, total: null, truncated: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return entries;
}

// ─────────────────────────────────────────────
// 本体
// ─────────────────────────────────────────────

export async function handleBackupCron(
  env: Env
): Promise<{ count: number; detail: string }> {
  if (!env.BACKUP_BUCKET) {
    throw new Error("保管庫（R2）が結び付いていません。設定を確認してください。");
  }

  const now = new Date();
  const date = jstDate(now);
  const prefix = `backup/${date}/`;
  const entries: Entry[] = [];

  // 1. Supabase
  let tables: string[] = [];
  let tableListError: string | null = null;
  try {
    tables = await listSupabaseTables(env);
  } catch (error) {
    tableListError = error instanceof Error ? error.message : String(error);
  }

  for (const table of tables) {
    entries.push(await backupOneTable(env, table, prefix));
  }

  // 2. Notion
  for (const source of NOTION_DATA_SOURCES) {
    entries.push(await backupOneNotionSource(env, source, prefix));
  }

  // 3. Firestore
  entries.push(...(await backupFirestore(env, prefix)));

  // 目録。取り切れていないもの・失敗したものがひと目で分かる形にする
  const succeeded = entries.filter((e) => e.ok);
  const failed = entries.filter((e) => !e.ok);
  const truncated = entries.filter((e) => e.truncated);

  const manifest = {
    版: "1.0.0",
    取得時刻: now.toISOString(),
    対象日: date,
    表の一覧の取得: tableListError ? `失敗：${tableListError}` : "成功",
    件数: {
      書けた: succeeded.length,
      失敗: failed.length,
      取り切れていない: truncated.length,
    },
    除外: "環境変数の値（dv_env_vars.value）は控えに含めていません",
    明細: entries,
  };

  await env.BACKUP_BUCKET.put(
    `${prefix}manifest.json`,
    JSON.stringify(manifest, null, 2),
    { httpMetadata: { contentType: "application/json; charset=utf-8" } }
  );

  // 1 つでも欠けたら失敗として記録に残す。全部そろって初めて「戻せる」ため
  if (tableListError || failed.length > 0 || truncated.length > 0) {
    const reasons: string[] = [];
    if (tableListError) reasons.push(`表の一覧を取得できず（${tableListError}）`);
    if (failed.length > 0) reasons.push(`${failed.length} 件が書けませんでした`);
    if (truncated.length > 0) reasons.push(`${truncated.length} 件が取り切れていません`);
    throw new Error(
      `控えに欠けがあります：${reasons.join(" / ")}。詳しくは ${prefix}manifest.json`
    );
  }

  return {
    count: succeeded.length,
    detail: `${date} の控えを ${succeeded.length} 件書き出しました（データ・管理表・タスク）`,
  };
}
