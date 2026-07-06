/**
 * Munikis Context Client
 *
 * Notion API を直接叩いて起動コンテキストを 1 発で取得する。
 * data source query（新 API・Notion-Version 2025-09-03）を使用。
 *
 * v0.31.0：レスポンスに weekly_review_due（boolean）を追加。
 *   Decision 3959c6c1-c439-81f9-9cac-e2dd3a93ac0d / 2026-07-06 に基づき、
 *   Slack 自動投稿 cron を廃止し「Google カレンダー繰返予定 + 本フラグ」の二段構えに移行。
 *
 * プロパティ型が select / status / multi_select / rich_text のいずれでも
 * 値を取り出せるよう汎用抽出関数 extractText で吸収する（推測禁止・§7.1 準拠）。
 *
 * 3 DB を並列 fetch（Promise.all）で遅延を最小化。Sessions は 1 回取得して
 * chat_type フィルタと weekly_review_due 判定の両方に使い回す。
 */

// 5DB の data_source_id（Notion 上で確定済み）
const SESSIONS_DS = "bd92c72f-44d8-40d7-87db-b052e3b292ab";
const DECISIONS_DS = "b5c89aef-e029-4c0f-9f3a-d30b7dff71fd";
const TASKS_DS = "dc631523-3b8e-4be4-a9dc-02a3cdf7b6d7";
const VISION_PAGE_URL =
  "https://www.notion.so/3539c6c1c439812a8514ea77473d8c6d";

// 週次レビュー Sessions を識別するチャット種別値（Naoki 運用規約）
const WEEKLY_REVIEW_CHAT_TYPE = "週次レビュー";

const NOTION_VERSION = "2025-09-03";
const NOTION_API_BASE = "https://api.notion.com/v1";

interface FetchOptions {
  chat_type: string;
  n_sessions: number;
}

interface SessionSummary {
  url: string;
  セッション名: string | null;
  日付: string | null;
  チャット種別: string | null;
  申し送り: string | null;
  last_edited_time: string;
}

interface DecisionSummary {
  url: string;
  タイトル: string | null;
  状態: string | null;
  種別: string | null;
  Date: string | null;
  結論: string | null;
}

interface TaskSummary {
  url: string;
  タスク名: string | null;
  状態: string | null;
  担当: string | null;
  優先度: string | null;
}

interface ContextResult {
  fetched_at: string;
  source: string;
  chat_type: string;
  n_sessions: number;
  vision_url: string;
  recent_sessions: SessionSummary[];
  open_decisions: DecisionSummary[];
  in_progress_tasks: TaskSummary[];
  weekly_review_due: boolean;
  meta: {
    sessions_total_scanned: number;
    sessions_matched: number;
    decisions_total_scanned: number;
    tasks_total_scanned: number;
    weekly_review_reference_iso: string;
  };
}

// ------------------------------------------------------------
// Notion API 汎用クエリ
// ------------------------------------------------------------
async function queryDataSource(
  notionToken: string,
  dataSourceId: string,
  body: Record<string, unknown>
): Promise<any> {
  const res = await fetch(
    `${NOTION_API_BASE}/data_sources/${dataSourceId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${notionToken}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Notion API error ${res.status} on ${dataSourceId}: ${text.slice(0, 300)}`
    );
  }
  return res.json();
}

// ------------------------------------------------------------
// プロパティ値の汎用抽出（型を推測せずすべての型に対応）
// ------------------------------------------------------------
function extractText(prop: any): string | null {
  if (!prop) return null;
  if (Array.isArray(prop.title) && prop.title.length > 0) {
    return prop.title.map((t: any) => t.plain_text ?? "").join("");
  }
  if (Array.isArray(prop.rich_text) && prop.rich_text.length > 0) {
    return prop.rich_text.map((t: any) => t.plain_text ?? "").join("");
  }
  if (prop.select && typeof prop.select.name === "string") {
    return prop.select.name;
  }
  if (prop.status && typeof prop.status.name === "string") {
    return prop.status.name;
  }
  if (Array.isArray(prop.multi_select) && prop.multi_select.length > 0) {
    return prop.multi_select.map((o: any) => o.name).join(", ");
  }
  if (prop.date && typeof prop.date.start === "string") {
    return prop.date.start;
  }
  if (typeof prop.url === "string" && prop.url.length > 0) {
    return prop.url;
  }
  return null;
}

