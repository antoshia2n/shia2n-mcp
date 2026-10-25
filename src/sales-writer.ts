/**
 * shia2n-mcp / src/sales-writer.ts / 新設（2026-10-25 v1.44.0 開発部・決済受け口 便 1）
 *
 * B（マーケくん・utage-alt-demo）が、定期の課金が通った月を売上管理（sales-manager）で入金済みにする口 SalesWriter。
 * 依頼：https://app.notion.com/p/4049c6c1c439812595c5d1f0975e6dcb
 *
 * 外（インターネット）からは呼べない。同じ Cloudflare のアカウントの Worker が「サービスの結び」で
 * 名前 SalesWriter を指したときだけ呼べる（TaskmasterReader・UtageReader と同じ形）。
 * B の wrangler.jsonc の services に
 *   { "binding": "SALES", "service": "shia2n-mcp", "entrypoint": "SalesWriter" }
 * を書くと、B から env.SALES.markPaid({ contract_id, year_month, paid_date, actual_amount }) で呼べる。
 *
 * 書き方は持たない：道具 sales_manager__mark_paid と同じ sales-manager の入口 POST /api/sm-mark-paid を呼ぶだけ
 * （同じ判定を 2 か所に置かない）。合言葉は shia2n-mcp がすでに持っている SALES_MANAGER_INTERNAL_SECRET と
 * Cloudflare Access の合言葉なので、B に鍵を増やさない。
 * 断られた（入金済み・見つからない・2 行以上）ときも投げずに { ok: false, status, error, body } で返す。
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./index.js";
import { cfAccessHeaders } from "./cf-access.js";
import { checkMarkArgs } from "./sales-writer-core.js";

export class SalesWriter extends WorkerEntrypoint<Env> {
  async markPaid(input: unknown): Promise<object> {
    const c = checkMarkArgs(input);
    if (!c.ok) return { ok: false, error: c.error };
    const secret = this.env.SALES_MANAGER_INTERNAL_SECRET;
    if (!secret) return { ok: false, error: "no_secret" };
    const base = this.env.SALES_MANAGER_API_BASE ?? "https://sales-manager.shia2n.jp";
    try {
      const res = await fetch(`${base}/api/sm-mark-paid`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}`, ...cfAccessHeaders(this.env) },
        body: JSON.stringify(c.args),
      });
      const text = await res.text();
      let body: unknown = null;
      try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
      if (!res.ok) {
        const o = (body && typeof body === "object" ? body : {}) as { error?: string; reason?: string };
        // error は sales-manager の印そのまま（already_paid・not_found・ambiguous・bad_request・unauthorized）
        return { ok: false, status: res.status, error: String(o.error || `status_${res.status}`).slice(0, 80), reason: o.reason ? String(o.reason).slice(0, 200) : undefined, body };
      }
      return { ok: true, status: res.status, body };
    } catch (e) {
      return { ok: false, error: "fetch_failed", detail: String((e as Error)?.message || e).slice(0, 200) };
    }
  }
}
