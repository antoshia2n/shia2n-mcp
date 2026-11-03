import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { getFirestoreToken, fsGet, fromVal, type FVal } from "./taskmaster.js";
import { memberHints, pickMembers } from "./note-counts-core.js";

/**
 * note の数字（シアニンの note のフォロワー数とメンシプ人数）を日ごとに残して返す（2026-11-03 開発部・コンテンツ担当の申し送り 4・Naoki「OK」18:26）。
 *
 * 取り方：note がログインなしで出している中身のデータ https://note.com/api/v2/creators/{urlname} を読む。
 *   フォロワー数は followerCount。メンシプ人数は、公開されていれば名前に member / circle を含む数の欄から拾う（拾えなければ null）。
 *   拾った欄の名前は「見つけた欄」に残す（あとで決め打ちするため）。
 * 置き場：保管庫（BACKUP_BUCKET）の note-counts/YYYY-MM-DD.json（日本時間の日付・1 日 1 つ・同じ日は上書き）。データベースの表は足さない。
 * メンシプ人数が note から取れない日は、haAku の KPI「メンシプ在籍数」のその日の値（Naoki が入れる）を、出どころつきで返す。
 * 毎朝 JST 07:30（UTC 22:30）に 1 回取る（index.ts の scheduled・記録は cron-log の note_counts）。
 */

export const NOTE_URLNAME = "shia2n";
const KEY = (d: string) => `note-counts/${d}.json`;
const MEM_KPI_TITLE = "メンシプ在籍数";

export type NoteSnap = { date: string; at: string; urlname: string; followers: number | null; members: number | null; found: Record<string, number> };

const jstDate = (t = Date.now()) => new Date(t + 9 * 3600 * 1000).toISOString().slice(0, 10);

export async function fetchNoteSnap(urlname = NOTE_URLNAME, now = Date.now()): Promise<NoteSnap> {
  const res = await fetch(`https://note.com/api/v2/creators/${encodeURIComponent(urlname)}`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; shia2n-mcp/1.0)", Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`note が ${res.status} を返しました`);
  const data = (await res.json() as any)?.data ?? {};
  const f = data.followerCount ?? data.followersCount ?? data.follower_count;
  const found = memberHints(data);
  return { date: jstDate(now), at: new Date(now).toISOString(), urlname, followers: typeof f === "number" ? f : null, members: pickMembers(found), found };
}

/** 取って保管庫に残す（毎朝の処理と、道具の refresh から） */
export async function recordNoteSnap(env: Env): Promise<{ count: number; detail: string }> {
  const s = await fetchNoteSnap();
  if (s.followers == null) throw new Error("note のフォロワー数が返りませんでした（中身のデータの形が変わったかもしれません）");
  await env.BACKUP_BUCKET.put(KEY(s.date), JSON.stringify(s), { httpMetadata: { contentType: "application/json" } });
  return { count: s.followers, detail: `${s.date} フォロワー ${s.followers}・メンシプ ${s.members ?? "note からは取れず"}` };
}

/** haAku の「メンシプ在籍数」の日ごとの値（年をまたぐ期間にも対応） */
async function haakuMembers(env: Env, from: string, to: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const uid = env.NAOKI_UID;
  if (!uid || !env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) return out;
  const token = await getFirestoreToken(env);
  const read = async (key: string) => {
    try { const d = await fsGet(token, `users/${uid}/app_data/${key}`); const v = d.fields?.value; return v ? fromVal(v as FVal) : null; } catch { return null; }
  };
  const kpis = await read("os_kpis");
  const kpi = Array.isArray(kpis) ? (kpis as any[]).find((k) => String(k?.title || "").trim() === MEM_KPI_TITLE) : null;
  if (!kpi?.id) return out;
  for (let y = +from.slice(0, 4); y <= +to.slice(0, 4); y++) {
    const daily = await read(`os_daily_${y}`);
    if (!daily || typeof daily !== "object") continue;
    for (const [d, rec] of Object.entries(daily as Record<string, any>)) {
      const v = rec?.kpiValues?.[kpi.id];
      if (d >= from && d <= to && typeof v === "number" && Number.isFinite(v) && v !== 0) out.set(d, v);
    }
  }
  return out;
}

const datesBetween = (from: string, to: string) => {
  const out: string[] = []; let t = Date.parse(`${from}T00:00:00Z`); const end = Date.parse(`${to}T00:00:00Z`);
  while (t <= end && out.length < 400) { out.push(new Date(t).toISOString().slice(0, 10)); t += 86400000; }
  return out;
};

export function registerNoteCountTools(server: McpServer, env: Env): void {
  server.tool(
    "note__counts",
    "シアニンの note（shia2n）の、日ごとの「メンシプ人数」と「note のフォロワー数」を返す。読むだけ（refresh: true のときだけ今の数を取って今日の分を残し直す）。数は毎朝 JST 07:30 に note から取って保管庫に残す（2026-11-03 から）。メンシプ人数が note から取れない日は、haAku の KPI「メンシプ在籍数」に Naoki が入れた値を返し、出どころに haAku と書く。記録の無い日は null。期間は最大 366 日。戻り値: { ok, 期間, 日ごと: [{ 日, フォロワー, メンシプ, メンシプの出どころ, 取った時刻 }], 最新 }。",
    {
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("最初の日 YYYY-MM-DD（日本時間）。省略時は今日"),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("最後の日。省略時は from と同じ"),
      refresh: z.boolean().optional().describe("true で今の数を note から取り、今日の分を残し直す"),
    },
    async ({ from, to, refresh }) => {
      try {
        const today = jstDate();
        const a = from ?? today, b = to ?? a;
        if (b < a) return asMcpTextResult({ ok: false, message: "to は from 以後の日付にしてください" });
        const days = datesBetween(a, b);
        if (days.length > 366) return asMcpTextResult({ ok: false, message: "一度に返せるのは 366 日までです" });
        let refreshed: string | null = null;
        if (refresh) {
          try { refreshed = (await recordNoteSnap(env)).detail; } catch (e) { refreshed = `取れませんでした：${e instanceof Error ? e.message : String(e)}`; }
        }
        const mem = await haakuMembers(env, a, b).catch(() => new Map<string, number>());
        const rows = [];
        for (const d of days) {
          const obj = await env.BACKUP_BUCKET.get(KEY(d));
          const s = obj ? (JSON.parse(await obj.text()) as NoteSnap) : null;
          const m = s?.members ?? null;
          rows.push({
            日: d, フォロワー: s?.followers ?? null,
            メンシプ: m ?? mem.get(d) ?? null,
            メンシプの出どころ: m != null ? "note" : mem.has(d) ? "haAku（手入れ）" : null,
            取った時刻: s ? new Date(Date.parse(s.at) + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ") : null,
            ...(s && Object.keys(s.found || {}).length ? { 見つけた欄: s.found } : {}),
          });
        }
        const latest = [...rows].reverse().find((r) => r.フォロワー != null || r.メンシプ != null) ?? null;
        return asMcpTextResult({ ok: true, 期間: `${a}〜${b}`, ...(refresh ? { 取り直し: refreshed } : {}), 日ごと: rows, 最新: latest });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );
}
