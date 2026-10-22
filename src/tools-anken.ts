import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { parseLine, parseMinutes, maskMessages, withHashes, SELF_NAMES } from "./anken-core.js";
import { getGoogleTokenForScope } from "./google-token.js";
import { getFirestoreToken, fsGet, fromVal, queryTasks } from "./taskmaster.js";
import { PERIOD_KINDS, mergePeriods, extractLinks, typeLabel, googleIdOf, type Period } from "./anken-plan.js";

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
 *
 * 2026-10-22 拾い方の直し（1便目の止め時・統括の壁打ち・Naoki 確定）：
 *   ・過去の分は推測しない。やることの候補は、起点の発言が「拾い始めの日」以降のものだけ
 *     （拾い始めの日＝PICK_FROM と案件を作った日の遅いほう）。それより前の候補は自動で下げない（Naoki が決める）
 *   ・「報告がまだ」の分けは無くし「やる」にまとめた（残っていたものは ai_update_case のときに do へ移す）
 *   ・「まだ」は TaskMaster の未完了だけで見る。数は やる（TaskMaster 未完了）／確かめる／相手待ち／候補箱
 *   ・期限の無い依頼は次の定例の日を仮の期限に置き、次の定例の議題に載せる
 *
 * 2026-10-22 案件のタブの直し（Naoki「クライアントのスケジュール感も必要・リンクは名称で整理」）：
 *   ・予定（ak_cases.periods）：ai_update_case の periods で AI が拾ったクライアントの期間・日を書く（ガントの一番上の段）。
 *     Naoki が画面で足した・直した・消したものは残し、AI は出し直さない（anken-plan.ts の mergePeriods）
 *   ・anken__links：記録に出てきたリンクと今の名称を返す／anken__name_links：リンクに名称を付ける（ak_cases.link_names）
 *
 * 2026-10-22 案件チャットの作業台（Naoki「案件ごとの Claude のプロジェクトが案件くんをフル活用して動く」）：
 *   ・anken__log_work：案件チャットが作業の終わりに「対応記録」を 1 件書く。時系列の記録「対応記録」の発言として入るので、
 *     記録と検索で探せ、日ごとの流れに並び、AI の読み取りにも乗る（表は増やさない）
 *   ・anken__get_home に「直近の対応記録」
 */

type Row = Record<string, any>;
/** 案件くんに入れる 1 人（画面の wrangler.jsonc の ANKEN_ALLOW_UID と同じ値。秘密ではない） */
const OWNER_UID = "VrMwzeSceqWeXVQOrm8kpu4uVR33";
const APP_URL = "https://anken.shia2n.jp";
const own = `user_id=eq.${OWNER_UID}`;
/** 「報告がまだ」（report）は 2026-10-22 に無くした。古い行が残っていても「やる」として見せる */
const KIND: Record<string, string> = { report: "やる", do: "やる", ask: "確かめる", wait: "相手待ち", later: "あとで", decision: "決定" };
const KINDS = ["do", "ask", "wait", "later"] as const;
const kindOf = (k: string) => (k === "report" ? "do" : k);
/** これより前の発言からは、やることの候補を出さない（過去の分は推測しない・2026-10-22 Naoki 確定） */
const PICK_FROM = "2026-10-22";
const jstDay = (iso: string) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 10);
const pickFromOf = (c: Row) => {
  const made = c.created_at ? jstDay(String(c.created_at)) : "";
  return made > PICK_FROM ? made : PICK_FROM;
};
/** 次の MTG の when（例「2026-10-22（木）13時（推定）」）の日付。読めなければ null */
const mtgDay = (when: unknown) => /^(\d{4}-\d{2}-\d{2})/.exec(String(when ?? ""))?.[1] ?? null;
/** TaskMaster のつないだプロジェクトのタスク（未完了の題名と、完了した id）。読めなければ null */
async function tmOf(env: Env, projectId: string | null | undefined): Promise<{ open: Row[]; doneIds: Set<string> } | null> {
  if (!projectId) return null;
  try {
    const token = await getFirestoreToken(env);
    const tasks = await queryTasks(token, env.NAOKI_UID, "projectId", { stringValue: projectId });
    return {
      open: tasks.filter((t: Row) => !t.archived && !t.completed),
      doneIds: new Set(tasks.filter((t: Row) => t.completed || t.archived).map((t: Row) => String(t.id))),
    };
  } catch { return null; }
}
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
const nowJstTime = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(11, 16);
/** 対応記録を入れる記録の名前（時系列の中の 1 本・2026-10-22） */
const LOG_SOURCE = "対応記録";
const daysBefore = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
const BODY_MAX = 1500;
const fmtMsg = (m: Row, src: string) => `[#${m.id}] ${m.at_time || "--:--"} 〈${src}〉 ${m.who || "?"}：${String(m.body).length > BODY_MAX ? String(m.body).slice(0, BODY_MAX) + "…（以下略）" : m.body}`;
const evLine = (e: Row, day: string) => `[#${e.msg_id}] ${day} ${e.type} ${e.who}：${e.text}${e.due ? `（期限 ${e.due}）` : ""}「${e.quote}」`;

