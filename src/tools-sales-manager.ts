/**
 * shia2n-mcp / src/tools-sales-manager.ts / 第2版（2026-08-25 開発部）
 *
 * 第2版で直したこと
 *   事業別の当月確定（by_business）が、有効な契約に紐づく支払いだけを数えていた。
 *   止まった契約の入金が丸ごと落ち、当月の確定（monthConf）と合わなくなっていた。
 *   支払いの行の business で数える形に変え、画面と同じ定義に揃えた。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import { cfAccessHeaders } from "./cf-access.js";
import type { Env } from "./index.js";

/**
 * Sales Manager ツールを登録する。
 * useRevenue.js（haAku）の集計ロジックを TypeScript に移植。
 * 命名規約：`sales_manager__<action>`
 */
export function registerSalesManagerTools(server: McpServer, env: Env): void {
  server.tool(
    "sales_manager__get_revenue_summary",
    "今月の確定売上・見込み・目標・事業別売上・年間・未収金・月次チャート・来月予測を一括取得する。秘書 Claude が毎朝売上 KPI を確認するために呼ぶ。月の目標は事業別の予算表（sm_budgets）の合計で、画面と同じ数字。予算表にその月の行が無いときは goal が null（＝未設定）になり、契約の合計では代用しない。戻り値は { month: {confirmed, projected, goal}, year: {confirmed, goal, goal_unset（目標が未設定の月）}, uncollected_total（当月以前で未入金の合計。入金管理タブのヘッダーの未収金と一致する）, uncollected_count, uncollected_by_month: [{abs, year, month, count, amount}]（月ごとの未収額）, by_business: {事業名: 金額}, chart_data: [{month, abs, conf, proj, goal}], next_month: {goal, projected, confirmed} }。",
    {},
    async () => {
      const data = await getRevenueSummary(env);
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ─── 月の売上を記録する（2026-08-09 追加・v0.45.0）─────────────────────────
  //
  // 依頼：https://www.notion.so/3b39c6c1c4398171997ad5fc5d8c8918
  //
  // 書き先は売上管理側に新設した受け口 /api/sm-record。合言葉が必須。
  // 既存の画面用の書き込み口は使わない（あちらは合言葉のチェックが無く、
  // 画面が合言葉を持てないため必須にできない）。
  //
  // 触れる行は、名前が「YYYY-MM 事業名（自動）」の形のものだけに
  // 受け口の側で縛ってある。Naoki が手で入れた行には当たらない。
  //
  // 受け取るのは確定した金額だけ。見込みはこの口では扱わない
  // （見込みは把握くん側の手前の数字が持っており、同じ事実を 2 か所に置くと必ず食い違う）。
  server.tool(
    "sales_manager__record_monthly_revenue",
    "売上管理に月の売上を1件記録する。メンシプ・X広告収益・教材販売など、契約や入金の形になっていない月ごとの売上を入れるときに使う。同じ年月・同じ事業の区分に2回目を送っても行は増えず、前に入れた行を書き換える。Naoki が画面から手で入れた行には触れない（この口が作る行は名前が「YYYY-MM 事業名（自動）」に固定されているため）。受け取るのは確定した金額だけで、見込みは扱わない。事業の区分は売上管理に登録済みの名前しか受け付けず、無い名前を渡すと登録済みの一覧を添えて断る。戻り値: { ok, action（created=新しく足した / updated=前の行を書き換えた）, row（入った行そのもの）, month: {year_month, month_idx, singles_total（その月の単発売上の合計）, singles_by_business（その月の区分ごとの金額）, singles_count}, summary: {month_confirmed（画面と同じ当月の確定）, month_goal, by_business, target_month_confirmed（指定した月の確定。今年の範囲のときだけ入る）} }",
    {
      year_month: z
        .string()
        .describe("対象の年月。YYYY-MM の形（例: 2026-08）。必須"),
      business: z
        .string()
        .describe(
          "事業の区分の名前（例: メンシプ / X広告収益 / 教材販売）。売上管理に登録済みの名前をそのまま渡す。sales_manager__get_revenue_summary の by_business に出てくる名前と同じ"
        ),
      amount: z
        .number()
        .describe("金額（円）。整数で渡す。0 以上"),
      count: z
        .number()
        .optional()
        .describe(
          "人数。しあらぼ継続の契約更新の名数など、金額と一緒に残したい人数がある場合だけ渡す。備考の欄に「更新 N 名」の形で入る"
        ),
      note: z
        .string()
        .optional()
        .describe("備考。残したい補足があるときだけ渡す。人数と両方渡した場合は「更新 N 名 / 備考」の形で並ぶ"),
    },
    async (args) => {
      const base = env.SALES_MANAGER_API_BASE ?? "https://sales-manager.shia2n.jp";
      const secret = env.SALES_MANAGER_INTERNAL_SECRET;

      // 書き込みの口は合言葉が必須。無いまま呼ぶと必ず断られるので、
      // 外へ出す前にここで止めて、設定が足りないことが分かる文で返す。
      if (!secret) {
        throw new Error(
          "SALES_MANAGER_INTERNAL_SECRET が設定されていません。書き込みの口は合言葉が必須のため、書き込みは行っていません"
        );
      }

      if (!/^\d{4}-\d{2}$/.test(args.year_month)) {
        throw new Error(
          `year_month は YYYY-MM の形で渡してください（受け取った値: ${args.year_month}）`
        );
      }
      if (!Number.isInteger(args.amount) || args.amount < 0) {
        throw new Error(
          `amount は 0 以上の整数で渡してください（受け取った値: ${String(args.amount)}）`
        );
      }
      if (args.count !== undefined && (!Number.isInteger(args.count) || args.count < 0)) {
        throw new Error(
          `count は 0 以上の整数で渡してください（受け取った値: ${String(args.count)}）`
        );
      }

      // 2026-08-12：住所の手前に Access の関門を置いたため、
      //   ブラウザのログインを通らないこの呼び出しにはサービス用の合言葉が要る。
      //   合言葉（Authorization）は売上管理側の受け口が見るもので、別物。両方送る。
      const res = await fetch(`${base}/api/sm-record`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
          ...cfAccessHeaders(env),
        },
        body: JSON.stringify({
          year_month: args.year_month,
          business:   args.business,
          amount:     args.amount,
          count:      args.count,
          note:       args.note,
        }),
      });

      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(
          `売上管理からの返事を読めませんでした（状態 ${res.status}）。書き込みは行われていない可能性があります: ${text.slice(0, 200)}`
        );
      }

      if (!res.ok) {
        const o = parsed as { error?: string; reason?: string; available?: string[] };
        const detail = [o.error, o.reason].filter(Boolean).join(" / ");
        const avail = o.available?.length
          ? `　登録されている区分: ${o.available.join(" / ")}`
          : "";
        throw new Error(
          `売上管理が書き込みを断りました（状態 ${res.status}）: ${detail || text.slice(0, 200)}${avail}`
        );
      }

      const written = parsed as {
        ok: boolean;
        action: string;
        row: unknown;
        month: {
          year_month: string;
          month_idx: number;
          singles_total: number;
          singles_by_business: Record<string, number>;
          singles_count: number;
        };
      };

      // 書いたあとの姿を、画面と同じ集計でも見せる。
      // 取得し直さずに確かめられるようにするため。
      let summary: {
        month_confirmed: number | null;
        month_goal: number | null;
        by_business: Record<string, number> | null;
        target_month_confirmed: number | null;
      } = {
        month_confirmed: null,
        month_goal: null,
        by_business: null,
        target_month_confirmed: null,
      };

      try {
        const rev = await getRevenueSummary(env);
        const hit = rev.chart_data.find((d) => d.abs === written.month.month_idx);
        summary = {
          month_confirmed:        rev.month.confirmed,
          month_goal:             rev.month.goal,
          by_business:            rev.by_business,
          // 指定した月が今年の範囲に無いときは chart_data に出てこないので null のまま
          target_month_confirmed: hit ? hit.conf : null,
        };
      } catch (e) {
        // 集計が取れなくても、書き込み自体は済んでいる。
        // ここで失敗を投げると「書けたのに失敗した」と読めてしまうため、
        // 集計だけを空にして返す。
        console.warn("[sales_manager__record_monthly_revenue] 集計の取得に失敗", e);
      }

      return asMcpTextResult({
        ok:     true,
        action: written.action,
        row:    written.row,
        month:  written.month,
        summary,
      });
    }
  );
}

