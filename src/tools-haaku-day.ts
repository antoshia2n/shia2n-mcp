/**
 * shia2n-mcp / src/tools-haaku-day.ts / 新設（2026-10-13 v1.15.0 開発部）
 * その日の記録の道具 3 本。依頼：https://www.notion.so/3f89c6c1c43981308c9dc4e780af3f0d
 *   haAku__get_day_records  … 読むだけ。日付の範囲のその日の記録（AI の分析用）
 *   haAku__build_day_record … 手で日付を指定して組む（dry_run で見るだけ）。毎日 JST 0 時台に前の日の分を自動で組むものと同じ処理
 *   kiroku__get_logs        … 読むだけ。記録くんの daily_logs と rule_checks（決まりの行つき）を日付の範囲で
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { buildDayRecord, readDayRecords, yesterdayJst, validDay } from "./haaku-day-record.js";
import { readKiroku } from "./kiroku-read.js";
import { runAndRecord, readAllRuns } from "./cron-log.js";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD で渡してください");

export function registerHaakuDayTools(server: McpServer, env: Env): void {
  server.tool(
    "haAku__get_day_records",
    "haAku に残した「その日の記録」を日付の範囲で返す。読むだけ。1日1件で、日報（goal・achieved・reflection・improvement と KPI の数字）・こなしたこと（その日に完了したタスク。プロジェクトと結んだマス・完了の時刻 completed_at・TaskMaster の時間帯 group_id と group_title つき）・残ったこと（着手日か期限がその日以前でその日の終わりに未完了だったタスク。時間帯つき）・予定（カレンダーの予定・時刻つき）・記録くん（その日の daily_logs の行と rule_checks）を持つ。sources にそれぞれの元が読めたかが入る。記録は毎日 JST 0 時台に前の日の分を組む。無い日は missing に並ぶ（haAku__build_day_record で組める）。時間帯の欄が無い前の記録には、読むときに今のタスクから時間帯を付ける（groups_note に件数）。最大62日。",
    { from: DATE.describe("最初の日 YYYY-MM-DD（日本時間）"), to: DATE.optional().describe("最後の日 YYYY-MM-DD。省略時は from と同じ") },
    async args => asMcpTextResult(await readDayRecords(env, args.from, args.to ?? args.from))
  );

  server.tool(
    "haAku__build_day_record",
    "日付を指定して「その日の記録」を組み、haAku の側（app_data/os_day_record_v1_YYYY-MM-DD）に残す。書く道具（承認なし・haAku の側の記録だけを書き、TaskMaster・記録くん・カレンダーには書かない）。同じ日は上書き、中身が変わらなければ書かない。読めなかった元は前の記録のその部分を残す。dry_run: true なら書かずに組んだ記録をそのまま返す。毎日 JST 0 時台の自動の回（記録 haaku_day_record）と同じ処理。",
    { date: DATE.optional().describe("組む日 YYYY-MM-DD（日本時間）。省略時は昨日"), dry_run: z.boolean().optional().describe("true で書かずに返す") },
    async args => {
      const day = validDay(args.date ?? yesterdayJst());
      if (args.dry_run) return asMcpTextResult(await buildDayRecord(env, day, { dryRun: true }));
      let thrown: string | null = null, result: unknown = null;
      try { await runAndRecord(env, "haaku_day_record", async () => { const r = await buildDayRecord(env, day); result = r; return { count: r.counts.done, detail: r.detail }; }); }
      catch (e) { thrown = e instanceof Error ? e.message : String(e); }
      const runs = await readAllRuns(env);
      return asMcpTextResult({ result, recorded: runs.haaku_day_record?.[0] ?? null, thrown });
    }
  );

  server.tool(
    "kiroku__get_logs",
    "記録くん（習慣のチェックと体調の記録）を日付の範囲で読む。読むだけ・書かない。daily_logs の行（全部の欄：体調のスコア・身体・症状・食事・日記・ポモドーロの回数など）と rule_checks（その日の決まりのチェック。rule に決まりの行）を返す。日付の欄の名前は表の定義から毎回決め、columns に返す。最大62日。",
    { from: DATE.describe("最初の日 YYYY-MM-DD"), to: DATE.optional().describe("最後の日 YYYY-MM-DD。省略時は from と同じ") },
    async args => {
      const from = validDay(args.from), to = validDay(args.to ?? args.from);
      if (to < from) throw new Error("to は from 以後の日付にしてください");
      if ((Date.parse(to) - Date.parse(from)) / 86400000 >= 62) throw new Error("一度に読めるのは 62 日までです");
      return asMcpTextResult({ ok: true, from, to, ...(await readKiroku(env, from, to)) });
    }
  );
}