/**
 * チャット種別が対象と一致するか判定。
 * select（単一）/ multi_select（複数）どちらの型でも
 * ", " 区切りで trim して includes 判定する。
 */
function matchesChatType(value: string | null, target: string): boolean {
  if (!value) return false;
  if (value === target) return true;
  return value
    .split(", ")
    .map((s) => s.trim())
    .includes(target);
}

// ------------------------------------------------------------
// Sessions：全件取得（chat_type フィルタと weekly_review_due 判定の両方で再利用）
// ------------------------------------------------------------
async function fetchAllSessions(notionToken: string): Promise<any[]> {
  const res = await queryDataSource(notionToken, SESSIONS_DS, {
    page_size: 100,
  });
  return (res.results as any[]).sort((a, b) => {
    const ta = new Date(a.last_edited_time).getTime();
    const tb = new Date(b.last_edited_time).getTime();
    return tb - ta;
  });
}

function toSessionSummary(page: any): SessionSummary {
  return {
    url: page.url,
    セッション名: extractText(page.properties["セッション名"]),
    日付: extractText(page.properties["日付"]),
    チャット種別: extractText(page.properties["チャット種別"]),
    申し送り: extractText(page.properties["次セッションへの申し送り"]),
    last_edited_time: page.last_edited_time,
  };
}

// ------------------------------------------------------------
// chat_type フィルタで直近 n 件を計算
// ------------------------------------------------------------
function computeRecentSessionsForChat(
  allSessions: any[],
  chatType: string,
  n: number
): { sessions: SessionSummary[]; total_scanned: number } {
  const summaries = allSessions.map(toSessionSummary);
  const filtered = summaries.filter((s) =>
    matchesChatType(s.チャット種別, chatType)
  );
  return {
    sessions: filtered.slice(0, n),
    total_scanned: summaries.length,
  };
}

// ------------------------------------------------------------
// 週次レビュー未起票判定（weekly_review_due）
//
// 判定基準：
//   1. 「直近の日曜 09:00 JST」を基準時刻とする
//      - 今が日曜 09:00 JST より前 → 前の日曜 09:00 JST
//      - 今が日曜 09:00 JST 以降 → 今日の 09:00 JST
//      - 月〜土 → 直近過去の日曜 09:00 JST
//   2. Sessions の「チャット種別 = 週次レビュー」で「日付 >= 基準時刻」の
//      レコードが 1 件でもあれば false（実施済み）、なければ true（未起票）
// ------------------------------------------------------------
function computeMostRecentSunday9amJst(now: Date): Date {
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const jstNow = new Date(now.getTime() + JST_OFFSET_MS);
  const jstDay = jstNow.getUTCDay(); // 0 = 日曜
  const jstHour = jstNow.getUTCHours();

  // JST の「今日の 09:00」を UTC の Date として表現
  const anchor = new Date(jstNow);
  anchor.setUTCHours(9, 0, 0, 0);

  if (jstDay === 0) {
    // 日曜
    if (jstHour < 9) {
      // 09:00 前 → 前週の日曜 09:00
      anchor.setUTCDate(anchor.getUTCDate() - 7);
    }
    // 09:00 以降 → 今日
  } else {
    // 月〜土 → 直近過去の日曜 09:00
    anchor.setUTCDate(anchor.getUTCDate() - jstDay);
  }

  // anchor は JST 時刻の Date 値なので、UTC に戻す
  return new Date(anchor.getTime() - JST_OFFSET_MS);
}

function computeWeeklyReviewDue(
  allSessions: any[],
  referenceUtc: Date
): boolean {
  const weeklyReviewSessions = allSessions
    .map(toSessionSummary)
    .filter((s) => matchesChatType(s.チャット種別, WEEKLY_REVIEW_CHAT_TYPE));

  const hasCurrentWeekReview = weeklyReviewSessions.some((s) => {
    if (!s.日付) return false;
    // "YYYY-MM-DD" の日付は JST 00:00 として解釈
    const sessionUtc = new Date(`${s.日付}T00:00:00+09:00`);
    return sessionUtc.getTime() >= referenceUtc.getTime();
  });

  return !hasCurrentWeekReview;
}

