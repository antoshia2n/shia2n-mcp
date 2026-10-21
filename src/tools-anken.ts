import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";

/**
 * 案件くん（anken.shia2n.jp・クライアント案件の LINE・議事録・やることを 1 か所で見る）の道具。
 * Supabase の ak_ の表を直接見る（思考整理くんの道具と同じ形）。命名規約：anken__<action>
 *
 * 2026-10-21 新設（開発部・案件くん 1便目の段 5「AI 連動」）。
 *   ・読む：案件の一覧・案件のホーム（要約・状態・やること・決定・次の MTG）・記録の検索
 *   ・書く：候補箱に入れるだけ（anken__add_candidates）。入れたものは origin = "mcp"・status = "candidate"。
 *     TaskMaster へ入れるか外すかは、Naoki が案件くんの画面で決める（haAku と同じ「AI が書く → Naoki が承認」の流れ）
 *   ・Naoki が決めたもの（登録・済み・外した）や、AI が拾ったものの中身は書き換えない
 *   ・読むのは Naoki の行だけ（user_id で絞る。画面に入れるのも Naoki の 1 人だけ）
 */

type Row = Record<string, any>;
/** 案件くんに入れる 1 人（画面の wrangler.jsonc の ANKEN_ALLOW_UID と同じ値。秘密ではない） */
const OWNER_UID = "VrMwzeSceqWeXVQOrm8kpu4uVR33";
const APP_URL = "https://anken.shia2n.jp";
const own = `user_id=eq.${OWNER_UID}`;
const KIND: Record<string, string> = { report: "報告がまだ", do: "やる", ask: "確かめる", wait: "相手待ち", later: "あとで", decision: "決定" };
const STATUS: Record<string, string> = { candidate: "候補箱", open: "登録済み", done: "済み", dismissed: "外した" };
const STL: Record<string, string> = { g: "順調", y: "注意", r: "遅れ" };

function sbHeaders(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    ...(/^eyJ/.test(String(env.SUPABASE_SERVICE_ROLE_KEY || "")) ? { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } : {}),
    "Content-Type": "application/json",
    ...extra,
  };
}
async function sbGet(env: Env, path: string): Promise<Row[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, { headers: sbHeaders(env) });
  if (!res.ok) throw new Error(`Supabase error ${res.status}: ${await res.text()}`);
  return (await res.json()) as Row[];
}
async function sbPost(env: Env, path: string, rows: Row[], prefer: string): Promise<Row[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method: "POST", headers: sbHeaders(env, { Prefer: prefer }), body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase error ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? (JSON.parse(t) as Row[]) : [];
}
const enc = encodeURIComponent;

async function findCase(env: Env, nameOrId: string): Promise<Row | null> {
  const all = await sbGet(env, `/ak_cases?select=*&${own}&order=sort.asc`);
  const q = nameOrId.trim();
  return all.find((c) => c.id === q) ?? all.find((c) => c.name === q) ?? all.find((c) => String(c.name).includes(q) || q.includes(String(c.name))) ?? null;
}
const notFound = async (env: Env, q: string) => {
  const all = await sbGet(env, `/ak_cases?select=name&${own}`);
  return asMcpTextResult({ ok: false, message: `案件「${q}」が見つかりません`, 案件: all.map((c) => c.name) });
};
const srcLine = (s: Row) => `${s.day ?? ""} ${s.time ?? ""} ${s.chat ?? ""} ${s.who ?? ""}「${s.quote ?? ""}」`.replace(/\s+/g, " ").trim();
const ACTIVE = new Set(["candidate", "open"]);

