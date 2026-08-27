import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";

/**
 * お金を守るくん（口座ごとの入出金と不足額の管理）の道具。
 * Supabase の mo_ で始まる 3 つの表を直接見る（積み上げラボの道具と同じ形）。
 *
 * 表：mo_accounts（口座）／mo_plans（予定）／mo_balances（実残高の記録）
 * 命名規約：okane__<action>
 *
 * 2026-08-26 新設（依頼書：お金を守るくん）。
 *   ・画面は作らない。毎日開く器を増やすと、開かない日が来てその日に漏れるため
 *   ・口座番号・カード番号・ログイン情報を持つ列は 1 つも無い
 *   ・日付が決まっていない入金は不足額の計算に入れない。入る前提で計算すると、
 *     足りているように見えて落ちる
 *   ・見込みは「足りなくなる側」へ寄せる。出るお金は多めに、入るお金は少なめに
 *   ・残高を入れる口は、過ぎた予定を「済」にしてから入れる。この順でないと、
 *     同じ残高から先の不足額が 2 通りに割れる（依頼書の手計算で実際に割れた）
 *   ・対で登録された予定（pair_key が同じ行）は、片方を動かすともう片方も動く
 *
 * 2026-08-27 直し：日付を過ぎた未入金を積み上げから外した。
 *   画面（okane-mamoru-kun の src/lib/calc.js の counted / unpaidIncome）は
 *   2026-08-27 に外しており、この口だけが古いまま残っていた。同じ数字を
 *   2 か所が別々に出す状態だったので、画面と同じ判定にそろえる。
 *   ・積み上げに入れないもの 2 つ：日付が決まっていない動き／日付を過ぎたのに
 *     済になっていない入金（＝未入金。まだ入っていないため）
 *   ・外した未入金は捨てず、別枠で「不足の原因」として返す。入る前提で積むと、
 *     足りているように見えて落ちる
 */

type Row = Record<string, unknown>;

const ACCOUNT_TABLE = "mo_accounts";
const PLAN_TABLE = "mo_plans";
const BALANCE_TABLE = "mo_balances";

function sbHeaders(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function sbGet(env: Env, path: string): Promise<Row[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, { headers: sbHeaders(env) });
  if (!res.ok) throw new Error(`Supabase error ${res.status}: ${await res.text()}`);
  return (await res.json()) as Row[];
}

async function sbPost(env: Env, path: string, body: Row | Row[], upsert = false): Promise<Row[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method: "POST",
    headers: sbHeaders(env, {
      Prefer: upsert
        ? "return=representation,resolution=merge-duplicates"
        : "return=representation",
    }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase error ${res.status}: ${await res.text()}`);
  return (await res.json()) as Row[];
}

async function sbPatch(env: Env, path: string, body: Row): Promise<Row[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method: "PATCH",
    headers: sbHeaders(env, { Prefer: "return=representation" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase error ${res.status}: ${await res.text()}`);
  return (await res.json()) as Row[];
}

