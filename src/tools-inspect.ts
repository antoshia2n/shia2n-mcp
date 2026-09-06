/**
 * MCP tool 登録：shr__billing / shr__contracts / logs__records
 *
 * 統括が人を待たずに答えられるようにするための、**読むだけ**の道具。
 * 書く列は 3 本とも 0 個。
 *
 * なぜ要るか（2026-09-06）：
 *   凍結の解除条件②「トラブルを予測して対応できる」は、読んだ量ではなく
 *   統括が叩ける口の数だけに連動する（可視化表の実測）。
 *   区間 2（決済する）・4/12（契約の台帳）・3/14/15/18（記録）は、
 *   実物が Supabase にあるのに読む口が 1 つも無い状態だった。
 *   依頼書：https://www.notion.so/3d39c6c1c4398165a471d2ffc69174d7
 *
 * 区間 2 について（2026-09-06 の実測）：
 *   依頼書には「Pay-kun は商品の一覧しか引けない」とだけあったが、
 *   決済の受け取り口（shr-webhook の src/index.js・指紋 72a16ce83ca8）の
 *   116〜125 行目が、決済 1 件ごとに `shr_billing_logs` へ
 *   member_id / event_type / amount / currency / univa_charge_id / raw_payload
 *   を書いている。**実物はすでにある。読む口が無かっただけ。**
 *
 * この 3 本の決まり：
 *   ・**列名を決め打ちしない。**`select=*` で取り、返ってきた列の名前を
 *     そのまま `columns_seen` に入れて返す。これがそのまま「読む列」の正本になる
 *   ・**メールは返さない。**列の名前に mail を含むものは値を落とす。
 *     呼び名（name）は返す（members__search が display_name を返すのと同じ扱い）
 *   ・**通知の全文（raw / payload）は返さない。**大きさと中身の両方の理由から。
 *     落とした列は `columns_omitted` に理由つきで必ず出す（黙って消さない）
 *   ・**総数は Content-Range から取る。**返した行数を総数として書かない
 *   ・**0 件と「引けなかった」を混ぜない。**失敗は lookup_failed で返す
 *   ・並べ替えの列も決め打ちしない。候補を順に試し、どれも通らなければ
 *     並べ替えなしで取り、`ordered_by` に実際の値を書く
 *
 * 設定の追加は無い（SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY は既存）。
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./index.js";

type Row = Record<string, unknown>;

/** 値を落とす列の見分け方。名前で判定し、落としたことは必ず応答に出す */
const OMIT_RULES: { pattern: RegExp; reason: string }[] = [
  { pattern: /mail/i, reason: "個人のメールは返さない決まり" },
  { pattern: /payload|_raw$|^raw/i, reason: "通知の全文。大きさと中身の両方の理由で返さない" },
];

/** 記録の 3 本。名前の実在は 2026-09-06 に確認済み（3 分の 3） */
const LOG_TABLES = ["entitlement_logs", "audit_logs", "sync_run_logs"] as const;
type LogTable = (typeof LOG_TABLES)[number];

/** 新しい順に並べたいときに試す列。上から順に試す */
const ORDER_CANDIDATES = ["created_at", "occurred_at", "updated_at", "id"];

function sbHeaders(env: Env): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

/**
 * 行と総数を一緒に取る。
 * 総数は Content-Range の見出し（例 `0-49/1234`）から読む。
 * 返した行数を総数として書かないための決まり。
 */
async function sbSelect(
  env: Env,
  path: string,
): Promise<{ ok: boolean; status: number; rows: Row[]; total: number | null; body: string }> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    headers: { ...sbHeaders(env), Prefer: "count=exact" },
  });
  const body = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, rows: [], total: null, body };
  }
  let rows: Row[] = [];
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) rows = parsed as Row[];
  } catch {
    return { ok: false, status: res.status, rows: [], total: null, body };
  }
  const range = res.headers.get("content-range"); // 例 "0-49/1234"
  let total: number | null = null;
  if (range) {
    const tail = range.split("/")[1];
    if (tail && tail !== "*") {
      const n = Number(tail);
      if (Number.isFinite(n)) total = n;
    }
  }
  return { ok: true, status: res.status, rows, total, body };
}

/**
 * 並べ替えの列を決め打ちしないで取る。
 * 候補を上から試し、その列が無ければ次へ。全部だめなら並べ替えなしで取る。
 */
