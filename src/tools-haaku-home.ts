/**
 * shia2n-mcp / src/tools-haaku-home.ts / 新設（2026-10-12 v1.10.0 開発部）
 * haAku のホームの道具 3 本。依頼：https://www.notion.so/3f69c6c1c43981b8bb09fa162e38da9b
 *   haAku__get_home            … 読むだけ。次はこれ・ここが詰まり・ステップと取り組みの行動と成果の率・期限の数
 *   haAku__link_tasks          … タスクをステップに結ぶ・付け替える・外す（承認なし・外したものも記録に残す）
 *   haAku__snapshot_progress_now … 毎週日曜の夜の記録（os_progress_weekly_v1）を手で 1 回残す
 *   haAku__sync_task_deadlines … v1.13.0：マスの期限を、結んだ TaskMaster のタスクの期限へ写す（見るだけの形あり）
 *                                 v1.14.0：着手日（startDate）も同じ決まりで写す
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { getFirestoreToken } from "./taskmaster.js";
import { buildHome, linkTasks, snapshotWeekly, jstToday, type LinkSource } from "./haaku-home-store.js";
import { runAndRecord, readAllRuns } from "./cron-log.js";
import { syncTaskDeadlines } from "./haaku-deadline-sync.js";

/** v1.13.0：期限を写して、実行の記録（haaku_deadline）に残す。失敗しても投げずに中身を返す */
async function syncAndRecord(env: Env): Promise<{ recorded: unknown; thrown: string | null }> {
  let thrown: string | null = null;
  try { await runAndRecord(env, "haaku_deadline", async () => syncTaskDeadlines(await ctxOf(env))); }
  catch (e) { thrown = e instanceof Error ? e.message : String(e); }
  const runs = await readAllRuns(env);
  return { recorded: runs.haaku_deadline?.[0] ?? null, thrown };
}

/**
 * v1.17.0：結ぶ → 続けて期限を写す、の 1 本。道具 haAku__link_tasks と TaskMaster の画面の受け口（haaku-task-link-http.ts）が同じものを呼ぶ
 * 写すのに失敗しても結びは書けているので、中身を返して止めない
 */
export async function linkAndCopyDeadlines(env: Env, changes: { taskId: string; milestoneId: string | null }[], by?: LinkSource) {
  const linked = await linkTasks(await ctxOf(env), changes, new Date().toISOString(), by);
  return { ...linked, deadlines: await syncAndRecord(env) };
}

export async function ctxOf(env: Env) {
  if (!env.NAOKI_UID || !env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
    throw new Error("haAku の読み書き設定がありません（NAOKI_UID / FIREBASE_SA_EMAIL / FIREBASE_SA_PRIVATE_KEY）");
  }
  return { token: await getFirestoreToken(env), uid: env.NAOKI_UID };
}

