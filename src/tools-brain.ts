/**
 * shia2n-mcp / src/tools-brain.ts / 新設（2026-11-22 v1.130.0 開発部・ブレインくん 便B・Naoki OK 08:25）
 * ブレインくん（brain.shia2n.jp）の道具 3 本。どれも読むだけ・書かない。読むのは Naoki（MCP_DEFAULT_USER_ID）の行だけ。
 *   brain__read   … ノート 1 件（本文・種類・用途・リンク・つながっているもの・意味のつながり）
 *   brain__search … メモ・キーワード・パターン・アイデア・ネタを横断して探す（種類で絞る）
 *   brain__tidy   … キーワード・パターンの整える候補（表記ゆれ・重複）。直すのは Naoki が画面で
 * AI による抜き出し・組み合わせの提案・評価はしない（Naoki の決め 11/21）。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { kindName, linksIn, plainText, searchBrain, tidyCandidates, normName, type BrNote, type BrRel } from "./brain-core.js";

const APP = "https://brain.shia2n.jp";
const COLS = "id,kind,use_id,title,folder,status,lines,aliases,daily,touched_at,created_at";

async function get<T>(env: Env, path: string): Promise<T> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.MCP_DEFAULT_USER_ID) throw new Error("設定がありません（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / MCP_DEFAULT_USER_ID）");
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY);
  const res = await fetch(env.SUPABASE_URL + "/rest/v1/" + path, { headers: { apikey: key, ...(/^eyJ/.test(key) ? { Authorization: "Bearer " + key } : {}), Accept: "application/json" } });
  if (!res.ok) throw new Error("ブレインくんの表を読めませんでした（" + res.status + "）：" + path.split("?")[0]);
  return res.json() as Promise<T>;
}
const me = (env: Env) => "user_id=eq." + encodeURIComponent(env.MCP_DEFAULT_USER_ID);
const notesOf = (env: Env) => get<BrNote[]>(env, `br_notes?select=${COLS}&${me(env)}&order=touched_at.desc&limit=5000`);
async function usesOf(env: Env): Promise<Map<string, string>> {
  const rows = await get<{ data: { uses?: { id: string; n: string }[] } }[]>(env, `br_settings?select=data&${me(env)}&limit=1`).catch(() => []);
  const list = rows[0]?.data?.uses ?? [{ id: "u1", n: "言葉" }, { id: "u2", n: "主張・事実" }, { id: "u3", n: "スタイル" }];
  return new Map(list.map(u => [u.id, u.n]));
}
const KIND = z.enum(["memo", "kw", "pt", "idea", "neta"]);

export function registerBrainTools(server: McpServer, env: Env): void {
  server.tool(
    "brain__read",
    "ブレインくんのノートを 1 件読む。読むだけ。id か title（題が同じもの・無ければ題に含むもので一番新しいもの）で選ぶ。種類（メモ・キーワード・パターン・アイデア・ネタ）・キーワードの用途・フォルダ・ステータス・本文（[[ ]] は題のまま）・このノートからのリンク・このノートにつながっているもの（リンクしてきたノート）・意味のつながり（具体例・アナロジー などの意味つき）と画面の住所を返す。",
    { id: z.string().uuid().optional().describe("ノートの id"), title: z.string().min(1).optional().describe("ノートの題（id が無いとき）") },
    async args => {
      if (!args.id && !args.title) throw new Error("id か title を渡してください");
      const [notes, uses] = await Promise.all([notesOf(env), usesOf(env)]);
      const n = args.id ? notes.find(x => x.id === args.id) : notes.find(x => x.title === args.title) ?? notes.find(x => normName(x.title).includes(normName(args.title)));
      if (!n) return asMcpTextResult({ ok: false, error: "見つかりません" });
      const rels = await get<BrRel[]>(env, `br_rels?select=id,from_id,to_id,label&${me(env)}&or=(from_id.eq.${n.id},to_id.eq.${n.id})`);
      const byId = new Map(notes.map(x => [x.id, x]));
      const title = (id: string) => byId.get(id)?.title ?? "（消えたノート）";
      return asMcpTextResult({
        ok: true, id: n.id, url: `${APP}/?note=${n.id}`, kind: kindName(n.kind), use: n.use_id ? uses.get(n.use_id) ?? null : null,
        title: n.title, folder: n.folder || null, status: n.status, daily: n.daily, aliases: n.aliases,
        body: (n.lines || []).map(l => l.t).filter(Boolean).join("\n\n"), body_plain: plainText(n.lines),
        links_out: linksIn(n.lines),
        backlinks: notes.filter(o => o.id !== n.id && linksIn(o.lines).includes(n.title)).map(o => ({ id: o.id, kind: kindName(o.kind), title: o.title })),
        meanings: rels.map(r => r.from_id === n.id ? { direction: "これは →", label: r.label, other: title(r.to_id), other_id: r.to_id } : { direction: "← から", label: r.label, other: title(r.from_id), other_id: r.from_id }),
        updated_at: n.touched_at,
      });
    }
  );

  server.tool(
    "brain__search",
    "ブレインくんのメモ・キーワード・パターン・アイデア・ネタを 1 つの言葉で横断して探す。読むだけ。題とエイリアスに当たったものが上、あとは更新が新しい順。kind で種類を絞る（memo・kw キーワード・pt パターン・idea アイデア・neta ネタ）。q を省くと新しい順の一覧。当たった所の前後（snippet）と、キーワードは用途を返す。中身は brain__read で読む。",
    { q: z.string().optional().describe("探す言葉（省くと一覧）"), kind: KIND.optional().describe("種類で絞る"), limit: z.number().int().min(1).max(100).optional().describe("最大件数（既定 30）") },
    async args => {
      const [notes, uses] = await Promise.all([notesOf(env), usesOf(env)]);
      const hits = searchBrain(notes, args.q ?? "", { kind: args.kind, uses, limit: args.limit ?? 30 });
      return asMcpTextResult({ ok: true, count: hits.length, hits: hits.map(h => ({ ...h, url: `${APP}/?note=${h.id}` })) });
    }
  );

  server.tool(
    "brain__tidy",
    "ブレインくんのキーワード・パターンの「整える候補」を出す。読むだけ・直さない。重複（全角半角・空白・大小をそろえると同じ題）と表記ゆれ（片方の題がもう片方に含まれ、長さの差が 3 字以内）だけ。まとめるか・どちらを残すかは Naoki がブレインくんの画面で決める。組み合わせの提案や評価はしない。",
    { kind: z.enum(["kw", "pt"]).optional().describe("kw キーワードだけ・pt パターンだけ（省くと両方）") },
    async args => {
      const items = tidyCandidates(await notesOf(env), args.kind);
      return asMcpTextResult({ ok: true, count: items.length, items: items.map(i => ({ ...i, notes: i.notes.map(n => ({ ...n, url: `${APP}/?note=${n.id}` })) })) });
    }
  );
}
