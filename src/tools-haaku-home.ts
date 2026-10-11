/**
 * shia2n-mcp / src/tools-haaku-home.ts / 新設（2026-10-12 v1.10.0 開発部）
 * haAku のホームの道具 3 本。依頼：https://www.notion.so/3f69c6c1c43981b8bb09fa162e38da9b
 *   haAku__get_home            … 読むだけ。次はこれ・ここが詰まり・ステップと取り組みの行動と成果の率・期限の数
 *   haAku__link_tasks          … タスクをステップに結ぶ・付け替える・外す（承認なし・外したものも記録に残す）
 *   haAku__snapshot_progress_now … 毎週日曜の夜の記録（os_progress_weekly_v1）を手で 1 回残す
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { getFirestoreToken } from "./taskmaster.js";
import { buildHome, linkTasks, snapshotWeekly, jstToday } from "./haaku-home-store.js";
import { runAndRecord, readAllRuns } from "./cron-log.js";

async function ctxOf(env: Env) {
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
    "TaskMasterのタスクを haAku のステップ（マイルストーン）に結ぶ・付け替える・外す。書く道具・承認なし。1タスクは0〜1ステップ。milestone_id を null にすると外す。外した・付け替えたものも記録（history）に残す。結びは haAku の側（os_task_links_v1）に持ち、TaskMaster のタスクは書き換えない。存在しないタスク・ステップは断る。1回1〜100件。返り値: { ok, results: [{task_id, from, to, changed}], links_total, history_total }",
    {
      links: z.array(z.object({
        task_id: z.string().describe("TaskMaster のタスクの id（taskmaster__list_tasks の id）"),
        milestone_id: z.string().nullable().describe("haAku のステップ（マイルストーン）の id。null で外す"),
      })).min(1).max(100),
    },
    async args => asMcpTextResult(await linkTasks(await ctxOf(env),
      args.links.map(l => ({ taskId: l.task_id, milestoneId: l.milestone_id }))))
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
