/**
 * shia2n-mcp / src/tools-brain.ts / 新設（2026-11-22 v1.130.0 開発部・ブレインくん 便B・Naoki OK 08:25）
 * ブレインくん（brain.shia2n.jp）の道具 3 本。どれも読むだけ・書かない。読むのは Naoki（MCP_DEFAULT_USER_ID）の行だけ。
 *   brain__read   … ノート 1 件（本文・種類・用途・リンク・つながっているもの・意味のつながり）
 *   brain__search … メモ・キーワード・パターン・アイデア・ネタを横断して探す（種類で絞る）
 *   brain__tidy   … キーワード・パターンの整える候補（表記ゆれ・重複）。直すのは Naoki が画面で
 * AI による抜き出し・組み合わせの提案・評価はしない（Naoki の決め 11/21）。
 * v1.152.0（2026-11-27 Naoki OK 12:57）：上の決めを「候補を出すだけで、決めるのは Naoki」に置き換え、書く道具を 2 本足した。
 *   brain__suggest    … Claude がノートを読んで出したキーワード・パターン・タスクの候補を「AI の候補」（br_ai）に入れる。ノートは作らない
 *   brain__send_tasks … Naoki が画面で「TaskMaster へ入れる」を押したタスクを TaskMaster へ送り、送った印を付ける
 *   作らない：押さずに勝手に入る仕組み・アイデアやネタの自動作成・点数づけ
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { kindName, linksIn, plainText, searchBrain, tidyCandidates, normName, planSuggestions, type BrNote, type BrRel, type AiRow } from "./brain-core.js";
import { handleTaskmasterAddTask } from "./taskmaster.js";

const APP = "https://brain.shia2n.jp";
const COLS = "id,kind,use_id,title,folder,status,lines,aliases,daily,touched_at,created_at";

async function get<T>(env: Env, path: string): Promise<T> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.MCP_DEFAULT_USER_ID) throw new Error("設定がありません（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / MCP_DEFAULT_USER_ID）");
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY);
  const res = await fetch(env.SUPABASE_URL + "/rest/v1/" + path, { headers: { apikey: key, ...(/^eyJ/.test(key) ? { Authorization: "Bearer " + key } : {}), Accept: "application/json" } });
  if (!res.ok) throw new Error("ブレインくんの表を読めませんでした（" + res.status + "）：" + path.split("?")[0]);
  return res.json() as Promise<T>;
}
async function write(env: Env, method: "POST" | "PATCH", path: string, body: unknown): Promise<unknown> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.MCP_DEFAULT_USER_ID) throw new Error("設定がありません（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / MCP_DEFAULT_USER_ID）");
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY);
  const res = await fetch(env.SUPABASE_URL + "/rest/v1/" + path, { method, headers: { apikey: key, ...(/^eyJ/.test(key) ? { Authorization: "Bearer " + key } : {}), "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error("ブレインくんの表に書けませんでした（" + res.status + "）：" + (await res.text().catch(() => "")).slice(0, 160));
  return res.json();
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

  server.tool(
    "brain__suggest",
    "ブレインくんの「AI の候補」（右パネル）に、キーワード・パターン・タスクの候補を入れる。ノートやタスクは作らない（Naoki が画面で「入れる／捨てる」を押して決める）。先に brain__search・brain__read でノート（特にデイリーノート）を読み、本文に書いてあることから拾う。書いていないことを足さない・アイデアやネタは作らない。1 件ごとに note_id（元のノート）・kind（kw キーワード=具体の言葉・主張・事実・スタイル／pt パターン=抽象の型／task やること）・title（短く）・why（根拠になる本文の 1 行をそのまま）を渡す。キーワードは use に用途の名前（言葉・主張・事実 など・設定の名前）。候補箱に同じ種類で同じ題がある（捨てたものも含む）・同じ題のノートがもうあるものは入れずに理由を返す。戻り値: { ok, added, skipped:[{title,reason}], url }",
    {
      items: z.array(z.object({
        note_id: z.string().uuid().optional().describe("元のノートの id"),
        kind: z.enum(["kw", "pt", "task"]).describe("kw キーワード・pt パターン・task タスク"),
        title: z.string().min(1).max(200).describe("候補の題"),
        use: z.string().max(40).optional().describe("キーワードの用途の名前"),
        why: z.string().max(500).optional().describe("根拠になる本文の 1 行"),
      })).min(1).max(50).describe("候補（1〜50 件）"),
    },
    async args => {
      const [notes, uses, have] = await Promise.all([notesOf(env), usesOf(env), get<AiRow[]>(env, `br_ai?select=kind,title,state&${me(env)}&limit=5000`)]);
      const { add, skipped } = planSuggestions(args.items, have, notes, uses);
      if (add.length) await write(env, "POST", "br_ai", add.map(r => ({ ...r, user_id: env.MCP_DEFAULT_USER_ID })));
      return asMcpTextResult({ ok: true, added: add.length, skipped, url: APP + "/" });
    }
  );

  server.tool(
    "brain__send_tasks",
    "ブレインくんの「AI の候補」で Naoki が「TaskMaster へ入れる」を押したタスク（送る待ち）を TaskMaster へ送り、送った印を付ける。押していない候補は送らない。タスクには元のノートへのリンクが付く。project_id を渡すとその TaskMaster のプロジェクトへ（省くとプロジェクトなし）。戻り値: { ok, sent:[{title,task_id,url}], failed:[{title,error}] }",
    { project_id: z.string().max(120).optional().describe("TaskMaster のプロジェクトの id（taskmaster__list_tasks などで分かるもの）") },
    async args => {
      const rows = await get<{ id: string; title: string; note_id: string | null }[]>(env, `br_ai?select=id,title,note_id&${me(env)}&kind=eq.task&state=eq.in&order=created_at&limit=50`);
      const notes = rows.some(r => r.note_id) ? await notesOf(env) : [];
      const sent: { title: string; task_id: string; url: string }[] = []; const failed: { title: string; error: string }[] = [];
      for (const r of rows) {
        const src = r.note_id ? notes.find(n => n.id === r.note_id) : undefined;
        const res = await handleTaskmasterAddTask(new Request("https://internal/taskmaster/tasks/add", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: r.title, projectId: args.project_id || null, ...(src ? { links: [{ title: "ブレインくん：" + (src.title || "ノート"), url: `${APP}/?note=${src.id}` }] } : {}) }),
        }), env);
        const body = (await res.json().catch(() => ({}))) as { task?: { id?: string }; error?: string };
        if (!res.ok || !body.task?.id) { failed.push({ title: r.title, error: String(body.error || `status_${res.status}`).slice(0, 120) }); continue; }
        await write(env, "PATCH", `br_ai?id=eq.${r.id}&${me(env)}`, { state: "sent", made_id: body.task.id, updated_at: new Date().toISOString() });
        sent.push({ title: r.title, task_id: body.task.id, url: `https://taskmaster.shia2n.jp/?task=${encodeURIComponent(body.task.id)}` });
      }
      return asMcpTextResult({ ok: failed.length === 0, sent, failed });
    }
  );
}