export function registerHaakuHomeTools(server: McpServer, env: Env): void {
  server.tool(
    "haAku__get_home",
    "haAkuのホームに出すものを1回で返す。読むだけ。next（次はこれ：詰まりの道の上で前のマスが全部100％の動けるステップの、未完了の結んだタスクの1件目・期限が近い順。タスクが無ければ state:no_tasks「タスクが結ばれていない」）、blocker（ここが詰まり：後ろの未完了のステップを一番多く止めている未完了のステップ・同数なら期限が近い方）、steps（ステップごとの状態 100%／待ち／動ける／進行中 と行動の率＝結んだタスクの完了÷全部）、initiatives（取り組みごとの行動の率・成果の率＝結んだKPIの今月の率・合図「打ち手を足す」）、deadlines（来週の月〜日に期限が来る未完了の数・今日までの期限で残っている数）。タスク→ステップの結びは haAku__link_tasks で書く。",
    { date: z.string().optional().describe("基準日 YYYY-MM-DD（日本時間）。省略時は今日") },
    async args => {
      if (args.date && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error("date は YYYY-MM-DD で渡してください");
      return asMcpTextResult(await buildHome(await ctxOf(env), args.date ?? jstToday()));
    }
  );

  server.tool(
    "haAku__link_tasks",
    "TaskMasterのタスクを haAku のステップ（マイルストーン）に結ぶ・付け替える・外す。書く道具・承認なし。1タスクは0〜1ステップ。milestone_id を null にすると外す。外した・付け替えたものも記録（history）に残す。結びは haAku の側（os_task_links_v1）に持つ。"+
    "結んだあと続けてマスの期限をタスクの期限（deadline）へ写す（haAku__sync_task_deadlines と同じ決まり：空か前回写した日のままのタスクだけ・Naoki が入れた日は上書きしない・外したタスクは期限を触らず写した記録だけ消す）。存在しないタスク・ステップは断る。1回1〜100件。返り値: { ok, results: [{task_id, from, to, changed}], links_total, history_total, deadlines: { recorded, thrown } }",
    {
      links: z.array(z.object({
        task_id: z.string().describe("TaskMaster のタスクの id（taskmaster__list_tasks の id）"),
        milestone_id: z.string().nullable().describe("haAku のステップ（マイルストーン）の id。null で外す"),
      })).min(1).max(100),
    },
    async args => {
      // v1.13.0：結んだ直後に期限を写す。v1.17.0：TaskMaster の画面と同じ 1 本（linkAndCopyDeadlines）を通す
      return asMcpTextResult(await linkAndCopyDeadlines(env, args.links.map(l => ({ taskId: l.task_id, milestoneId: l.milestone_id }))));
    }
  );

  server.tool(
    "haAku__sync_task_deadlines",
    "haAku のマスの期限を、結んだ TaskMaster のタスクの期限（deadline）へ写す。v1.14.0 からマスの着手日（startDate）もタスクの startDate へ同じ決まりで写す（期限と着手日は別々に照らす）。30分ごとに自動で動くものを手で1回動かす道具。"+
    "写すのは、結んだ未完了・未アーカイブのタスクのうち期限が空か、期限が前回 haAku が写した日のままのものだけ。期限が入っていて前回写した日と違うものは Naoki の日として上書きしない。"+
    "マスの期限が空になったら、前回写した日のままのタスクだけ空に戻す。結びを外したタスクは期限を触らず、写した記録だけ消す。書くのは deadline と startDate の2欄だけで、1つのタスクには1回にまとめて書き、値が変わらないときは書かない。マスの着手日が日付として読めないときは、そのマスの着手日には触らない。"+
    "dry_run: true なら何も書かずに、写す・空に戻す予定と Naoki の日の一覧を返す（見るだけ・着手日は start_writes と naoki_start_dates）。dry_run を省くと書いて、記録 haaku_deadline（GET /diag の last_runs・munikis__get_context の recent_runs）に件数を残す。",
    { dry_run: z.boolean().optional().describe("true で見るだけ（書かない・記録に残さない）") },
    async args => {
      if (args.dry_run) return asMcpTextResult(await syncTaskDeadlines(await ctxOf(env), { dryRun: true }));
      return asMcpTextResult(await syncAndRecord(env));
    }
  );

  server.tool(
    "haAku__snapshot_progress_now",
    "毎週日曜の夜（JST 23:30）に自動で残す、取り組みとステップの行動と成果の率の記録（os_progress_weekly_v1）を、手で1回残す。書く道具。同じ週の記録は上書き。結果は記録 haaku_weekly と GET /diag の last_runs.haaku_weekly に出る。",
    { confirm: z.literal("yes").describe("実行する場合は yes") },
    async () => {
      let thrown: string | null = null;
      try { await runAndRecord(env, "haaku_weekly", async () => snapshotWeekly(await ctxOf(env))); }
      catch (e) { thrown = e instanceof Error ? e.message : String(e); }
      const runs = await readAllRuns(env);
      return asMcpTextResult({ recorded: runs.haaku_weekly?.[0] ?? null, thrown });
    }
  );
}
