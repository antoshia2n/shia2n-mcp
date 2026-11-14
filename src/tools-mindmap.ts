import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import {
  type MNodes, ID_RE, addItems, parseMapRef, moveNode, findTable, tablesOf, putTrow, bodyOf, cleanName, countNodes, findRequests, imagesOf, markChecks, newMapTree, parseBullets, pathOf, sameName, titleOf, toOutline,
} from "./mindmap-core.js";
import { reduceRows, countDays, datesBetween, nextDate, type Snap } from "./mindmap-activity.js";

/**
 * 思考整理くん（mindmap.shia2n.jp・Naoki 個人用のマインドマップ）の道具。
 * Supabase の mm_maps（マップ 1 枚 1 行）と mm_settings（フォルダの名前）を直接見る（お金を守るくんの道具と同じ形）。
 * 命名規約：mindmap__<action>
 *
 * 2026-10-18 新設（開発部・AI 連携の段階 A。Naoki「OK」12:51）。
 *   ・Naoki がマップの枝に「AI への指示」を書いておく → Claude が読んで子の枝を足す、の流れのための口
 *   ・Claude は枝を足すことと、チェックを済みにすることだけ。枝の文字の書き換え・削除はしない
 *   ・足した枝には by: "ai" が付き、画面で「AI」の印が出る。残すか捨てるかは Naoki が画面で決める
 *   ・書くときは版（rev）が読んだときと同じ行だけを書き換える。違えば書かずに断る（画面で書いた分を消さないため）
 *   ・最後の保存から 3 分たっていないマップには書かない（画面で書いている最中だと、ぶつかって「写し」ができるため）。
 *     force: true のときだけ書く
 *   ・読むのは Naoki の行だけ（user_id で絞る。画面に入れるのも Naoki の 1 人だけ）
 *
 * 2026-10-24 mindmap__create_map を足した（開発部・統括の依頼・Naoki「OK」19:56）。
 *   ・画面の「新しいマップを作る」（antoshia2n/mindmap の src/engine.js の newMap → src/lib/api.js の createMap）と
 *     同じ欄を同じ値で mm_maps に 1 行足す。拡張機能のパネル（src/panel.js）と同じく、フォルダの中の表（mm_settings の trows）には入れない
 *   ・同じフォルダに同じ名前のマップ（テンプレは除く）があれば作らず、そのマップを返す（呼び直しで 2 枚できないため）
 *   ・フォルダの名前は mm_settings から読む。読めないときは作らずに断る（標準の名前で別のフォルダへ入れないため）
 *
 * 2026-10-25 mindmap__activity を足した（開発部・週間レポートの口 便 2・Naoki「OK」19:34）。
 *   ・期間の日ごと・マップごとに「足した枝・直した枝・消した枝」を数える。読むだけ
 *   ・枝に時刻が無いので、毎朝の控え（保管庫 backup/日付/supabase/mm_maps.json）を隣の日と比べる（src/mindmap-activity.ts）。
 *     今日と、今朝の控えがまだ無いときの昨日は、今の中身と比べる。控えがあるかを日ごとに返す
 */

type Row = Record<string, any>;
const MAP_TABLE = "mm_maps";
const SETTINGS_TABLE = "mm_settings";
/** 思考整理くんに入れる 1 人（画面の wrangler.jsonc の MINDMAP_ALLOW_UID と同じ値。秘密ではない） */
const OWNER_UID = "VrMwzeSceqWeXVQOrm8kpu4uVR33";
const APP_URL = "https://mindmap.shia2n.jp";
const BUSY_MS = 3 * 60 * 1000;
const KINDS: Record<string, string> = { strategy: "戦略", seminar: "セミナー", article: "記事", memo: "メモ" };
const META = "id,title,tags,kind,folder_id,pinned,is_template,body_text,node_count,rev,updated_at";

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
async function sbPost(env: Env, path: string, body: Row): Promise<Row[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method: "POST", headers: sbHeaders(env, { Prefer: "return=representation" }), body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase error ${res.status}: ${await res.text()}`);
  return (await res.json()) as Row[];
}
async function sbPatch(env: Env, path: string, body: Row): Promise<Row[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method: "PATCH", headers: sbHeaders(env, { Prefer: "return=representation" }), body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase error ${res.status}: ${await res.text()}`);
  return (await res.json()) as Row[];
}

