import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { getFirestoreToken, fsGetOrNull, fromVal, type FVal } from "./taskmaster.js";
import {
  buildHaakuManagementOverview,
  getHaakuStrategyHistory,
  parseHaakuRoadmap,
  parseHaakuStrategyStore,
  validAsOfDate,
} from "./haaku-plan-summary.js";

/**
 * Phase 3: haAku が記録した経営の北極星、マイルストーン、
 * 人が確定した戦略の現行版を、認証済み AI が「読むだけ」で取得する。
 *
 * 新しい書き込み口は作らない。
 * haAku と同じ Firestore カスタムDBを taskmaster.ts の既存ヘルパーで読む。
 */
function requireFirestoreEnv(env: Env): string {
  if (!env.NAOKI_UID || !env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
    throw new Error("haAkuの読み取り設定がありません（NAOKI_UID / FIREBASE_SA_EMAIL / FIREBASE_SA_PRIVATE_KEY）");
  }
  return env.NAOKI_UID;
}

function currentJstDate(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 404 = 未登録、その他の取得失敗 = エラー。0件に読み替えない。 */
async function loadHaakuValue(token: string, uid: string, key: string): Promise<unknown | null> {
  let doc;
  try {
    doc = await fsGetOrNull(token, "users/" + uid + "/app_data/" + key);
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    const code = message.match(/failed:\s*(\d{3})/)?.[1] || "unknown";
    throw new Error("haAkuの「" + key + "」を取得できません（HTTP " + code + "）。未登録とは区別して中断しました");
  }
  if (!doc) return null;
  const field = doc.fields?.value as FVal | undefined;
  if (!field) throw new Error("haAkuの「" + key + "」に value 欄がありません。未登録とは区別して中断しました");
  const value = fromVal(field);
  if (value === null) throw new Error("haAkuの「" + key + "」の value が不正です");
  return value;
}

export function registerHaakuPlanTools(server: McpServer, env: Env): void {
  server.tool(
    "haAku__get_management_overview",
    "haAkuに本人が記録した北極星、今期マイルストーンの達成数と期限、次に達成する成果物、戦略・計画の現行版を読み取る。値が未登録なら state:not_configured と明示。取得エラー時は停止。AIは情報を参照するだけで、数値・計画・タスクを書き換えない。KGI/KPIの実績値は別の haAku__get_kpi_progress を使う。",
    {
      date: z.string().optional().describe("基準日 YYYY-MM-DD（日本時間）。省略時は今日の日本時間。日付に応じて四半期を決める"),
    },
    async args => {
      const day = validAsOfDate(args.date ?? currentJstDate());
      const uid = requireFirestoreEnv(env);
      const token = await getFirestoreToken(env);
      const [rawRoadmap, rawStrategies] = await Promise.all([
        loadHaakuValue(token, uid, "os_roadmap_v1"),
        loadHaakuValue(token, uid, "os_strategy_records_v1"),
      ]);
      const roadmap = parseHaakuRoadmap(rawRoadmap);
      const strategy = parseHaakuStrategyStore(rawStrategies);
      return asMcpTextResult(buildHaakuManagementOverview(roadmap, strategy, day));
    }
  );

  server.tool(
    "haAku__get_strategy_history",
    "haAkuの特定の戦略記録について、確定済みの改訂履歴を新しい版から順に読み取る。各版の元マインドマップURLと変更理由を返す。書き込みは一切しない。対象IDは haAku__get_management_overview の strategies.current[].record_id で確認できる。",
    {
      record_id: z.string().min(1).describe("haAkuの戦略記録ID。対象名ではなくrecord_idで指定"),
    },
    async args => {
      const uid = requireFirestoreEnv(env);
      const token = await getFirestoreToken(env);
      const raw = await loadHaakuValue(token, uid, "os_strategy_records_v1");
      const strategy = parseHaakuStrategyStore(raw);
      return asMcpTextResult(getHaakuStrategyHistory(strategy, args.record_id));
    }
  );
}