/** 発言を入れる（アプリの /api/import と同じ決まり：伏せ字・同じ発言は 1 回だけ・知らせは入れない） */
async function importMessages(env: Env, c: Row, kind: "line" | "minutes", name: string, parsed: Row, url?: string): Promise<Row> {
  const msgs = (parsed.messages as Row[]).filter((m) => !m.system);
  if (!msgs.length) return { ok: false, message: "発言を 1 件も読めませんでした", 読めなかった行: (parsed.skipped || []).slice(0, 5) };
  const { messages: clean, count: masked } = maskMessages(msgs);
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
〈対応記録〉の発言は自分（シアニン側・案件チャットの Claude を含む）の作業の記録。やったことは type＝report で拾う。挨拶・お礼・相づち・雑談・「画像」「音声」だけの発言は拾わない。quote は原文をそのまま 80 字以内で切り出す（言い換えない）。期限は発言の日付から YYYY-MM-DD に直す（読めなければ null）。渡した日はすべて days に入れる（出来事が無い日も要約は書く）。`;

const CASE_RULES = `「拾い始めの日」以降に新しく出た依頼・約束を拾い、anken__ai_update_case に渡す。それより前の出来事は、閉じているかどうかと文脈を読むためだけに使い、そこからやることは出さない（過去の分は推測しない）。
4 つの分け（kind）：do（やる）＝自分が引き受けた・頼まれた・自分から言い出したこと／ask（確かめる）＝誰がやるか・何をするかが読み取れず、相手に確かめないと進めないもの／wait（相手待ち）＝相手の作業・返事を待っているもの／later（あとで）＝期限が 15 日以上先か、相手が「急がない」と言ったもの。「報告がまだ」の分けは無い（済んだかどうかは TaskMaster の完了で見る）。
期限：発言に期限があればその日。期限の無い do・ask・wait は、次の定例の日（next_mtg の日付）を仮の期限にして due に入れ、next_mtg.agenda にも載せる（多いときは「新しい依頼の確認」1 つにまとめ、note に名前を並べる）。
後の日付に同じことの report や、相手の「ありがとう・できました・届きました」がある依頼は閉じている。出さない。取り下げ・別の人に頼んだものも出さない。同じことは 1 つにまとめ、origin_msg_id は最初の依頼か約束。議事録は 1 回分が 1 つの発言なので、1 つの議事録から複数のやること・決定を出してよい（そのときは origin_quote・quote に議事録の該当行をそのまま書く）。「登録済み」「TaskMaster にあるもの」「Naoki が外したもの（理由を読む）」と同じことは出さない。note は日付と事実で 1 文。プロジェクトは 3〜8 個、既存の名前はそのまま使う。決定は直近 30 日の大事なものだけ多くて 8 つ。next_mtg は記録にあればその日時、無ければ過去の開催から推定して「（推定）」。
予定（periods）：クライアント側の期間・日を、記録に書いてあるものだけ拾う（オファー・募集・販売＝offer／公開・配信・リリース＝release／セミナー・撮影・イベント・MTG 以外の催し＝event／不在・休み・旅行＝off／ほか＝other）。定例 MTG そのものは入れない。start・end は YYYY-MM-DD（1 日だけなら同じ日、終わりが読めなければ start と同じ）。今日の 30 日前から 90 日先まで。拾い始めの日より前の発言からも拾ってよい（予定は過去の推測ではなく書いてある日付）。「今の予定」に Naoki のもの（by: naoki）があれば同じものは出さない。title は 20 字ほど。`;

export function registerAnkenTools(server: McpServer, env: Env): void {

  // ─── 1. anken__list_cases ────────────────────────────────────────
  server.tool(
    "anken__list_cases",
    "案件くんの案件の一覧と、それぞれの状態・今週の要約・4 つの数（やる＝TaskMaster の未完了・確かめる・相手待ち・候補箱）を返す。TaskMaster とつないでいない案件の「やる」は、登録済みの「やる」の数。戻り値: { ok, 一覧: [{ id, 名前, 状態, 今週, 数, 次のMTG, 拾い始めの日, 住所 }] }。1 件の中身は anken__get_home。",
    {},
    async () => {
      try {
        const [cases, items] = await Promise.all([
          sbGet(env, `/ak_cases?select=*&${own}&order=sort.asc`),
          sbGet(env, `/ak_items?select=case_id,kind,status,tm_task_id&${own}&status=in.(candidate,open)`),
        ]);
        const tms = await Promise.all(cases.map((c) => tmOf(env, c.tm_project)));
        return asMcpTextResult({
          ok: true,
          一覧: cases.map((c, ci) => {
            const its = items.filter((i) => i.case_id === c.id && i.kind !== "decision");
            const n = (k: string, st?: string) => its.filter((i) => kindOf(i.kind) === k && (!st || i.status === st)).length;
            const tm = tms[ci];
            return {
              id: c.id, 名前: c.name, 状態: STL[c.state] ?? c.state, 今週: c.week ?? "", 注意: c.alert ?? "",
              数: { やる: tm ? tm.open.length : n("do", "open"), 確かめる: n("ask"), 相手待ち: n("wait"), 候補箱: its.filter((i) => i.status === "candidate").length },
              次のMTG: c.mtg?.when ?? "", 拾い始めの日: pickFromOf(c), 住所: `${APP_URL}/c/${c.id}`,
            };
          }),
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 2. anken__get_home ──────────────────────────────────────────
  server.tool(
    "anken__get_home",
    "案件くんの案件 1 件のホームを返す：4 つの数（やる＝TaskMaster の未完了・確かめる・相手待ち・候補箱）・今週の要約・状態・注意・次の MTG の事前メモ・プロジェクト・やること（やる → 確かめる → 相手待ち → あとで の順。候補箱か登録済みか・期限・AI の見立て・根拠の発言。TaskMaster で完了したものは「済み」）・TaskMaster の未完了・最近の決定・入っている記録。kind で 1 種類だけに絞れる。include_closed: true で済み・外したもの（外した理由つき）も出す。戻り値: { ok, 案件, 数, 状態, 今週, 注意, 次のMTG, 拾い始めの日, プロジェクト, やること, TaskMaster, 決定, 記録 }。",
    {
      case: z.string().min(1).max(80).describe("案件の名前か id（例: るーみん）"),
      kind: z.enum(KINDS).optional().describe("この種類だけ（do=やる・ask=確かめる・wait=相手待ち・later=あとで）"),
      include_closed: z.boolean().optional().describe("済み・外したものも出す"),
    },
    async ({ case: q, kind, include_closed }) => {
      try {
        const c = await findCase(env, q);
        if (!c) return notFound(env, q);
        const logSrc = (await sbGet(env, `/ak_sources?select=id&case_id=eq.${enc(c.id)}&${own}&name=eq.${enc(LOG_SOURCE)}`))[0];
        const logs = logSrc ? await sbGet(env, `/ak_msgs?select=day,at_time,who,body&source_id=eq.${enc(logSrc.id)}&${own}&order=day.desc,at_time.desc&limit=5`) : [];
        const [projects, items, sources, last] = await Promise.all([
          sbGet(env, `/ak_projects?select=id,name,state,next,recent&case_id=eq.${enc(c.id)}&${own}&order=sort.asc`),
          sbGet(env, `/ak_items?select=id,kind,title,status,due,note,reason,src,origin,project_id,tm_task_id,created_at&case_id=eq.${enc(c.id)}&${own}`),
          sbGet(env, `/ak_sources?select=name,kind,last_import_at&case_id=eq.${enc(c.id)}&${own}`),
          sbGet(env, `/ak_msgs?select=day&case_id=eq.${enc(c.id)}&${own}&order=day.desc&limit=1`),
        ]);
        const pName = new Map(projects.map((p) => [p.id, p.name]));
        const tm = await tmOf(env, c.tm_project);
        // TaskMaster で完了（か片づけ）したタスクにつながる登録済みは「済み」として見る（「まだ」は TaskMaster の未完了だけ）
        const st = (i: Row) => (i.status === "open" && i.tm_task_id && tm?.doneIds.has(String(i.tm_task_id)) ? "done" : i.status);
        const live = (i: Row) => ACTIVE.has(st(i));
        const order: Record<string, number> = { do: 0, ask: 1, wait: 2, later: 3 };
        const todo = items.filter((i) => i.kind !== "decision" && (include_closed || live(i)) && (!kind || kindOf(i.kind) === kind))
          .sort((a, b) => (order[kindOf(a.kind)] ?? 9) - (order[kindOf(b.kind)] ?? 9) || String(a.due ?? "9").localeCompare(String(b.due ?? "9")));
        const act = items.filter((i) => i.kind !== "decision" && live(i));
        const n = (k: string, s?: string) => act.filter((i) => kindOf(i.kind) === k && (!s || i.status === s)).length;
        return asMcpTextResult({
          ok: true, 案件: c.name, 住所: `${APP_URL}/c/${c.id}`,
          数: { やる: tm ? tm.open.length : n("do", "open"), 確かめる: n("ask"), 相手待ち: n("wait"), 候補箱: act.filter((i) => i.status === "candidate").length },
          状態: STL[c.state] ?? c.state, 今週: c.week ?? "", 注意: c.alert ?? "",
          最後のやりとり: last[0]?.day ?? null,
          直近の対応記録: logs.map((m) => `${m.day} ${m.at_time ?? ""} ${m.who ?? ""}：${String(m.body).replace(/^【対応記録】/, "").split("\n")[0].slice(0, 100)}`),
          次のMTG: c.mtg ?? {},
          拾い始めの日: pickFromOf(c),
          予定: (Array.isArray(c.periods) ? c.periods : []).filter((p: Period) => !p.hidden).map((p: Period) => ({ 名前: p.title, 始まり: p.start, 終わり: p.end, 種類: p.kind, 出どころ: p.by === "naoki" ? "Naoki" : "AI" })),
          プロジェクト: projects.map((p) => ({ 名前: p.name, 状態: STL[p.state] ?? p.state, 次の一手: p.next, 直近: p.recent })),
          やること: todo.map((i) => ({
            id: i.id, 種類: KIND[i.kind] ?? i.kind, 置き場: STATUS[st(i)] ?? st(i), 名前: i.title, 期限: i.due,
            プロジェクト: pName.get(i.project_id) ?? "", 見立て: i.note ?? "", ...(i.reason ? { 外した理由: i.reason } : {}),
            根拠: (i.src || []).map(srcLine), 出どころ: i.origin === "mcp" ? "Claude" : "AI の拾い", TaskMaster: !!i.tm_task_id,
          })),
          TaskMaster: tm ? tm.open.map((t) => ({ 名前: t.title ?? "", 期限: t.deadline || null })) : c.tm_project ? "読めませんでした" : "つないでいない",
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
    "案件くんの候補箱に、やることを足す（書く道具はこれだけ）。足したものは「Claude から」の印が付き、Naoki が画面で TaskMaster へ入れるか、理由を付けて外す。同じ名前のものが同じ案件の候補箱か登録済みにあれば足さない。kind：do=やる・ask=確かめる・wait=相手待ち・later=あとで。期限の無い do・ask・wait は、次の定例の日（案件の次の MTG）を仮の期限にする。根拠（evidence）には、元になった発言や議事録の言葉をそのまま書く（言い換えない）。戻り値: { ok, 足した数, 足したもの, 足さなかったもの: [{ 名前, 理由 }], 住所 }。",
    {
      case: z.string().min(1).max(80).describe("案件の名前か id"),
      items: z.array(z.object({
        kind: z.enum(KINDS),
        title: z.string().min(1).max(120).describe("やることの名前（動詞で終える）"),
        due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("期限 YYYY-MM-DD（無ければ次の定例の日が入る）"),
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
        const mtg = mtgDay(c.mtg?.when);
        const nextMtg = mtg && mtg >= today ? mtg : null;
        const rows: Row[] = [];
        const skipped: Row[] = [];
        for (const it of items) {
          if (have.has(norm(it.title))) { skipped.push({ 名前: it.title, 理由: "同じ名前が候補箱か登録済みにある" }); continue; }
          have.add(norm(it.title));
          rows.push({
            user_id: OWNER_UID, case_id: c.id, kind: it.kind, title: it.title, due: it.due ?? (it.kind !== "later" ? nextMtg : null),
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
        const { messages: clean, count: masked } = maskMessages(inRange);
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
    "案件くんの AI の仕事（段 2 の材料）：拾い始めの日・日ごとに拾った出来事（拾い始めの日以降＝やることを拾う元／それより前＝閉じているかと文脈を読むだけ）・直近 21 日の要約・既存のプロジェクト・登録済みと外したもの（理由つき）・TaskMaster のつないだプロジェクトの未完了タスクを返す。読んだら anken__ai_update_case に渡す。戻り値: { ok, 今日, 拾い始めの日, 決まり, 既存のプロジェクト, 登録済み, 外したもの, TaskMaster, 要約, 出来事, 前の出来事 }。",
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
        const tmr = await tmOf(env, c.tm_project);
        const tm: string[] = (tmr?.open ?? []).map((t: Row) => String(t.title ?? "").slice(0, 120));
        const from = pickFromOf(c);
        const ev: string[] = [];
        const before: string[] = [];
        for (const d of days) for (const e of d.tags || []) (d.day >= from ? ev : before).push(evLine(e, d.day));
        return asMcpTextResult({
          ok: true, 案件: c.name, 今日: todayJst(), 拾い始めの日: from, 決まり: CASE_RULES,
          ...(pend.length ? { 注意: "まだ読んでいない日があります。先に anken__ai_next_days を済ませてください" } : {}),
          既存のプロジェクト: projects.map((p) => p.name),
          登録済み: items.filter((i) => (i.status === "open" || i.status === "done") && i.kind !== "decision").map((i) => i.title),
          外したもの: items.filter((i) => i.status === "dismissed").map((i) => `${i.title}：${i.reason || "理由なし"}`),
          TaskMaster: tm,
          今の予定: (Array.isArray(c.periods) ? c.periods : []).filter((p: Period) => !p.hidden).map((p: Period) => `${p.start}〜${p.end} ${p.kind} ${p.title}（${p.by === "naoki" ? "Naoki" : "AI"}）`),
          要約: days.slice(-21).map((d) => `${d.day}：${d.summary}`),
          出来事: ev,
          前の出来事: before.slice(-300),
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 11. anken__ai_update_case ───────────────────────────────────
  server.tool(
    "anken__ai_update_case",
    "案件くんの AI の仕事（段 2 の書き込み）：今週の要約・状態・注意・次の MTG の事前メモ・プロジェクト・やることの候補・決定を書く。やることは候補箱（status = candidate）へ入り、Naoki が画面で TaskMaster へ入れるか外す。起点の発言が拾い始めの日より前のものは入れない（過去の分は推測しない）。期限の無い do・ask・wait には次の定例の日が入る。Naoki が決めたもの（登録・済み・外した）は書き換えない。前に AI が出した候補で今回出さなかったものは下げる（拾い始めの日より前の候補と、Claude の add_candidates で入れたものは残す）。根拠の発言が見つからないものは入れない。戻り値: { ok, 新しい候補, 直した候補, 下げた候補, 入れなかった（拾い始めより前）, 仮の期限を置いた, 決定, プロジェクト, 住所 }。",
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
        kind: z.enum(KINDS),
        title: z.string().max(120),
        project: z.string().max(60),
        due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe("期限。発言に無ければ次の定例の日（省略すると next_mtg の日付が入る）"),
        evidence_msg_ids: z.array(z.number().int()).max(5),
        note: z.string().max(300),
      })).max(60),
      decisions: z.array(z.object({ msg_id: z.number().int(), quote: z.string().max(200).optional().describe("決まったことに当たる原文（議事録のときは該当行をそのまま）"), title: z.string().max(120), project: z.string().max(60) })).max(12),
      periods: z.array(z.object({
        title: z.string().min(1).max(40),
        start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("終わりの日（1 日だけなら省略）"),
        kind: z.enum(PERIOD_KINDS).describe("offer＝オファー・募集・販売／release＝公開・配信／event＝セミナー・撮影などの催し／off＝不在・休み／other"),
        project: z.string().max(60).optional(),
        msg_id: z.number().int().describe("その日付が書いてある発言"),
        quote: z.string().max(120).optional().describe("日付が書いてある原文"),
      })).max(30).optional().describe("クライアントの予定（ガントの一番上の段）。省略すると今の予定はそのまま。渡すと AI の分を出し直す（Naoki のもの・消したものは残る）"),
    },
    async ({ case: q, week, state, alert, next_mtg, projects, items, decisions, periods }) => {
      try {
        const c = await findCase(env, q);
        if (!c) return notFound(env, q);
        const now = new Date().toISOString();
        const from = pickFromOf(c);
        const today = todayJst();
        // 「報告がまだ」は無くした：残っている行は「やる」へ移す（Naoki が決めた置き場はそのまま）
        const moved = await sbPatch(env, `/ak_items?case_id=eq.${enc(c.id)}&${own}&kind=eq.report&select=id`, { kind: "do", updated_at: now });
        const [oldProj, oldItems, days, sources] = await Promise.all([
          sbGet(env, `/ak_projects?select=id,name&case_id=eq.${enc(c.id)}&${own}`),
          sbGet(env, `/ak_items?select=id,fp,status,origin,kind,src&case_id=eq.${enc(c.id)}&${own}`),
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
        for (const p of periods ?? []) ids.add(p.msg_id);
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
        const mtg = mtgDay(next_mtg.when);
        const nextMtg = mtg && mtg >= today ? mtg : null;
        let added = 0, updated = 0, tooOld = 0, provisional = 0;
        const provTitles: string[] = [];
        for (const it of items) {
          // 起点の発言が拾い始めの日より前なら入れない（過去の分は推測しない）
          const om = byId.get(it.origin_msg_id);
          if (!om) continue;
          if (String(om.day) < from) { tooOld++; continue; }
          const src = srcOf([it.origin_msg_id, ...it.evidence_msg_ids], it.origin_quote);
          if (!src.length) continue;
          const fp = await fpOf("m", it.origin_msg_id, isMinutes(it.origin_msg_id), it.origin_quote, it.title);
          keep.add(fp);
          const due = it.due ?? (it.kind !== "later" ? nextMtg : null);
          if (!it.due && due) { provisional++; provTitles.push(it.title); }
          const row = { kind: it.kind, title: it.title, project_id: pId.get(it.project) ?? null, due, note: it.note || null, src, updated_at: now };
          const ex = byFp.get(fp);
          if (!ex) { await sbPost(env, `/ak_items`, [{ user_id: OWNER_UID, case_id: c.id, fp, status: "candidate", origin: "ai", ...row }], "return=minimal"); added++; }
          else if (ex.status === "candidate") { await sbPatch(env, `/ak_items?id=eq.${enc(ex.id)}&${own}`, row); updated++; }
        }
        // 下げるのは拾い始めの日以降の AI の候補だけ（それより前の候補は Naoki が決める）
        const gone = oldItems.filter((i) => i.status === "candidate" && i.origin === "ai" && String(i.fp ?? "").startsWith("m:") && !keep.has(i.fp)
          && String((i.src || [])[0]?.day ?? "") >= from);
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
        // 仮の期限を置いた依頼は、次の定例の議題にも載せる（AI が載せていなければ 1 つにまとめて足す）
        const agenda = [...next_mtg.agenda];
        const flat = agenda.map((a) => `${a.title}${a.note}`).join("\n");
        const missing = provTitles.filter((t) => !flat.includes(t));
        if (missing.length && agenda.length < 8) {
          agenda.push({ title: "新しい依頼の確認", note: missing.slice(0, 6).join("／").slice(0, 200) });
        }
        // 予定：根拠の発言が見つかるものだけ。Naoki のもの・消したものは残す
        let plan: { periods: Period[]; added: number; skipped: number } | null = null;
        let planDropped = 0;
        if (periods) {
          const inc = periods.filter((p) => byId.has(p.msg_id) || (planDropped++, false)).map((p) => {
            const m = byId.get(p.msg_id)!;
            return { title: p.title, start: p.start, end: p.end ?? p.start, kind: p.kind, project: p.project ?? null,
              src: { msg_id: p.msg_id, day: m.day, chat: sName.get(m.source_id) ?? "", who: m.who, quote: String(p.quote || evQuote.get(p.msg_id) || m.body).slice(0, 120) } };
          });
          plan = await mergePeriods(c.periods, inc);
        }
        await sbPatch(env, `/ak_cases?id=eq.${enc(c.id)}&${own}`, { week, state, alert: alert || null, mtg: { ...next_mtg, agenda }, ...(plan ? { periods: plan.periods } : {}), updated_at: now });
        await sbPost(env, `/ak_runs`, [{ user_id: OWNER_UID, case_id: c.id, days: days.length, msgs: items.length, model: "claude-chat", note: "段 2：案件ごと（MCP）" }], "return=minimal");
        return asMcpTextResult({
          ok: true, 案件: c.name, 拾い始めの日: from, 新しい候補: added, 直した候補: updated, 下げた候補: gone.length,
          "入れなかった（拾い始めより前）": tooOld, 仮の期限を置いた: provisional, ...(nextMtg ? { 仮の期限: nextMtg } : {}),
          ...(moved.length ? { "「報告がまだ」から「やる」へ移した": moved.length } : {}),
          決定: keepD.size, 下げた決定: goneD.length, プロジェクト: projects.length,
          ...(plan ? { 予定: { 入れた: plan.added, "出し直さなかった（Naoki のもの・消したもの）": plan.skipped, "根拠が無く入れなかった": planDropped, 全部: plan.periods.filter((p) => !p.hidden).length } } : {}),
          住所: `${APP_URL}/c/${c.id}`,
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 12. anken__links ────────────────────────────────────────────
  server.tool(
    "anken__links",
    "案件くんの案件の記録（LINE・議事録）に出てきたリンクを、新しい順に返す（画面の「リンク」タブと同じ拾い方）。名称は anken__name_links で付けたものがあればそれ、無ければ前後の文から付けた仮の名前。Google のファイルは google_id を返すので、Google ドライブの道具で本当のファイル名を見て名称に使える。Zoom は既定で外す。戻り値: { ok, 案件, 件数, 名称なし, リンク: [{ key, 名称, 名称の出どころ, 種類, url, google_id, 日, チャット, 発言者, 回数 }] }。",
    {
      case: z.string().min(1).max(80).describe("案件の名前か id"),
      unnamed_only: z.boolean().optional().describe("名称をまだ付けていないものだけ"),
      include_zoom: z.boolean().optional().describe("Zoom のリンクも出す"),
    },
    async ({ case: q, unnamed_only, include_zoom }) => {
      try {
        const c = await findCase(env, q);
        if (!c) return notFound(env, q);
        const [msgs, sources] = await Promise.all([
          sbGet(env, `/ak_msgs?select=day,at_time,who,body,source_id&case_id=eq.${enc(c.id)}&${own}&body=ilike.*http*&order=day.desc&limit=1500`),
          sbGet(env, `/ak_sources?select=id,name&case_id=eq.${enc(c.id)}&${own}`),
        ]);
        const sName = new Map(sources.map((x) => [x.id, x.name]));
        const names: Record<string, Row> = c.link_names && typeof c.link_names === "object" ? c.link_names : {};
        const rows = extractLinks(msgs, { chatOf: (m) => sName.get(m.source_id) ?? "" })
          .filter((l) => include_zoom || l.type !== "zoom")
          .map((l) => ({ l, n: names[l.key] }));
        const list = rows.filter(({ n }) => !unnamed_only || !n?.name);
        return asMcpTextResult({
          ok: true, 案件: c.name, 件数: rows.length, 名称なし: rows.filter(({ n }) => !n?.name).length,
          リンク: list.slice(0, 200).map(({ l, n }) => ({
            key: l.key, 名称: n?.name || l.name, 名称の出どころ: n?.name ? (n.by === "naoki" ? "Naoki" : "Claude") : "前後の文（仮）",
            種類: typeLabel(l.type), url: l.url, google_id: googleIdOf(l.key), 日: l.day, チャット: l.chat, 発言者: l.who, 回数: l.count,
          })),
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 13. anken__name_links ───────────────────────────────────────
  server.tool(
    "anken__name_links",
    "案件くんのリンクに名称を付ける（画面の「リンク」タブは名称の順に並び、同じ名称はまとまる）。key は anken__links の key。Google のファイルは本当のファイル名を、ほかは何のページかが分かる短い名前（20 字ほど）にする。Naoki が画面で付けた名称は書き換えない。name を空にすると Claude の付けた名称を消す。戻り値: { ok, 書いた, 書き換えなかった（Naoki の名称）, 知らない鍵 }。",
    {
      case: z.string().min(1).max(80).describe("案件の名前か id"),
      names: z.array(z.object({ key: z.string().min(1).max(300), name: z.string().max(60) })).min(1).max(200),
    },
    async ({ case: q, names }) => {
      try {
        const c = await findCase(env, q);
        if (!c) return notFound(env, q);
        const msgs = await sbGet(env, `/ak_msgs?select=day,at_time,who,body,source_id&case_id=eq.${enc(c.id)}&${own}&body=ilike.*http*&order=day.desc&limit=1500`);
        const known = new Set(extractLinks(msgs).map((l) => l.key));
        const cur: Record<string, Row> = c.link_names && typeof c.link_names === "object" ? { ...c.link_names } : {};
        let wrote = 0, kept = 0;
        const unknown: string[] = [];
        for (const { key, name } of names) {
          if (!known.has(key)) { unknown.push(key); continue; }
          if (cur[key]?.by === "naoki") { kept++; continue; }
          const v = name.trim();
          if (v) cur[key] = { name: v, by: "claude" }; else delete cur[key];
          wrote++;
        }
        if (wrote) await sbPatch(env, `/ak_cases?id=eq.${enc(c.id)}&${own}`, { link_names: cur, updated_at: new Date().toISOString() });
        return asMcpTextResult({ ok: true, 案件: c.name, 書いた: wrote, "書き換えなかった（Naoki の名称）": kept, 知らない鍵: unknown, 住所: `${APP_URL}/c/${c.id}` });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 14. anken__log_work ─────────────────────────────────────────
  server.tool(
    "anken__log_work",
    "案件くんに「対応記録」を 1 件書く。案件ごとの Claude のチャットが、作業の終わりに必ず呼ぶ（何をしたか・手順・関連の資料・どのタスクか・作業したチャットの住所）。記録は時系列の「対応記録」の発言として入り、案件くんの「記録と検索」で探せ、日ごとの流れに並び、次に AI にかけたとき「済んだ」の判断にも使われる。ID・パスワードなどの値は書かない（書かれていても伏せる）。戻り値: { ok, 案件, 日, 時刻, 伏せた, 住所 }。",
    {
      case: z.string().min(1).max(80).describe("案件の名前か id"),
      title: z.string().min(1).max(80).describe("何をしたか（1 行。例：本講座申込フォーム②を新価格に直した）"),
      body: z.string().max(1500).optional().describe("やったことの中身（1〜5 行）"),
      steps: z.string().max(1500).optional().describe("手順（次に同じことをするときに役立つもの。あれば）"),
      links: z.array(z.object({ name: z.string().max(60), url: z.string().url().max(500) })).max(10).optional().describe("関連の資料・ページ"),
      task: z.string().max(200).optional().describe("どの TaskMaster のタスクの作業か（題名の一部で可）"),
      session_url: z.string().max(300).optional().describe("作業したチャットの住所（claude.ai のチャットの URL など）"),
      who: z.string().max(40).optional().describe("書き手（省略時「Claude（案件チャット）」）"),
    },
    async ({ case: q, title, body, steps, links, task, session_url, who }) => {
      try {
        const c = await findCase(env, q);
        if (!c) return notFound(env, q);
        const text = [
          `【対応記録】${title.trim()}`,
          body?.trim() || "",
          steps?.trim() ? `手順：\n${steps.trim()}` : "",
          links?.length ? `関連：\n${links.map((l) => `・${l.name} ${l.url}`).join("\n")}` : "",
          task?.trim() ? `タスク：${task.trim()}` : "",
          session_url?.trim() ? `チャット：${session_url.trim()}` : "",
        ].filter(Boolean).join("\n");
        const day = todayJst(), time = nowJstTime();
        const { messages: clean, count: masked } = maskMessages([{ day, time, who: who?.trim() || "Claude（案件チャット）", body: text }]);
        const [m] = await withHashes(clean);
        const [src] = await sbPost(env, `/ak_sources?on_conflict=case_id,kind,name`, [{
          user_id: OWNER_UID, case_id: c.id, kind: "line", name: LOG_SOURCE, last_import_at: new Date().toISOString(),
        }], "resolution=merge-duplicates,return=representation");
        await sbPost(env, `/ak_msgs?on_conflict=source_id,hash`, [{
          user_id: OWNER_UID, case_id: c.id, source_id: src.id, day, at_time: time, who: m.who, body: m.body, masked: m.masked, hash: m.hash,
        }], "resolution=ignore-duplicates,return=minimal");
        return asMcpTextResult({ ok: true, 案件: c.name, 日: day, 時刻: time, 伏せた: masked, 住所: `${APP_URL}/c/${c.id}` });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );
}