async function sbSelectOrdered(
  env: Env,
  table: string,
  query: string,
): Promise<{
  ok: boolean;
  status: number;
  rows: Row[];
  total: number | null;
  body: string;
  ordered_by: string | null;
  order_tried: string[];
}> {
  const tried: string[] = [];
  for (const col of ORDER_CANDIDATES) {
    tried.push(col);
    const r = await sbSelect(env, `/${table}?${query}&order=${col}.desc`);
    if (r.ok) return { ...r, ordered_by: col, order_tried: tried };
    // 列が無いときは 400。それ以外（鍵・表そのもの）は並べ替えを外しても直らない
    if (r.status !== 400) {
      return { ...r, ordered_by: null, order_tried: tried };
    }
  }
  const r = await sbSelect(env, `/${table}?${query}`);
  return { ...r, ordered_by: null, order_tried: tried };
}

/** 落とす列を決め、値を伏せた行と、列の一覧を作る */
function redact(rows: Row[]): {
  rows: Row[];
  columns_seen: string[];
  columns_omitted: { column: string; reason: string }[];
} {
  const seen: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.includes(key)) seen.push(key);
    }
  }
  const omitted: { column: string; reason: string }[] = [];
  for (const col of seen) {
    for (const rule of OMIT_RULES) {
      if (rule.pattern.test(col)) {
        omitted.push({ column: col, reason: rule.reason });
        break;
      }
    }
  }
  const omittedNames = omitted.map((o) => o.column);
  const cleaned = rows.map((row) => {
    const out: Row = {};
    for (const [key, value] of Object.entries(row)) {
      if (omittedNames.includes(key)) continue;
      out[key] = value;
    }
    return out;
  });
  return { rows: cleaned, columns_seen: seen, columns_omitted: omitted };
}

