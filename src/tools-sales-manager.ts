import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
}

// ─────────────────────────────────────────────
// 型定義
// ─────────────────────────────────────────────

type Payment  = { paid: boolean; month_idx: number; amount: number; actual_amount?: number | null; contract_id?: string; due_date?: string | null };
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

async function fetchSMData(base: string, secret?: string): Promise<{
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
  const init: RequestInit | undefined = secret
    ? { headers: { Authorization: `Bearer ${secret}` } }
    : undefined;

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

async function getRevenueSummary(env: Env) {
  const base = env.SALES_MANAGER_API_BASE ?? "https://sales-manager-black.vercel.app";
  const { payments, contracts, singles, budgets, businesses } = await fetchSMData(
    base,
    env.SALES_MANAGER_INTERNAL_SECRET
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
  const byBusiness: Record<string, number> = {};
  for (const biz of bizList) {
    const bizContracts = contracts.filter(c => c.business === biz.name && c.status === "active");
    const conf = payments
      .filter(p => p.paid && p.month_idx === cur)
      .filter(p => bizContracts.some(c => c.id === p.contract_id))
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
