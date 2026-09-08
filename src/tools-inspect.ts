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
import { getFirestoreToken } from "./taskmaster.js";
import { getGoogleTokenForScope } from "./google-token.js";

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
const ORDER_CANDIDATES = ["created_at", "occurred_at", "started_at", "updated_at", "id"];

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

/** テスト用の行の見分け方。業務マニュアルの「数えるときの決まり」と同じ */
const TEST_EMAIL_SUFFIX = "@example.com";

/** Firestore のプロジェクト。gate.ts / taskmaster.ts と同じ値 */
const FIREBASE_PROJECT_ID = "gen-lang-client-0371348401";

/**
 * Firestore が返す値を、素の JavaScript の値へ直す。
 * 欄の名前は一切決め打ちしない（来たものをそのまま入れ物へ移すだけ）。
 */
function fromFirestoreValue(v: Record<string, unknown>): unknown {
  if (v === null || v === undefined) return null;
  if ("nullValue" in v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) {
    const inner = (v.arrayValue as { values?: Record<string, unknown>[] })?.values ?? [];
    return inner.map(fromFirestoreValue);
  }
  if ("mapValue" in v) {
    const fields = (v.mapValue as { fields?: Record<string, Record<string, unknown>> })?.fields ?? {};
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(fields)) out[k] = fromFirestoreValue(inner);
    return out;
  }
  return v;
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function isTestEmail(email: unknown): boolean {
  return typeof email === "string" && email.toLowerCase().endsWith(TEST_EMAIL_SUFFIX);
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

  // ============================================================
  // portal__state（区間 8 ポータルに入る）
  // ============================================================
  server.tool(
    "portal__state",
    "ポータルの状態を引く。誰がログインできる状態か（新しい人の表で本人の番号が入っているか）と、どの札が出るかを決めている材料（Supabase の 2 つの対応表と、Firestore の apps）をまとめて返す。表の名前も欄の名前も決め打ちせず、返ってきたものをそのまま出す。Firestore は先にデータベースの一覧を引いてから読むので、どこを読んだかも一緒に返る。読むだけで、書く列は 0。",
    {
      include_test: z
        .boolean()
        .optional()
        .describe("テスト用の行も数に入れる（省略時 false）"),
    },
    async ({ include_test }) => {
      const out: Record<string, unknown> = {
        ok: true,
        writes: "無し（この道具は読むだけ）",
      };

      // 1. 誰がログインできる状態か（新しい人の表）
      try {
        const r = await sbSelect(env, "/member?select=id,email,auth_uid&limit=2000");
        if (!r.ok) {
          out.login = { ok: false, error: "lookup_failed", status: r.status, detail: r.body.slice(0, 200) };
        } else {
          const all = r.rows;
          const counted = include_test ? all : all.filter((row) => !isTestEmail(row["email"]));
          const bound = counted.filter((row) => {
            const v = row["auth_uid"];
            return typeof v === "string" && v.length > 0;
          });
          out.login = {
            ok: true,
            table: "member",
            counted_members: counted.length,
            excluded_test: all.length - counted.length,
            can_log_in: bound.length,
            never_logged_in: counted.length - bound.length,
            note: "本人の番号が空の人は、まだ一度も入っていない。入れないとは限らない（初回に入った時点で埋まる）",
          };
        }
      } catch (e) {
        out.login = { ok: false, error: "lookup_failed", detail: String(e) };
      }

      // 2. 札を決める対応表（Supabase 側）
      const matrices: Record<string, unknown> = {};
      for (const t of ["entitlement_app_matrix", "plan_entitlement_matrix"]) {
        try {
          const r = await sbSelect(env, `/${t}?select=*&limit=500`);
          if (!r.ok) {
            matrices[t] = { ok: false, error: "lookup_failed", status: r.status, detail: r.body.slice(0, 200) };
            continue;
          }
          const { rows, columns_seen, columns_omitted } = redact(r.rows);
          matrices[t] = {
            ok: true,
            total_rows_in_table: r.total,
            returned: rows.length,
            columns_seen,
            columns_omitted,
            rows,
          };
        } catch (e) {
          matrices[t] = { ok: false, error: "lookup_failed", detail: String(e) };
        }
      }
      out.supabase_matrices = matrices;

      // 3. 札そのもの（Firestore の apps）。データベースの名前を決め打ちしない
      try {
        const token = await getFirestoreToken(env);
        const auth = { Authorization: `Bearer ${token}` };
        const dbRes = await fetch(
          `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases`,
          { headers: auth },
        );
        const dbBody = await dbRes.text();
        if (!dbRes.ok) {
          out.firestore = {
            ok: false,
            error: "lookup_failed",
            where: "databases",
            status: dbRes.status,
            detail: dbBody.slice(0, 300),
          };
        } else {
          const parsed = JSON.parse(dbBody) as { databases?: { name?: string }[] };
          const names = (parsed.databases ?? [])
            .map((d) => (d.name ?? "").split("/databases/")[1])
            .filter((n) => n && n.length > 0);
          const perDb: Record<string, unknown> = {};
          for (const dbId of names) {
            const docRes = await fetch(
              `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}` +
                `/databases/${encodeURIComponent(dbId)}/documents/apps?pageSize=100`,
              { headers: auth },
            );
            const docBody = await docRes.text();
            if (!docRes.ok) {
              perDb[dbId] = { ok: false, status: docRes.status, detail: docBody.slice(0, 200) };
              continue;
            }
            const docs = (JSON.parse(docBody) as {
              documents?: { name?: string; fields?: Record<string, Record<string, unknown>> }[];
            }).documents ?? [];
            perDb[dbId] = {
              ok: true,
              count: docs.length,
              apps: docs.map((d) => {
                const fields: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(d.fields ?? {})) {
                  fields[k] = fromFirestoreValue(v);
                }
                return { doc_id: (d.name ?? "").split("/documents/apps/")[1] ?? null, fields };
              }),
            };
          }
          out.firestore = {
            ok: true,
            project: FIREBASE_PROJECT_ID,
            databases_found: names,
            apps_by_database: perDb,
            note:
              names.length === 0
                ? "データベースが 1 つも返らなかった。読む許可が足りていない疑いがある"
                : "apps が 0 件のデータベースは、そこに札を置いていないというだけ",
          };
        }
      } catch (e) {
        out.firestore = { ok: false, error: "lookup_failed", detail: String(e) };
      }

      return textResult(out);
    },
  );

  // ============================================================
  // db__grants（区間 16 権利の入口の守り）
  // ============================================================
  server.tool(
    "db__grants",
    "処理を実行してよい許可の一覧を引く（どの立場が、どの処理を呼べるか）。表を読む道からは届かないので、データベース側に置いた読み出し専用の処理 list_routine_grants を呼ぶ。外から呼べる処理があるかを人に聞かずに確かめるための口。まだ処理が置かれていないときは、その旨を返す。読むだけで、書く列は 0。",
    {
      grantee: z
        .string()
        .optional()
        .describe("立場で絞る（例：anon / authenticated / service_role）。省略すると全部"),
    },
    async ({ grantee }) => {
      try {
        const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/list_routine_grants`, {
          method: "POST",
          headers: sbHeaders(env),
          body: JSON.stringify({}),
        });
        const body = await res.text();
        if (res.status === 404) {
          return textResult({
            ok: false,
            error: "not_installed",
            note:
              "読み出し用の処理 list_routine_grants がまだ置かれていない。置く文は依頼書に載せてある。0 件ではなく未設置",
            status: res.status,
          });
        }
        if (!res.ok) {
          return errorResult("db__grants", `HTTP ${res.status}: ${body.slice(0, 300)}`);
        }
        let rows: Row[] = [];
        try {
          const parsed = JSON.parse(body);
          if (Array.isArray(parsed)) rows = parsed as Row[];
        } catch {
          return errorResult("db__grants", `本文が読めない形だった: ${body.slice(0, 200)}`);
        }
        const filtered = grantee
          ? rows.filter((r) => String(r["grantee"]) === grantee)
          : rows;
        const columns_seen: string[] = [];
        for (const row of rows) {
          for (const k of Object.keys(row)) if (!columns_seen.includes(k)) columns_seen.push(k);
        }
        return textResult({
          ok: true,
          source: "list_routine_grants",
          writes: "無し（この道具は読むだけ）",
          total: rows.length,
          returned: filtered.length,
          columns_seen,
          count_by_grantee: countBy(rows, "grantee"),
          count_by_privilege_type: countBy(rows, "privilege_type"),
          rows: filtered,
          note:
            "外から呼べるかどうかは、立場が anon の行があるかで見る。PUBLIC の行は「誰でも」の意味",
        });
      } catch (e) {
        return errorResult("db__grants", e);
      }
    },
  );

  // ============================================================
  // portal__users（2026-09-06 新設）
  // 役（role）がどこに入っているかを、Naoki の画面なしで引く。
  // Firestore の users を読むだけ。書く列は 0。
  // 呼び名・あだ名・note の名前は返さない（個人が分かる値は伏せる決まり）。
  // ============================================================
  server.tool(
    "portal__users",
    "ポータルの利用者（Firestore の users）を引く。役（role）が実物でどう入っているかを見るための口。データベースの名前は決め打ちせず、先に一覧を引いてから読む。個人が分かる値（呼び名・あだ名・note の名前・メール）は返さない。読むだけで、書く列は 0。0 件と引けなかったは別の戻り値になる。",
    {
      include_fields: z
        .boolean()
        .optional()
        .describe("true で 1 人ずつの欄も返す（省略時 false。既定は集計だけ）"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(300)
        .optional()
        .describe("1 つのデータベースあたりの読む上限（省略時 300）"),
    },
    async ({ include_fields, limit }) => {
      const cap = limit ?? 300;
      const HIDE = ["nickname", "noteID", "note_id", "email", "displayName", "photoURL"];
      try {
        const token = await getFirestoreToken(env);
        const auth = { Authorization: `Bearer ${token}` };

        const dbRes = await fetch(
          `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases`,
          { headers: auth },
        );
        const dbBody = await dbRes.text();
        if (!dbRes.ok) {
          return textResult({
            ok: false,
            error: "lookup_failed",
            where: "databases",
            status: dbRes.status,
            detail: dbBody.slice(0, 300),
            note: "0 件と失敗は別物。これは「引けなかった」",
          });
        }
        const names = ((JSON.parse(dbBody) as { databases?: { name?: string }[] }).databases ?? [])
          .map((d) => (d.name ?? "").split("/databases/")[1])
          .filter((n) => n && n.length > 0);

        const perDb: Record<string, unknown> = {};
        for (const dbId of names) {
          const docRes = await fetch(
            `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}` +
              `/databases/${encodeURIComponent(dbId)}/documents/users?pageSize=${cap}`,
            { headers: auth },
          );
          const docBody = await docRes.text();
          if (!docRes.ok) {
            perDb[dbId] = { ok: false, status: docRes.status, detail: docBody.slice(0, 200) };
            continue;
          }
          const docs = (JSON.parse(docBody) as {
            documents?: { name?: string; fields?: Record<string, Record<string, unknown>> }[];
          }).documents ?? [];

          const seen: string[] = [];
          const byRole: Record<string, number> = {};
          const byPaymentStatus: Record<string, number> = {};
          const rows: Record<string, unknown>[] = [];

          for (const d of docs) {
            const fields: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(d.fields ?? {})) {
              if (!seen.includes(k)) seen.push(k);
              if (HIDE.includes(k)) continue;
              fields[k] = fromFirestoreValue(v);
            }
            const role = fields["role"];
            const roleKey = role === null || role === undefined || role === "" ? "（空）" : String(role);
            byRole[roleKey] = (byRole[roleKey] ?? 0) + 1;

            const ps = fields["paymentStatus"];
            const psKey = ps === null || ps === undefined || ps === "" ? "（空）" : String(ps);
            byPaymentStatus[psKey] = (byPaymentStatus[psKey] ?? 0) + 1;

            rows.push({ doc_id: (d.name ?? "").split("/documents/users/")[1] ?? null, fields });
          }

          perDb[dbId] = {
            ok: true,
            count: docs.length,
            reached_limit: docs.length >= cap,
            columns_seen: seen,
            columns_omitted: seen
              .filter((k) => HIDE.includes(k))
              .map((k) => ({ column: k, reason: "個人が分かる値は返さない決まり" })),
            count_by_role: byRole,
            count_by_payment_status: byPaymentStatus,
            users: include_fields === true ? rows : undefined,
          };
        }

        return textResult({
          ok: true,
          writes: "無し（この道具は読むだけ）",
          project: FIREBASE_PROJECT_ID,
          databases_found: names,
          users_by_database: perDb,
          note:
            names.length === 0
              ? "データベースが 1 つも返らなかった。読む許可が足りていない疑いがある"
              : "users が 0 件のデータベースは、そこに利用者を置いていないというだけ。役が空の人は、まだ役が付いていない",
        });
      } catch (e) {
        return errorResult("portal__users", e);
      }
    },
  );

// ============================================================
// portal__auth_users（2026-09-09 新設）
// Firebase の利用者（認証の側）を、Naoki の画面なしで引く。
// メールで 1 人を引く（accounts:lookup）か、直近に入った人の一覧を出す（accounts:batchGet）。
// どちらも読むだけ。書く列は 0。
// 一覧のメールは先頭 2 文字と @ より後ろだけ残す（個人が分かる値は伏せる決まり）。
// 通行証は google-token.ts（scope は identitytoolkit）。鍵は Firestore と同じ 2 つで、新しい設定は 0。
// ============================================================
server.tool(
  "portal__auth_users",
  "Firebase の利用者（認証の側）を引く。email を渡すとその 1 人（uid・作られた日時・最後に入った日時・入口の種類・無効化・Firestore の users の role と paymentStatus）。email を省くと直近 recent_days 日に入った人の一覧（既定 30 日・メールは一部を伏せる）。読むだけで、書く列は 0。0 件と引けなかったは別の戻り値になる。403 が返ったら鍵に firebaseauth.users.get の役が無い。",
  {
    email: z
      .string()
      .optional()
      .describe("この 1 人を引く。省略時は一覧"),
    recent_days: z
      .number()
      .int()
      .min(1)
      .max(3650)
      .optional()
      .describe("一覧のとき、この日数以内に入った人だけ返す（省略時 30）"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("一覧のとき、読む上限（省略時 1000）"),
  },
  async ({ email, recent_days, limit }) => {
    const IDTK_SCOPE = "https://www.googleapis.com/auth/identitytoolkit";
    const BASE = `https://identitytoolkit.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}`;

    type AuthUser = {
      localId?: string;
      email?: string;
      createdAt?: string;
      lastLoginAt?: string;
      disabled?: boolean;
      providerUserInfo?: { providerId?: string }[];
    };

    const msToIso = (ms?: string) =>
      ms && /^\d+$/.test(ms) ? new Date(Number(ms)).toISOString() : null;

    const maskEmail = (e?: string) => {
      if (!e || !e.includes("@")) return null;
      const [local, domain] = e.split("@");
      return `${local.slice(0, 2)}***@${domain}`;
    };

    const shape = (u: AuthUser, hide: boolean) => ({
      uid: u.localId ?? null,
      email: hide ? maskEmail(u.email) : (u.email ?? null),
      created_at: msToIso(u.createdAt),
      last_login_at: msToIso(u.lastLoginAt),
      providers: (u.providerUserInfo ?? []).map((p) => p.providerId ?? null),
      disabled: u.disabled === true,
    });

    const failed = (where: string, status: number, body: string) =>
      textResult({
        ok: false,
        error: "lookup_failed",
        where,
        status,
        detail: body.slice(0, 300),
        hint:
          status === 403
            ? "鍵（FIREBASE_SA_EMAIL のサービスアカウント）に firebaseauth.users.get の役が無い疑い。Naoki の画面 1 枚で役を足す"
            : undefined,
        note: "0 件と失敗は別物。これは「引けなかった」",
      });

    try {
      const token = await getGoogleTokenForScope(env, IDTK_SCOPE);
      const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

      // ── メールで 1 人 ──
      if (email && email.trim().length > 0) {
        const target = email.trim().toLowerCase();
        const res = await fetch(`${BASE}/accounts:lookup`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ email: [target] }),
        });
        const body = await res.text();
        if (!res.ok) return failed("accounts:lookup", res.status, body);
        const users = ((JSON.parse(body) as { users?: AuthUser[] }).users ?? []);
        if (users.length === 0) {
          return textResult({
            ok: true,
            writes: "無し（この道具は読むだけ）",
            project: FIREBASE_PROJECT_ID,
            email: target,
            found: false,
            note: "Firebase の認証の側に、このメールの利用者は居ない。一度も Google で入っていないということ",
          });
        }

        // Firestore の users/{uid} から role と paymentStatus を引く（データベースは決め打ちせず一覧から）
        const fsToken = await getFirestoreToken(env);
        const fsAuth = { Authorization: `Bearer ${fsToken}` };
        const dbRes = await fetch(
          `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases`,
          { headers: fsAuth },
        );
        const dbNames = dbRes.ok
          ? (((JSON.parse(await dbRes.text()) as { databases?: { name?: string }[] }).databases ?? [])
              .map((d) => (d.name ?? "").split("/databases/")[1])
              .filter((n) => n && n.length > 0))
          : [];

        const rows = [];
        for (const u of users) {
          const profile: Record<string, unknown> = {};
          for (const dbId of dbNames) {
            const docRes = await fetch(
              `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}` +
                `/databases/${encodeURIComponent(dbId)}/documents/users/${encodeURIComponent(u.localId ?? "")}`,
              { headers: fsAuth },
            );
            if (docRes.status === 404) { profile[dbId] = { exists: false }; continue; }
            if (!docRes.ok) { profile[dbId] = { ok: false, status: docRes.status }; continue; }
            const fields = (JSON.parse(await docRes.text()) as {
              fields?: Record<string, Record<string, unknown>>;
            }).fields ?? {};
            profile[dbId] = {
              exists: true,
              role: fields["role"] ? fromFirestoreValue(fields["role"]) : null,
              paymentStatus: fields["paymentStatus"] ? fromFirestoreValue(fields["paymentStatus"]) : null,
            };
          }
          rows.push({ ...shape(u, false), firestore_users: profile });
        }

        return textResult({
          ok: true,
          writes: "無し（この道具は読むだけ）",
          project: FIREBASE_PROJECT_ID,
          email: target,
          found: true,
          count: rows.length,
          users: rows,
          databases_checked: dbNames,
          note: "firestore_users の exists が false のデータベースは、その人がまだ登録口を通っていないということ",
        });
      }

      // ── 直近に入った人の一覧 ──
      const days = recent_days ?? 30;
      const cap = limit ?? 1000;
      const since = Date.now() - days * 24 * 60 * 60 * 1000;
      const all: AuthUser[] = [];
      let pageToken: string | undefined;
      let pages = 0;
      do {
        const url =
          `${BASE}/accounts:batchGet?maxResults=${Math.min(500, cap - all.length)}` +
          (pageToken ? `&nextPageToken=${encodeURIComponent(pageToken)}` : "");
        const res = await fetch(url, { headers: auth });
        const body = await res.text();
        if (!res.ok) return failed("accounts:batchGet", res.status, body);
        const json = JSON.parse(body) as { users?: AuthUser[]; nextPageToken?: string };
        all.push(...(json.users ?? []));
        pageToken = json.nextPageToken;
        pages += 1;
      } while (pageToken && all.length < cap && pages < 20);

      const recent = all
        .filter((u) => {
          const t = u.lastLoginAt && /^\d+$/.test(u.lastLoginAt) ? Number(u.lastLoginAt) : 0;
          return t >= since;
        })
        .sort((a, b) => Number(b.lastLoginAt ?? 0) - Number(a.lastLoginAt ?? 0))
        .map((u) => shape(u, true));

      return textResult({
        ok: true,
        writes: "無し（この道具は読むだけ）",
        project: FIREBASE_PROJECT_ID,
        total_users: all.length,
        reached_limit: all.length >= cap,
        recent_days: days,
        recent_count: recent.length,
        recent_users: recent,
        note:
          all.length === 0
            ? "利用者が 1 人も返らなかった。読む許可が足りていない疑いがある（0 件と失敗は別物）"
            : "recent_count は、この日数以内に Google で入った人の数。会員かどうかは見ていない",
      });
    } catch (e) {
      return errorResult("portal__auth_users", e);
    }
  },
);
}
