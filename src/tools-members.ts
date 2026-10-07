/**
 * MCP tool 登録：members__search / members__get / members__update
 *
 * v2.0.0（2026-10-07 開発部・旧の 2 本を落とす行の 9 便の 7 番目）
 *   会員管理くんの画面を畳む（2026-10-07 Naoki 判断）のに合わせ、
 *   会員管理くんの内部 API（旧の members と members_decrypted を読む）を経由するのをやめ、
 *   新しい会員の表を直接読む形に作り直した。
 *     - member             … 1 人 1 行（呼び名・メール・ログインの番号・役・旧の番号・登録日）
 *     - member_alias       … 名寄せの鍵（2026-10-07 に旧の members の 7 列から写した表）
 *     - member_entitlement … 権利
 *     - member_subscription… 継続課金
 *   member_id は新しい表 member の番号。旧の契約の台帳の番号を渡したときは、
 *   新しい人の番号を手がかりとして返す（取り違えの切り分け用・個人の値は返さない）。
 *
 *   members__update で変えられるのは、呼び名と名寄せの鍵だけ。
 *   権利は gate__entitlement_grant / gate__entitlement_revoke で付け外しする（新しい表の書き口）。
 *   本名・メモ・案件（旧の legal_name・notes・consult_case_ids）と meta・plans は新しい表に無い
 *   （2026-09-25 統括合意：本名・メモ・案件はしあらぼ管理くん、付帯の列は落とす）。
 *
 *   設定の追加は 0 個（SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY は既存）。
 *   MEMBERS_API_BASE と MEMBERS_INTERNAL_TOKEN はこのファイルからは参照しなくなった。
 *
 * v1.x（2026-07-05〜）：会員管理くん Phase 4 スコープ A。内部 API の薄い包み。
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface MembersEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

type Row = Record<string, unknown>;

const MEMBER_COLUMNS = "id,name,email,auth_uid,role,legacy_shr_id,enrolled_at,created_at,updated_at";

/** 1 人に 1 つだけ持つ鍵（置き換える）。other_name だけは 1 人に複数持つ */
const SINGLE_KINDS = [
  "shr_student_id",
  "note_account",
  "note_name",
  "line_name",
  "utage_common_reader_id",
] as const;

/** sor_id で探す鍵 */
const SOR_KINDS = ["shr_student_id", "note_account", "utage_common_reader_id"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sbHeaders(env: MembersEnv, prefer?: string): Record<string, string> {
  const h: Record<string, string> = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  if (prefer) h.Prefer = prefer;
  return h;
}

async function sbGet(env: MembersEnv, path: string): Promise<Row[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, { headers: sbHeaders(env) });
  if (!res.ok) throw new Error(`Supabase GET ${res.status}: ${await res.text()}`);
  return (await res.json()) as Row[];
}