// ─────────────────────────────────────────────
// 型定義
// ─────────────────────────────────────────────

type Payment  = { paid: boolean; month_idx: number; amount: number; actual_amount?: number | null; contract_id?: string; due_date?: string | null; business?: string };
type Contract = { id: string; status: string; type: string; start_month_idx?: number; total_count?: number; amount: number; business?: string };
type Single   = { month_idx: number; amount: number; business?: string };
type Budget   = { biz: string; month_idx: number; amount: number };
type Business = { id: number; name: string; color?: string };

// ─────────────────────────────────────────────
// abs ユーティリティ（Sales Manager UI 側 constants.ts と完全整合）
// BASE_YEAR(2026) からの月インデックス。0 = 2026年1月、4 = 2026年5月。
// haAku の year*12+month 形式ではない（DBスキーマが異なる）。
// ─────────────────────────────────────────────

const BASE_YEAR = 2026;

function currAbs(): number {
  const now = new Date();
  return (now.getFullYear() - BASE_YEAR) * 12 + now.getMonth();
}

function yearAbsList(): number[] {
  const now = new Date();
  const yearOffset = (now.getFullYear() - BASE_YEAR) * 12;
  return Array.from({ length: 12 }, (_, i) => yearOffset + i);
}

function nextAbs(): number {
  return currAbs() + 1;
}

