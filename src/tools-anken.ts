import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { parseLine, parseMinutes, maskSecrets, withHashes, SELF_NAMES } from "./anken-core.js";
import { getGoogleTokenForScope } from "./google-token.js";
import { getFirestoreToken, fsGet, fromVal, queryTasks } from "./taskmaster.js";

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
 *
 * 2026-10-21 夜 追加（Naoki「API は今は使わない・取り込みとセッティングはそっちで」20:21）：
 *   アプリの AI の口（Claude API）の代わりに、Claude のチャットや予約した仕事が読んで書く道具。
 *   ・anken__setup_case：案件を作る・TaskMaster のプロジェクトとつなぐ
 *   ・anken__import_text／anken__import_doc：LINE の文・議事録（Google ドキュメント）を入れる（伏せ字・重ならない）
 *   ・anken__replace_days：読み方や伏せ字を直したあと、ある期間の発言を入れ直して読み直しに戻す（2026-10-21 夜 追加）
 *   ・anken__ai_next_days → anken__ai_record_days：まだ読んでいない日を渡す → 日ごとの要約と出来事を書く（段 1）
 *   ・anken__ai_case_context → anken__ai_update_case：出来事の一覧を渡す → 5 つの分け・プロジェクト・要約を書く（段 2）
 *   書く決まりはアプリの worker/ai.js と同じ（Naoki が決めたものは書き換えない・根拠の無いものは入れない）
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

/** やること・決定の見分け（アプリの worker/ai.js の fpOf と同じ）。議事録（1 回分が 1 発言）は該当行ごとに分ける */
async function fpOf(prefix: string, msgId: number, isMinutes: boolean, quote?: string, title?: string): Promise<string> {
  if (!isMinutes) return `${prefix}:${Number(msgId)}`;
  const key = String(quote || title || "").replace(/\s+/g, "").slice(0, 80);
  const h = (await sha1(key)).slice(0, 12);
  return `${prefix}:${Number(msgId)}:${h}`;
}


