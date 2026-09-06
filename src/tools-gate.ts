/**
 * MCP tool 登録：gate__diag / gate__attempts / gate__entitlements /
 *                gate__entitlement_grant / gate__entitlement_revoke
 *
 * 会員の門番（src/gate.ts）を、統括が道具として呼べる形に包んだもの。
 *
 * なぜ包むか（2026-09-08）：
 *   門番は 3 つの口を持っているが、そのうち統括が使うのは 2 つ
 *   （/gate/attempts と /gate/diag）で、どちらも合言葉つきの住所を
 *   直接叩く形だった。合言葉を人づてに渡すと置き場が増える。
 *   道具にすれば MCP の入口の検証がそのまま効くので、
 *   **新しい合言葉を 1 つも配らずに済む。**
 *   （/gate/resolve は本人の券そのものが認証なので道具にできない。
 *     道具から呼べる形にすると「券なしで人を引く口」になってしまう。）
 *
 * 権利の読み書きを 3 つ足した理由（2026-09-08）：
 *   2026-09-07 の判断記録で「解約した人の権利は手で剥奪する」と決めたが、
 *   新しい `member_entitlement` へ書く手が 1 つも無いことが 2026-09-08 に
 *   実測で分かった（この置き場の全文を対照つきで数えて、触っているのは
 *   src/gate.ts の読み取り 1 か所だけ）。決めを実行できる状態にする。
 *   判断記録：https://www.notion.so/3d29c6c1c43981c68993d81088383679
 *
 * 設計の正本：会員の仕組み ― 業務マニュアルの【新】の節
 * https://www.notion.so/3d19c6c1c43981579dc0ded0a37f53ab
 *
 * この 1 本の決まり：
 *   ・個人のメールと呼び名を返さない。返すのは `member_id` と権利のキーだけ
 *   ・書く道具は既定が下見（preview: true）。実際に書くときだけ明示する
 *   ・書いたあとは、その人の権利の一覧を必ず取り直して返す
 *     （「落ちた人が 0」だけで終えず、「本当に書き換わった」も同じ回に出す）
 *   ・テスト用の行（メールが example.com）は既定で数から外す
 *     業務マニュアルの「数えるときの決まり」と同じ扱い
 *
 * 設定の追加は無い（SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY は既存）。
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./index.js";
import { handleGateAttempts, handleGateDiag } from "./gate.js";

type Row = Record<string, unknown>;

/** テスト用の行の見分け方。業務マニュアルの「数えるときの決まり」と同じ */
const TEST_EMAIL_SUFFIX = "@example.com";

/** `member_entitlement` の列（2026-09-05 の作業 75 の作る文が正本・全 8 列） */
const ENTITLEMENT_COLUMNS = "id,member_id,key,source,reason,granted_at,expires_at,created_at";

function sbHeaders(env: Env): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