// ─────────────────────────────────────────────
// 集計ヘルパー（useRevenue.js より移植）
// ─────────────────────────────────────────────

const FALLBACK_BUSINESSES: Business[] = [
  { id: -1, name: "しあらぼ"  },
  { id: -2, name: "X"         },
  { id: -3, name: "note"      },
  { id: -4, name: "CW案件"    },
  { id: -5, name: "教材販売"  },
  { id: -6, name: "その他"    },
];

function contractAmountForMonth(contracts: Contract[], abs: number): number {
  return contracts.filter(c => c.status === "active").reduce((a, c) => {
    const s = c.start_month_idx ?? 0;
    if (c.type === "recurring" && s <= abs) return a + c.amount;
    if (c.type === "variable"  && s <= abs) return a + c.amount;
    if (c.type === "installment") {
      const e = s + (c.total_count ?? 0) - 1;
      if (s <= abs && abs <= e) return a + c.amount;
    }
    return a;
  }, 0);
}

// 月の目標＝事業別の予算表（sm_budgets）の合計。
// 2026-08-05：戦略メモ（sm_strategy の goal_*）を読むのをやめ、画面と同じ側に一本化した。
//   判断記録：3b39c6c1-c439-81b7-9695-d668b408b7a2
// 画面と同じく「事業マスタに載っている名前の行だけ」を足す。
//   予算表には事業名でない行（__goal__ など）が混ざっており、足すと画面と数字がずれるため。
// 行が無い月は null（＝未設定）を返す。契約の合計で代用しない。
function getBudgetGoal(budgets: Budget[], bizNames: Set<string>, abs: number): number | null {
  const rows = budgets.filter(b => b.month_idx === abs && bizNames.has(b.biz));
  if (rows.length === 0) return null;
  const total = rows.reduce((a, b) => a + (b.amount || 0), 0);
  return total > 0 ? total : null;
}

// ─────────────────────────────────────────────
// データ取得
// ─────────────────────────────────────────────

