import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import {
  type MNodes, ID_RE, addItems, bodyOf, countNodes, findRequests, markChecks, parseBullets, pathOf, titleOf, toOutline,
} from "./mindmap-core.js";

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

async function folderNames(env: Env): Promise<Map<string, string>> {
  const m = new Map<string, string>(Object.entries(KINDS));
  try {
    const rows = await sbGet(env, `/${SETTINGS_TABLE}?select=data&${own}&limit=1`);
    const fs = rows[0]?.data?.folders;
    if (Array.isArray(fs)) { m.clear(); for (const f of fs) if (f && f.id) m.set(String(f.id), String(f.name || "無題のフォルダ")); }
  } catch { /* 設定が読めないときは標準の名前で返す */ }
  return m;
}
const folderIdOf = (r: Row) => { const v = r.folder_id != null && r.folder_id !== "" ? r.folder_id : r.kind; return !v || v === "none" ? "none" : String(v); };

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
          const want = f === "未分類" ? "none" : ([...names.entries()].find(([id, n]) => id === f || n === f)?.[0] ?? null);
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
    "思考整理くんのマップ 1 枚を、入れ子の箇条書きの文字で返す。各行の末尾の {id} が枝の印で、mindmap__add_branches の足し先や mindmap__mark_done の宛先に使う。行の印：[ ] 未完了のチェック／[x] 済み／(AI) Claude が足してまだ Naoki が残すか決めていない枝。メモと「AI への指示」は次の行に字下げして出る。from_node を渡すとその枝から下だけ。戻り値: { ok, id, 名前, 版, 最終更新, 住所, 箇条書き, AI への指示 }。",
    {
      map_id: z.string().max(64).describe("マップの id（mindmap__list_maps の id）"),
      from_node: z.string().max(64).optional().describe("この枝から下だけ読む（{id}）"),
    },
    async ({ map_id, from_node }) => {
      try {
        const r = await getFull(env, map_id);
        if (!r) return asMcpTextResult({ ok: false, message: "このマップは見つかりませんでした" });
        const nodes = (r.nodes || {}) as MNodes;
        return asMcpTextResult({
          ok: true, id: r.id, 名前: r.title || "無題", 版: r.rev, 最終更新: jst(r.updated_at), 住所: `${APP_URL}/m/${r.id}`,
          箇条書き: toOutline(r.root, nodes, from_node),
          AIへの指示: findRequests(r.root, nodes),
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
    "思考整理くんのマップの枝の子として、新しい枝を足す。足した枝にはすべて「AI」の印が付き、Naoki が画面の右クリックで「残す」か「捨てる」を選ぶ。branches は箇条書きの文字（1 行 1 枝・字下げ 2 つで 1 段深く・「- 」や「・」は付けても付けなくてもよい・[ ] で始めるとチェック）。足し先の枝に「AI への指示」があれば、足したあと消す（clear_request: false で残す）。Naoki の枝の文字は書き換えない。最後の保存から 3 分以内のマップには書かない（画面で書いている最中のため。force: true のときだけ書く）。戻り値: { ok, 足した枝の数, 足した枝, 版, 住所 }。",
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
}

function countAll(items: { children: any[] }[]): number { let n = 0; for (const i of items) n += 1 + countAll(i.children); return n; }
