import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { RATIO, buildRows, jstDay, prevMonthOf, type Old } from "./notekoryaku-core.js";

/**
 * note攻略くん（note-koryaku.shia2n.jp）の「自分の記事」を、note の数字で入れ直す道具（2026-11-10 開発部・作業 72・Naoki「OK」20:55）。
 *
 * 使い方：毎月 2 日の予約が、Naoki の Chrome で note のダッシュボード（ログイン中）と公開の記事一覧を読み、全記事をこの道具へ渡す。
 *   ・記事ごとに、題・公開日・種類・全体ビュー・スキ・コメント（今日までの合計）を入れ直し、取った日の合計を snaps に足す（前の回の分は残す）
 *   ・公開日の近い前後 10 本のスキの真ん中より 1.2 倍以上の記事に、スワイプ候補の印（pick）を付ける。判定は judge の範囲だけ
 *   ・スワイプくんへは入れない（選ぶのは Naoki。画面の「スワイプくんへ」）
 * 書くのは Naoki の自分の場所の na_articles だけ（user_id で絞る）。note の記事の印 note_key で 1 本 1 行。手で足した記事（印なし）には触らない。
 */

const APP_URL = "https://note-koryaku.shia2n.jp";
const OWNER = "VrMwzeSceqWeXVQOrm8kpu4uVR33"; // Naoki の Firebase の印（秘密ではない。X攻略くん・思考整理くんの道具と同じ）

function sbHeaders(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    ...(/^eyJ/.test(String(env.SUPABASE_SERVICE_ROLE_KEY || "")) ? { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } : {}),
    "Content-Type": "application/json",
    ...extra,
  };
}

const ArtIn = z.object({
  key: z.string().regex(/^n[0-9a-z]{6,20}$/).describe("note の記事の印（住所の /n/ の後ろ）"),
  title: z.string().max(300),
  published_at: z.string().describe("公開日時（note の publishAt のまま・ISO）"),
  price: z.number().min(0).optional(),
  membership: z.boolean().optional().describe("メンシプにつながっているか（isMembershipConnected）"),
  views: z.number().min(0).nullable().optional().describe("全体ビュー（ダッシュボードの read_count・今日までの合計）"),
  likes: z.number().min(0).nullable().optional(),
  comments: z.number().min(0).nullable().optional(),
});

export function registerNotekoryakuTools(server: McpServer, env: Env): void {
  server.tool(
    "notekoryaku__put_articles",
    "note攻略くんの「自分の記事」を、シアニンの note の数字で入れ直す（毎月 2 日の予約が Naoki の Chrome で読んだ全記事を渡す）。記事ごとに題・公開日・種類（値段あり＝有料・メンシプにつながる＝メンシプ・ほか無料）・全体ビュー・スキ・コメント（今日までの合計）を入れ、取った日の合計を残す。公開日の近い前後 10 本のスキの真ん中より 1.2 倍以上の記事にスワイプ候補の印を付ける（judge の範囲だけ判定し直す。Naoki が入れた・見送ったものは残す）。スワイプくんへは入れない。数字は note から取った値だけ（推して埋めない）。dry_run で書かずに結果だけ。戻り値: { ok, 取った日, 判定した範囲, 記事, 新しく足した, 候補: [{ 公開日, 題, スキ, 近い10本, 倍率, 状態 }], 住所 }。",
    {
      articles: z.array(ArtIn).min(1).max(1000).describe("全記事（下書きは入れない）。一部だけ渡すと、近い 10 本の比べが狂うので全部渡す"),
      taken_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("取った日（日本時間）。省略で今日"),
      judge: z.string().regex(/^(all|\d{4}-\d{2})$/).optional().describe("候補を判定し直す範囲。all＝全部（初回）・YYYY-MM＝その月の公開分。省略で取った日の前の月"),
      dry_run: z.boolean().optional(),
    },
    async ({ articles, taken_on, judge, dry_run }) => {
      try {
        const day = taken_on ?? jstDay(new Date().toISOString());
        const range = judge ?? prevMonthOf(day);
        const keys = new Set<string>();
        for (const a of articles) { if (keys.has(a.key)) return asMcpTextResult({ ok: false, message: `同じ記事が 2 回あります：${a.key}` }); keys.add(a.key); }
        if (articles.some(a => !Number.isFinite(Date.parse(a.published_at)))) return asMcpTextResult({ ok: false, message: "公開日時が読めない記事があります" });
        const own = `user_id=eq.${encodeURIComponent(OWNER)}`;
        const r0 = await fetch(`${env.SUPABASE_URL}/rest/v1/na_articles?select=note_key,snaps,pick,sort&${own}&note_key=not.is.null`, { headers: sbHeaders(env) });
        if (!r0.ok) {
          const t = await r0.text();
          if (/note_key|snaps|pick/.test(t)) return asMcpTextResult({ ok: false, message: "na_articles に note_key・snaps・pick の列がまだありません（作業 72 の SQL を流してから）" });
          return asMcpTextResult({ ok: false, message: `Supabase error ${r0.status}: ${t}` });
        }
        const olds = (await r0.json()) as Old[];
        const { rows, added } = buildRows(OWNER, articles, olds, day, range);
        const cands = rows.filter(r => r.pick).sort((p, q) => (q.pick!.r - p.pick!.r)).map(r => ({
          公開日: r.published_on, 題: r.title, スキ: r.likes, 近い10本: r.pick!.base, 倍率: r.pick!.r, 状態: ({ new: "まだ見ていない", sent: "スワイプくんへ入れた", skip: "見送った" } as const)[r.pick!.st],
        }));
        if (!dry_run) {
          const res = await fetch(`${env.SUPABASE_URL}/rest/v1/na_articles?on_conflict=user_id,note_key`, {
            method: "POST", headers: sbHeaders(env, { Prefer: "resolution=merge-duplicates,return=minimal" }), body: JSON.stringify(rows),
          });
          if (!res.ok) return asMcpTextResult({ ok: false, message: `書けませんでした（Supabase ${res.status}: ${(await res.text()).slice(0, 300)}）` });
        }
        return asMcpTextResult({
          ok: true, ...(dry_run ? { 下見: "書いていない" } : {}), 取った日: day, 判定した範囲: range === "all" ? "全部" : `${range} の公開分`, 基準: `近い 10 本のスキの真ん中の ${RATIO} 倍以上`,
          記事: rows.length, 新しく足した: added, 候補の数: cands.length, まだ見ていない候補: cands.filter(c => c.状態 === "まだ見ていない").length, 候補: cands, 住所: `${APP_URL}（レポート › スワイプ候補）`,
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );
}
