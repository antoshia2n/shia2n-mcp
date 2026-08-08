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
 * v0.43.0（2026-08-08）：取りこぼしの修正。3 点。
 *   ① ページ送りが無く、Sessions は先頭 100 件、Decisions と Tasks は先頭 30 件しか
 *      見ていなかった。実物は Sessions 240 件・Decisions 291 件・Tasks 317 件。
 *      並べ替えは取ったあとに手元でやっていたため、「直近 30 件」ではなく
 *      「たまたま先に返ってきた 30 件」を見ていた。has_more が false になるまで
 *      続きを取るようにした（安全のため最大 10 ページ＝1,000 件で打ち切り、
 *      打ち切ったときは meta に印を出す）。
 *   ② 除外する状態の名前が実物と違っていた。Tasks の実際の値は「完了」「廃案」だが
 *      コードは「完了」「破棄」を除外しており、廃案が未完了として混ざりうる状態だった。
 *      Decisions の実際の値は「確定」「保留」「適用済」「撤回」で、存在しない
 *      「完了」「破棄」を除外していた。撤回を除く現行の見え方は変えていない。
 *   ③ 起動のたびに担当で数え直す手作業が要らないよう、未完了の総数・担当別の内訳・
 *      呼び出したチャットの担当ぶんの一覧（期限順）を返すようにした。
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

// ページ送りの上限（1 ページ 100 件・最大 10 ページ＝1,000 件）
// 外部呼び出しの回数を抑えつつ、現状の最大 317 件に対して十分な余裕を取る。
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

// 実物の選択肢に合わせた「閉じた」状態の名前（2026-08-08 実測）
// Tasks の選択肢：未発行 / 発行済（投入待ち）/ 発行済（着手待ち）/ 進行中 / 完了 / 凍結中 / 廃案
const TASK_CLOSED_STATES = ["完了", "廃案"];
// Decisions の選択肢：確定 / 保留 / 適用済 / 撤回
// 「適用済」を開いたままにするかは運用の判断のため、現行の見え方を変えずに撤回のみ除外する。
const DECISION_CLOSED_STATES = ["撤回"];

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
  期限: string | null;
}

interface ChatTasksSummary {
  担当: string | null;
  未完了: number;
  期限切れ: number;
  一覧: TaskSummary[];
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
  tasks_open_total: number;
  tasks_open_by_owner: Record<string, number>;
  tasks_for_this_chat: ChatTasksSummary;
  weekly_review_due: boolean;
  meta: {
    sessions_total_scanned: number;
    sessions_matched: number;
    decisions_total_scanned: number;
    tasks_total_scanned: number;
    sessions_truncated: boolean;
    decisions_truncated: boolean;
    tasks_truncated: boolean;
    weekly_review_reference_iso: string;
  };
}

// ------------------------------------------------------------
// Notion API 汎用クエリ（1 ページ）
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
// Notion API 汎用クエリ（has_more が false になるまで続きを取る）
//
// v0.43.0：ここが無かったため、先頭 1 ページぶんしか見えていなかった。
// 打ち切ったときは truncated=true を返し、呼び出し側が meta に出す。
// ------------------------------------------------------------
async function queryAllPages(
  notionToken: string,
  dataSourceId: string
): Promise<{ results: any[]; truncated: boolean }> {
  const results: any[] = [];
  let cursor: string | undefined = undefined;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const body: Record<string, unknown> = { page_size: PAGE_SIZE };
    if (cursor) body.start_cursor = cursor;

    const res = await queryDataSource(notionToken, dataSourceId, body);
    if (Array.isArray(res.results)) results.push(...res.results);

    if (!res.has_more || !res.next_cursor) {
      cursor = undefined;
      break;
    }
    cursor = res.next_cursor as string;
    if (page === MAX_PAGES - 1) truncated = true;
  }

  return { results, truncated };
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

function sortByLastEditedDesc(pages: any[]): any[] {
  return pages.sort((a, b) => {
    const ta = new Date(a.last_edited_time).getTime();
    const tb = new Date(b.last_edited_time).getTime();
    return tb - ta;
  });
}

