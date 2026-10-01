/**
 * shia2n-mcp / src/tools-sales-manager-payments.ts（2026-10-01 開発部・新設）
 *
 * 経理系が毎月 1〜5 日に、通帳の入金と sales-manager を 1 件ずつ突き合わせて
 * 入金済みの処理まで終わらせるための道具 2 本。
 *   sales_manager__list_unpaid  指定した月の未入金を 1 行ずつ返す（読むだけ）
 *   sales_manager__mark_paid    契約と月を指定して、その月の支払いを入金済みにする
 *
 * どちらも sales-manager 側の外から叩ける入口を呼ぶだけで、数え方と書き方は持たない。
 *   GET  /api/sm-unpaid     画面の入金のタブと同じ行を返す（DB の行と、DB に行が無い契約の月）
 *   POST /api/sm-mark-paid  画面の入金のタブで入金済みにしたときと同じ書き方をする
 * 同じ判定を 2 か所に置くと、片方だけ直したときに数字が食い違うため。
 *
 * 合言葉（SALES_MANAGER_INTERNAL_SECRET）と、入口の手前の Cloudflare Access の
 * 合言葉（cfAccessHeaders）の両方を送る。sales_manager__record_monthly_revenue と同じ形。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import { cfAccessHeaders } from "./cf-access.js";
import type { Env } from "./index.js";

const YM = /^(\d{4})-(\d{2})$/;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

function checkYearMonth(ym: string): void {
  const m = YM.exec(ym);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[1]) < 2026) {
    throw new Error(`year_month は 2026-01 以降の YYYY-MM の形で渡してください（受け取った値: ${ym}）`);
  }
}

function checkDate(d: string): void {
  const m = YMD.exec(d);
  if (!m) {
    throw new Error(`paid_date は YYYY-MM-DD の形で渡してください（受け取った値: ${d}）`);
  }
  const t = new Date(`${d}T00:00:00Z`);
  if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d) {
    throw new Error(`paid_date が実在しない日付です（受け取った値: ${d}）`);
  }
}

async function callSalesManager(
  env: Env,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<unknown> {
  const base = env.SALES_MANAGER_API_BASE ?? "https://sales-manager.shia2n.jp";
  const secret = env.SALES_MANAGER_INTERNAL_SECRET;
  if (!secret) {
    throw new Error(
      "SALES_MANAGER_INTERNAL_SECRET が設定されていません。sales-manager の入口は合言葉が必須のため、呼び出していません"
    );
  }
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${secret}`,
      ...cfAccessHeaders(env),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `sales-manager からの返事を読めませんでした（状態 ${res.status}・${path}）。` +
        `入口がまだ本番に無いか、Access の関門で止まっている可能性があります: ${text.slice(0, 200)}`
    );
  }
  if (!res.ok) {
    const o = parsed as { error?: string; reason?: string };
    const detail = [o.error, o.reason].filter(Boolean).join(" / ");
    // 断られた理由（見つからない・2 件以上・入金済み）は、中身ごと返して次の手を選べるようにする
    throw new Error(
      `sales-manager が断りました（状態 ${res.status}・${path}）: ${detail || "理由の記載なし"} 返事: ${text.slice(0, 600)}`
    );
  }
  return parsed;
}

export function registerSalesManagerPaymentTools(server: McpServer, env: Env): void {
  server.tool(
    "sales_manager__list_unpaid",
    "sales-manager で、指定した月の未入金を 1 行ずつ返す。読むだけ。経理系が通帳の入金と 1 件ずつ突き合わせるために使う。画面の入金のタブと同じ行を返す：DB にある未入金の行（source が db）と、契約はあるがその月の行が DB にまだ無いもの（source が planned。画面で入金済みにしたときに初めて行が作られる）。止めた契約の止めた月より後は入らない。金額は未収に数えている額（実額があれば実額、無ければ予定の額）。返り値: { ok, year_month, month_idx, count, total（両方の合計）, db_count, db_total（source が db だけ。sales_manager__get_revenue_summary の uncollected_by_month の同じ月と一致する）, rows: [{ source（db / planned）, payment_id（planned は null）, contract_id（契約に紐づかない行は null）, name（入金のタブに出ている相手の名前）, business（事業の区分）, amount（未収に数えている額）, planned_amount（予定の額） }] }。入金済みにするときは contract_id と year_month をそのまま sales_manager__mark_paid に渡す",
    {
      year_month: z.string().describe("対象の年月。YYYY-MM の形（例: 2026-09）。2026-01 以降。必須"),
    },
    async (args) => {
      checkYearMonth(args.year_month);
      const data = await callSalesManager(
        env,
        "GET",
        `/api/sm-unpaid?year_month=${encodeURIComponent(args.year_month)}`
      );
      return asMcpTextResult(data);
    }
  );

  server.tool(
    "sales_manager__mark_paid",
    "sales-manager で、契約 1 件の指定した月を入金済みにする。書く道具。画面の入金のタブで入金済みにしたときと同じ書き方をし、入金日と実際に入った額も書く。その月の行が DB にあれば、その行を入金済みにする。DB に行が無く、入金のタブにその契約のその月が出ている（source が planned）ときは、画面と同じ形で行を 1 行足して入金済みにする。2 行以上ある（ambiguous）・すでに入金済み（already_paid）・入金のタブにその契約のその月が無い（not_found）のときは何も書かずに断る（断るときは理由と該当の行を返す）。同じ呼び出しを 2 回送っても 2 回目は already_paid で断られ、二重には書かない。返り値: { ok, action（updated=既存の行を入金済みにした / created=行を足して入金済みにした）, before: 書く前の行（created のときは null）, after: 書いたあとの行, month_remaining: { count, total }（その月にまだ残っている未入金。sales_manager__list_unpaid と同じ数え方） }",
    {
      contract_id: z
        .union([z.string(), z.number()])
        .describe("契約の番号。sales_manager__list_unpaid の contract_id をそのまま渡す。必須"),
      year_month: z.string().describe("どの月の支払いか。YYYY-MM の形（例: 2026-09）。必須"),
      paid_date: z.string().describe("入金日。YYYY-MM-DD の形（例: 2026-10-02）。通帳に記帳された日。必須"),
      actual_amount: z.number().describe("実際に入金された額（円）。0 以上の整数。予定の額と違ってもよい。必須"),
    },
    async (args) => {
      checkYearMonth(args.year_month);
      checkDate(args.paid_date);
      if (!Number.isInteger(args.actual_amount) || args.actual_amount < 0) {
        throw new Error(
          `actual_amount は 0 以上の整数で渡してください（受け取った値: ${String(args.actual_amount)}）`
        );
      }
      const contractId = String(args.contract_id).trim();
      if (!contractId) {
        throw new Error("contract_id が空です。sales_manager__list_unpaid の contract_id をそのまま渡してください");
      }
      const data = await callSalesManager(env, "POST", "/api/sm-mark-paid", {
        contract_id: contractId,
        year_month: args.year_month,
        paid_date: args.paid_date,
        actual_amount: args.actual_amount,
      });
      return asMcpTextResult(data);
    }
  );
}