// ------------------------------------------------------------
// Decisions 取得（オープン = 「完了」「破棄」「撤回」以外）
// ------------------------------------------------------------
async function fetchOpenDecisions(
  notionToken: string
): Promise<{ decisions: DecisionSummary[]; total_scanned: number }> {
  const res = await queryDataSource(notionToken, DECISIONS_DS, {
    page_size: 30,
  });
  const sorted = (res.results as any[]).sort((a, b) => {
    const ta = new Date(a.last_edited_time).getTime();
    const tb = new Date(b.last_edited_time).getTime();
    return tb - ta;
  });
  const items: DecisionSummary[] = sorted.map((page) => ({
    url: page.url,
    タイトル: extractText(page.properties["タイトル"]),
    状態: extractText(page.properties["状態"]),
    種別: extractText(page.properties["種別"]),
    Date: extractText(page.properties["Date"]),
    結論: extractText(page.properties["結論"]),
  }));
  const CLOSED = ["完了", "破棄", "撤回"];
  const open = items
    .filter((it) => !it.状態 || !CLOSED.includes(it.状態))
    .slice(0, 10);
  return { decisions: open, total_scanned: items.length };
}

// ------------------------------------------------------------
// Tasks 取得（進行中 = 「完了」「破棄」以外）
// ------------------------------------------------------------
async function fetchInProgressTasks(
  notionToken: string
): Promise<{ tasks: TaskSummary[]; total_scanned: number }> {
  const res = await queryDataSource(notionToken, TASKS_DS, {
    page_size: 30,
  });
  const sorted = (res.results as any[]).sort((a, b) => {
    const ta = new Date(a.last_edited_time).getTime();
    const tb = new Date(b.last_edited_time).getTime();
    return tb - ta;
  });
  const items: TaskSummary[] = sorted.map((page) => ({
    url: page.url,
    タスク名: extractText(page.properties["タスク名"]),
    状態: extractText(page.properties["状態"]),
    担当: extractText(page.properties["担当"]),
    優先度: extractText(page.properties["優先度"]),
  }));
  const DONE = ["完了", "破棄"];
  const inProgress = items
    .filter((it) => !it.状態 || !DONE.includes(it.状態))
    .slice(0, 10);
  return { tasks: inProgress, total_scanned: items.length };
}

// ------------------------------------------------------------
// エントリポイント：3 DB 並列 fetch
// ------------------------------------------------------------
export async function fetchMunikisContext(
  notionToken: string,
  { chat_type, n_sessions }: FetchOptions
): Promise<ContextResult> {
  const [allSessions, decisionsResult, tasksResult] = await Promise.all([
    fetchAllSessions(notionToken),
    fetchOpenDecisions(notionToken),
    fetchInProgressTasks(notionToken),
  ]);

  const now = new Date();
  const referenceUtc = computeMostRecentSunday9amJst(now);

  const sessionsResult = computeRecentSessionsForChat(
    allSessions,
    chat_type,
    n_sessions
  );
  const weeklyReviewDue = computeWeeklyReviewDue(allSessions, referenceUtc);

  return {
    fetched_at: now.toISOString(),
    source: "notion_api_v1_data_sources",
    chat_type,
    n_sessions,
    vision_url: VISION_PAGE_URL,
    recent_sessions: sessionsResult.sessions,
    open_decisions: decisionsResult.decisions,
    in_progress_tasks: tasksResult.tasks,
    weekly_review_due: weeklyReviewDue,
    meta: {
      sessions_total_scanned: sessionsResult.total_scanned,
      sessions_matched: sessionsResult.sessions.length,
      decisions_total_scanned: decisionsResult.total_scanned,
      tasks_total_scanned: tasksResult.total_scanned,
      weekly_review_reference_iso: referenceUtc.toISOString(),
    },
  };
}
