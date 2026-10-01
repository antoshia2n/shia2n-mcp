/**
 * shia2n-mcp / src/tools-sales-manager-ledger.ts（2026-10-01 開発部・新設）
 *
 * sales-manager を通帳と 1 円まで合う台帳にし、経理系だけで直せるようにするための道具 4 本。
 *   sales_manager__replace_monthly_revenue  その月のその区分を、渡した額の 1 行に置き換える
 *   sales_manager__list_payments            その月の行を、入金済み・未入金とも 1 行ずつ返す
 *   sales_manager__set_contract_status      契約を止める・有効に戻す
 *   sales_manager__set_payer_name           契約に振込名義のカナを保存する
 *
 * どれも sales-manager 側の外から叩ける入口を呼ぶだけで、数え方と書き方は持たない。
 * 呼び方（合言葉と Cloudflare Access の見出し）は tools-sales-manager-payments.ts と同じ。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import { cfAccessHeaders } from "./cf-access.js";
import type { Env } from "./index.js";

const YM = /^(\d{4})-(\d{2})$/;

function checkYearMonth(label: string, ym: string): void {
  const m = YM.exec(ym);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[1]) < 2026) {
    throw new Error(`${label} は 2026-01 以降の YYYY-MM の形で渡してください（受け取った値: ${ym}）`);
  }
}

function checkContractId(v: string | number): string {
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) {
    throw new Error(`contract_id は契約の番号（数字）で渡してください（受け取った値: ${s}）`);
  }
  return s;
}

async function callLedger(env: Env, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const base = env.SALES_MANAGER_API_BASE ?? "https://sales-manager.shia2n.jp";
  const secret = env.SALES_MANAGER_INTERNAL_SECRET;
  if (!secret) {
    throw new Error("SALES_MANAGER_INTERNAL_SECRET が設定されていません。sales-manager の入口は合言葉が必須のため、呼び出していません");
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
    // 断られたとき（会員ごとの行がある・契約が無い など）は、理由と該当の行をそのまま返す。
    // 断りは失敗ではなく判断の材料なので、例外にせず返り値として見せる。
    return { http_status: res.status, ...(parsed as object) };
  }
  return parsed;
}

export function registerSalesManagerLedgerTools(server: McpServer, env: Env): void {
  server.tool(
    "sales_manager__replace_monthly_revenue",
    "sales-manager で、指定した月・指定した事業の区分の行を全部外し、渡した額の 1 行（名前は「YYYY-MM 区分（自動）」）に置き換える。書く道具。通帳の実額に合わせるときに使う。外してよいのは単発の売上の行と、目安の契約（毎月額が変わり、未入金の一覧に出さない契約。いまは 30・32・33）の支払いの行だけ。会員ごとの契約の支払いの行（しあらぼ・CW 案件など）が 1 つでもある月は、何も書かずに断り、該当の行を返す（ok が false・error が member_rows_present）。額に 0 を渡すと、外すだけで行は入れない。外した行は消す前に控えの表（sm_removed_rows）に全列を残す。返り値: { ok, year_month, business, before: 外した行の一覧, after: 新しい行（0 のときは null） }。断ったとき: { ok: false, error, rows（外せない行）または available（登録済みの区分） }",
    {
      year_month: z.string().describe("対象の年月。YYYY-MM の形（例: 2026-05）。必須"),
      business: z.string().describe("事業の区分の名前（例: X広告収益）。登録済みの名前をそのまま渡す。必須"),
      amount: z.number().describe("置き換えたあとの額（円）。0 以上の整数。0 なら外すだけ。必須"),
      note: z.string().optional().describe("備考。通帳の日付と額の内訳など。新しい行の備考に入る"),
    },
    async (args) => {
      checkYearMonth("year_month", args.year_month);
      if (!Number.isInteger(args.amount) || args.amount < 0) {
        throw new Error(`amount は 0 以上の整数で渡してください（受け取った値: ${String(args.amount)}）`);
      }
      const data = await callLedger(env, "POST", "/api/sm-replace-monthly", {
        year_month: args.year_month,
        business: args.business,
        amount: args.amount,
        note: args.note ?? "",
      });
      return asMcpTextResult(data);
    }
  );

  server.tool(
    "sales_manager__list_payments",
    "sales-manager で、指定した月の行を入金済み・未入金とも 1 行ずつ返す。読むだけ。通帳と 1 行ずつ突き合わせるために使う。数え方は画面と同じ（止めた契約の止めた月より後の未入金は入らない）。返り値: { ok, year_month, month_idx, count, confirmed_total（入金済みと単発の売上の合計。sales_manager__get_revenue_summary のその月の確定と一致する）, unpaid_total, rows: [{ source（contract=契約の支払いの行 / planned=契約はあるがその月の行がまだ無い / single=単発の売上の行）, payment_id, single_id, contract_id, name, business, amount（予定の額）, actual_amount（実際の額）, paid, paid_date（入金日）, payer_name（振込名義のカナ。未登録は null） }] }",
    {
      year_month: z.string().describe("対象の年月。YYYY-MM の形（例: 2026-05）。必須"),
    },
    async (args) => {
      checkYearMonth("year_month", args.year_month);
      const data = await callLedger(env, "GET", `/api/sm-payments-month?year_month=${encodeURIComponent(args.year_month)}`);
      return asMcpTextResult(data);
    }
  );

  server.tool(
    "sales_manager__set_contract_status",
    "sales-manager で、契約 1 件を止める、または有効に戻す。書く道具。止めると、from_month の月から先はその契約の未入金を未収に数えず、見込にも入れない（sales_manager__list_unpaid と sales_manager__get_revenue_summary の両方）。止めた月より前の未入金は未収に残る。画面で契約を止めたときと同じ書き方（状態を停止にし、最後に有効な月を from_month の前の月にする）。有効に戻すと、状態を有効にし、最後に有効な月を空に戻す。支払いの行は消さず、入金済みにもしない。止めるのは Naoki の判断記録があるときだけ。返り値: { ok, before: 契約, after: 契約 }",
    {
      contract_id: z.union([z.string(), z.number()]).describe("契約の番号。必須"),
      status: z.enum(["stopped", "active"]).describe("stopped=止める / active=有効に戻す。必須"),
      from_month: z
        .string()
        .optional()
        .describe("止めるときだけ必須。この月から未収に数えない。YYYY-MM の形（例: 2026-09）"),
    },
    async (args) => {
      const contractId = checkContractId(args.contract_id);
      if (args.status === "stopped") {
        if (!args.from_month) throw new Error("止めるときは from_month（この月から未収に数えない）を渡してください");
        checkYearMonth("from_month", args.from_month);
      }
      const data = await callLedger(env, "POST", "/api/sm-contract-status", {
        contract_id: contractId,
        status: args.status,
        ...(args.status === "stopped" ? { from_month: args.from_month } : {}),
      });
      return asMcpTextResult(data);
    }
  );

  server.tool(
    "sales_manager__set_payer_name",
    "sales-manager で、契約 1 件に振込名義のカナを保存する。書く道具。通帳に出る名義（例: ヤマダ タロウ。半角のカナでもよい）をそのまま入れる。保存した名義は sales_manager__list_unpaid と sales_manager__list_payments の payer_name に出る。空の文字を渡すと消す。返り値: { ok, before: 契約, after: 契約 }",
    {
      contract_id: z.union([z.string(), z.number()]).describe("契約の番号。必須"),
      payer_name: z.string().describe("振込名義のカナ。全角・半角どちらでもよい。64 文字まで。空にすると消す。必須"),
    },
    async (args) => {
      const contractId = checkContractId(args.contract_id);
      if (args.payer_name.length > 64) {
        throw new Error(`payer_name は 64 文字までです（受け取った長さ: ${args.payer_name.length}）`);
      }
      const data = await callLedger(env, "POST", "/api/sm-payer-name", {
        contract_id: contractId,
        payer_name: args.payer_name,
      });
      return asMcpTextResult(data);
    }
  );
}