/** 値ごとの件数を数える（空は「（空）」にまとめる） */
function countBy(rows: Row[], column: string): Record<string, number> | null {
  if (!rows.some((r) => column in r)) return null;
  const out: Record<string, number> = {};
  for (const row of rows) {
    const v = row[column];
    const key = v === null || v === undefined || v === "" ? "（空）" : String(v);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(where: string, detail: unknown) {
  return textResult({
    ok: false,
    error: "lookup_failed",
    where,
    detail: String(detail),
    note: "0 件と失敗は別物。この応答は「引けなかった」であって「無い」ではない",
  });
}

export function registerInspectTools(server: McpServer, env: Env): void {
  // ============================================================
  // shr__billing（区間 2 決済する）
  // ============================================================
  server.tool(
    "shr__billing",
    "決済の実績を 1 件ずつ引く（shr_billing_logs）。いつ・誰の決済か（member_id）・種別・金額・通貨・決済業者側の番号を返す。書き込んでいるのは決済の受け取り口だけで、この道具は読むだけ。個人のメールと通知の全文は返さない。誰かは member_id で、shr__contracts の行と突き合わせる。総数は返した行数ではなく表の全行数を別に返す。",
    {
      limit: z.number().int().min(1).max(200).optional().describe("返す行数（1-200・省略時 50）"),
      event_type: z.string().optional().describe("種別で絞る（完全一致）。省略すると全部"),
    },
    async ({ limit, event_type }) => {
      try {
        const n = limit ?? 50;
        let query = `select=*&limit=${n}`;
        if (event_type) query += `&event_type=eq.${encodeURIComponent(event_type)}`;
        const r = await sbSelectOrdered(env, "shr_billing_logs", query);
        if (!r.ok) {
          return errorResult("shr__billing", `HTTP ${r.status}: ${r.body.slice(0, 300)}`);
        }
        const { rows, columns_seen, columns_omitted } = redact(r.rows);

        // 金額の合計は、amount の列が実際に返ってきたときだけ出す
        let amount_sum: Record<string, number> | null = null;
        if (rows.some((row) => "amount" in row)) {
          amount_sum = {};
          for (const row of rows) {
            const v = Number(row["amount"]);
            if (!Number.isFinite(v)) continue;
            const cur = typeof row["currency"] === "string" ? (row["currency"] as string) : "不明";
            amount_sum[cur] = (amount_sum[cur] ?? 0) + v;
          }
        }

        return textResult({
          ok: true,
          table: "shr_billing_logs",
          writes: "無し（この道具は読むだけ）",
          total_rows_in_table: r.total,
          returned: rows.length,
          ordered_by: r.ordered_by,
          order_tried: r.order_tried,
          columns_seen,
          columns_omitted,
          count_by_event_type: countBy(rows, "event_type"),
          amount_sum_of_returned: amount_sum,
          note:
            "amount_sum は返した行だけの合計で、表全体の合計ではない。期間の合計が要るときは limit を上げて数え直す",
          rows,
        });
      } catch (e) {
        return errorResult("shr__billing", e);
      }
    },
  );

  // ============================================================
  // shr__contracts（区間 4 契約の台帳・区間 12 継続と解約）
  // ============================================================
  server.tool(
    "shr__contracts",
    "しあらぼの契約の台帳を引く（shr_members）。契約の状態・プラン・次の課金日・登録日・解約日を返す。次の課金日の分布も同じ応答で返すので、継続と解約の様子はこの 1 回で分かる。個人のメールは返さない（呼び名は返す）。この表は 10 月に落とす予定の旧の表で、そのときこの道具も作り直しになる。読むだけで、書く列は 0。",
    {
      limit: z.number().int().min(1).max(200).optional().describe("返す行数（1-200・省略時 100）"),
      subscription_status: z
        .string()
        .optional()
        .describe("契約の状態で絞る（完全一致）。省略すると全部"),
    },
    async ({ limit, subscription_status }) => {
      try {
        const n = limit ?? 100;
        let query = `select=*&limit=${n}`;
        if (subscription_status) {
          query += `&subscription_status=eq.${encodeURIComponent(subscription_status)}`;
        }
        const r = await sbSelectOrdered(env, "shr_members", query);
        if (!r.ok) {
          return errorResult("shr__contracts", `HTTP ${r.status}: ${r.body.slice(0, 300)}`);
        }
        const { rows, columns_seen, columns_omitted } = redact(r.rows);

        return textResult({
          ok: true,
          table: "shr_members",
          writes: "無し（この道具は読むだけ）",
          total_rows_in_table: r.total,
          returned: rows.length,
          ordered_by: r.ordered_by,
          columns_seen,
          columns_omitted,
          count_by_subscription_status: countBy(rows, "subscription_status"),
          count_by_plan: countBy(rows, "plan"),
          count_by_next_billing_date: countBy(rows, "next_billing_date"),
          note:
            "次の課金日は、更新されずに古い日付のまま残っている行がありうる（2026-09-05 実測で 2 件）。分布をそのまま切り替えの窓の根拠にしない",
          rows,
        });
      } catch (e) {
        return errorResult("shr__contracts", e);
      }
    },
  );

  // ============================================================
  // logs__records（区間 3・14・15・18 記録）
  // ============================================================
  server.tool(
    "logs__records",
    "記録の 3 本（entitlement_logs / audit_logs / sync_run_logs）を引く。table を省くと 3 本の総件数と、それぞれの直近の行をまとめて返す。指定するとその 1 本だけを深く返す。3 本を同時に取るので、1 本だけ 0 件なら「その表が空」、3 本とも 0 件なら「取り方が効いていない」と読み分けられる。個人のメールと通知の全文は返さない。読むだけで、書く列は 0。",
    {
      table: z
        .enum(LOG_TABLES)
        .optional()
        .describe("1 本だけ深く見るときに指定する（省略すると 3 本まとめて）"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("1 本あたりの返す行数（1-200・省略時は 3 本まとめてなら 5、1 本指定なら 50）"),
    },
    async ({ table, limit }) => {
      try {
        const targets: LogTable[] = table ? [table] : [...LOG_TABLES];
        const n = limit ?? (table ? 50 : 5);
        const result: Record<string, unknown> = {};
        let reachable = 0;
        let totalAll = 0;

        for (const t of targets) {
          const r = await sbSelectOrdered(env, t, `select=*&limit=${n}`);
          if (!r.ok) {
            result[t] = {
              ok: false,
              error: "lookup_failed",
              status: r.status,
              detail: r.body.slice(0, 200),
            };
            continue;
          }
          reachable += 1;
          totalAll += r.total ?? 0;
          const { rows, columns_seen, columns_omitted } = redact(r.rows);
          result[t] = {
            ok: true,
            total_rows_in_table: r.total,
            returned: rows.length,
            ordered_by: r.ordered_by,
            columns_seen,
            columns_omitted,
            rows,
          };
        }

        return textResult({
          ok: reachable > 0,
          writes: "無し（この道具は読むだけ）",
          tables: targets,
          reachable_tables: reachable,
          total_rows_all_tables: totalAll,
          per_table: result,
          note:
            reachable === 0
              ? "3 本とも届かなかった。表が空なのではなく、取り方そのものが効いていない疑いがある"
              : "権利の記録のキーの欄には、まとめ書きの行が 2 件ある（2026-09-06 実測）。行の数とキーの数を別に数える",
        });
      } catch (e) {
        return errorResult("logs__records", e);
      }
    },
  );
}
