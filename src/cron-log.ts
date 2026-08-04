/**
 * 自動で動くものの実行記録 v1.0.0（2026-08-04）
 *
 * 判断記録：https://www.notion.so/3b29c6c1c4398113bc59df5a566ea591
 *   通知先を新しく作らない。自動で動くものは実行の結果を記録として残し、
 *   起動したときに 1 か所で確認できる形に寄せる。
 *
 * 置き場は既存の KV（OAUTH_KV）。新しいデータベースも画面も作らない。
 * 記録するのは 4 点：いつ動いたか / 成功か失敗か / 何件処理したか / 失敗の原因。
 *
 * 見る場所は 2 つ。どちらも既存の入れ物への追加：
 *   - GET /diag の last_runs（URL 1 つで分かる）
 *   - munikis__get_context の recent_runs（起動時の取得 1 回で分かる）
 */

export type RunStatus = "success" | "failure" | "skipped";

export interface RunRecord {
  /** いつ動いたか（ISO 8601・UTC） */
  at: string;
  /** 成功したか失敗したか。skipped は「止めているので動かさなかった」 */
  status: RunStatus;
  /** 何件処理したか。件数が分からない処理は null */
  count: number | null;
  /** 成功時は処理の要約、失敗時は原因 */
  detail: string;
  /** かかった時間（ミリ秒） */
  duration_ms: number;
}

/** 記録を残す対象。ここに無い名前は /diag にも起動時の取得にも出ない */
export const KNOWN_JOBS = [
  "zeus_sync",
  "utage_polling",
  "neta_mail",
  "selftest",
] as const;

export type JobName = (typeof KNOWN_JOBS)[number];

/** 1 つの処理につき残す件数。増やしすぎると読むのが重くなる */
const MAX_RECORDS_PER_JOB = 5;

interface KvEnv {
  OAUTH_KV: KVNamespace;
}

function keyFor(job: JobName): string {
  return `cronlog:${job}`;
}

/**
 * 記録を 1 件足す。新しいものが先頭。
 * 記録の保存に失敗しても本体の処理は止めない（記録は補助であって目的ではない）。
 */
export async function appendRun(
  env: KvEnv,
  job: JobName,
  record: RunRecord
): Promise<void> {
  try {
    const raw = await env.OAUTH_KV.get(keyFor(job));
    const prev: RunRecord[] = raw ? (JSON.parse(raw) as RunRecord[]) : [];
    const next = [record, ...prev].slice(0, MAX_RECORDS_PER_JOB);
    await env.OAUTH_KV.put(keyFor(job), JSON.stringify(next));
  } catch (error) {
    console.error(
      "[cron-log] failed to write record",
      JSON.stringify({
        job,
        reason: error instanceof Error ? error.message : String(error),
      })
    );
  }
}

/**
 * 処理を実行し、成功でも失敗でも記録を残す。
 * 失敗はそのまま投げ直すので、これまでどおり Cron Events にも失敗として残る。
 */
export async function runAndRecord(
  env: KvEnv,
  job: JobName,
  fn: () => Promise<{ count?: number | null; detail?: string } | void>
): Promise<void> {
  const startedAt = Date.now();

  try {
    const outcome = (await fn()) ?? {};
    await appendRun(env, job, {
      at: new Date().toISOString(),
      status: "success",
      count: outcome.count ?? null,
      detail: outcome.detail ?? "",
      duration_ms: Date.now() - startedAt,
    });
  } catch (error) {
    await appendRun(env, job, {
      at: new Date().toISOString(),
      status: "failure",
      count: null,
      detail: error instanceof Error ? error.message : String(error),
      duration_ms: Date.now() - startedAt,
    });
    throw error;
  }
}

/** 動かさなかったことを記録する（止めている処理が「消えた」ように見えないように） */
export async function recordSkipped(
  env: KvEnv,
  job: JobName,
  detail: string
): Promise<void> {
  await appendRun(env, job, {
    at: new Date().toISOString(),
    status: "skipped",
    count: null,
    detail,
    duration_ms: 0,
  });
}

/** 記録をまとめて読む。1 件も無い処理は空の配列で返す（欄そのものは必ず出す） */
export async function readAllRuns(
  env: KvEnv
): Promise<Record<string, RunRecord[]>> {
  const entries = await Promise.all(
    KNOWN_JOBS.map(async (job) => {
      try {
        const raw = await env.OAUTH_KV.get(keyFor(job));
        return [job, raw ? (JSON.parse(raw) as RunRecord[]) : []] as const;
      } catch {
        return [job, []] as const;
      }
    })
  );

  return Object.fromEntries(entries);
}