const own = `user_id=eq.${OWNER_UID}`;
const jst = (iso: string) => {
  const t = Date.parse(iso); if (!t) return "";
  const d = new Date(t + 9 * 3600 * 1000); const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

/** フォルダの id → 名前。strict なら設定が読めないときに止める（作るときに別のフォルダへ入れないため） */
async function folderNames(env: Env, strict = false): Promise<Map<string, string>> {
  const m = new Map<string, string>(Object.entries(KINDS));
  try {
    const rows = await sbGet(env, `/${SETTINGS_TABLE}?select=data&${own}&limit=1`);
    const fs = rows[0]?.data?.folders;
    if (Array.isArray(fs)) { m.clear(); for (const f of fs) if (f && f.id) m.set(String(f.id), String(f.name || "無題のフォルダ")); }
  } catch (e) { if (strict) throw e; /* 一覧を見るだけのときは標準の名前で返す */ }
  return m;
}
/**
 * 2026-11-03 設定の 1 行（mm_settings）を読む。表への登録で使う。
 * 画面は設定をまるごと保存し直すので、3 分以内に保存された設定には書かない。書くときは読んだときの updated_at の行だけを書き換える
 */
async function readSettings(env: Env): Promise<{ data: any; updated_at: string } | null> {
  const rows = await sbGet(env, `/${SETTINGS_TABLE}?select=data,updated_at&${own}&limit=1`);
  return rows[0] && rows[0].data && typeof rows[0].data === "object" ? { data: rows[0].data, updated_at: rows[0].updated_at } : null;
}
function settingsBusy(s: { updated_at: string }, force?: boolean): string | null {
  if (force) return null;
  const t = Date.parse(s.updated_at);
  if (t && Date.now() - t < BUSY_MS) return `フォルダと表の設定が ${jst(s.updated_at)} に画面で保存されたばかりです。画面で表を触っている最中かもしれないので、書いていません。少し待ってからもう一度呼んでください（Naoki が画面を閉じていると分かっているときだけ force: true）。`;
  return null;
}
async function writeSettings(env: Env, s: { data: any; updated_at: string }): Promise<boolean> {
  const rows = await sbPatch(env, `/${SETTINGS_TABLE}?${own}&updated_at=eq.${encodeURIComponent(s.updated_at)}&select=user_id`, { data: s.data, updated_at: new Date().toISOString() });
  return rows.length > 0;
}
/** マップを表へ入れる（同じフォルダの表だけ）。入れた表の名前を返す。入れられないときは理由を throw */
async function addToTable(env: Env, mapId: string, fid: string, table: string, force?: boolean): Promise<string> {
  const s = await readSettings(env);
  if (!s) throw new Error("フォルダと表の設定を読めませんでした（書いていません）");
  const busy = settingsBusy(s, force); if (busy) throw new Error(busy);
  const t = findTable(s.data, fid, table);
  if (!t) {
    const here = tablesOf(s.data).filter((x) => x.fid === fid).map((x) => x.name);
    throw new Error(`このフォルダに表「${table.trim()}」が見つかりません（このフォルダの表：${here.length ? here.join("・") : "無し"}）`);
  }
  putTrow(s.data, mapId, t.id);
  if (!(await writeSettings(env, s))) throw new Error("読んでから書くまでの間に、画面でフォルダと表の設定が保存されました。書いていません。もう一度呼んでください");
  return t.name;
}

/** フォルダの名前か id を、フォルダの id にする（「未分類」は none）。見つからなければ null */
const resolveFolder = (names: Map<string, string>, folder: string) => {
  const f = folder.trim();
  return f === "未分類" || f === "none" ? "none" : ([...names.entries()].find(([id, n]) => id === f || n === f)?.[0] ?? null);
};
const folderIdOf = (r: Row) => { const v = r.folder_id != null && r.folder_id !== "" ? r.folder_id : r.kind; return !v || v === "none" ? "none" : String(v); };

/** v1.97.0：スライドの台帳から枝の画像を読むため（読むだけ） */
export async function readMapNodes(env: Env, id: string): Promise<{ root: string; nodes: MNodes } | null> {
  const r = await getFull(env, id);
  return r ? { root: String(r.root), nodes: (r.nodes || {}) as MNodes } : null;
}
async function getFull(env: Env, id: string): Promise<Row | null> {
  if (!ID_RE.test(id)) throw new Error("map_id の形が違います（mindmap__list_maps の id を使ってください）");
  const rows = await sbGet(env, `/${MAP_TABLE}?select=${META},root,nodes&id=eq.${id}&${own}&limit=1`);
  return rows[0] ?? null;
}

/** 書く前の確かめ（3 分以内に保存されたマップは、force が無ければ書かない） */
function busyMessage(r: Row, force?: boolean): string | null {
  if (force) return null;
  const t = Date.parse(r.updated_at);
  if (t && Date.now() - t < BUSY_MS) {
    return `このマップは ${jst(r.updated_at)} に保存されたばかりで、Naoki が画面で書いている最中かもしれません。書くとぶつかって「写し」ができるため、書いていません。少し待ってからもう一度呼ぶか、Naoki が画面を閉じていると分かっているときだけ force: true で呼んでください。`;
  }
  return null;
}

/** 版が読んだときと同じ行だけを書き換える */
async function writeNodes(env: Env, r: Row, nodes: MNodes): Promise<{ ok: true; rev: number } | { ok: false; message: string }> {
  const body = {
    nodes, title: titleOf(r.root, nodes), node_count: countNodes(nodes), body_text: bodyOf(nodes),
    rev: (r.rev ?? 1) + 1, updated_at: new Date().toISOString(),
  };
  const rows = await sbPatch(env, `/${MAP_TABLE}?id=eq.${r.id}&${own}&rev=eq.${r.rev ?? 1}&select=id,rev`, body);
  if (!rows.length) return { ok: false, message: "読んでから書くまでの間に、このマップが画面で保存されました。書いていません。もう一度読んでからやり直してください。" };
  return { ok: true, rev: rows[0].rev };
}

export function registerMindmapTools(server: McpServer, env: Env): void {

  // ─── 1. mindmap__list_maps ───────────────────────────────────────
  server.tool(
    "mindmap__list_maps",
    "思考整理くん（Naoki の個人用マインドマップ）のマップの一覧を、最終更新の新しい順で返す。フォルダ（名前か id）・タグ・言葉（名前と中の枝の文字とメモ）で絞れる。テンプレは既定で除く。戻り値: { ok, 件数, 一覧: [{ id, 名前, フォルダ, タグ, 枝の数, ピン留め, 最終更新（日本時間）, 住所 }] }。1 枚の中身は mindmap__get_map で読む。",
    {
      folder: z.string().max(80).optional().describe("フォルダの名前か id（例: アウトプット）。「未分類」も可"),
      tag: z.string().max(80).optional().describe("タグ（# は付けなくてよい）"),
      query: z.string().max(200).optional().describe("名前・枝の文字・メモに含まれる言葉"),
      include_templates: z.boolean().optional().describe("true ならテンプレも含める"),
      limit: z.number().int().min(1).max(200).optional().describe("何件まで（省略時 30）"),
    },
    async ({ folder, tag, query, include_templates, limit }) => {
      try {
        const [rows, names] = await Promise.all([
          sbGet(env, `/${MAP_TABLE}?select=${META}&${own}&order=updated_at.desc`),
          folderNames(env),
        ]);
        let list = rows.filter((r) => include_templates || !r.is_template);
        if (folder) {
          const f = folder.trim();
          const want = resolveFolder(names, f);
          if (!want) return asMcpTextResult({ ok: false, message: `フォルダ「${f}」が見つかりません`, フォルダ: [...names.values()] });
          list = list.filter((r) => (names.has(folderIdOf(r)) ? folderIdOf(r) : "none") === want);
        }
        if (tag) { const t = tag.replace(/^#/, "").trim(); list = list.filter((r) => (r.tags || []).includes(t)); }
        if (query) { const q = query.toLowerCase(); list = list.filter((r) => `${r.title || ""}\n${r.body_text || ""}`.toLowerCase().includes(q)); }
        const total = list.length;
        list = list.slice(0, limit ?? 30);
        return asMcpTextResult({
          ok: true, 件数: total, 返した件数: list.length,
          一覧: list.map((r) => ({
            id: r.id, 名前: r.title || "無題", フォルダ: names.get(folderIdOf(r)) ?? "未分類", // 画面と同じく、無いフォルダの印は未分類として見せる
            タグ: r.tags || [], 枝の数: r.node_count ?? 0, ピン留め: !!r.pinned, テンプレ: !!r.is_template,
            最終更新: jst(r.updated_at), 住所: `${APP_URL}/m/${r.id}`,
          })),
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 2. mindmap__get_map ─────────────────────────────────────────
  server.tool(
    "mindmap__get_map",
    "思考整理くんのマップ 1 枚を、入れ子の箇条書きの文字で返す。map_id には共有リンク（/s/…）やマップの住所（/m/…）も渡せる。各行の末尾の {id} が枝の印で、mindmap__add_branches の足し先や mindmap__mark_done の宛先に使う。行の印：[ ] 未完了のチェック／[x] 済み／(AI) Claude が足してまだ Naoki が残すか決めていない枝。メモと「AI への指示」「スライドの指示」は次の行に字下げして出る。(画像 住所) は枝に貼った画像（開いて見られる）。from_node を渡すとその枝から下だけ。戻り値: { ok, id, 名前, 版, 最終更新, 住所, 箇条書き, AI への指示, 画像: [{ node_id, 枝, url }] }。",
    {
      map_id: z.string().max(300).describe("マップの id（mindmap__list_maps の id）。マップの住所（https://mindmap.shia2n.jp/m/…）や共有リンク（https://mindmap.shia2n.jp/s/…）をそのまま渡してもよい"),
      from_node: z.string().max(64).optional().describe("この枝から下だけ読む（{id}）"),
    },
    async ({ map_id, from_node }) => {
      try {
        // 2026-11-03：共有リンクとマップの住所も受ける（読むだけ。探すのは Naoki のマップの中だけ）
        const ref = parseMapRef(map_id);
        if (!ref) return asMcpTextResult({ ok: false, message: "map_id の形が違います（mindmap__list_maps の id か、mindmap.shia2n.jp の /m/… か /s/… の住所を渡してください）" });
        let id = ref.value;
        if (ref.kind === "share") {
          const hit = await sbGet(env, `/${MAP_TABLE}?select=id&share_token=eq.${encodeURIComponent(ref.value)}&${own}&limit=1`);
          if (!hit[0]?.id) return asMcpTextResult({ ok: false, message: "この共有リンクのマップは見つかりませんでした（共有を止めたか、リンクが違います）" });
          id = String(hit[0].id);
        }
        const r = await getFull(env, id);
        if (!r) return asMcpTextResult({ ok: false, message: "このマップは見つかりませんでした" });
        const nodes = (r.nodes || {}) as MNodes;
        return asMcpTextResult({
          ok: true, id: r.id, 名前: r.title || "無題", 版: r.rev, 最終更新: jst(r.updated_at), 住所: `${APP_URL}/m/${r.id}`,
          箇条書き: toOutline(r.root, nodes, from_node, env.SUPABASE_URL),
          AIへの指示: findRequests(r.root, nodes),
          画像: imagesOf(r.root, nodes, env.SUPABASE_URL, from_node),
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 3. mindmap__list_ai_requests ────────────────────────────────
  server.tool(
    "mindmap__list_ai_requests",
    "Naoki が枝に書いた「AI への指示」が残っている枝を、全部のマップから集めて返す（map_id を渡すとその 1 枚だけ）。テンプレは除く。指示に応えるときは、その枝を mindmap__get_map で読み、mindmap__add_branches で子の枝として足す（足すと指示は消える）。戻り値: { ok, 件数, 一覧: [{ map_id, マップ, node_id, 枝, 道すじ, 指示, 最終更新 }] }。",
    { map_id: z.string().max(64).optional().describe("この 1 枚だけ見る") },
    async ({ map_id }) => {
      try {
        const rows = map_id ? [await getFull(env, map_id)].filter(Boolean) as Row[]
          : await sbGet(env, `/${MAP_TABLE}?select=id,title,root,nodes,is_template,updated_at&${own}&is_template=eq.false&order=updated_at.desc`);
        const out: Row[] = [];
        for (const r of rows) for (const q of findRequests(r.root, r.nodes || {})) out.push({ map_id: r.id, マップ: r.title || "無題", ...q, 最終更新: jst(r.updated_at) });
        return asMcpTextResult({ ok: true, 件数: out.length, 一覧: out });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 4. mindmap__add_branches ────────────────────────────────────
  server.tool(
    "mindmap__add_branches",
    "思考整理くんのマップの枝の子として、新しい枝を足す。足した枝にはすべて「AI」の印が付き、Naoki が画面の右クリックで「残す」か「捨てる」を選ぶ。branches は箇条書きの文字（1 行 1 枝・字下げ 2 つで 1 段深く・「- 」や「・」は付けても付けなくてもよい・[ ] で始めるとチェック・行の末尾を「(リンク https://…)」か素の https://… にするとその枝のリンクになり、押すと開く。mindmap__get_map の行をそのまま書き戻してもよい）。足し先の枝に「AI への指示」があれば、足したあと消す（clear_request: false で残す）。Naoki の枝の文字は書き換えない。最後の保存から 3 分以内のマップには書かない（画面で書いている最中のため。force: true のときだけ書く）。戻り値: { ok, 足した枝の数, 足した枝, 版, 住所 }。",
    {
      map_id: z.string().max(64).describe("マップの id"),
      parent_node_id: z.string().max(64).describe("足し先の枝の {id}（mindmap__get_map で見る）"),
      branches: z.string().min(1).max(20000).describe("足す枝の箇条書き（例: \"- 論点A\\n  - 根拠\\n- 論点B\"）"),
      memo: z.string().max(5000).optional().describe("最初に足す枝に付けるメモ（出どころ・考えた筋など）"),
      clear_request: z.boolean().optional().describe("足し先の「AI への指示」を消すか（省略時 true）"),
      force: z.boolean().optional().describe("3 分以内に保存されたマップにも書く"),
    },
    async ({ map_id, parent_node_id, branches, memo, clear_request, force }) => {
      try {
        const r = await getFull(env, map_id);
        if (!r) return asMcpTextResult({ ok: false, message: "このマップは見つかりませんでした" });
        const busy = busyMessage(r, force); if (busy) return asMcpTextResult({ ok: false, message: busy });
        const items = parseBullets(branches);
        if (!items.length) return asMcpTextResult({ ok: false, message: "足す枝がありません（branches に 1 行以上）" });
        const nodes = JSON.parse(JSON.stringify(r.nodes || {})) as MNodes;
        if (!nodes[parent_node_id]) return asMcpTextResult({ ok: false, message: "足し先の枝が見つかりません（mindmap__get_map の {id} を使ってください）" });
        if (countAll(items) > 300) return asMcpTextResult({ ok: false, message: "一度に足せるのは 300 本までです" });
        const made = addItems(r.root, nodes, parent_node_id, items, memo);
        const hadRequest = !!nodes[parent_node_id].ai;
        if (hadRequest && clear_request !== false) delete nodes[parent_node_id].ai;
        const w = await writeNodes(env, r, nodes);
        if (!w.ok) return asMcpTextResult({ ok: false, message: w.message });
        return asMcpTextResult({
          ok: true, 足した枝の数: made.length, 足し先: pathOf(nodes, parent_node_id),
          足した枝: made.map((id) => ({ id, 枝: nodes[id].text })),
          AIへの指示: hadRequest ? (clear_request !== false ? "消した" : "残した") : "無かった",
          版: w.rev, 住所: `${APP_URL}/m/${r.id}`,
          備考: "画面では「AI」の印付きで出ます。開いていれば 30 秒以内に読み直されます",
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 5. mindmap__mark_done ───────────────────────────────────────
  server.tool(
    "mindmap__mark_done",
    "思考整理くんのマップの枝のチェックを、済み（done: false なら未完了）にする。チェックでない枝はチェックにしてから付ける。最後の保存から 3 分以内のマップには書かない（force: true のときだけ書く）。戻り値: { ok, 変えた, 見つからない, 版 }。",
    {
      map_id: z.string().max(64).describe("マップの id"),
      node_ids: z.array(z.string().max(64)).min(1).max(200).describe("枝の {id} の並び"),
      done: z.boolean().optional().describe("true で済み（省略時）／false で未完了に戻す"),
      force: z.boolean().optional().describe("3 分以内に保存されたマップにも書く"),
    },
    async ({ map_id, node_ids, done, force }) => {
      try {
        const r = await getFull(env, map_id);
        if (!r) return asMcpTextResult({ ok: false, message: "このマップは見つかりませんでした" });
        const busy = busyMessage(r, force); if (busy) return asMcpTextResult({ ok: false, message: busy });
        const nodes = JSON.parse(JSON.stringify(r.nodes || {})) as MNodes;
        const res = markChecks(nodes, node_ids.filter((id) => id !== r.root), done !== false);
        if (!res.変えた.length) return asMcpTextResult({ ok: true, 変えた: [], 見つからない: res.見つからない, 備考: "変える枝がありませんでした（書いていません）" });
        const w = await writeNodes(env, r, nodes);
        if (!w.ok) return asMcpTextResult({ ok: false, message: w.message });
        return asMcpTextResult({ ok: true, 変えた: res.変えた.map((id) => ({ id, 枝: nodes[id].text })), 見つからない: res.見つからない, 版: w.rev });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 6. mindmap__create_map ──────────────────────────────────────
  server.tool(
    "mindmap__create_map",
    "思考整理くんに新しいマップを 1 枚作る（画面の「新しいマップを作る」と同じ形）。name が中心の枝の文字＝マップの名前（例: 26年10月27日｜オンラインビジネス攻略）。folder はフォルダの名前か id（「未分類」も可）。branches を渡すと中心の子として足す（mindmap__add_branches と同じ書き方・行の末尾の「(リンク https://…)」か素の https://… は枝のリンクになる・足した枝にはすべて「AI」の印）。table を渡すと、そのフォルダの中の表に入れる（省略時は表に入れず、画面ではそのフォルダの「表に入っていないマップ」に出る）。同じフォルダに同じ名前のマップがあれば作らず、そのマップを返す。戻り値: 成功 { ok: true, id, 名前, フォルダ, 住所, 足した枝の数 }／作らなかった・失敗 { ok: false, message, 既にある（同じ名前があったとき）, フォルダ（フォルダが見つからないとき） }。",
    {
      name: z.string().min(1).max(200).describe("マップの名前（中心の枝の文字）"),
      folder: z.string().min(1).max(80).describe("フォルダの名前か id（例: アウトプット）。「未分類」も可"),
      branches: z.string().max(20000).optional().describe("最初の枝の箇条書き（省略可・例: \"- 導入\\n  - つかみ\\n- 本題\"）"),
      table: z.string().max(80).optional().describe("作ったマップを入れる、そのフォルダの中の表（名前か id）。省略時は表に入れない"),
    },
    async ({ name, folder, branches, table }) => {
      try {
        const title = cleanName(name);
        if (!title) return asMcpTextResult({ ok: false, message: "名前が空です" });
        let names: Map<string, string>;
        try { names = await folderNames(env, true); }
        catch (e) { return asMcpTextResult({ ok: false, message: `フォルダの設定を読めなかったため、作っていません：${String(e)}` }); }
        const want = resolveFolder(names, folder);
        if (!want) return asMcpTextResult({ ok: false, message: `フォルダ「${folder.trim()}」が見つからないため、作っていません`, フォルダ: [...names.values()] });
        const folderName = want === "none" ? "未分類" : names.get(want)!;

        const rows = await sbGet(env, `/${MAP_TABLE}?select=id,title,kind,folder_id,is_template&${own}`);
        const dup = rows.find((r) => !r.is_template && (names.has(folderIdOf(r)) ? folderIdOf(r) : "none") === want && sameName(r.title || "", title));
        if (dup) {
          return asMcpTextResult({
            ok: false, message: `フォルダ「${folderName}」に同じ名前のマップがあるため、作っていません`,
            既にある: { id: dup.id, 名前: dup.title, フォルダ: folderName, 住所: `${APP_URL}/m/${dup.id}` },
          });
        }

        const items = branches && branches.trim() ? parseBullets(branches) : [];
        if (branches && branches.trim() && !items.length) return asMcpTextResult({ ok: false, message: "最初の枝が読めませんでした（1 行 1 枝の箇条書きで）。作っていません" });
        if (countAll(items) > 300) return asMcpTextResult({ ok: false, message: "一度に足せる枝は 300 本までです。作っていません" });

        const { root, nodes, made } = newMapTree(title, items);
        // 画面の api.js の createMap と同じ欄・同じ値（user_id は画面では入口が押す。ここでは Naoki の印を自分で押す）
        const row = {
          user_id: OWNER_UID, title: titleOf(root, nodes), tags: [], kind: "memo", folder_id: want, is_template: false, pinned: false,
          root, nodes, node_count: countNodes(nodes), body_text: bodyOf(nodes), rev: 1,
        };
        const out = await sbPost(env, `/${MAP_TABLE}?select=id,title,folder_id`, row);
        const m = out[0];
        if (!m?.id) return asMcpTextResult({ ok: false, message: "作ったはずの行が返ってきませんでした。mindmap__list_maps で名前を探して確かめてください" });
        let 表: string | null = null, 表に入れなかった: string | null = null;
        if (table && table.trim()) {
          try { 表 = await addToTable(env, String(m.id), want, table); } catch (e) { 表に入れなかった = e instanceof Error ? e.message : String(e); }
        }
        return asMcpTextResult({
          ok: true, id: m.id, 名前: m.title, フォルダ: folderName, 住所: `${APP_URL}/m/${m.id}`,
          足した枝の数: made.length,
          ...(表 ? { 表 } : {}), ...(表に入れなかった ? { 表に入れなかった } : {}),
          備考: 表 ? "開いたままの画面には、読み直すと出ます" : "フォルダの中の「表に入っていないマップ」に出ます（表へは mindmap__set_table）。開いたままの画面には、読み直すと出ます",
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 7. mindmap__move_branch（2026-11-03）───────────────────────
  server.tool(
    "mindmap__move_branch",
    "思考整理くんのマップで、Claude が足した枝（get_map で (AI) の印の枝）を、同じマップの別の枝の下へ動かす。下の枝もいっしょに動く。Naoki が書いた枝・中心の枝は動かさない。index で並びの位置（0 が先頭・省略で最後）。最後の保存から 3 分以内のマップには書かない（force: true のときだけ書く）。戻り値: { ok, 動かした, 前の場所, 今の場所, 版 }。",
    {
      map_id: z.string().max(64).describe("マップの id"),
      node_id: z.string().max(64).describe("動かす枝の {id}（(AI) の印の枝）"),
      to_node_id: z.string().max(64).describe("動かし先の枝の {id}。この枝の子になる"),
      index: z.number().int().min(0).max(1000).optional().describe("動かし先の子の中の位置（0 が先頭）。省略で最後"),
      force: z.boolean().optional().describe("3 分以内に保存されたマップにも書く"),
    },
    async ({ map_id, node_id, to_node_id, index, force }) => {
      try {
        const r = await getFull(env, map_id);
        if (!r) return asMcpTextResult({ ok: false, message: "このマップは見つかりませんでした" });
        const busy = busyMessage(r, force); if (busy) return asMcpTextResult({ ok: false, message: busy });
        const nodes = JSON.parse(JSON.stringify(r.nodes || {})) as MNodes;
        const before = nodes[node_id]?.parent ? pathOf(nodes, nodes[node_id].parent as string) : "";
        try { moveNode(r.root, nodes, node_id, to_node_id, index); }
        catch (e) { return asMcpTextResult({ ok: false, message: e instanceof Error ? e.message : String(e) }); }
        const w = await writeNodes(env, r, nodes);
        if (!w.ok) return asMcpTextResult({ ok: false, message: w.message });
        return asMcpTextResult({ ok: true, 動かした: nodes[node_id].text, 前の場所: before, 今の場所: pathOf(nodes, to_node_id), 版: w.rev, 住所: `${APP_URL}/m/${r.id}` });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 8. mindmap__set_table（2026-11-03）─────────────────────────
  server.tool(
    "mindmap__set_table",
    "思考整理くんのマップを、そのマップのフォルダの中の表（名前か id）に入れる。画面の表の行に出る。列の値は今のまま残す。ほかのフォルダの表には入れない・表やフォルダは作らない・テンプレは入れない。フォルダと表の設定が 3 分以内に画面で保存されていたら書かない（force: true のときだけ書く）。読んでから書くまでに画面で保存されたら書かずに断る。戻り値: { ok, マップ, フォルダ, 表 }。",
    {
      map_id: z.string().max(300).describe("マップの id（/m/… の住所も可）"),
      table: z.string().min(1).max(80).describe("入れる表の名前か id（そのマップのフォルダの中の表）"),
      force: z.boolean().optional().describe("3 分以内に保存された設定にも書く"),
    },
    async ({ map_id, table, force }) => {
      try {
        const ref = parseMapRef(map_id);
        if (!ref || ref.kind !== "id") return asMcpTextResult({ ok: false, message: "map_id はマップの id か /m/… の住所で渡してください" });
        const rows = await sbGet(env, `/${MAP_TABLE}?select=id,title,kind,folder_id,is_template&id=eq.${ref.value}&${own}&limit=1`);
        const m = rows[0];
        if (!m) return asMcpTextResult({ ok: false, message: "このマップは見つかりませんでした" });
        if (m.is_template) return asMcpTextResult({ ok: false, message: "テンプレは表に入れられません" });
        const names = await folderNames(env);
        const fid = names.has(folderIdOf(m)) ? folderIdOf(m) : "none";
        let 表: string;
        try { 表 = await addToTable(env, String(m.id), fid, table, force); }
        catch (e) { return asMcpTextResult({ ok: false, message: e instanceof Error ? e.message : String(e) }); }
        return asMcpTextResult({ ok: true, マップ: m.title || "無題", フォルダ: fid === "none" ? "未分類" : names.get(fid), 表, 住所: `${APP_URL}/m/${m.id}`, 備考: "開いたままの画面には、30 秒以内か読み直すと出ます" });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── 9. mindmap__delete_map（2026-11-03）────────────────────────
  server.tool(
    "mindmap__delete_map",
    "思考整理くんのマップを 1 枚消す。confirm が無ければ消さずに下見（名前・フォルダ・枝の数・最終更新）だけ返す。消すのは、下見を Naoki に見せて「消してよい」と言われてから confirm: true で呼ぶときだけ。テンプレと、3 分以内に保存されたマップは消さない。画面にゴミ箱は無いが、毎朝の控え（保管庫）から戻せる。戻り値: 下見 { ok, 下見: true, マップ, … }／消した { ok, 消した, … }。",
    {
      map_id: z.string().max(300).describe("マップの id（/m/… の住所も可）"),
      confirm: z.boolean().optional().describe("true で本当に消す（Naoki の「消してよい」を受けてから）"),
    },
    async ({ map_id, confirm }) => {
      try {
        const ref = parseMapRef(map_id);
        if (!ref || ref.kind !== "id") return asMcpTextResult({ ok: false, message: "map_id はマップの id か /m/… の住所で渡してください" });
        const rows = await sbGet(env, `/${MAP_TABLE}?select=id,title,kind,folder_id,is_template,node_count,updated_at&id=eq.${ref.value}&${own}&limit=1`);
        const m = rows[0];
        if (!m) return asMcpTextResult({ ok: false, message: "このマップは見つかりませんでした" });
        if (m.is_template) return asMcpTextResult({ ok: false, message: "テンプレは道具からは消しません（画面で消してください）" });
        const names = await folderNames(env);
        const fid = folderIdOf(m);
        const info = { マップ: m.title || "無題", フォルダ: names.get(fid) ?? "未分類", 枝の数: m.node_count ?? 0, 最終更新: jst(m.updated_at), 住所: `${APP_URL}/m/${m.id}` };
        if (!confirm) return asMcpTextResult({ ok: true, 下見: true, ...info, 備考: "まだ消していません。Naoki に見せて「消してよい」と言われたら confirm: true で呼ぶ。消したあとは毎朝の控えから戻せる" });
        const t = Date.parse(m.updated_at);
        if (t && Date.now() - t < BUSY_MS) return asMcpTextResult({ ok: false, message: `このマップは ${jst(m.updated_at)} に保存されたばかりで、画面で開いている最中かもしれません。消していません` });
        const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${MAP_TABLE}?id=eq.${m.id}&${own}&is_template=eq.false`, { method: "DELETE", headers: sbHeaders(env, { Prefer: "return=representation" }) });
        if (!res.ok) throw new Error(`Supabase error ${res.status}: ${await res.text()}`);
        const gone = (await res.json()) as Row[];
        if (!gone.length) return asMcpTextResult({ ok: false, message: "消せませんでした（行が見つからなかった）" });
        // 表の 1 行（trows）も外す。外せなくても、画面は無いマップの行を出さない
        let 表の行: string = "無かった";
        try {
          const s = await readSettings(env);
          if (s?.data?.trows && s.data.trows[m.id]) { delete s.data.trows[m.id]; 表の行 = (await writeSettings(env, s)) ? "外した" : "外せなかった（画面が先に保存した。害は無い）"; }
        } catch { 表の行 = "外せなかった（害は無い）"; }
        return asMcpTextResult({ ok: true, 消した: info.マップ, ...info, 表の行, 備考: "戻すときは毎朝の控え（backup/日付/supabase/mm_maps.json）から" });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );

  // ─── mindmap__activity ───────────────────────────────────────────
  server.tool(
    "mindmap__activity",
    "思考整理くんで、期間（from〜to・日本時間・最大 31 日）の日ごと・マップごとに「足した枝」「直した枝」「消した枝」の数を返す。読むだけ。枝には時刻が無いので、毎朝の控え（4〜6 時台に取る）を隣の日と比べて数える。1 日は「その日の朝の控え〜次の日の朝の控え」で、今日の分は今の中身と比べる。同じ日に何度直しても 1。マップの名前の枝とテンプレは数えない。控え に日ごとの控えの有無と時刻、数えられない に控えが無くて数えなかった日。map でマップの名前か id に絞れる。戻り値: { ok, 期間, 区切り, 控え, 日ごと: [{ 日, 足した, 直した, 消した, マップ }], マップごと: [{ id, 名前, 足した, 直した, 消した, 日ごと }], 数えられない }。",
    {
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("最初の日 YYYY-MM-DD（日本時間）"),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("最後の日 YYYY-MM-DD。省略時は from と同じ"),
      map: z.string().max(120).optional().describe("このマップだけ（名前の一部か id）"),
    },
    async ({ from, to, map }) => {
      try {
        const last = to ?? from;
        if (last < from) return asMcpTextResult({ ok: false, message: "to は from 以後の日付にしてください" });
        const days = datesBetween(from, last);
        if (days.length > 31) return asMcpTextResult({ ok: false, message: "一度に数えられるのは 31 日までです" });
        if (!env.BACKUP_BUCKET) return asMcpTextResult({ ok: false, message: "保管庫（R2）が結び付いていません" });
        const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
        // 要る控え：from〜（to の次の日と今日の早いほう）。大きいので 1 日ずつ読んで縮める
        const need = datesBetween(from, nextDate(last) < today ? nextDate(last) : today);
        const snaps = new Map<string, Snap>(), at = new Map<string, string>();
        const backups: Row[] = [];
        for (const d of need) {
          const obj = await env.BACKUP_BUCKET.get(`backup/${d}/supabase/${MAP_TABLE}.json`);
          if (!obj) { backups.push({ 日: d, ある: false }); continue; }
          const rows = JSON.parse(await obj.text());
          if (!Array.isArray(rows)) { backups.push({ 日: d, ある: false, 理由: "控えの形が読めない" }); continue; }
          snaps.set(d, reduceRows(rows, OWNER_UID));
          at.set(d, jst(obj.uploaded.toISOString()));
          backups.push({ 日: d, ある: true, 取った時刻: at.get(d) });
        }
        const useLive = nextDate(last) >= today;
        const live = useLive ? reduceRows(await sbGet(env, `/${MAP_TABLE}?select=id,user_id,title,is_template,root,nodes&${own}`), OWNER_UID) : null;
        const liveAt = jst(new Date().toISOString());
        const q = map?.trim();
        const pick = (id: string, title: string) => !q || id === q || title.includes(q);
        const counted = countDays(days, today, snaps, at, live, liveAt);
        const byMap = new Map<string, Row>();
        const 日ごと: Row[] = [], 数えられない: Row[] = [];
        for (const c of counted) {
          if ("missing" in c) { 数えられない.push({ 日: c.day, 理由: c.missing }); continue; }
          const ms = c.maps.filter(m => pick(m.id, m.title));
          const sum = (k: "added" | "edited" | "removed") => ms.reduce((n, m) => n + m[k], 0);
          日ごと.push({
            日: c.day, 比べた: `${c.from} → ${c.to}`, 足した: sum("added"), 直した: sum("edited"), 消した: sum("removed"),
            マップ: ms.map(m => ({ id: m.id, 名前: m.title, 足した: m.added, 直した: m.edited, 消した: m.removed, ...(m.created ? { 新しいマップ: true } : {}), ...(m.deleted ? { 消えたマップ: true } : {}) })),
          });
          for (const m of ms) {
            const e = byMap.get(m.id) ?? { id: m.id, 名前: m.title, 足した: 0, 直した: 0, 消した: 0, 日ごと: [] as Row[], 住所: `${APP_URL}/m/${m.id}` };
            e.名前 = m.title; e.足した += m.added; e.直した += m.edited; e.消した += m.removed;
            e.日ごと.push({ 日: c.day, 足した: m.added, 直した: m.edited, 消した: m.removed });
            byMap.set(m.id, e);
          }
        }
        return asMcpTextResult({
          ok: true, 期間: `${from}〜${last}`,
          区切り: "1 日＝その日の朝の控え〜次の日の朝の控え（控えは毎朝 4〜6 時台）。今日の分は今の中身と比べる。同じ日に何度直しても 1",
          控え: backups,
          日ごと,
          マップごと: [...byMap.values()].sort((a, b) => b.足した + b.直した - (a.足した + a.直した)),
          数えられない,
        });
      } catch (e) { return asMcpTextResult({ ok: false, message: String(e) }); }
    }
  );
}

function countAll(items: { children: any[] }[]): number { let n = 0; for (const i of items) n += 1 + countAll(i.children); return n; }