async function fetchSMData(
  base: string,
  secret: string | undefined,
  accessHeaders: Record<string, string>
): Promise<{
  payments: Payment[];
  contracts: Contract[];
  singles: Single[];
  budgets: Budget[];
  businesses: Business[];
}> {
  // 2026-08-03：取得口の合言葉を付けて呼ぶ（段階1）。
  //   Sales Manager 側は段階2で「あれば通す・無くても通す」で受けるため、
  //   ここで先に送り始めても本番は止まらない。
  //   合言葉が未設定のときは見出しを付けない（設定漏れで取得が全滅しないため）。
  //
  // 2026-08-12：住所の手前に Access の関門を置いたため、
  //   ここにサービス用の合言葉（CF-Access-Client-Id / CF-Access-Client-Secret）も載せる。
  //   関門をまだ置いていない住所へ送っても、余分な見出しとして無視されるだけで害は無い。
  //   これにより「先に呼び出し側へ入れてから関門をかける」順番が採れる。
  const headers: Record<string, string> = {
    ...accessHeaders,
    ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
  };
  const init: RequestInit | undefined =
    Object.keys(headers).length > 0 ? { headers } : undefined;

  const [payments, contracts, singles, businesses, budgets] = await Promise.all([
    fetch(`${base}/api/sm-payments`, init).then(r => r.json() as Promise<Payment[]>),
    fetch(`${base}/api/sm-contracts`, init).then(r => r.json() as Promise<Contract[]>),
    fetch(`${base}/api/sm-singles`, init).then(r => r.json() as Promise<Single[]>),
    fetch(`${base}/api/sm-businesses`, init).then(r => r.json() as Promise<Business[]>),
    fetch(`${base}/api/sm-budgets`, init).then(r => r.json() as Promise<Budget[]>),
  ]);
  return { payments, contracts, singles, businesses, budgets };
}

// ─────────────────────────────────────────────
// 集計メイン（useRevenue.js の stats useMemo を移植）
// ─────────────────────────────────────────────

