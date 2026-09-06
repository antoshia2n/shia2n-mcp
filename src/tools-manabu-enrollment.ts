/**
 * 学ぶくんの受講の結び（mn_member_curriculums）を止める・戻す道具。
 *
 * 2026-09-06 新設。解約した人を学ぶくんから止める手を、毎回の依頼から機能 1 本へ移す。
 *
 * 人の正本は会員の表（member）の id 1 つ。ここに渡すのもその id で、
 * 中で shr_member_id を引き直して学ぶくんの結びに当てる。
 * 呼ぶ側が学ぶくん側の番号を知る必要は無い。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Env } from "./index.js";

const T_ENROLLMENT = "mn_member_curriculums";

function hdr(env: Env): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

async function getRows(env: Env, path: string): Promise<any[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { headers: hdr(env) });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as any[];
}

export function registerManabuEnrollmentTools(server: McpServer, env: Env): void {
  server.tool(
    "mn__enrollment_set",
    "学ぶくんの受講の結びを止める・戻す。会員の表の id を渡すと、その人の shr_member_id を引いて mn_member_curriculums の active を書き換える。既定は下見（preview: true）で、実際に変えるときだけ preview を false にする。呼ばれたことは audit_logs に 1 件残る（action は manabu_enrollment_set）。対象がいなかったとき（ok true の changed 0）と、引けなかったとき（ok false と符号）は別の戻り値になる。変えたあとは前と後の件数を両方返す。",
    {
      member_id: z.string().uuid().describe("会員の id（新しい member の表の id）"),
      active: z.boolean().describe("false で止める / true で戻す"),
      reason: z.string().min(1).describe("なぜ変えるか（記録に残る）"),
      preview: z.boolean().optional().describe("true で変えずに対象だけ返す（省略時 true）"),
    },
    async ({ member_id, active, reason, preview }) => {
      const isPreview = preview !== false;
      const out = (o: unknown) => ({
        content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }],
      });

      let members: any[];
      try {
        members = await getRows(
          env,
          `member?id=eq.${encodeURIComponent(member_id)}&select=id,shr_member_id`
        );
      } catch (e: any) {
        return out({ ok: false, error: "MEMBER_LOOKUP_FAILED", message: String(e?.message ?? e) });
      }
      if (members.length === 0) {
        return out({ ok: false, error: "MEMBER_NOT_FOUND", member_id });
      }
      const shrId = members[0]?.shr_member_id ?? null;
      if (!shrId) {
        return out({
          ok: false,
          error: "NO_SHR_MEMBER_ID",
          member_id,
          note: "この人には契約の台帳の番号が入っていないので、学ぶくんの結びに当てられない",
        });
      }

      const q = `${T_ENROLLMENT}?member_id=eq.${encodeURIComponent(
        shrId
      )}&select=id,member_id,curriculum_id,active`;

      let rows: any[];
      try {
        rows = await getRows(env, q);
      } catch (e: any) {
        return out({
          ok: false,
          error: "ENROLLMENT_LOOKUP_FAILED",
          message: String(e?.message ?? e),
        });
      }

      const before = {
        total: rows.length,
        active: rows.filter((r) => r.active === true).length,
      };
      const targets = rows.filter((r) => r.active !== active);

      if (targets.length === 0) {
        return out({
          ok: true,
          applied: false,
          changed: 0,
          note: "NO_TARGET_ROW",
          member_id,
          shr_member_id: shrId,
          before,
          after: before,
        });
      }

      if (isPreview) {
        return out({
          ok: true,
          preview: true,
          applied: false,
          would_change: targets,
          would_change_count: targets.length,
          member_id,
          shr_member_id: shrId,
          before,
          note: "実際に変えるときは preview を false にして同じ呼び出しをする",
        });
      }

      const changed: any[] = [];
      for (const t of targets) {
        const res = await fetch(
          `${env.SUPABASE_URL}/rest/v1/${T_ENROLLMENT}?id=eq.${encodeURIComponent(t.id)}`,
          {
            method: "PATCH",
            headers: { ...hdr(env), Prefer: "return=representation" },
            body: JSON.stringify({ active }),
          }
        );
        if (!res.ok) {
          return out({
            ok: false,
            error: "UPDATE_FAILED",
            status: res.status,
            body: (await res.text()).slice(0, 200),
            changed_so_far: changed,
            note: "途中で止まった。戻すときは changed_so_far の id を active を反対にして叩き直す",
          });
        }
        changed.push(...((await res.json()) as any[]));
      }

      let after: any[] = [];
      try {
        after = await getRows(env, q);
      } catch {
        after = [];
      }

      let audit = "skipped";
      try {
        const ares = await fetch(`${env.SUPABASE_URL}/rest/v1/audit_logs`, {
          method: "POST",
          headers: { ...hdr(env), Prefer: "return=minimal" },
          body: JSON.stringify({
            actor_uid: "mcp_mn_enrollment_set",
            action: "manabu_enrollment_set",
            target_member_id: null,
            changed_fields: {
              member_id,
              shr_member_id: shrId,
              active_to: active,
              rows_changed: changed.length,
              row_ids: changed.map((c) => c.id),
              reason,
            },
          }),
        });
        audit = ares.ok ? "ok" : `failed_${ares.status}`;
      } catch (e: any) {
        audit = `failed_${String(e?.message ?? e)}`;
      }

      return out({
        ok: true,
        applied: true,
        changed: changed.length,
        changed_rows: changed,
        member_id,
        shr_member_id: shrId,
        before,
        after: {
          total: after.length,
          active: after.filter((r) => r.active === true).length,
        },
        audit_log: audit,
        note: "戻すときは active を反対にして同じ呼び出しをする",
      });
    }
  );
}