async function sbPatch(env: Env, path: string, body: Row): Promise<Row[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method: "PATCH", headers: sbHeaders(env, { Prefer: "return=representation" }), body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase error ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? (JSON.parse(t) as Row[]) : [];
}
async function sbDelete(env: Env, path: string): Promise<Row[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, { method: "DELETE", headers: sbHeaders(env, { Prefer: "return=representation" }) });
  if (!res.ok) throw new Error(`Supabase error ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? (JSON.parse(t) as Row[]) : [];
}
const todayJst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const daysBefore = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
const BODY_MAX = 1500;
const fmtMsg = (m: Row, src: string) => `[#${m.id}] ${m.at_time || "--:--"} 〈${src}〉 ${m.who || "?"}：${String(m.body).length > BODY_MAX ? String(m.body).slice(0, BODY_MAX) + "…（以下略）" : m.body}`;
const evLine = (e: Row, day: string) => `[#${e.msg_id}] ${day} ${e.type} ${e.who}：${e.text}${e.due ? `（期限 ${e.due}）` : ""}「${e.quote}」`;

/** 発言を入れる（アプリの /api/import と同じ決まり：伏せ字・同じ発言は 1 回だけ・知らせは入れない） */
async function importMessages(env: Env, c: Row, kind: "line" | "minutes", name: string, parsed: Row, url?: string): Promise<Row> {
  const msgs = (parsed.messages as Row[]).filter((m) => !m.system);
  if (!msgs.length) return { ok: false, message: "発言を 1 件も読めませんでした", 読めなかった行: (parsed.skipped || []).slice(0, 5) };
  let masked = 0;
  const clean = msgs.map((m) => { const r = maskSecrets(m.body); masked += r.count; return { ...m, body: r.text, masked: r.count > 0 }; });
  const hashed = await withHashes(clean);
  const [src] = await sbPost(env, `/ak_sources?on_conflict=case_id,kind,name`, [{
    user_id: OWNER_UID, case_id: c.id, kind, name, ...(url ? { url } : {}), last_import_at: new Date().toISOString(),
  }], "resolution=merge-duplicates,return=representation");
  let added = 0;
  for (let i = 0; i < hashed.length; i += 400) {
    const rows = hashed.slice(i, i + 400).map((m: Row) => ({
      user_id: OWNER_UID, case_id: c.id, source_id: src.id, day: m.day, at_time: m.time || null, who: m.who || null, body: m.body, masked: m.masked, hash: m.hash,
    }));
    added += (await sbPost(env, `/ak_msgs?on_conflict=source_id,hash`, rows, "resolution=ignore-duplicates,return=representation")).length;
  }
  return { ok: true, 案件: c.name, 名前: name, 読んだ: hashed.length, 新しく入れた: added, 前に入れてあった: hashed.length - added, 伏せた: masked, 期間: `${parsed.from} 〜 ${parsed.to}`, 話した人: parsed.names };
}

const DAY_RULES = `日ごとに「1 行要約（60 字以内）」と「出来事」を拾い、anken__ai_record_days に渡す。
自分＝${SELF_NAMES.join("・")}（同じ人。シアニンはこの人の発信名）。この記録は自分（コンサル側）とクライアントやその周りの人とのやりとり。
出来事の type：ask＝自分以外が自分に頼んだ・聞いた／promise＝自分がこれからやると言った／report＝自分がやったと伝えた（何についての報告かを text に）／decision＝決まったこと／wait＝自分以外がやると言った／deadline＝期限・日程だけ。
挨拶・お礼・相づち・雑談・「画像」「音声」だけの発言は拾わない。quote は原文をそのまま 80 字以内で切り出す（言い換えない）。期限は発言の日付から YYYY-MM-DD に直す（読めなければ null）。渡した日はすべて days に入れる（出来事が無い日も要約は書く）。`;

const CASE_RULES = `まだ閉じていないことを洗い出し、anken__ai_update_case に渡す。
5 つの分け（kind）：report（報告がまだ）＝自分が引き受けた・約束したことで、3 日以上たってもそのことについての report が見当たらないもの／do（やる）＝自分がやること。引き受けて 3 日未満・期限が 14 日以内・自分から言い出した提案／ask（確かめる）＝誰がやるか・何をするかが読み取れず、相手に確かめないと進めないもの／wait（相手待ち）＝相手の作業・返事を待っているもの／later（あとで）＝期限が 15 日以上先か、相手が「急がない」と言ったもの。
後の日付に同じことの report や、相手の「ありがとう・できました・届きました」がある依頼は閉じている。出さない。取り下げ・別の人に頼んだものも出さない。同じことは 1 つにまとめ、origin_msg_id は最初の依頼か約束。議事録は 1 回分が 1 つの発言なので、1 つの議事録から複数のやること・決定を出してよい（そのときは origin_quote・quote に議事録の該当行をそのまま書く）。「登録済み」「TaskMaster にあるもの」「Naoki が外したもの（理由を読む）」と同じことは出さない。note は日付と事実で 1 文。プロジェクトは 3〜8 個、既存の名前はそのまま使う。決定は直近 30 日の大事なものだけ多くて 8 つ。next_mtg は記録にあればその日時、無ければ過去の開催から推定して「（推定）」。`;

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

  // ─── 5. anken__setup_case ────────────────────────────────────────
  server.tool(
    "anken__setup_case",
    "案件くんに案件を作る（同じ名前があればそれを直す）。tm_project に TaskMaster のプロジェクトの名前か id を渡すと、画面で承認したやることがそのプロジェクトへ入るようになる。戻り値: { ok, 案件, id, TaskMaster, 住所, 作った }。",
    {
      name: z.string().min(1).max(40).describe("案件の名前（例: るーみん）"),
      tm_project: z.string().max(80).optional().describe("TaskMaster のプロジェクトの名前か id（例: 案件｜るーみん）"),
    },
    async ({ name, tm_project }) => {
      try {
        let tm: Row | null = null;
        if (tm_project) {
          const token = await getFirestoreToken(env);
          const doc = await fsGet(token, `users/${env.NAOKI_UID}/app_data/projects`);
          const list = ((doc.fields?.value ? fromVal(doc.fields.value) : []) as Row[]) || [];
          tm = list.find((p) => p?.id === tm_project) ?? list.find((p) => p?.title === tm_project) ?? null;
          if (!tm) return asMcpTextResult({ ok: false, message: `TaskMaster のプロジェクト「${tm_project}」が見つかりません`, プロジェクト: list.map((p) => p?.title).filter(Boolean) });
        }
        const all = await sbGet(env, `/ak_cases?select=*&${own}&order=sort.asc`);
        const ex = all.find((c) => c.name === name);
        const now = new Date().toISOString();
        let row: Row;
        if (ex) {
          [row] = await sbPatch(env, `/ak_cases?id=eq.${enc(ex.id)}&${own}`, { ...(tm ? { tm_project: tm.id } : {}), updated_at: now });
        } else {
          const colors = ["var(--b4)", "var(--b5)", "var(--b3)", "var(--b6)", "var(--b1)"];
          [row] = await sbPost(env, `/ak_cases`, [{ id: crypto.randomUUID(), user_id: OWNER_UID, name, tm_project: tm?.id ?? null, sort: all.length, color: colors[all.length % colors.length] }], "return=representation");
        }
        return asMcpTextResult({ ok: true, 作った: !ex, 案件: row.name, id: row.id, TaskMaster: tm?.title ?? (row.tm_project ? "つないである" : "つないでいない"), 住所: `${APP_URL}/c/${row.id}` });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 6. anken__import_text ───────────────────────────────────────
  server.tool(
    "anken__import_text",
    "案件くんに LINE の履歴（「トーク履歴を保存」の文）か議事録の文を入れる。ID・パスワードらしき値は伏せて保存し、同じ発言は 1 回だけ入る（同じ name で何度入れても重ならない）。大きなファイルは画面の取り込みか anken__import_doc を使う。戻り値: { ok, 読んだ, 新しく入れた, 前に入れてあった, 伏せた, 期間, 話した人 }。",
    {
      case: z.string().min(1).max(80).describe("案件の名前か id"),
      kind: z.enum(["line", "minutes"]).describe("line＝LINE の履歴・minutes＝議事録"),
      name: z.string().min(1).max(80).describe("チャットか議事録の名前（例: 1対1・運営グループ・議事録）"),
      text: z.string().min(1).max(200000),
      url: z.string().max(500).optional(),
    },
    async ({ case: q, kind, name, text, url }) => {
      try {
        const c = await findCase(env, q);
        if (!c) return notFound(env, q);
        const parsed = kind === "minutes" ? parseMinutes(text, { today: todayJst() }) : parseLine(text, { self: SELF_NAMES });
        return asMcpTextResult(await importMessages(env, c, kind, name, parsed, url));
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 6b. anken__replace_days ─────────────────────────────────────
  server.tool(
    "anken__replace_days",
    "案件くんの 1 つの記録（チャットか議事録）の、from〜to の日の発言を入れ直す（読み方や伏せ字を直したあとに使う）。その範囲の古い発言を消して text から読み直して入れ、その日々は AI がもう一度読む（全部の記録の、その日の発言を未読に戻し、日ごとの要約を消す）。続けて anken__ai_next_days → anken__ai_record_days → anken__ai_case_context → anken__ai_update_case を回す。戻り値: { ok, 消した, 入れた, 未読に戻した, 古い発言を根拠にしていたやること }。",
    {
      case: z.string().min(1).max(80).describe("案件の名前か id"),
      kind: z.enum(["line", "minutes"]).describe("line＝LINE の履歴・minutes＝議事録"),
      name: z.string().min(1).max(80).describe("入れ直す記録の名前（例: 1対1）。前に入れたときと同じ名前"),
      text: z.string().min(1).max(200000).describe("その範囲を含む元の文（範囲の外の日は入れない）"),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("この日から"),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("この日まで（from から 62 日以内）"),
    },
    async ({ case: q, kind, name, text, from, to }) => {
      try {
        const c = await findCase(env, q);
        if (!c) return notFound(env, q);
        if (from > to || (Date.parse(to) - Date.parse(from)) / 864e5 > 62) return asMcpTextResult({ ok: false, message: "from〜to は 62 日以内にしてください" });
        const [src] = await sbGet(env, `/ak_sources?select=id,name&case_id=eq.${enc(c.id)}&${own}&kind=eq.${kind}&name=eq.${enc(name)}`);
        if (!src) return asMcpTextResult({ ok: false, message: `記録「${name}」がありません。初めてなら anken__import_text で入れてください` });
        const parsed = kind === "minutes" ? parseMinutes(text, { today: todayJst() }) : parseLine(text, { self: SELF_NAMES });
        const inRange = (parsed.messages as Row[]).filter((m) => !m.system && m.day >= from && m.day <= to);
        if (!inRange.length) return asMcpTextResult({ ok: false, message: `${from}〜${to} の発言を 1 件も読めませんでした。何も消していません` });
        const range = `day=gte.${from}&day=lte.${to}`;
        const old = await sbGet(env, `/ak_msgs?select=id&case_id=eq.${enc(c.id)}&${own}&source_id=eq.${enc(src.id)}&${range}`);
        const oldIds = new Set(old.map((m) => Number(m.id)));
        await sbDelete(env, `/ak_msgs?case_id=eq.${enc(c.id)}&${own}&source_id=eq.${enc(src.id)}&${range}`);
        let masked = 0;
        const clean = inRange.map((m) => { const r = maskSecrets(m.body); masked += r.count; return { ...m, body: r.text, masked: r.count > 0 }; });
        const hashed = await withHashes(clean);
        let added = 0;
        for (let i = 0; i < hashed.length; i += 400) {
          const rows = hashed.slice(i, i + 400).map((m: Row) => ({
            user_id: OWNER_UID, case_id: c.id, source_id: src.id, day: m.day, at_time: m.time || null, who: m.who || null, body: m.body, masked: m.masked, hash: m.hash,
          }));
          added += (await sbPost(env, `/ak_msgs?on_conflict=source_id,hash`, rows, "resolution=ignore-duplicates,return=representation")).length;
        }
        const reset = await sbPatch(env, `/ak_msgs?case_id=eq.${enc(c.id)}&${own}&${range}&select=id`, { ai_at: null });
        await sbDelete(env, `/ak_days?case_id=eq.${enc(c.id)}&${own}&${range}`);
        const items = await sbGet(env, `/ak_items?select=title,status,src&case_id=eq.${enc(c.id)}&${own}`);
        const touched = items.filter((it) => (it.src || []).some((x: Row) => oldIds.has(Number(x.msg_id))));
        return asMcpTextResult({
          ok: true, 案件: c.name, 記録: name, 期間: `${from} 〜 ${to}`, 消した: old.length, 入れた: added, 伏せた: masked, 未読に戻した: reset.length,
          古い発言を根拠にしていたやること: touched.map((it) => `${STATUS[it.status] ?? it.status}：${it.title}`),
          次: `anken__ai_next_days（since: ${from}）から読み直す`,
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 7. anken__import_doc ────────────────────────────────────────
  server.tool(
    "anken__import_doc",
    "Google ドキュメントの議事録を、サーバーが直接読んで案件くんに入れる（日付の見出しごとに 1 回分）。since より前の回は入れない（既定は 90 日前から）。ドキュメントが機械用の身分に共有されていないと読めず、そのときは共有先のメールを返す。冒頭のログイン情報などは伏せて保存する。戻り値: { ok, 読んだ, 新しく入れた, 前に入れてあった, 伏せた, 期間 }。",
    {
      case: z.string().min(1).max(80).describe("案件の名前か id"),
      doc: z.string().min(5).max(300).describe("ドキュメントの住所か番号"),
      name: z.string().max(80).optional().describe("記録の名前（省略時 議事録）"),
      since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("この日より前の回は入れない（省略時 90 日前）"),
    },
    async ({ case: q, doc, name, since }) => {
      try {
        const c = await findCase(env, q);
        if (!c) return notFound(env, q);
        const id = (/\/document\/d\/([A-Za-z0-9_-]+)/.exec(doc)?.[1]) ?? doc.trim();
        const token = await getGoogleTokenForScope(env, "https://www.googleapis.com/auth/drive.readonly");
        const res = await fetch(`https://www.googleapis.com/drive/v3/files/${enc(id)}/export?mimeType=text/plain&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) {
          return asMcpTextResult({ ok: false, status: res.status, message: res.status === 404 || res.status === 403
            ? `このドキュメントは機械用の身分から読めません。ドキュメントの共有に ${env.FIREBASE_SA_EMAIL} を閲覧者で足すと読めます。`
            : `読めませんでした（${res.status}）：${(await res.text()).slice(0, 200)}` });
        }
        const text = await res.text();
        const today = todayJst();
        const from = since ?? daysBefore(today, 90);
        const parsed = parseMinutes(text, { today });
        // 日付の見出しの前の塊（冒頭のログイン情報など）は today の日付になるので入れない
        const kept = (parsed.messages as Row[]).filter((m) => m.day >= from && !(m.day === today && !/^\s*[#＃■◆●【\[]*\s*(?:\d{4}[./年-])?\d{1,2}[./月]\d{1,2}/.test(m.body)));
        const days = kept.map((m) => m.day);
        const out = await importMessages(env, c, "minutes", name || "議事録", { ...parsed, messages: kept, from: days.length ? days.reduce((a, b) => (a < b ? a : b)) : null, to: days.length ? days.reduce((a, b) => (a > b ? a : b)) : null }, `https://docs.google.com/document/d/${id}/edit`);
        return asMcpTextResult({ ...out, 全体の回数: parsed.messages.length, 入れた範囲: `${from} 以降` });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 8. anken__ai_next_days ──────────────────────────────────────
  server.tool(
    "anken__ai_next_days",
    "案件くんの AI の仕事（段 1）：まだ読んでいない日の発言を、古い順に 40,000 字ほどまとめて返す。読んだら日ごとの要約と出来事を anken__ai_record_days に渡す。残りが 0 になるまで繰り返し、0 になったら anken__ai_case_context へ。since より前の未読の日は読まずに読んだことにする（既定 60 日前）。戻り値: { ok, 決まり, 日, 発言（各行の [#番号] が msg_id）, 残りの日, 読まずに済ませた日 }。",
    {
      case: z.string().min(1).max(80).describe("案件の名前か id"),
      since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("この日より前は読まない（省略時 60 日前）"),
      max_chars: z.number().int().min(5000).max(80000).optional().describe("1 回に返す字数の目安（省略時 40000）"),
    },
    async ({ case: q, since, max_chars }) => {
      try {
        const c = await findCase(env, q);
        if (!c) return notFound(env, q);
        const from = since ?? daysBefore(todayJst(), 60);
        const old = await sbPatch(env, `/ak_msgs?case_id=eq.${enc(c.id)}&${own}&ai_at=is.null&day=lt.${from}&select=day`, { ai_at: new Date().toISOString() });
        const pending = await sbGet(env, `/ak_msgs?select=day&case_id=eq.${enc(c.id)}&${own}&ai_at=is.null&order=day.asc&limit=1000`);
        const daysLeft = [...new Set(pending.map((r) => r.day))];
        if (!daysLeft.length) return asMcpTextResult({ ok: true, 案件: c.name, 日: [], 残りの日: 0, 読まずに済ませた日: new Set(old.map((r) => r.day)).size, 次: "anken__ai_case_context を呼ぶ" });
        const sources = await sbGet(env, `/ak_sources?select=id,name&case_id=eq.${enc(c.id)}&${own}`);
        const sName = new Map(sources.map((s) => [s.id, s.name]));
        const limit = max_chars ?? 40000;
        const take: string[] = [];
        const lines: string[] = [];
        let size = 0;
        for (const d of daysLeft) {
          const rows = await sbGet(env, `/ak_msgs?select=id,at_time,who,body,source_id&case_id=eq.${enc(c.id)}&${own}&day=eq.${d}&order=at_time.asc.nullsfirst,id.asc`);
          const block = [`=== ${d} ===`, ...rows.map((m) => fmtMsg(m, sName.get(m.source_id) ?? ""))].join("\n");
          if (take.length && size + block.length > limit) break;
          take.push(d); lines.push(block); size += block.length;
          if (size > limit) break;
        }
        return asMcpTextResult({
          ok: true, 案件: c.name, 決まり: DAY_RULES, 日: take, 残りの日: daysLeft.length - take.length,
          読まずに済ませた日: new Set(old.map((r) => r.day)).size, 発言: lines.join("\n"),
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 9. anken__ai_record_days ────────────────────────────────────
  server.tool(
    "anken__ai_record_days",
    "案件くんの AI の仕事（段 1 の書き込み）：anken__ai_next_days で読んだ日の、1 行要約と出来事を書き、その日の発言を読んだことにする。msg_id がその日の発言に無い出来事は捨てる。戻り値: { ok, 書いた日, 出来事, 捨てた出来事 }。",
    {
      case: z.string().min(1).max(80).describe("案件の名前か id"),
      days: z.array(z.object({
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        summary: z.string().max(200),
        events: z.array(z.object({
          msg_id: z.number().int(),
          type: z.enum(["ask", "promise", "report", "decision", "wait", "deadline"]),
          who: z.string().max(80),
          text: z.string().max(120),
          quote: z.string().max(200),
          due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        })).max(80),
      })).min(1).max(40),
    },
    async ({ case: q, days }) => {
      try {
        const c = await findCase(env, q);
        if (!c) return notFound(env, q);
        const list = days.map((d) => d.day);
        const msgs = await sbGet(env, `/ak_msgs?select=id,day&case_id=eq.${enc(c.id)}&${own}&day=in.(${list.join(",")})`);
        const idDay = new Map(msgs.map((m) => [Number(m.id), m.day]));
        const before = await sbGet(env, `/ak_days?select=day,summary,tags&case_id=eq.${enc(c.id)}&${own}&day=in.(${list.join(",")})`);
        const old = new Map(before.map((r) => [r.day, r]));
        let dropped = 0, kept = 0;
        const now = new Date().toISOString();
        const rows = days.map((d) => {
          const evs = d.events.filter((e) => idDay.get(e.msg_id) === d.day).map((e) => ({ ...e, due: e.due ?? null }));
          dropped += d.events.length - evs.length; kept += evs.length;
          const o = old.get(d.day);
          const seen = new Set(evs.map((e) => `${e.msg_id}|${e.type}`));
          const tags = o && Array.isArray(o.tags) ? o.tags.filter((e: Row) => !seen.has(`${e.msg_id}|${e.type}`)).concat(evs) : evs;
          return { user_id: OWNER_UID, case_id: c.id, day: d.day, summary: d.summary || o?.summary || "", tags, updated_at: now };
        });
        await sbPost(env, `/ak_days?on_conflict=case_id,day`, rows, "resolution=merge-duplicates,return=minimal");
        await sbPatch(env, `/ak_msgs?case_id=eq.${enc(c.id)}&${own}&ai_at=is.null&day=in.(${list.join(",")})&select=id`, { ai_at: now });
        await sbPost(env, `/ak_runs`, [{ user_id: OWNER_UID, case_id: c.id, days: list.length, msgs: msgs.length, model: "claude-chat", note: "段 1：日ごと（MCP）" }], "return=minimal");
        return asMcpTextResult({ ok: true, 案件: c.name, 書いた日: list.length, 出来事: kept, 捨てた出来事: dropped, 次: "anken__ai_next_days をもう一度（残りが 0 なら anken__ai_case_context）" });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 10. anken__ai_case_context ──────────────────────────────────
  server.tool(
    "anken__ai_case_context",
    "案件くんの AI の仕事（段 2 の材料）：日ごとに拾った出来事の全部・直近 21 日の要約・既存のプロジェクト・登録済みと外したもの（理由つき）・TaskMaster のつないだプロジェクトの未完了タスクを返す。読んだら anken__ai_update_case に渡す。戻り値: { ok, 今日, 決まり, 既存のプロジェクト, 登録済み, 外したもの, TaskMaster, 要約, 出来事 }。",
    { case: z.string().min(1).max(80).describe("案件の名前か id") },
    async ({ case: q }) => {
      try {
        const c = await findCase(env, q);
        if (!c) return notFound(env, q);
        const [days, projects, items, pend] = await Promise.all([
          sbGet(env, `/ak_days?select=day,summary,tags&case_id=eq.${enc(c.id)}&${own}&order=day.asc`),
          sbGet(env, `/ak_projects?select=name&case_id=eq.${enc(c.id)}&${own}&order=sort.asc`),
          sbGet(env, `/ak_items?select=title,status,reason,kind&case_id=eq.${enc(c.id)}&${own}`),
          sbGet(env, `/ak_msgs?select=id&case_id=eq.${enc(c.id)}&${own}&ai_at=is.null&limit=1`),
        ]);
        let tm: string[] = [];
        if (c.tm_project) {
          try {
            const token = await getFirestoreToken(env);
            const tasks = await queryTasks(token, env.NAOKI_UID, "projectId", { stringValue: c.tm_project });
            tm = tasks.filter((t: Row) => !t.archived && !t.completed).map((t: Row) => String(t.title ?? "").slice(0, 120));
          } catch { tm = []; }
        }
        const ev: string[] = [];
        for (const d of days) for (const e of d.tags || []) ev.push(evLine(e, d.day));
        return asMcpTextResult({
          ok: true, 案件: c.name, 今日: todayJst(), 決まり: CASE_RULES,
          ...(pend.length ? { 注意: "まだ読んでいない日があります。先に anken__ai_next_days を済ませてください" } : {}),
          既存のプロジェクト: projects.map((p) => p.name),
          登録済み: items.filter((i) => (i.status === "open" || i.status === "done") && i.kind !== "decision").map((i) => i.title),
          外したもの: items.filter((i) => i.status === "dismissed").map((i) => `${i.title}：${i.reason || "理由なし"}`),
          TaskMaster: tm,
          要約: days.slice(-21).map((d) => `${d.day}：${d.summary}`),
          出来事: ev,
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 11. anken__ai_update_case ───────────────────────────────────
  server.tool(
    "anken__ai_update_case",
    "案件くんの AI の仕事（段 2 の書き込み）：今週の要約・状態・注意・次の MTG の事前メモ・プロジェクト・やることの候補・決定を書く。やることは候補箱（status = candidate）へ入り、Naoki が画面で TaskMaster へ入れるか外す。Naoki が決めたもの（登録・済み・外した）は書き換えない。前に AI が出した候補で今回出さなかったものは下げる（Claude の add_candidates で入れたものは残す）。根拠の発言が見つからないものは入れない。戻り値: { ok, 新しい候補, 直した候補, 下げた候補, 決定, プロジェクト, 住所 }。",
    {
      case: z.string().min(1).max(80).describe("案件の名前か id"),
      week: z.string().max(400).describe("直近 7 日の要約（2〜3 文）"),
      state: z.enum(["g", "y", "r"]).describe("g＝順調・y＝注意・r＝遅れ"),
      alert: z.string().max(200).describe("すぐ気をつけること 1 つ（無ければ空）"),
      next_mtg: z.object({
        when: z.string().max(80), why: z.string().max(200),
        agenda: z.array(z.object({ title: z.string().max(80), note: z.string().max(200) })).max(8),
        theirs: z.array(z.string().max(120)).max(10),
      }),
      projects: z.array(z.object({ name: z.string().max(60), state: z.enum(["g", "y", "r"]), next: z.string().max(120), recent: z.string().max(120) })).max(10),
      items: z.array(z.object({
        origin_msg_id: z.number().int(),
        origin_quote: z.string().max(200).optional().describe("起点の発言の中で、このやることに当たる原文（議事録のときは該当行をそのまま）"),
        kind: z.enum(["report", "do", "ask", "wait", "later"]),
        title: z.string().max(120),
        project: z.string().max(60),
        due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        evidence_msg_ids: z.array(z.number().int()).max(5),
        note: z.string().max(300),
      })).max(60),
      decisions: z.array(z.object({ msg_id: z.number().int(), quote: z.string().max(200).optional().describe("決まったことに当たる原文（議事録のときは該当行をそのまま）"), title: z.string().max(120), project: z.string().max(60) })).max(12),
    },
    async ({ case: q, week, state, alert, next_mtg, projects, items, decisions }) => {
      try {
        const c = await findCase(env, q);
        if (!c) return notFound(env, q);
        const now = new Date().toISOString();
        const [oldProj, oldItems, days, sources] = await Promise.all([
          sbGet(env, `/ak_projects?select=id,name&case_id=eq.${enc(c.id)}&${own}`),
          sbGet(env, `/ak_items?select=id,fp,status,origin,kind&case_id=eq.${enc(c.id)}&${own}`),
          sbGet(env, `/ak_days?select=day,tags&case_id=eq.${enc(c.id)}&${own}`),
          sbGet(env, `/ak_sources?select=id,name,kind&case_id=eq.${enc(c.id)}&${own}`),
        ]);
        const savedProj = projects.length ? await sbPost(env, `/ak_projects?on_conflict=case_id,name`, projects.map((p, i) => ({
          user_id: OWNER_UID, case_id: c.id, name: p.name, state: p.state, next: p.next || null, recent: p.recent || null, sort: i, updated_at: now,
        })), "resolution=merge-duplicates,return=representation") : [];
        const pId = new Map([...oldProj, ...savedProj].map((p) => [p.name, p.id]));
        const evQuote = new Map<number, string>();
        for (const d of days) for (const e of d.tags || []) if (!evQuote.has(Number(e.msg_id))) evQuote.set(Number(e.msg_id), e.quote);
        const ids = new Set<number>();
        for (const it of items) for (const id of [it.origin_msg_id, ...it.evidence_msg_ids]) ids.add(id);
        for (const d of decisions) ids.add(d.msg_id);
        const msgs = ids.size ? await sbGet(env, `/ak_msgs?select=id,day,at_time,who,body,source_id&case_id=eq.${enc(c.id)}&${own}&id=in.(${[...ids].join(",")})`) : [];
        const byId = new Map(msgs.map((m) => [Number(m.id), m]));
        const sName = new Map(sources.map((s) => [s.id, s.name]));
        const sKind = new Map(sources.map((s) => [s.id, s.kind]));
        const isMinutes = (id: number) => sKind.get(byId.get(id)?.source_id) === "minutes";
        // 根拠は 5 つまで。先頭（起点の発言）の原文は、示された該当行を優先する
        const srcOf = (list: number[], firstQuote?: string) => [...new Set(list)].filter((id) => byId.has(id)).slice(0, 5).map((id, i) => {
          const m = byId.get(id)!;
          const quote = (i === 0 && firstQuote) || evQuote.get(id) || String(m.body).slice(0, 120);
          return { msg_id: id, day: m.day, time: m.at_time, chat: sName.get(m.source_id) ?? "", who: m.who, quote: String(quote).slice(0, 200) };
        });
        const byFp = new Map(oldItems.map((i) => [i.fp, i]));
        const keep = new Set<string>();
        let added = 0, updated = 0;
        for (const it of items) {
          const src = srcOf([it.origin_msg_id, ...it.evidence_msg_ids], it.origin_quote);
          if (!src.length) continue;
          const fp = await fpOf("m", it.origin_msg_id, isMinutes(it.origin_msg_id), it.origin_quote, it.title);
          keep.add(fp);
          const row = { kind: it.kind, title: it.title, project_id: pId.get(it.project) ?? null, due: it.due ?? null, note: it.note || null, src, updated_at: now };
          const ex = byFp.get(fp);
          if (!ex) { await sbPost(env, `/ak_items`, [{ user_id: OWNER_UID, case_id: c.id, fp, status: "candidate", origin: "ai", ...row }], "return=minimal"); added++; }
          else if (ex.status === "candidate") { await sbPatch(env, `/ak_items?id=eq.${enc(ex.id)}&${own}`, row); updated++; }
        }
        const gone = oldItems.filter((i) => i.status === "candidate" && i.origin === "ai" && String(i.fp ?? "").startsWith("m:") && !keep.has(i.fp));
        for (const g of gone) await sbDelete(env, `/ak_items?id=eq.${enc(g.id)}&${own}&status=eq.candidate`);
        // 決定：AI が出したものは毎回出し直す（直す・足す・今回出さなかったものは消す）
        const keepD = new Set<string>();
        for (const d of decisions) {
          const src = srcOf([d.msg_id], d.quote);
          if (!src.length) continue;
          const fp = await fpOf("d", d.msg_id, isMinutes(d.msg_id), d.quote, d.title);
          keepD.add(fp);
          await sbPost(env, `/ak_items?on_conflict=case_id,fp`, [{
            user_id: OWNER_UID, case_id: c.id, fp, kind: "decision", status: "open", origin: "ai", title: d.title, project_id: pId.get(d.project) ?? null, src, decided_at: now, updated_at: now,
          }], "resolution=merge-duplicates,return=minimal");
        }
        const goneD = oldItems.filter((i) => i.kind === "decision" && i.origin === "ai" && String(i.fp ?? "").startsWith("d:") && !keepD.has(i.fp));
        for (const g of goneD) await sbDelete(env, `/ak_items?id=eq.${enc(g.id)}&${own}&origin=eq.ai&kind=eq.decision`);
        await sbPatch(env, `/ak_cases?id=eq.${enc(c.id)}&${own}`, { week, state, alert: alert || null, mtg: next_mtg, updated_at: now });
        await sbPost(env, `/ak_runs`, [{ user_id: OWNER_UID, case_id: c.id, days: days.length, msgs: items.length, model: "claude-chat", note: "段 2：案件ごと（MCP）" }], "return=minimal");
        return asMcpTextResult({ ok: true, 案件: c.name, 新しい候補: added, 直した候補: updated, 下げた候補: gone.length, 決定: keepD.size, 下げた決定: goneD.length, プロジェクト: projects.length, 住所: `${APP_URL}/c/${c.id}` });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );
}