// 2026-08-16：毎晩の処理（cron-haaku-fill.ts）からも同じ集計を使うため export する。
// 同じ計算をもう 1 つ書くと、片方だけ直したときに数字が食い違うため。
export async function getRevenueSummary(env: Env) {
  // 2026-08-08：設定値が無いときの行き先も新しい住所に合わせる（保険）
  const base = env.SALES_MANAGER_API_BASE ?? "https://sales-manager.shia2n.jp";
  const { payments, contracts, singles, budgets, businesses } = await fetchSMData(
    base,
    env.SALES_MANAGER_INTERNAL_SECRET,
    cfAccessHeaders(env)
  );

  const cur     = currAbs();
  const absList = yearAbsList();

  const bizList = businesses?.length ? businesses : FALLBACK_BUSINESSES;

  const bizNames = new Set(bizList.map(b => b.name));

  // null = 未設定（予算表にその月の行が無い）
  const getGoal = (abs: number): number | null => getBudgetGoal(budgets, bizNames, abs);

  // 当月確定
  const monthConf =
    payments.filter(p => p.paid && p.month_idx === cur).reduce((a, p) => a + (p.actual_amount ?? p.amount), 0) +
    singles.filter(s => s.month_idx === cur).reduce((a, s) => a + s.amount, 0);

  // 当月目標
  const monthGoal = getGoal(cur);

  // 当月見込み
  const monthUnpaid = contracts.filter(c => c.status === "active").reduce((a, c) => {
    const s = c.start_month_idx ?? 0;
    if (c.type === "variable" && s <= cur) return a + c.amount;
    if (c.type === "recurring" && s <= cur)
      return payments.some(p => p.contract_id === c.id && p.month_idx === cur && p.paid) ? a : a + c.amount;
    if (c.type === "installment") {
      const e = s + (c.total_count ?? 0) - 1;
      if (s <= cur && cur <= e)
        return payments.some(p => p.contract_id === c.id && p.month_idx === cur && p.paid) ? a : a + c.amount;
    }
    return a;
  }, 0);
  const monthProj = monthConf + monthUnpaid;

  // 年間
  const yearConf =
    payments.filter(p => p.paid && absList.includes(p.month_idx)).reduce((a, p) => a + (p.actual_amount ?? p.amount), 0) +
    singles.filter(s => absList.includes(s.month_idx)).reduce((a, s) => a + s.amount, 0);
  // 未設定の月は足さない（画面の年間目標と同じ数え方）
  const yearGoalMonths = absList.map(abs => getGoal(abs));
  const yearGoal       = yearGoalMonths.reduce<number>((t, g) => t + (g ?? 0), 0);
  const yearGoalUnset  = absList.filter((_, i) => yearGoalMonths[i] === null)
                                .map(abs => `${abs % 12 + 1}月`);

  // 未収金（当月以前・未入金）
  //
  // 2026-08-03 修正：due_date ベースから当月以前ベースへ戻した。
  //   旧実装は「支払期限が設定済み・期限到来・未入金」で数えていたが、
  //   sm_payments 291 件すべてで due_date が未設定のため、条件に合致する行が
  //   存在せず uncollected_total が常に 0 を返していた。
  //   画面（入金管理タブのヘッダー）は「当月以前で未入金」で数えており、
  //   同じ入金管理の数字が二系統に割れていた状態だった。
  //   due_date を使う定義は、値が全件投入されたあと（Phase 3）に再度切り替える。
  //   金額は画面と同じく実額優先（actual_amount があればそれ、無ければ amount）。
  const uncollectedPayments = payments.filter(p => !p.paid && p.month_idx <= cur);

  const uncollectedTotal = uncollectedPayments
    .reduce((a, p) => a + (p.actual_amount ?? p.amount), 0);

  // 月ごとの未収額（どの月から回収するかを決めるために使う）
  const uncollectedByMonth = Array.from(
    uncollectedPayments.reduce((map, p) => {
      const e = map.get(p.month_idx) ?? { count: 0, amount: 0 };
      e.count  += 1;
      e.amount += p.actual_amount ?? p.amount;
      map.set(p.month_idx, e);
      return map;
    }, new Map<number, { count: number; amount: number }>())
  )
    .sort((a, b) => a[0] - b[0])
    .map(([abs, e]) => ({
      abs,
      year:   BASE_YEAR + Math.floor(abs / 12),
      month:  abs % 12 + 1,
      count:  e.count,
      amount: e.amount,
    }));

  // 月次チャート
  const chartData = absList.map(abs => {
    const m    = abs % 12 + 1;
    const conf = payments.filter(p => p.paid && p.month_idx === abs).reduce((a, p) => a + (p.actual_amount ?? p.amount), 0)
               + singles.filter(s => s.month_idx === abs).reduce((a, s) => a + s.amount, 0);
    const goal = getGoal(abs);
    const proj = abs > cur
      ? contractAmountForMonth(contracts, abs)
      : abs === cur ? monthProj : conf;
    return { month: `${m}月`, abs, conf, proj, goal, isCurrent: abs === cur };
  });

  // 来月予測
  const nxt           = nextAbs();
  const nextMonthGoal = getGoal(nxt);
  const nextMonthProj = contractAmountForMonth(contracts, nxt);
  const nextMonthConf =
    payments.filter(p => p.paid && p.month_idx === nxt).reduce((a, p) => a + (p.actual_amount ?? p.amount), 0) +
    singles.filter(s => s.month_idx === nxt).reduce((a, s) => a + s.amount, 0);

  // 事業別当月確定
  //
  // 2026-08-25 の直し（開発部）：
  //   以前は「有効な契約に紐づく支払い」だけを数えていた。そのため、止まった契約の
  //   入金（契約が終わった月額の最終回など）が事業別から丸ごと落ちていた。
  //   すぐ上の当月の確定（monthConf）は契約を見ずに数えているので、両者が食い違う。
  //   実測（2026-08-25）：当月の確定 648,000 に対し事業別の合計は 626,000 で、
  //   差の 22,000 は契約が stopped になっている行 1 本ぶんだった。
  //   画面（sales-manager の components/sm/useAppData.ts）は支払いの行の business を
  //   見ているので、そちらに揃える。この口の説明にある「画面と同じ数字」を満たす形。
  const byBusiness: Record<string, number> = {};
  for (const biz of bizList) {
    const conf = payments
      .filter(p => p.paid && p.month_idx === cur && p.business === biz.name)
      .reduce((a, p) => a + (p.actual_amount ?? p.amount), 0);
    const singleConf = singles
      .filter(s => s.month_idx === cur && s.business === biz.name)
      .reduce((a, s) => a + s.amount, 0);
    byBusiness[biz.name] = conf + singleConf;
  }

  return {
    month: {
      confirmed: monthConf,
      projected: monthProj,
      goal:      monthGoal,
    },
    year: {
      confirmed: yearConf,
      goal:       yearGoal,
      goal_unset: yearGoalUnset,   // 目標が未設定の月（年間目標には足していない）
    },
    uncollected_total:    uncollectedTotal,
    uncollected_count:    uncollectedPayments.length,
    uncollected_by_month: uncollectedByMonth,
    by_business:          byBusiness,
    chart_data:        chartData,
    next_month: {
      goal:      nextMonthGoal,
      projected: nextMonthProj,
      confirmed: nextMonthConf,
    },
  };
}