/** 日本時間の今日を YYYY-MM-DD で返す */
function todayJst(): string {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

/** YYYY-MM-DD に日数を足す（負の数で戻る） */
function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

type Account = {
  id: number;
  name: string;
  kind: string;
  min_balance: number;
  base_balance: number;
  base_balance_date: string;
};

async function loadAccounts(env: Env): Promise<Account[]> {
  const rows = await sbGet(env, `/${ACCOUNT_TABLE}?select=*&order=id.asc`);
  return rows.map((r) => ({
    id: num(r.id),
    name: str(r.name),
    kind: str(r.kind),
    min_balance: num(r.min_balance),
    base_balance: num(r.base_balance),
    base_balance_date: str(r.base_balance_date),
  }));
}

type DayPoint = {
  口座: string;
  日付: string;
  予定残高: number;
  最低残高: number;
  不足額: number;
  入れる期限: string;
  その日の動き: { 名前: string; 出入り: string; 金額: number; 確定見込み: string; 動かせるか: string }[];
};

/**
 * その動きを積み上げに入れてよいか（画面の calc.js の counted と同じ判定）。
 * 入れないもの 2 つ：日付が決まっていない／日付を過ぎた未入金。
 */
function counted(p: Row, today: string): boolean {
  if (!p.plan_date) return false;
  if (str(p.direction) === "in" && str(p.plan_date) < today) return false;
  return true;
}

/**
 * 口座ごとに、起点の残高から未の予定を日付順に積み上げる。
 * 日付が決まっていない予定（plan_date が空）と、日付を過ぎた未入金は積まない。
 * 積まなかった未入金は unpaid で返す（不足の原因として並べるため）。
 */
async function buildForecast(
  env: Env,
  untilDate: string,
  today: string = todayJst()
): Promise<{ accounts: Account[]; points: DayPoint[]; undated: Row[]; unpaid: Row[] }> {
  const accounts = await loadAccounts(env);
  const plans = await sbGet(
    env,
    `/${PLAN_TABLE}?select=*&status=eq.%E6%9C%AA&order=plan_date.asc,id.asc`
  );

  const undated = plans.filter((p) => !p.plan_date);
  const unpaid = plans.filter(
    (p) => str(p.direction) === "in" && !!p.plan_date && str(p.plan_date) < today
  );
  const points: DayPoint[] = [];

  for (const a of accounts) {
    const mine = plans
      .filter((p) => num(p.account_id) === a.id && counted(p, today))
      .filter((p) => str(p.plan_date) >= a.base_balance_date && str(p.plan_date) <= untilDate)
      .sort((x, y) => (str(x.plan_date) < str(y.plan_date) ? -1 : 1));

    const byDate = new Map<string, Row[]>();
    for (const p of mine) {
      const d = str(p.plan_date);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d)!.push(p);
    }

    let running = a.base_balance;
    for (const d of Array.from(byDate.keys()).sort()) {
      const rows = byDate.get(d)!;
      for (const p of rows) {
        running += str(p.direction) === "out" ? -num(p.amount) : num(p.amount);
      }
      points.push({
        口座: a.name,
        日付: d,
        予定残高: running,
        最低残高: a.min_balance,
        不足額: Math.max(0, a.min_balance - running),
        入れる期限: addDays(d, -1),
        その日の動き: rows.map((p) => ({
          名前: str(p.name),
          出入り: str(p.direction) === "out" ? "出" : "入",
          金額: num(p.amount),
          確定見込み: str(p.certainty),
          動かせるか: str(p.movable),
        })),
      });
    }
  }

  points.sort((x, y) => (x.口座 === y.口座 ? (x.日付 < y.日付 ? -1 : 1) : x.口座 < y.口座 ? -1 : 1));
  return { accounts, points, undated, unpaid };
}

/** 未入金の行を、返す形にそろえる */
function shapeUnpaid(rows: Row[], nameById: Map<number, string>) {
  return rows.map((p) => ({
    口座: nameById.get(num(p.account_id)) ?? "",
    名前: str(p.name),
    入るはずだった日: str(p.plan_date),
    金額: num(p.amount),
    確定見込み: str(p.certainty),
  }));
}

