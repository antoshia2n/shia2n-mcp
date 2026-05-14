import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";

/**
 * しあらぼ管理システム（shiarabo-admin）読み取りツール群。
 * Supabase の shr_students テーブルを直接参照。
 *
 * テーブル：shr_students（shr_overrides は同テーブルに統合済み）
 * 命名規約：`shiarabo__<action>`
 * v0.24.0 で追加（依頼書：35f9c6c1-c439-813a-9cf5-c249f7618349）
 */

// ─── ステージ定義（constants.js と整合） ──────────────────────────────────────

const STAGES: Record<string, string> = {
  S0: "土台作り",
  S1: "コンセプト整理",
  S2: "商品・導線構築",
  S3: "収益化実践",
  S4: "継続・拡張",
};

// ─── Supabase ヘルパー ────────────────────────────────────────────────────────

async function sbFetch(
  env: Env,
  path: string
): Promise<unknown[]> {
  const url = `${env.SUPABASE_URL}/rest/v1${path}`;
  const res = await fetch(url, {
    headers: {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }
  return res.json() as Promise<unknown[]>;
}

// ─── 型定義 ───────────────────────────────────────────────────────────────────

interface StudentRow {
  id: number;
  name: string;
  email?: string;
  status?: string;
  stage?: string;
  issues?: string;
  strategy?: string;
  payment?: string;
  contact?: string;
  archived?: boolean;
  sort_order?: number;
  last_mtg?: string;
  next_mtg?: string;
  next_action?: string;
  renewal_likelihood?: string;
  monthly_fee?: number;
  proposal_status?: string;
  created_at?: string;
  updated_at?: string;
}

function stageLabel(stageId?: string): string {
  if (!stageId) return "";
  return `${stageId}（${STAGES[stageId] ?? stageId}）`;
}

// ─── ツール登録 ───────────────────────────────────────────────────────────────

export function registerShiaraboTools(server: McpServer, env: Env): void {

  // ─── 1. shiarabo__list_students ──────────────────────────────────────────
  server.tool(
    "shiarabo__list_students",
    "しあらぼ管理の生徒一覧を取得する。統括Claudeがスプリントレビュー・顧問レポートで生徒状況を確認するときに使う。archived=false の全生徒をステージ昇順で返す。戻り値: { ok, total, students: [{id, name, stage, stage_label, last_mtg, next_mtg, monthly_fee, renewal_likelihood, proposal_status, next_action, status}] }",
    {
      include_archived: z
        .boolean()
        .optional()
        .describe("アーカイブ済み生徒を含めるか（デフォルト: false）"),
      stage: z
        .string()
        .optional()
        .describe("ステージでフィルタ（例: S3, S4）。省略時は全ステージ"),
    },
    async (args) => {
      const includeArchived = args.include_archived ?? false;

      let path = "/shr_students?select=id,name,status,stage,last_mtg,next_mtg,next_action,renewal_likelihood,monthly_fee,proposal_status,archived,sort_order&order=sort_order.asc";

      if (!includeArchived) {
        path += "&archived=eq.false";
      }
      if (args.stage) {
        path += `&stage=eq.${encodeURIComponent(args.stage)}`;
      }

      const rows = (await sbFetch(env, path)) as StudentRow[];

      const students = rows.map((r) => ({
        id:                 r.id,
        name:               r.name,
        stage:              r.stage ?? "",
        stage_label:        stageLabel(r.stage),
        last_mtg:           r.last_mtg ?? "",
        next_mtg:           r.next_mtg ?? "",
        monthly_fee:        r.monthly_fee ?? 0,
        renewal_likelihood: r.renewal_likelihood ?? "",
        proposal_status:    r.proposal_status ?? "",
        next_action:        r.next_action ?? "",
        status:             r.status ?? "",
        archived:           r.archived ?? false,
      }));

      return asMcpTextResult({
        ok:      true,
        total:   students.length,
        students,
      });
    }
  );

  // ─── 2. shiarabo__get_student ─────────────────────────────────────────────
  server.tool(
    "shiarabo__get_student",
    "しあらぼ生徒の詳細情報をIDで取得する。shiarabo__list_students で id を確認してから使う。戻り値: { ok, student: {全フィールド} }",
    {
      id: z.number().describe("生徒の id（shiarabo__list_students の id フィールド）"),
    },
    async (args) => {
      const path = `/shr_students?select=*&id=eq.${args.id}&limit=1`;
      const rows = (await sbFetch(env, path)) as StudentRow[];

      if (rows.length === 0) {
        return asMcpTextResult({ ok: false, error: `id=${args.id} の生徒が見つかりません` });
      }

      const r = rows[0];
      return asMcpTextResult({
        ok: true,
        student: {
          id:                 r.id,
          name:               r.name,
          email:              r.email ?? "",
          status:             r.status ?? "",
          stage:              r.stage ?? "",
          stage_label:        stageLabel(r.stage),
          issues:             r.issues ?? "",
          strategy:           r.strategy ?? "",
          payment:            r.payment ?? "",
          contact:            r.contact ?? "",
          archived:           r.archived ?? false,
          sort_order:         r.sort_order ?? 0,
          last_mtg:           r.last_mtg ?? "",
          next_mtg:           r.next_mtg ?? "",
          next_action:        r.next_action ?? "",
          renewal_likelihood: r.renewal_likelihood ?? "",
          monthly_fee:        r.monthly_fee ?? 0,
          proposal_status:    r.proposal_status ?? "",
          created_at:         r.created_at ?? "",
          updated_at:         r.updated_at ?? "",
        },
      });
    }
  );
}
