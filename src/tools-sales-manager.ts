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
    "今月の確定売上・見込み・目標・事業別売上・年間・未収金・月次チャート・来月予測を一括取得する。秘書 Claude が毎朝売上 KPI を確認するために呼ぶ。戻り値は { month: {confirmed, projected, goal}, year: {confirmed, goal}, uncollected_total, by_business: {事業名: 金額}, chart_data: [{month, abs, conf, proj, goal}], next_month: {goal, projected, confirmed} }。",
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

type Payment  = { paid: boolean; month_idx: number; amount: number; actual_amount?: number | null; contract_id?: string };
type Contract = { id: string; status: string; type: string; start_month_idx?: number; total_count?: number; amount: number; business?: string };
type Single   = { month_idx: number; amount: number; business?: string };
type Strategy = { key: string; value: string | number };
type Business = { id: number; name: string; color?: string };

// ─────────────────────────────────────────────
// abs ユーティリティ（haAku/src/tokens.ts 相当）
// abs = year * 12 + month(0始まり)
// ─────────────────────────────────────────────

function currAbs(): number {
  const now = new Date();
  return now.getFullYear() * 12 + now.getMonth();
}

function yearAbsList(): number[] {
  const now = new Date();
  const year = now.getFullYear();
  return Array.from({ length: 12 }, (_, i) => year * 12 + i);
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

function getStrategyGoal(strategy: Strategy[], abs: number): number | null {
  // abs形式（goal_24316）またはmonth_idx形式（goal_4）の両方に対応
  // sm_strategy API が month_idx(0-11) 形式で返す場合に abs % 12 でフォールバック
  const row = strategy.find(r => r.key === `goal_${abs}`)
           ?? strategy.find(r => r.key === `goal_${abs % 12}`);
  if (!row) return null;
  try {
    const val = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
    return typeof val === "number" ? val : null;
  } catch { return null; }
}

// ─────────────────────────────────────────────
// データ取得
// ─────────────────────────────────────────────

async function fetchSMData(base: string): Promise<{
  payments: Payment[];
  contracts: Contract[];
  singles: Single[];
  strategy: Strategy[];
  businesses: Business[];
}> {
  const [payments, contracts, singles, businesses, strategy] = await Promise.all([
    fetch(`${base}/api/sm-payments`).then(r => r.json() as Promise<Payment[]>),
    fetch(`${base}/api/sm-contracts`).then(r => r.json() as Promise<Contract[]>),
    fetch(`${base}/api/sm-singles`).then(r => r.json() as Promise<Single[]>),
    fetch(`${base}/api/sm-businesses`).then(r => r.json() as Promise<Business[]>),
    fetch(`${base}/api/sm-strategy`).then(r => r.json() as Promise<Strategy[]>),
  ]);
  return { payments, contracts, singles, businesses, strategy };
}

// ─────────────────────────────────────────────
// 集計メイン（useRevenue.js の stats useMemo を移植）
// ─────────────────────────────────────────────

async function getRevenueSummary(env: Env) {
  const base = env.SALES_MANAGER_API_BASE ?? "https://sales-manager-black.vercel.app";
  const { payments, contracts, singles, strategy, businesses } = await fetchSMData(base);

  const cur     = currAbs();
  const absList = yearAbsList();

  const bizList = businesses?.length ? businesses : FALLBACK_BUSINESSES;

  const getGoal = (abs: number): number =>
    getStrategyGoal(strategy, abs) ?? contractAmountForMonth(contracts, abs);

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
  const yearGoal = absList.reduce((t, abs) => t + getGoal(abs), 0);

  // 未収金
  const uncollectedTotal = payments
    .filter(p => !p.paid && p.month_idx < cur)
    .reduce((a, p) => a + p.amount, 0);

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
      goal:      yearGoal,
    },
    uncollected_total: uncollectedTotal,
    by_business:       byBusiness,
    chart_data:        chartData,
    next_month: {
      goal:      nextMonthGoal,
      projected: nextMonthProj,
      confirmed: nextMonthConf,
    },
  };
}