// ------------------------------------------------------------
// Sessions：全件取得（chat_type フィルタと weekly_review_due 判定の両方で再利用）
// ------------------------------------------------------------
async function fetchAllSessions(
  notionToken: string
): Promise<{ pages: any[]; truncated: boolean }> {
  const { results, truncated } = await queryAllPages(notionToken, SESSIONS_DS);
  return { pages: sortByLastEditedDesc(results), truncated };
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
// Decisions 取得（オープン = 「撤回」以外）
// ------------------------------------------------------------
async function fetchOpenDecisions(notionToken: string): Promise<{
  decisions: DecisionSummary[];
  total_scanned: number;
  truncated: boolean;
}> {
  const { results, truncated } = await queryAllPages(notionToken, DECISIONS_DS);
  const sorted = sortByLastEditedDesc(results);
  const items: DecisionSummary[] = sorted.map((page) => ({
    url: page.url,
    タイトル: extractText(page.properties["タイトル"]),
    状態: extractText(page.properties["状態"]),
    種別: extractText(page.properties["種別"]),
    Date: extractText(page.properties["Date"]),
    結論: extractText(page.properties["結論"]),
  }));
  const open = items
    .filter((it) => !it.状態 || !DECISION_CLOSED_STATES.includes(it.状態))
    .slice(0, 10);
  return { decisions: open, total_scanned: items.length, truncated };
}

// ------------------------------------------------------------
// Tasks 取得（未完了 = 「完了」「廃案」以外）
// ------------------------------------------------------------
function toTaskSummary(page: any): TaskSummary {
  return {
    url: page.url,
    タスク名: extractText(page.properties["タスク名"]),
    状態: extractText(page.properties["状態"]),
    担当: extractText(page.properties["担当"]),
    優先度: extractText(page.properties["優先度"]),
    期限: extractText(page.properties["期限"]),
  };
}

/** 期限の早い順。期限なしは最後に置く。同じ期限なら 高 → 中 → 低。 */
function sortByDueThenPriority(a: TaskSummary, b: TaskSummary): number {
  const da = a.期限 ?? "9999-12-31";
  const db = b.期限 ?? "9999-12-31";
  if (da !== db) return da < db ? -1 : 1;
  const rank: Record<string, number> = { 高: 0, 中: 1, 低: 2 };
  const ra = a.優先度 ? rank[a.優先度] ?? 3 : 3;
  const rb = b.優先度 ? rank[b.優先度] ?? 3 : 3;
  return ra - rb;
}

async function fetchOpenTasks(notionToken: string): Promise<{
  tasks: TaskSummary[];
  total_scanned: number;
  truncated: boolean;
}> {
  const { results, truncated } = await queryAllPages(notionToken, TASKS_DS);
  const sorted = sortByLastEditedDesc(results);
  const items = sorted.map(toTaskSummary);
  const open = items.filter(
    (it) => !it.状態 || !TASK_CLOSED_STATES.includes(it.状態)
  );
  return { tasks: open, total_scanned: items.length, truncated };
}

/** 担当別の未完了件数 */
function countByOwner(openTasks: TaskSummary[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of openTasks) {
    const owner = t.担当 ?? "（担当なし）";
    counts[owner] = (counts[owner] ?? 0) + 1;
  }
  return counts;
}

/**
 * 呼び出したチャットの担当ぶんをまとめる。
 * チャット種別と担当は同じ文字列で運用しているため、一致する担当があればそれを使う。
 * 一致が無ければ担当は null にして一覧を空で返す（推測で別の担当に読み替えない）。
 */
function summarizeTasksForChat(
  openTasks: TaskSummary[],
  chatType: string,
  todayIso: string
): ChatTasksSummary {
  const mine = openTasks.filter((t) => matchesChatType(t.担当, chatType));
  if (mine.length === 0) {
    return { 担当: null, 未完了: 0, 期限切れ: 0, 一覧: [] };
  }
  const sorted = [...mine].sort(sortByDueThenPriority);
  const overdue = sorted.filter((t) => t.期限 !== null && t.期限 < todayIso);
  return {
    担当: chatType,
    未完了: sorted.length,
    期限切れ: overdue.length,
    一覧: sorted,
  };
}

/** JST の今日（YYYY-MM-DD） */
function todayIsoJst(now: Date): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

// ------------------------------------------------------------
// エントリポイント：3 DB 並列 fetch
// ------------------------------------------------------------
export async function fetchMunikisContext(
  notionToken: string,
  { chat_type, n_sessions }: FetchOptions
): Promise<ContextResult> {
  const [sessionsRaw, decisionsResult, tasksResult] = await Promise.all([
    fetchAllSessions(notionToken),
    fetchOpenDecisions(notionToken),
    fetchOpenTasks(notionToken),
  ]);

  const now = new Date();
  const referenceUtc = computeMostRecentSunday9amJst(now);
  const today = todayIsoJst(now);

  const sessionsResult = computeRecentSessionsForChat(
    sessionsRaw.pages,
    chat_type,
    n_sessions
  );
  const weeklyReviewDue = computeWeeklyReviewDue(
    sessionsRaw.pages,
    referenceUtc
  );

  const openTasks = tasksResult.tasks;

  return {
    fetched_at: now.toISOString(),
    source: "notion_api_v1_data_sources",
    chat_type,
    n_sessions,
    vision_url: VISION_PAGE_URL,
    recent_sessions: sessionsResult.sessions,
    open_decisions: decisionsResult.decisions,
    // 従来どおり、担当を問わず直近の更新順で 10 件
    in_progress_tasks: openTasks.slice(0, 10),
    tasks_open_total: openTasks.length,
    tasks_open_by_owner: countByOwner(openTasks),
    tasks_for_this_chat: summarizeTasksForChat(openTasks, chat_type, today),
    weekly_review_due: weeklyReviewDue,
    meta: {
      sessions_total_scanned: sessionsResult.total_scanned,
      sessions_matched: sessionsResult.sessions.length,
      decisions_total_scanned: decisionsResult.total_scanned,
      tasks_total_scanned: tasksResult.total_scanned,
      sessions_truncated: sessionsRaw.truncated,
      decisions_truncated: decisionsResult.truncated,
      tasks_truncated: tasksResult.truncated,
      weekly_review_reference_iso: referenceUtc.toISOString(),
    },
  };
}