async function sbSend(
  env: MembersEnv,
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<Row[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: sbHeaders(env, "return=representation"),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${res.status}: ${raw}`);
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Row[]) : [];
  } catch {
    return [];
  }
}

/** 会員管理くんと同じ作り方（小文字・前後の空白を落として SHA-256 の 16 進） */
async function emailHash(email: string): Promise<string> {
  const data = new TextEncoder().encode(email.toLowerCase().trim());
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function inList(ids: string[]): string {
  return `(${ids.map((id) => encodeURIComponent(id)).join(",")})`;
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function fail(where: string, e: unknown) {
  return text({ ok: false, error: "lookup_failed", where, message: e instanceof Error ? e.message : String(e) });
}

async function loadAliases(env: MembersEnv, memberId: string): Promise<Row[]> {
  return sbGet(
    env,
    `/member_alias?member_id=eq.${encodeURIComponent(memberId)}&select=id,kind,value,label,source,created_at&order=kind.asc,value.asc`
  );
}

/** 旧の契約の台帳の番号を渡されたときの手がかり（新しい人の番号だけ返す・個人の値は返さない） */
async function hintForUnknownId(env: MembersEnv, id: string): Promise<Row | null> {
  if (!UUID_RE.test(id)) return null;
  const byLegacy = await sbGet(env, `/member?legacy_shr_id=eq.${encodeURIComponent(id)}&select=id&limit=1`);
  if (byLegacy.length > 0) {
    return { provided_id_type: "legacy_shr_id", member_id: String(byLegacy[0].id) };
  }
  return null;
}

type PlanStep =
  | { op: "set_name"; value: string }
  | { op: "replace_alias"; kind: string; value: string | null }
  | { op: "add_alias"; kind: "other_name"; value: string; label: string | null }
  | { op: "remove_alias"; kind: "other_name"; value: string };

export function registerMembersTools(server: McpServer, env: MembersEnv): void {
  // ============================================================
  // members__search
  // ============================================================
  server.tool(
    "members__search",
    "会員を新しい会員の表（member と member_alias）から探す。query_type=display_name（呼び名の部分一致）/ email（メールの完全一致・大文字小文字は見ない）/ sor_id（会員の番号・旧の番号・生徒番号・note アカウント・UTAGE の読者番号の完全一致）。メールは返さず、一覧向けの最小の欄（member_id / display_name / entitlement_keys / subscription_statuses / updated_at）だけ返す。詳細は members__get。",
    {
      query_type: z
        .enum(["display_name", "email", "sor_id"])
        .describe("検索種別。display_name=部分一致 / email=完全一致 / sor_id=番号の完全一致"),
      query: z.string().min(1).describe("検索文字列（空文字禁止）"),
      limit: z.number().int().min(1).max(100).optional().describe("最大件数（1-100・デフォルト 20）"),
    },
    async ({ query_type, query, limit }) => {
      try {
        const n = limit ?? 20;
        const q = query.trim();
        const ids = new Set<string>();

        if (query_type === "display_name") {
          const safe = q.replace(/[*,()]/g, "");
          const rows = await sbGet(
            env,
            `/member?name=ilike.${encodeURIComponent(`*${safe}*`)}&select=id&order=updated_at.desc&limit=${n}`
          );
          rows.forEach((r) => ids.add(String(r.id)));
        } else if (query_type === "email") {
          const lower = q.toLowerCase();
          const direct = await sbGet(env, `/member?email=eq.${encodeURIComponent(lower)}&select=id&limit=${n}`);
          direct.forEach((r) => ids.add(String(r.id)));
          const hash = await emailHash(q);
          const viaAlias = await sbGet(
            env,
            `/member_alias?kind=eq.email_hash&value=eq.${hash}&select=member_id&limit=${n}`
          );
          viaAlias.forEach((r) => ids.add(String(r.member_id)));
        } else {
          if (UUID_RE.test(q)) {
            const byId = await sbGet(
              env,
              `/member?or=(id.eq.${encodeURIComponent(q)},legacy_shr_id.eq.${encodeURIComponent(q)})&select=id&limit=${n}`
            );
            byId.forEach((r) => ids.add(String(r.id)));
          }
          const viaAlias = await sbGet(
            env,
            `/member_alias?kind=in.(${SOR_KINDS.join(",")})&value=eq.${encodeURIComponent(q)}&select=member_id&limit=${n}`
          );
          viaAlias.forEach((r) => ids.add(String(r.member_id)));
        }

        const idList = Array.from(ids).slice(0, n);
        if (idList.length === 0) return text({ ok: true, results: [], count: 0 });

        const [members, ents, subs] = await Promise.all([
          sbGet(env, `/member?id=in.${inList(idList)}&select=id,name,updated_at`),
          sbGet(env, `/member_entitlement?member_id=in.${inList(idList)}&select=member_id,key`),
          sbGet(env, `/member_subscription?member_id=in.${inList(idList)}&select=member_id,status`),
        ]);

        const results = members.map((m) => {
          const id = String(m.id);
          return {
            member_id: id,
            display_name: m.name ?? null,
            entitlement_keys: ents.filter((e) => String(e.member_id) === id).map((e) => e.key),
            subscription_statuses: subs.filter((s) => String(s.member_id) === id).map((s) => s.status),
            updated_at: m.updated_at ?? null,
          };
        });
        return text({ ok: true, results, count: results.length });
      } catch (e) {
        return fail("members__search", e);
      }
    }
  );

  // ============================================================
  // members__get
  // ============================================================
  server.tool(
    "members__get",
    "会員 1 人の詳細を新しい会員の表から返す。member の行（呼び名・メール・ログインの番号・役・旧の番号・登録日）・名寄せの鍵（member_alias）・権利（member_entitlement）・継続課金（member_subscription）。見つからないときは ok: false, error: 'MEMBER_NOT_FOUND'。旧の契約の台帳の番号を渡したときは、新しい人の番号を手がかりとして返す。",
    {
      member_id: z.string().uuid().describe("会員の番号（新しい表 member の id）"),
    },
    async ({ member_id }) => {
      try {
        const rows = await sbGet(env, `/member?id=eq.${encodeURIComponent(member_id)}&select=${MEMBER_COLUMNS}&limit=1`);
        if (rows.length === 0) {
          const hint = await hintForUnknownId(env, member_id);
          return text({ ok: false, error: "MEMBER_NOT_FOUND", member_id, ...(hint ? { hint } : {}) });
        }
        const [aliases, entitlements, subscriptions] = await Promise.all([
          loadAliases(env, member_id),
          sbGet(
            env,
            `/member_entitlement?member_id=eq.${encodeURIComponent(member_id)}&select=key,source,reason,granted_at,expires_at&order=key.asc`
          ),
          sbGet(env, `/member_subscription?member_id=eq.${encodeURIComponent(member_id)}&select=*&order=created_at.desc`),
        ]);
        return text({ ok: true, member: rows[0], aliases, entitlements, subscriptions });
      } catch (e) {
        return fail("members__get", e);
      }
    }
  );

  // ============================================================
  // members__update
  // ============================================================
  server.tool(
    "members__update",
    "会員 1 人の呼び名と名寄せの鍵を変える（新しい表 member と member_alias）。変えられるのは name・shr_student_id・note_account・note_name・line_name・utage_common_reader_id（1 人 1 つ・null で外す）と、他サービスでの呼び名（other_names_add / other_names_remove・1 人に複数）。権利は gate__entitlement_grant / gate__entitlement_revoke を使う（ここで entitlements を渡すと断る）。preview: true で変える中身だけ返し、書かない。1 回 1 人。",
    {
      member_id: z.string().uuid().describe("会員の番号（新しい表 member の id）"),
      updates: z
        .object({
          name: z.string().min(1).optional().describe("呼び名"),
          shr_student_id: z.string().nullable().optional().describe("しあらぼの生徒番号（null で外す）"),
          note_account: z.string().nullable().optional().describe("note アカウント（null で外す）"),
          note_name: z.string().nullable().optional().describe("note の呼び名（null で外す）"),
          line_name: z.string().nullable().optional().describe("LINE の呼び名（null で外す）"),
          utage_common_reader_id: z.string().nullable().optional().describe("UTAGE の読者番号（null で外す）"),
          other_names_add: z
            .array(z.object({ value: z.string().min(1), label: z.string().optional() }))
            .optional()
            .describe("他サービスでの呼び名を足す（label はサービス名・任意）"),
          other_names_remove: z.array(z.string().min(1)).optional().describe("他サービスでの呼び名を外す（値で指定）"),
          entitlements: z.unknown().optional().describe("受け付けない。gate__entitlement_grant / revoke を使う"),
        })
        .describe("変える欄（1 つ以上）"),
      reason: z.string().min(1).describe("変える理由（実行記録 sync_run_logs に残す・空文字禁止）"),
      preview: z.boolean().optional().describe("true で書かずに変える中身だけ返す。初回は true から"),
    },
    async ({ member_id, updates, reason, preview }) => {
      try {
        if (updates.entitlements !== undefined) {
          return text({
            ok: false,
            error: "FIELD_NOT_ALLOWED",
            field: "entitlements",
            message: "権利は gate__entitlement_grant / gate__entitlement_revoke で付け外しする",
          });
        }

        const rows = await sbGet(env, `/member?id=eq.${encodeURIComponent(member_id)}&select=${MEMBER_COLUMNS}&limit=1`);
        if (rows.length === 0) {
          const hint = await hintForUnknownId(env, member_id);
          return text({ ok: false, error: "MEMBER_NOT_FOUND", member_id, ...(hint ? { hint } : {}) });
        }
        const before = rows[0];
        const beforeAliases = await loadAliases(env, member_id);

        const plan: PlanStep[] = [];
        if (updates.name !== undefined && updates.name !== before.name) {
          plan.push({ op: "set_name", value: updates.name });
        }
        for (const kind of SINGLE_KINDS) {
          const v = (updates as Record<string, unknown>)[kind] as string | null | undefined;
          if (v === undefined) continue;
          const current = beforeAliases.filter((a) => a.kind === kind).map((a) => String(a.value));
          const next = v === null ? null : v.trim();
          if (next !== null && next === "") {
            return text({ ok: false, error: "EMPTY_VALUE", field: kind, message: "外すときは null を渡す" });
          }
          if (next === null && current.length === 0) continue;
          if (next !== null && current.length === 1 && current[0] === next) continue;
          plan.push({ op: "replace_alias", kind, value: next });
        }
        for (const item of updates.other_names_add ?? []) {
          const v = item.value.trim();
          if (!v) continue;
          if (beforeAliases.some((a) => a.kind === "other_name" && a.value === v)) continue;
          plan.push({ op: "add_alias", kind: "other_name", value: v, label: item.label ?? null });
        }
        for (const raw of updates.other_names_remove ?? []) {
          const v = raw.trim();
          if (!beforeAliases.some((a) => a.kind === "other_name" && a.value === v)) continue;
          plan.push({ op: "remove_alias", kind: "other_name", value: v });
        }

        if (plan.length === 0) {
          return text({ ok: true, preview: preview === true, member_id, changed: 0, note: "変える中身が無い", before, aliases: beforeAliases });
        }
        if (preview === true) {
          return text({ ok: true, preview: true, member_id, would_change: plan, before, aliases: beforeAliases });
        }

        for (const step of plan) {
          if (step.op === "set_name") {
            await sbSend(env, "PATCH", `/member?id=eq.${encodeURIComponent(member_id)}`, {
              name: step.value,
              updated_at: new Date().toISOString(),
            });
          } else if (step.op === "replace_alias") {
            await sbSend(
              env,
              "DELETE",
              `/member_alias?member_id=eq.${encodeURIComponent(member_id)}&kind=eq.${encodeURIComponent(step.kind)}`
            );
            if (step.value !== null) {
              await sbSend(env, "POST", "/member_alias", {
                member_id,
                kind: step.kind,
                value: step.value,
                source: "mcp_manual",
              });
            }
          } else if (step.op === "add_alias") {
            await sbSend(env, "POST", "/member_alias", {
              member_id,
              kind: "other_name",
              value: step.value,
              label: step.label,
              source: "mcp_manual",
            });
          } else {
            await sbSend(
              env,
              "DELETE",
              `/member_alias?member_id=eq.${encodeURIComponent(member_id)}&kind=eq.other_name&value=eq.${encodeURIComponent(step.value)}`
            );
          }
        }

        // 実行記録（前と同じ source=mcp_manual）。書けなくても変更そのものは取り消さない
        let runLogged = true;
        try {
          await sbSend(env, "POST", "/sync_run_logs", {
            source: "mcp_manual",
            status: "success",
            finished_at: new Date().toISOString(),
            items_processed: plan.length,
            meta: { tool: "members__update", member_id, reason, changes: plan },
          });
        } catch {
          runLogged = false;
        }

        const afterRows = await sbGet(env, `/member?id=eq.${encodeURIComponent(member_id)}&select=${MEMBER_COLUMNS}&limit=1`);
        const afterAliases = await loadAliases(env, member_id);
        return text({
          ok: true,
          preview: false,
          member_id,
          changed: plan.length,
          changes: plan,
          before,
          after: afterRows[0] ?? null,
          aliases_before: beforeAliases,
          aliases_after: afterAliases,
          ...(runLogged ? {} : { warning: "sync_run_logs に記録できなかった（変更は入っている）" }),
        });
      } catch (e) {
        return fail("members__update", e);
      }
    }
  );
}