async function sha1(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

export function registerAnkenTools(server: McpServer, env: Env): void {

  // ─── 1. anken__list_cases ────────────────────────────────────────
  server.tool(
    "anken__list_cases",
    "案件くんの案件の一覧と、それぞれの状態・今週の要約・やることの数（報告がまだ・やる・確かめる・相手待ち・候補箱）を返す。戻り値: { ok, 一覧: [{ id, 名前, 状態, 今週, 数, 次のMTG, 住所 }] }。1 件の中身は anken__get_home。",
    {},
    async () => {
      try {
        const [cases, items] = await Promise.all([
          sbGet(env, `/ak_cases?select=*&${own}&order=sort.asc`),
          sbGet(env, `/ak_items?select=case_id,kind,status&${own}&status=in.(candidate,open)`),
        ]);
        return asMcpTextResult({
          ok: true,
          一覧: cases.map((c) => {
            const its = items.filter((i) => i.case_id === c.id && i.kind !== "decision");
            const n = (k: string) => its.filter((i) => i.kind === k).length;
            return {
              id: c.id, 名前: c.name, 状態: STL[c.state] ?? c.state, 今週: c.week ?? "", 注意: c.alert ?? "",
              数: { 報告がまだ: n("report"), やる: n("do"), 確かめる: n("ask"), 相手待ち: n("wait"), あとで: n("later"), 候補箱: its.filter((i) => i.status === "candidate").length },
              次のMTG: c.mtg?.when ?? "", 住所: `${APP_URL}/c/${c.id}`,
            };
          }),
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 2. anken__get_home ──────────────────────────────────────────
  server.tool(
    "anken__get_home",
    "案件くんの案件 1 件のホームを返す：今週の要約・状態・注意・次の MTG の事前メモ・プロジェクト・やること（報告がまだ → やる → 確かめる → 相手待ち → あとで の順。候補箱か登録済みか・期限・AI の見立て・根拠の発言）・最近の決定・入っている記録。kind で 1 種類だけに絞れる。include_closed: true で済み・外したもの（外した理由つき）も出す。戻り値: { ok, 案件, 状態, 今週, 注意, 次のMTG, プロジェクト, やること, 決定, 記録 }。",
    {
      case: z.string().min(1).max(80).describe("案件の名前か id（例: るーみん）"),
      kind: z.enum(["report", "do", "ask", "wait", "later"]).optional().describe("この種類だけ（report=報告がまだ・do=やる・ask=確かめる・wait=相手待ち・later=あとで）"),
      include_closed: z.boolean().optional().describe("済み・外したものも出す"),
    },
    async ({ case: q, kind, include_closed }) => {
      try {
        const c = await findCase(env, q);
        if (!c) return notFound(env, q);
        const [projects, items, sources, last] = await Promise.all([
          sbGet(env, `/ak_projects?select=id,name,state,next,recent&case_id=eq.${enc(c.id)}&${own}&order=sort.asc`),
          sbGet(env, `/ak_items?select=id,kind,title,status,due,note,reason,src,origin,project_id,tm_task_id,created_at&case_id=eq.${enc(c.id)}&${own}`),
          sbGet(env, `/ak_sources?select=name,kind,last_import_at&case_id=eq.${enc(c.id)}&${own}`),
          sbGet(env, `/ak_msgs?select=day&case_id=eq.${enc(c.id)}&${own}&order=day.desc&limit=1`),
        ]);
        const pName = new Map(projects.map((p) => [p.id, p.name]));
        const order: Record<string, number> = { report: 0, do: 1, ask: 2, wait: 3, later: 4 };
        const todo = items.filter((i) => i.kind !== "decision" && (include_closed || ACTIVE.has(i.status)) && (!kind || i.kind === kind))
          .sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || String(a.due ?? "9").localeCompare(String(b.due ?? "9")));
        return asMcpTextResult({
          ok: true, 案件: c.name, 住所: `${APP_URL}/c/${c.id}`, 状態: STL[c.state] ?? c.state, 今週: c.week ?? "", 注意: c.alert ?? "",
          最後のやりとり: last[0]?.day ?? null,
          次のMTG: c.mtg ?? {},
          プロジェクト: projects.map((p) => ({ 名前: p.name, 状態: STL[p.state] ?? p.state, 次の一手: p.next, 直近: p.recent })),
          やること: todo.map((i) => ({
            id: i.id, 種類: KIND[i.kind] ?? i.kind, 置き場: STATUS[i.status] ?? i.status, 名前: i.title, 期限: i.due,
            プロジェクト: pName.get(i.project_id) ?? "", 見立て: i.note ?? "", ...(i.reason ? { 外した理由: i.reason } : {}),
            根拠: (i.src || []).map(srcLine), 出どころ: i.origin === "mcp" ? "Claude" : "AI の拾い", TaskMaster: !!i.tm_task_id,
          })),
          決定: items.filter((i) => i.kind === "decision" && i.status !== "dismissed").slice(0, 12).map((i) => ({ 名前: i.title, 根拠: (i.src || []).map(srcLine)[0] ?? "" })),
          記録: sources.map((s) => ({ 名前: s.name, 種類: s.kind === "minutes" ? "議事録" : "LINE", 最後の取り込み: s.last_import_at })),
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 3. anken__search ────────────────────────────────────────────
  server.tool(
    "anken__search",
    "案件くんの記録（LINE の発言・議事録・日ごとの要約）を言葉で探す。day を渡すと、その日の発言を全部（時刻順）返す。戻り値: { ok, 案件, 要約に当たったもの: [{ 日, 要約 }], 発言: [{ 日, 時刻, チャット, 発言者, 本文 }] }。本文は 600 字で切る。ID・パスワードらしき値は保存のときに伏せてある。",
    {
      case: z.string().min(1).max(80).describe("案件の名前か id"),
      query: z.string().max(100).optional().describe("探す言葉（本文と発言者に含まれるもの）"),
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("この日の発言を全部（YYYY-MM-DD）"),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("この日から"),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("この日まで"),
      limit: z.number().int().min(1).max(200).optional().describe("発言を何件まで（省略時 60）"),
    },
    async ({ case: q, query, day, from, to, limit }) => {
      try {
        const c = await findCase(env, q);
        if (!c) return notFound(env, q);
        if (!query && !day) return asMcpTextResult({ ok: false, message: "query か day のどちらかを渡してください" });
        const sources = await sbGet(env, `/ak_sources?select=id,name&case_id=eq.${enc(c.id)}&${own}`);
        const sName = new Map(sources.map((s) => [s.id, s.name]));
        let path = `/ak_msgs?select=day,at_time,who,body,source_id&case_id=eq.${enc(c.id)}&${own}`;
        if (day) path += `&day=eq.${day}&order=at_time.asc.nullsfirst,id.asc&limit=${limit ?? 400}`;
        else {
          const w = String(query).replace(/[,()*]/g, " ").trim();
          path += `&or=${enc(`(body.ilike.*${w}*,who.ilike.*${w}*)`)}&order=day.desc,at_time.desc&limit=${limit ?? 60}`;
          if (from) path += `&day=gte.${from}`;
          if (to) path += `&day=lte.${to}`;
        }
        const [msgs, days] = await Promise.all([
          sbGet(env, path),
          query ? sbGet(env, `/ak_days?select=day,summary&case_id=eq.${enc(c.id)}&${own}&summary=ilike.${enc(`*${String(query).replace(/[,()*]/g, " ").trim()}*`)}&order=day.desc&limit=30`)
            : sbGet(env, `/ak_days?select=day,summary&case_id=eq.${enc(c.id)}&${own}&day=eq.${day}`),
        ]);
        return asMcpTextResult({
          ok: true, 案件: c.name,
          要約に当たったもの: days.map((d) => ({ 日: d.day, 要約: d.summary })),
          件数: msgs.length,
          発言: msgs.map((m) => ({ 日: m.day, 時刻: m.at_time, チャット: sName.get(m.source_id) ?? "", 発言者: m.who, 本文: String(m.body).length > 600 ? String(m.body).slice(0, 600) + "…" : m.body })),
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 4. anken__add_candidates ────────────────────────────────────
  server.tool(
    "anken__add_candidates",
    "案件くんの候補箱に、やることを足す（書く道具はこれだけ）。足したものは「Claude から」の印が付き、Naoki が画面で TaskMaster へ入れるか、理由を付けて外す。同じ名前のものが同じ案件の候補箱か登録済みにあれば足さない。kind：report=報告がまだ・do=やる・ask=確かめる・wait=相手待ち・later=あとで。根拠（evidence）には、元になった発言や議事録の言葉をそのまま書く（言い換えない）。戻り値: { ok, 足した数, 足したもの, 足さなかったもの: [{ 名前, 理由 }], 住所 }。",
    {
      case: z.string().min(1).max(80).describe("案件の名前か id"),
      items: z.array(z.object({
        kind: z.enum(["report", "do", "ask", "wait", "later"]),
        title: z.string().min(1).max(120).describe("やることの名前（動詞で終える）"),
        due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("期限 YYYY-MM-DD"),
        project: z.string().max(60).optional().describe("束ねるプロジェクトの名前（案件くんにある名前。無ければ空のまま）"),
        note: z.string().max(300).optional().describe("なぜこの分けか・どこから来たか 1 文"),
        evidence: z.string().max(300).optional().describe("根拠の言葉（原文のまま）"),
        evidence_from: z.string().max(80).optional().describe("根拠の出どころ（例: 10/22 定例の議事録・Claude のチャット）"),
      })).min(1).max(30),
    },
    async ({ case: q, items }) => {
      try {
        const c = await findCase(env, q);
        if (!c) return notFound(env, q);
        const [projects, existing] = await Promise.all([
          sbGet(env, `/ak_projects?select=id,name&case_id=eq.${enc(c.id)}&${own}`),
          sbGet(env, `/ak_items?select=title,status,fp&case_id=eq.${enc(c.id)}&${own}`),
        ]);
        const pId = new Map(projects.map((p) => [p.name, p.id]));
        const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
        const have = new Set(existing.filter((i) => ACTIVE.has(i.status)).map((i) => norm(i.title)));
        const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
        const rows: Row[] = [];
        const skipped: Row[] = [];
        for (const it of items) {
          if (have.has(norm(it.title))) { skipped.push({ 名前: it.title, 理由: "同じ名前が候補箱か登録済みにある" }); continue; }
          have.add(norm(it.title));
          rows.push({
            user_id: OWNER_UID, case_id: c.id, kind: it.kind, title: it.title, due: it.due ?? null,
            project_id: it.project ? pId.get(it.project) ?? null : null, note: it.note ?? null,
            src: it.evidence ? [{ day: today, time: "", chat: it.evidence_from ?? "Claude", who: "", quote: it.evidence }] : [],
            status: "candidate", origin: "mcp", fp: `x:${await sha1(`${c.id}|${norm(it.title)}`)}`,
          });
        }
        const saved = rows.length ? await sbPost(env, `/ak_items?on_conflict=case_id,fp`, rows, "resolution=ignore-duplicates,return=representation") : [];
        return asMcpTextResult({
          ok: true, 案件: c.name, 足した数: saved.length,
          足したもの: saved.map((r) => ({ 種類: KIND[r.kind], 名前: r.title, 期限: r.due })),
          足さなかったもの: skipped.concat(rows.filter((r) => !saved.some((s) => s.fp === r.fp)).map((r) => ({ 名前: r.title, 理由: "前に同じものを入れて外されている" }))),
          住所: `${APP_URL}/cands`,
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );
}