export function registerMoneyTools(server: McpServer, env: Env): void {

  // ─── 1. okane__shortage ──────────────────────────────────────────
  server.tool(
    "okane__shortage",
    "口座ごとの不足額を日付順に返す。起点は各口座の基準残高とその日付で、そこから状態が「未」の動きだけを積み上げる。不足額は「最低残高 − 予定残高」で、マイナスにはならない。入れる期限は引き落とし日の 1 日前（同じ日では間に合わないため）。積み上げに入れないものが 2 つあり、どちらも別枠で返す。1 つは日付が決まっていない動き（日付未定）。もう 1 つは日付を過ぎたのに済になっていない入金（未入金）で、こちらは不足の原因として返す。戻り値: { ok, 起点, 一覧, 最初に不足が出るところ, 不足の原因, 日付未定 }。",
    {
      days: z.number().int().min(1).max(400).optional().describe("今日から何日先まで見るか（省略時 90）"),
      account: z.string().optional().describe("口座の呼び名でしぼる（例: みずほ法人）。省略時は全部"),
      only_shortage: z.boolean().optional().describe("true なら不足が出ている日だけ返す"),
    },
    async ({ days, account, only_shortage }) => {
      try {
        const today = todayJst();
        const until = addDays(today, days ?? 90);
        const { accounts, points, undated, unpaid } = await buildForecast(env, until, today);
        const nameById = new Map(accounts.map((a) => [a.id, a.name]));

        let rows = points;
        if (account) rows = rows.filter((p) => p.口座 === account);
        if (only_shortage) rows = rows.filter((p) => p.不足額 > 0);

        const first = points.filter((p) => p.不足額 > 0).sort((x, y) => (x.日付 < y.日付 ? -1 : 1))[0] ?? null;

        const unpaidRows = account
          ? unpaid.filter((p) => (nameById.get(num(p.account_id)) ?? "") === account)
          : unpaid;

        return asMcpTextResult({
          ok: true,
          今日: today,
          見る範囲の終わり: until,
          起点: accounts.map((a) => ({
            口座: a.name,
            区分: a.kind,
            基準残高: a.base_balance,
            基準残高の日: a.base_balance_date,
            最低残高: a.min_balance,
          })),
          一覧: rows,
          最初に不足が出るところ: first,
          不足の原因: {
            未入金: {
              件数: unpaidRows.length,
              合計: unpaidRows.reduce((s, p) => s + num(p.amount), 0),
              一覧: shapeUnpaid(unpaidRows, nameById),
              備考: "入るはずだった日を過ぎても済になっていないため、不足額の計算に入れていない",
            },
          },
          日付未定: undated.map((p) => ({
            口座: nameById.get(num(p.account_id)) ?? "",
            名前: str(p.name),
            出入り: str(p.direction) === "out" ? "出" : "入",
            金額: num(p.amount),
            備考: "日付が決まっていないため不足額の計算に入れていない",
          })),
        });
      } catch (e) {
        return asMcpTextResult({ ok: false, message: String(e) });
      }
    }
  );

  // ─── 2. okane__list_plans ────────────────────────────────────────
  server.tool(
    "okane__list_plans",
    "予定の一覧を返す。口座・期間・状態でしぼれる。予定を直すときは、この口で key を確かめてから okane__upsert_plan に渡す。戻り値: { ok, 件数, 予定: [行] }。",
    {
      account: z.string().optional().describe("口座の呼び名でしぼる"),
      from: z.string().optional().describe("この日以降（YYYY-MM-DD）"),
      to: z.string().optional().describe("この日まで（YYYY-MM-DD）"),
      status: z.enum(["未", "済"]).optional().describe("状態でしぼる。省略時は両方"),
      limit: z.number().int().min(1).max(500).optional().describe("最大件数（省略時 200）"),
    },
    async ({ account, from, to, status, limit }) => {
      try {
        const accounts = await loadAccounts(env);
        const q: string[] = ["select=*", "order=plan_date.asc,id.asc", `limit=${limit ?? 200}`];
        if (status) q.push(`status=eq.${encodeURIComponent(status)}`);
        if (from) q.push(`plan_date=gte.${from}`);
        if (to) q.push(`plan_date=lte.${to}`);
        if (account) {
          const a = accounts.find((x) => x.name === account);
          if (!a) return asMcpTextResult({ ok: false, message: `口座「${account}」がありません。登録されているのは ${accounts.map((x) => x.name).join(" / ")} です。` });
          q.push(`account_id=eq.${a.id}`);
        }
        const rows = await sbGet(env, `/${PLAN_TABLE}?${q.join("&")}`);
        const nameById = new Map(accounts.map((a) => [a.id, a.name]));
        return asMcpTextResult({
          ok: true,
          件数: rows.length,
          予定: rows.map((r) => ({
            key: str(r.key),
            口座: nameById.get(num(r.account_id)) ?? "",
            日付: r.plan_date ?? null,
            出入り: str(r.direction) === "out" ? "出" : "入",
            金額: num(r.amount),
            名前: str(r.name),
            繰り返し: r.recurrence ?? null,
            確定見込み: str(r.certainty),
            動かせるか: str(r.movable),
            状態: str(r.status),
            対の相手: r.pair_key ?? null,
            備考: r.note ?? null,
          })),
        });
      } catch (e) {
        return asMcpTextResult({ ok: false, message: String(e) });
      }
    }
  );

  // ─── 3. okane__upsert_plan ───────────────────────────────────────
  server.tool(
    "okane__upsert_plan",
    "予定を 1 件足すか、既にある予定を直す。key が同じ行があれば直し、無ければ足す。渡した欄だけ変わり、渡さなかった欄は元の値のまま残る。対で登録されている予定（対の相手が同じ行）は、日付を変えるともう片方の日付も同じだけ動く。金額を変えたときも同じ額に合わせる。これにより、法人の出が個人の入りになるものを片方だけ動かして片側だけ狂う、という形にならない。戻り値: { ok, 動作, 入った行, 一緒に動いた対の相手 }。",
    {
      key: z.string().describe("その予定を指す鍵。既にある鍵を渡すと直しになる（必須）"),
      account: z.string().optional().describe("口座の呼び名。新しく足すときは必須"),
      date: z.string().optional().describe("日付（YYYY-MM-DD）。空文字を渡すと日付未定にする"),
      direction: z.enum(["out", "in"]).optional().describe("out=出ていく / in=入ってくる"),
      amount: z.number().optional().describe("金額（円）"),
      name: z.string().optional().describe("名前"),
      recurrence: z.string().optional().describe("繰り返しの決まり（例: 毎月 27 日）"),
      certainty: z.enum(["確定", "見込み"]).optional().describe("確定か見込みか"),
      movable: z.enum(["動かせない", "期日をずらせる", "金額を変えられる"]).optional().describe("動かせるかの印"),
      status: z.enum(["未", "済"]).optional().describe("状態"),
      pair_key: z.string().optional().describe("対の相手を指す鍵。同じ値を持つ行どうしが対になる"),
      note: z.string().optional().describe("備考"),
    },
    async (args) => {
      try {
        const accounts = await loadAccounts(env);
        const existing = await sbGet(env, `/${PLAN_TABLE}?select=*&key=eq.${encodeURIComponent(args.key)}`);
        const body: Row = {};

        if (args.account !== undefined) {
          const a = accounts.find((x) => x.name === args.account);
          if (!a) return asMcpTextResult({ ok: false, message: `口座「${args.account}」がありません。登録されているのは ${accounts.map((x) => x.name).join(" / ")} です。` });
          body.account_id = a.id;
        }
        if (args.date !== undefined) body.plan_date = args.date === "" ? null : args.date;
        if (args.direction !== undefined) body.direction = args.direction;
        if (args.amount !== undefined) body.amount = args.amount;
        if (args.name !== undefined) body.name = args.name;
        if (args.recurrence !== undefined) body.recurrence = args.recurrence;
        if (args.certainty !== undefined) body.certainty = args.certainty;
        if (args.movable !== undefined) body.movable = args.movable;
        if (args.status !== undefined) body.status = args.status;
        if (args.pair_key !== undefined) body.pair_key = args.pair_key;
        if (args.note !== undefined) body.note = args.note;

        let saved: Row[];
        let action: string;

        if (existing.length > 0) {
          if (Object.keys(body).length === 0) {
            return asMcpTextResult({ ok: false, message: "直す欄が 1 つも渡されていません。" });
          }
          saved = await sbPatch(env, `/${PLAN_TABLE}?key=eq.${encodeURIComponent(args.key)}`, body);
          action = "直した";
        } else {
          for (const need of ["account_id", "direction", "amount", "name", "certainty", "movable"]) {
            if (body[need] === undefined) {
              return asMcpTextResult({
                ok: false,
                message: `新しく足すときは account / direction / amount / name / certainty / movable が全部要ります（足りないのは ${need}）。`,
              });
            }
          }
          body.key = args.key;
          if (body.status === undefined) body.status = "未";
          saved = await sbPost(env, `/${PLAN_TABLE}`, body);
          action = "足した";
        }

        // 対の相手も同じだけ動かす
        let movedPair: Row[] = [];
        const pk = str(saved[0]?.pair_key ?? "");
        const pairBody: Row = {};
        if (args.date !== undefined) pairBody.plan_date = args.date === "" ? null : args.date;
        if (args.amount !== undefined) pairBody.amount = args.amount;
        if (args.status !== undefined) pairBody.status = args.status;

        if (pk && Object.keys(pairBody).length > 0) {
          movedPair = await sbPatch(
            env,
            `/${PLAN_TABLE}?pair_key=eq.${encodeURIComponent(pk)}&key=neq.${encodeURIComponent(args.key)}`,
            pairBody
          );
        }

        const nameById = new Map(accounts.map((a) => [a.id, a.name]));
        const shape = (r: Row) => ({
          key: str(r.key),
          口座: nameById.get(num(r.account_id)) ?? "",
          日付: r.plan_date ?? null,
          出入り: str(r.direction) === "out" ? "出" : "入",
          金額: num(r.amount),
          名前: str(r.name),
          状態: str(r.status),
          対の相手: r.pair_key ?? null,
        });

        return asMcpTextResult({
          ok: true,
          動作: action,
          入った行: saved.map(shape),
          一緒に動いた対の相手: movedPair.map(shape),
        });
      } catch (e) {
        return asMcpTextResult({ ok: false, message: String(e) });
      }
    }
  );

  // ─── 4. okane__put_balance ───────────────────────────────────────
  server.tool(
    "okane__put_balance",
    "実際の残高を 1 件入れる。入れる前に、その日より前の「未」の予定を全部「済」にする。reflected_today に、その日の予定がもう落ちた後かどうかを渡す（true ならその日の予定も済にする）。この順で通さないと、同じ残高から先の不足額が 2 通りに割れる。あわせて、入れた時点の予測残高と実際の残高の差を出して記録する。差が出るということは、登録していない出入りがあるということで、これが登録漏れの検出器になる。入れたあとは、その残高が新しい起点になる。戻り値: { ok, 予測残高, 実際の残高, 差, 済にした予定, これから先の最初の不足 }。",
    {
      account: z.string().describe("口座の呼び名（必須・例: みずほ法人）"),
      date: z.string().describe("残高を見た日（YYYY-MM-DD・必須）"),
      actual_balance: z.number().describe("画面に出ている実際の残高（円・必須）"),
      reflected_today: z.boolean().describe("その日の予定がもう落ちた後なら true、まだ落ちていないなら false（必須）"),
    },
    async ({ account, date, actual_balance, reflected_today }) => {
      try {
        const accounts = await loadAccounts(env);
        const a = accounts.find((x) => x.name === account);
        if (!a) {
          return asMcpTextResult({ ok: false, message: `口座「${account}」がありません。登録されているのは ${accounts.map((x) => x.name).join(" / ")} です。` });
        }
        if (date < a.base_balance_date) {
          return asMcpTextResult({
            ok: false,
            message: `入れようとしている日（${date}）が、いまの基準残高の日（${a.base_balance_date}）より前です。前の日に戻す形はこの口では受けません。`,
          });
        }

        // 入れる前の予測残高を出す（この日までの未の予定を積む）
        const plans = await sbGet(
          env,
          `/${PLAN_TABLE}?select=*&status=eq.%E6%9C%AA&account_id=eq.${a.id}&order=plan_date.asc,id.asc`
        );
        const upto = plans.filter((p) => {
          const d = str(p.plan_date);
          if (!d) return false;
          if (d < a.base_balance_date) return false;
          return reflected_today ? d <= date : d < date;
        });
        let predicted = a.base_balance;
        for (const p of upto) {
          predicted += str(p.direction) === "out" ? -num(p.amount) : num(p.amount);
        }
        const diff = predicted - actual_balance;

        // 過ぎた予定を済にする
        const doneKeys = upto.map((p) => str(p.key));
        if (doneKeys.length > 0) {
          const filter = reflected_today ? `plan_date=lte.${date}` : `plan_date=lt.${date}`;
          await sbPatch(
            env,
            `/${PLAN_TABLE}?account_id=eq.${a.id}&status=eq.%E6%9C%AA&plan_date=gte.${a.base_balance_date}&${filter}`,
            { status: "済" }
          );
        }

        // 実残高を記録し、新しい起点にする
        await sbPost(
          env,
          `/${BALANCE_TABLE}?on_conflict=account_id,balance_date`,
          [
            {
              account_id: a.id,
              balance_date: date,
              actual_balance,
              predicted_balance: predicted,
              diff,
            },
          ],
          true
        );
        await sbPatch(env, `/${ACCOUNT_TABLE}?id=eq.${a.id}`, {
          base_balance: actual_balance,
          base_balance_date: date,
        });

        const { points } = await buildForecast(env, addDays(todayJst(), 90));
        const next = points
          .filter((p) => p.口座 === a.name && p.不足額 > 0)
          .sort((x, y) => (x.日付 < y.日付 ? -1 : 1))[0] ?? null;

        return asMcpTextResult({
          ok: true,
          口座: a.name,
          日付: date,
          予測残高: predicted,
          実際の残高: actual_balance,
          差: diff,
          差の読み方:
            diff === 0
              ? "ずれ無し。登録漏れは見つかっていない"
              : diff > 0
              ? `予測より ${diff} 円少ない。登録していない出があるか、見込みの額が実際より小さい`
              : `予測より ${-diff} 円多い。登録していない入りがあるか、見込みの額が実際より大きい`,
          済にした予定: doneKeys,
          これから先の最初の不足: next,
        });
      } catch (e) {
        return asMcpTextResult({ ok: false, message: String(e) });
      }
    }
  );

  // ─── 5. okane__morning_line ─────────────────────────────────────
  server.tool(
    "okane__morning_line",
    "毎朝の報告に足す 1 行を返す。出す条件は 2 つだけで、7 日以内に不足が出る口座があるか、直近に入れた実残高が予測とずれているか。どちらも無ければ line は null で返るので、その日は何も書かない。不足が出ていて、その口座に日付を過ぎた未入金があるときは、原因として件数と合計を line の後ろに付ける。未入金は不足額の計算には入っていない（まだ入っていないため）。新しい画面を毎日開く形にしないための口。戻り値: { ok, line, 理由, 不足が出る日, 不足の原因 }。",
    {
      within_days: z.number().int().min(1).max(60).optional().describe("何日以内の不足を見るか（省略時 7）"),
    },
    async ({ within_days }) => {
      try {
        const span = within_days ?? 7;
        const today = todayJst();
        const limitDate = addDays(today, span);
        const { accounts, points, unpaid } = await buildForecast(env, addDays(today, 90), today);
        const nameById = new Map(accounts.map((a) => [a.id, a.name]));

        const soon = points
          .filter((p) => p.不足額 > 0 && p.日付 <= limitDate)
          .sort((x, y) => (x.日付 < y.日付 ? -1 : 1));

        const balances = await sbGet(
          env,
          `/${BALANCE_TABLE}?select=*&order=balance_date.desc,id.desc&limit=5`
        );
        const drifted = balances.filter((b) => num(b.diff) !== 0);

        const 理由: string[] = [];
        const parts: string[] = [];

        // 不足が出ている口座の未入金だけを原因として並べる
        const 不足の口座 = new Set(soon.map((p) => p.口座));
        const cause = unpaid.filter((p) => 不足の口座.has(nameById.get(num(p.account_id)) ?? ""));

        if (soon.length > 0) {
          const first = soon[0];
          const 原因 =
            cause.length > 0
              ? `。不足の原因：未入金 ${cause.length} 件・${cause
                  .reduce((s, p) => s + num(p.amount), 0)
                  .toLocaleString("ja-JP")}円`
              : "";
          parts.push(
            `${first.口座}が${first.日付}に${first.不足額.toLocaleString("ja-JP")}円足りません（入れる期限は${first.入れる期限}）${原因}`
          );
          理由.push(`${span} 日以内に不足が出る日が ${soon.length} 件`);
          if (cause.length > 0) 理由.push(`不足が出る口座に未入金が ${cause.length} 件`);
        }
        if (drifted.length > 0) {
          const d = drifted[0];
          parts.push(
            `${d.balance_date}に入れた実残高が予測と${Math.abs(num(d.diff)).toLocaleString("ja-JP")}円ずれています（登録していない出入りがあります）`
          );
          理由.push("直近の実残高が予測とずれている");
        }

        return asMcpTextResult({
          ok: true,
          今日: today,
          line: parts.length > 0 ? `お金：${parts.join("。")}。` : null,
          理由,
          不足が出る日: soon,
          不足の原因: {
            未入金: {
              件数: cause.length,
              合計: cause.reduce((s, p) => s + num(p.amount), 0),
              一覧: shapeUnpaid(cause, nameById),
              備考: "入るはずだった日を過ぎても済になっていないため、不足額の計算に入れていない",
            },
          },
        });
      } catch (e) {
        return asMcpTextResult({ ok: false, message: String(e) });
      }
    }
  );
}