async function sbSelect(env: Env, path: string): Promise<Row[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    headers: sbHeaders(env),
  });
  if (!res.ok) {
    throw new Error(`Supabase GET ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as Row[];
}

/** 書いた行そのものを返させる（何が変わったかを目で見るため） */
async function sbWrite(
  env: Env,
  method: "POST" | "DELETE",
  path: string,
  body?: Row,
): Promise<{ status: number; rows: Row[]; raw: string }> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: { ...sbHeaders(env), Prefer: "return=representation" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let rows: Row[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) rows = parsed as Row[];
  } catch {
    // 本文が JSON でないときは raw をそのまま返す（握りつぶさない）
  }
  return { status: res.status, rows, raw };
}

function isTestEmail(email: unknown): boolean {
  return typeof email === "string" && email.toLowerCase().endsWith(TEST_EMAIL_SUFFIX);
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(where: string, e: unknown) {
  return textResult({
    ok: false,
    error: "lookup_failed",
    where,
    message: String(e),
    note: "0 件と失敗は別物。この応答は「引けなかった」であって「無い」ではない",
  });
}

/** その人の権利の一覧を取り直す（書いたあとの確かめに使う） */
async function readEntitlements(env: Env, memberId: string): Promise<Row[]> {
  return sbSelect(
    env,
    `/member_entitlement?select=${ENTITLEMENT_COLUMNS}` +
      `&member_id=eq.${encodeURIComponent(memberId)}&order=key.asc`,
  );
}

export function registerGateTools(server: McpServer, env: Env): void {
  // ============================================================
  // gate__diag
  // ============================================================
  server.tool(
    "gate__diag",
    "会員の門番が立っているかだけを返す。版・券を確かめる鍵が取れるか・読む表 3 本（member / member_entitlement / auth_attempt）に届くかと、それぞれの行数。秘密の値は 1 つも返さない。人が入れないという話が出たときに、まずここを 1 回叩く。",
    {},
    async () => {
      try {
        const res = await handleGateDiag(env);
        return textResult(await res.json());
      } catch (e) {
        return errorResult("gate__diag", e);
      }
    },
  );

  // ============================================================
  // gate__attempts
  // ============================================================
  server.tool(
    "gate__attempts",
    "入ろうとした記録を、日ごと・符号ごとに数えて返す（auth_attempt）。符号は ok / no_token / bad_token / no_email / not_found / multiple / lookup_failed。not_found（台帳にいない）と lookup_failed（引けなかった）は別物なので混ぜて読まない。個人のメールはここでは返さない。人に「入れましたか」と聞く代わりに使う口。",
    {
      days: z
        .number()
        .int()
        .min(1)
        .max(90)
        .optional()
        .describe("さかのぼる日数（1-90・省略時は 7）"),
    },
    async ({ days }) => {
      try {
        const n = days ?? 7;
        const request = new Request(`https://internal/gate/attempts?days=${n}`);
        const res = await handleGateAttempts(request, env);
        return textResult(await res.json());
      } catch (e) {
        return errorResult("gate__attempts", e);
      }
    },
  );

  // ============================================================
  // gate__entitlements（読み・集計と 1 人分を 1 本にまとめてある）
  // ============================================================
  server.tool(
    "gate__entitlements",
    "新しい権利の表（member_entitlement）を読む。member_id を省くと全体の集計（キーごとの人数と行数・人ごとのキーの組み合わせ）、指定するとその 1 人分の行を返す。既定ではテスト用の行（メールが example.com）を数から外し、外した数を別に返す。個人のメールと呼び名は返さない。数を出すときの決まりの正本：会員の仕組み ― 業務マニュアルの「数えるときの決まり」。",
    {
      member_id: z
        .string()
        .uuid()
        .optional()
        .describe("この人 1 人分だけを見るときに指定する（省略すると全体の集計）"),
      include_test: z
        .boolean()
        .optional()
        .describe("テスト用の行も数に入れる（省略時 false）"),
    },
    async ({ member_id, include_test }) => {
      try {
        if (member_id) {
          const rows = await readEntitlements(env, member_id);
          return textResult({
            ok: true,
            member_id,
            count: rows.length,
            entitlements: rows,
            note: rows.length === 0 ? "0 行。人そのものが居ないのか、権利が無いのかは gate__diag と別に確かめる" : undefined,
          });
        }

        const members = await sbSelect(env, "/member?select=id,email&limit=1000");
        const ents = await sbSelect(
          env,
          `/member_entitlement?select=${ENTITLEMENT_COLUMNS}&limit=5000`,
        );

        const testIds = new Set(
          members.filter((m) => isTestEmail(m.email)).map((m) => String(m.id)),
        );
        const useAll = include_test === true;
        const countedEnts = useAll
          ? ents
          : ents.filter((e) => !testIds.has(String(e.member_id)));
        const countedMembers = useAll
          ? members
          : members.filter((m) => !testIds.has(String(m.id)));

        const byKey = new Map<string, { key: string; members: Set<string>; rows: number }>();
        for (const e of countedEnts) {
          const key = String(e.key);
          const entry = byKey.get(key) ?? { key, members: new Set<string>(), rows: 0 };
          entry.members.add(String(e.member_id));
          entry.rows += 1;
          byKey.set(key, entry);
        }

        const byMember = new Map<string, string[]>();
        for (const e of countedEnts) {
          const id = String(e.member_id);
          const list = byMember.get(id) ?? [];
          list.push(String(e.key));
          byMember.set(id, list);
        }

        return textResult({
          ok: true,
          include_test: useAll,
          counted: {
            members: countedMembers.length,
            entitlement_rows: countedEnts.length,
            keys: byKey.size,
          },
          excluded_test: {
            members: useAll ? 0 : testIds.size,
            entitlement_rows: useAll ? 0 : ents.length - countedEnts.length,
          },
          totals_including_test: {
            members: members.length,
            entitlement_rows: ents.length,
          },
          by_key: [...byKey.values()]
            .map((v) => ({ key: v.key, members: v.members.size, rows: v.rows }))
            .sort((a, b) => b.rows - a.rows || a.key.localeCompare(b.key)),
          by_member: [...byMember.entries()]
            .map(([id, keys]) => ({ member_id: id, keys: keys.sort() }))
            .sort((a, b) => b.keys.length - a.keys.length),
          note: "totals_including_test の 2 つは gate__diag の行数と一致するはず。合わなければ数え方が効いていない",
        });
      } catch (e) {
        return errorResult("gate__entitlements", e);
      }
    },
  );

  // ============================================================
  // gate__entitlement_grant（手当てを 1 行足す）
  // ============================================================
  server.tool(
    "gate__entitlement_grant",
    "手当ての権利を 1 行足す（member_entitlement）。source は manual に固定で、reason は必須（表の側にも必須の決まりが入っている）。支払いから出る権利（source=payment）はここからは書けない。書くのは決済の受け取り口だけという決まりのため。既定は下見（preview: true）で、実際に書くときだけ preview を false にする。書いたあとはその人の権利の一覧を取り直して返す。",
    {
      member_id: z.string().uuid().describe("誰に渡すか（member の id）"),
      key: z.string().min(1).describe("何の権利か（例：shiarabo_basic）"),
      reason: z
        .string()
        .min(1)
        .describe("なぜ手で渡すか（例：銀行振込・無料招待・継続の手当て）。空文字は表の側で拒否される"),
      expires_at: z
        .string()
        .optional()
        .describe("いつまで（ISO 8601 の日時。省略すると無期限）"),
      preview: z
        .boolean()
        .optional()
        .describe("true で書かずに影響だけ返す（省略時 true）"),
    },
    async ({ member_id, key, reason, expires_at, preview }) => {
      const dryRun = preview !== false;
      try {
        const before = await readEntitlements(env, member_id);
        const already = before.filter(
          (r) => String(r.key) === key && String(r.source) === "manual",
        );

        if (dryRun) {
          return textResult({
            ok: true,
            preview: true,
            applied: false,
            member_id,
            would_insert: { key, source: "manual", reason, expires_at: expires_at ?? null },
            already_has_same_row: already.length > 0,
            before: { count: before.length, keys: before.map((r) => String(r.key)).sort() },
            note: "実際に書くときは preview を false にして同じ呼び出しをする",
          });
        }

        if (already.length > 0) {
          return textResult({
            ok: true,
            applied: false,
            reason_not_applied: "same_row_exists",
            member_id,
            existing: already,
            note: "同じ人・同じキー・同じ出どころの行は 1 つしか置けない決まり。何も書いていない",
          });
        }

        const wrote = await sbWrite(env, "POST", "/member_entitlement", {
          member_id,
          key,
          source: "manual",
          reason,
          expires_at: expires_at ?? null,
        });

        if (wrote.status < 200 || wrote.status >= 300) {
          return textResult({
            ok: false,
            applied: false,
            http_status: wrote.status,
            body: wrote.raw,
            note: "書けなかった。表の側の決まり（source は payment か manual・manual は reason 必須）を先に見る",
          });
        }

        const after = await readEntitlements(env, member_id);
        return textResult({
          ok: true,
          applied: true,
          member_id,
          inserted: wrote.rows,
          before: { count: before.length, keys: before.map((r) => String(r.key)).sort() },
          after: { count: after.length, keys: after.map((r) => String(r.key)).sort() },
          changed: after.length - before.length,
          note: "件数が 1 増えていること と inserted が 1 行返っていること の両方を見る",
        });
      } catch (e) {
        return errorResult("gate__entitlement_grant", e);
      }
    },
  );

  // ============================================================
  // gate__entitlement_revoke（1 行外す）
  // ============================================================
  server.tool(
    "gate__entitlement_revoke",
    "権利を 1 行外す（member_entitlement）。既定は手当ての行（source=manual）だけを対象にする。支払いから出た行（source=payment）を外すときは source を明示する（自動の組み直しが入れ直すので、ふつうは外さない）。既定は下見（preview: true）で、実際に外すときだけ preview を false にする。外したあとはその人の権利の一覧を取り直して返す。戻すときは gate__entitlement_grant で同じキーを入れ直す。",
    {
      member_id: z.string().uuid().describe("誰から外すか（member の id）"),
      key: z.string().min(1).describe("どの権利を外すか"),
      source: z
        .enum(["manual", "payment"])
        .optional()
        .describe("出どころ（省略時 manual）"),
      reason: z
        .string()
        .min(1)
        .describe("なぜ外すか（例：解約・誤って渡した）。応答に残るだけで、表には書かれない"),
      preview: z
        .boolean()
        .optional()
        .describe("true で外さずに影響だけ返す（省略時 true）"),
    },
    async ({ member_id, key, source, reason, preview }) => {
      const dryRun = preview !== false;
      const src = source ?? "manual";
      const filter =
        `?member_id=eq.${encodeURIComponent(member_id)}` +
        `&key=eq.${encodeURIComponent(key)}` +
        `&source=eq.${encodeURIComponent(src)}`;
      try {
        const before = await readEntitlements(env, member_id);
        const target = before.filter(
          (r) => String(r.key) === key && String(r.source) === src,
        );

        if (dryRun) {
          return textResult({
            ok: true,
            preview: true,
            applied: false,
            member_id,
            reason,
            would_delete: target,
            would_delete_count: target.length,
            before: { count: before.length, keys: before.map((r) => String(r.key)).sort() },
            note:
              target.length === 0
                ? "当たる行が 0。キーか出どころが違う可能性がある。gate__entitlements で 1 人分を先に見る"
                : "実際に外すときは preview を false にして同じ呼び出しをする",
          });
        }

        if (target.length === 0) {
          return textResult({
            ok: true,
            applied: false,
            reason_not_applied: "no_matching_row",
            member_id,
            note: "当たる行が 0 なので何もしていない。0 件と失敗は別物",
          });
        }

        const wrote = await sbWrite(env, "DELETE", `/member_entitlement${filter}`);

        if (wrote.status < 200 || wrote.status >= 300) {
          return textResult({
            ok: false,
            applied: false,
            http_status: wrote.status,
            body: wrote.raw,
          });
        }

        const after = await readEntitlements(env, member_id);
        return textResult({
          ok: true,
          applied: true,
          member_id,
          reason,
          deleted: wrote.rows,
          deleted_count: wrote.rows.length,
          before: { count: before.length, keys: before.map((r) => String(r.key)).sort() },
          after: { count: after.length, keys: after.map((r) => String(r.key)).sort() },
          changed: before.length - after.length,
          note: "deleted に外した行そのものが返っていること と 件数が減っていること の両方を見る。戻すときは gate__entitlement_grant で同じキーを入れ直す",
        });
      } catch (e) {
        return errorResult("gate__entitlement_revoke", e);
      }
    },
  );
}
