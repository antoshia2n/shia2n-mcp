/**
 * shia2n-mcp / src/slides.ts / 新設（2026-11-13 開発部・スライド制作 便1・v1.94.0）
 *
 * 思考整理くんのマップから GPT がスライドを描くための「台帳」と道具。作る前の 1 枚に Naoki OK（2026-11-13 23:34）。
 *   ・台帳＝1 デッキ 1 冊（KV の slide_deck:<id>）。マップの住所・トーンの型・各スライド（番号・役割・見出し・中身・絵の指示・素材・いまの画像・版・直しの指示・済み）
 *   ・画像は R2（BACKUP_BUCKET の slides/ の下）。見る住所は /slides/img/<deck>/<file>（デッキの id と画像の名前は推測できない乱数）
 *   ・スライド制作スキル（手順）は SKILL としてここに置き、slides__get が毎回返す。GPT のプロジェクトの指示は「最初に slides__get」の 1 行で済む（重くしない・直すのはここ 1 か所）
 *   ・セッションをまたいでも、台帳を読めばどこまでできたかがわかる（status と各スライドの state）
 * 実績のスクショなど「実物の素材」は AI に描き直させない（数字や文字が変わるため）。便2 で空き枠へはめ込む。便1 では素材は台帳に記録するだけ
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./index.js";

export const DECK_PREFIX = "slide_deck:";
export const INDEX_KEY = "slide_decks_index_v1";
export const IMG_PATH = "/slides/img/";
const ORIGIN = "https://shia2n-mcp.gameister1.workers.dev";

export const ROLES = ["表紙", "章", "本題", "図解", "実績", "まとめ"] as const;
export type Role = (typeof ROLES)[number];
export type SlideState = "plan" | "drawn" | "redo" | "ok";
export type Slide = {
  no: number; role: Role; title: string; body: string; visual: string;
  node_ids: string[]; materials: { url: string; note?: string }[];
  image?: { file: string; url: string; v: number; at: string; text_check?: string };
  feedback?: string; state: SlideState;
};
export type Deck = {
  v: 1; id: string; title: string; map_id: string; map_url: string;
  tone: { name: string; rules: string; anchors: number[] };
  status: "plan" | "plan_ok" | "drawing" | "done";
  slides: Slide[]; created_at: string; updated_at: string; log: string[];
};

/** スライド制作スキル（GPT が毎回読む手順）。直すときはここだけ */
export const SKILL = `【スライド制作スキル v1（シアニンのセミナー用）】
目的：思考整理くんのマップの内容を、見た目がリッチで、トーンが全部そろったスライドにする。考える（中身）はシアニン、デザインと描くのはあなた。
0. いつも最初に slides__get で台帳を読む。続きは台帳の status と各枚の state から始める（会話の記憶に頼らない）
1. 台本（status=plan）：mindmap__get_map でマップを読み、1枚＝伝えることが1つになるように台本を作り、slides__put_plan で全部の枚を書く。枚数の上限は無い。役割は 表紙・章・本題・図解・実績・まとめ のどれか。見出しは短く（全角18字まで）、中身は話す人の補助なので1枚に3行まで。枝に付いた素材（materials）はその枚に残す。書いたら一覧をシアニンに見せて OK をもらう（OK なら slides__put_plan の plan_ok=true）
2. 見本（トーンの固定）：最初に表紙と本題の2枚だけを描いて見せる。シアニンが「これ」と言った枚を slides__set_tone の anchors に入れる。以降は必ず、その見本の画像と同じ色・字・余白・飾りで描く（言葉だけで描くとずれる。見本を添えて描く）
3. 描く：横長16:9。1回に描くのは5枚まで（多すぎると上限に当たる・止まっても台帳から続きができる）。描いたら slides__put_image で1枚ずつ書き戻す
4. 字の読み直し：描いた画像の中の字を読み直し、台帳の見出し・中身と1字でも違えば、その枚だけ描き直す。読み直した字は put_image の text_check に入れる
5. 実物の素材（実績のスクショ・数字の画像など）は絶対に描き直さない。その枚は「素材を入れる空き枠」を残したデザインにする（はめ込みは仕組みがやる）
6. 直し：シアニンが「◯枚目を…」と言ったら slides__feedback に書き、その枚だけ描き直す。台帳の直しの指示（feedback）が残っている枚も同じ
7. 全部の枚が ok になったら status を done にする（slides__set_status）
トーンの決まり（rules）は台帳の tone に書く。デッキごとに変えてよいが、同じデッキの中では変えない。`;

export const newId = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

export function parseDeck(v: unknown): Deck | null {
  if (!v || typeof v !== "object") return null;
  const d = v as Deck;
  if (d.v !== 1 || typeof d.id !== "string" || !Array.isArray(d.slides)) throw new Error("台帳の形が読めません。止めました");
  return d;
}

/** 台本を入れる。番号は 1 から振り直す。描いた画像は、同じ番号で見出しが同じなら残す */
export function applyPlan(deck: Deck, plan: Omit<Slide, "state" | "no" | "image">[], ok: boolean): Deck {
  const old = new Map(deck.slides.map(s => [s.no, s]));
  const slides: Slide[] = plan.map((p, i) => {
    const no = i + 1, prev = old.get(no);
    const keep = prev?.image && prev.title === p.title && prev.body === p.body;
    return {
      no, role: ROLES.includes(p.role) ? p.role : "本題", title: p.title.trim(), body: (p.body || "").trim(), visual: (p.visual || "").trim(),
      node_ids: p.node_ids || [], materials: p.materials || [], ...(keep ? { image: prev!.image, state: prev!.state } : { state: "plan" as const }),
      ...(prev?.feedback && keep ? { feedback: prev.feedback } : {}),
    };
  });
  return { ...deck, slides, status: ok ? "plan_ok" : "plan", updated_at: nowIso(), log: [...deck.log, `${nowIso()} 台本 ${slides.length} 枚${ok ? "（OK）" : ""}`].slice(-50) };
}

/** 次に描く枚（直しの指示がある枚 → まだ描いていない枚の順・見本の枚は先） */
export function nextToDraw(deck: Deck, max = 5): number[] {
  const redo = deck.slides.filter(s => s.state === "redo").map(s => s.no);
  const plan = deck.slides.filter(s => s.state === "plan").map(s => s.no);
  return [...redo, ...plan].slice(0, max);
}

export function summary(deck: Deck) {
  const c = (st: SlideState) => deck.slides.filter(s => s.state === st).length;
  return { total: deck.slides.length, plan: c("plan"), drawn: c("drawn"), redo: c("redo"), ok: c("ok") };
}

async function loadDeck(env: Env, id: string): Promise<Deck> {
  const d = parseDeck(await env.OAUTH_KV.get(DECK_PREFIX + id, "json"));
  if (!d) throw new Error(`台帳 ${id} がありません`);
  return d;
}
async function saveDeck(env: Env, d: Deck): Promise<void> {
  d.updated_at = nowIso();
  await env.OAUTH_KV.put(DECK_PREFIX + d.id, JSON.stringify(d));
  const idx = ((await env.OAUTH_KV.get(INDEX_KEY, "json")) as { id: string; title: string; at: string }[] | null) || [];
  const rest = idx.filter(x => x.id !== d.id);
  await env.OAUTH_KV.put(INDEX_KEY, JSON.stringify([{ id: d.id, title: d.title, at: d.updated_at }, ...rest].slice(0, 200)));
}
const ok = (p: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(p, null, 2) }] });
const view = (d: Deck) => ({ ok: true, deck: d, summary: summary(d), next_to_draw: nextToDraw(d), skill: SKILL });

const MaterialZ = z.object({ url: z.string().url(), note: z.string().max(200).optional() });
const PlanZ = z.object({
  role: z.enum(ROLES), title: z.string().min(1).max(60), body: z.string().max(600).optional(),
  visual: z.string().max(600).optional().describe("絵の指示（何を描くか・図解の形）"),
  node_ids: z.array(z.string().max(64)).max(20).optional().describe("もとになった枝の {id}"),
  materials: z.array(MaterialZ).max(6).optional().describe("実物の素材（描き直さない）"),
});
const OpenAIFile = z.object({ download_url: z.string(), file_id: z.string(), mime_type: z.string().optional(), file_name: z.string().optional() });

export const SLIDE_TOOLS = ["slides__start", "slides__list", "slides__get", "slides__put_plan", "slides__set_tone", "slides__put_image", "slides__feedback", "slides__set_status"] as const;

export function registerSlideTools(server: McpServer, env: Env): void {
  server.tool("slides__start",
    "思考整理くんのマップからスライドの台帳（1 デッキ）を作る。map_id はマップの id か住所。作ったら同じ返り値の skill（スライド制作スキル）の手順どおりに進める。戻り値: { ok, deck, summary, next_to_draw, skill }",
    { map_id: z.string().min(1).max(300), title: z.string().min(1).max(120), tone_name: z.string().max(60).optional(), tone_rules: z.string().max(3000).optional().describe("色・字・余白・飾りの決まり") },
    async (a) => {
      const id = newId(), at = nowIso();
      const m = a.map_id.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      const d: Deck = { v: 1, id, title: a.title, map_id: m ? m[0] : a.map_id, map_url: m ? `https://mindmap.shia2n.jp/m/${m[0]}` : a.map_id,
        tone: { name: a.tone_name || "シアニン標準", rules: a.tone_rules || "", anchors: [] }, status: "plan", slides: [], created_at: at, updated_at: at, log: [`${at} 作った`] };
      await saveDeck(env, d);
      return ok(view(d));
    });
  server.tool("slides__list", "スライドの台帳の一覧（新しい順）。続きをするデッキを探すときに使う。戻り値: { ok, decks: [{ id, title, at }] }", {},
    async () => ok({ ok: true, decks: ((await env.OAUTH_KV.get(INDEX_KEY, "json")) as unknown[]) || [] }));
  server.tool("slides__get", "スライドの台帳を読む（いつも最初に呼ぶ）。どこまでできたか（summary・各枚の state）、次に描く枚（next_to_draw）、見本の画像の住所、スライド制作スキル（skill）が返る。戻り値: { ok, deck, summary, next_to_draw, skill }",
    { deck_id: z.string().uuid() }, async (a) => ok(view(await loadDeck(env, a.deck_id))));
  server.tool("slides__put_plan", "台本（全部の枚）を書く。並びの順が番号になる（1 から）。見出しと中身が変わっていない枚の画像は残る。plan_ok=true はシアニンが台本に OK を言ったときだけ。戻り値: { ok, deck, summary }",
    { deck_id: z.string().uuid(), slides: z.array(PlanZ).min(1).max(200), plan_ok: z.boolean().optional() },
    async (a) => { const d = applyPlan(await loadDeck(env, a.deck_id), a.slides as Omit<Slide, "state" | "no" | "image">[], !!a.plan_ok); await saveDeck(env, d); return ok(view(d)); });
  server.tool("slides__set_tone", "トーンの型を決める。anchors＝見本にする枚の番号（シアニンが「これ」と言った枚・1〜3 枚）。rules＝色・字・余白・飾りの決まり。同じデッキの中では見本を変えない。戻り値: { ok, deck }",
    { deck_id: z.string().uuid(), anchors: z.array(z.number().int().min(1)).max(3).optional(), rules: z.string().max(3000).optional(), name: z.string().max(60).optional() },
    async (a) => {
      const d = await loadDeck(env, a.deck_id);
      if (a.anchors) { const bad = a.anchors.filter(n => !d.slides.find(s => s.no === n)?.image); if (bad.length) return ok({ ok: false, error: `${bad.join("・")} 枚目はまだ描いていないので見本にできません` }); d.tone.anchors = a.anchors; }
      if (a.rules != null) d.tone.rules = a.rules; if (a.name) d.tone.name = a.name;
      d.log = [...d.log, `${nowIso()} トーン（見本 ${d.tone.anchors.join("・") || "なし"}）`].slice(-50);
      await saveDeck(env, d); return ok(view(d));
    });
  (server as any).registerTool("slides__put_image", {
    description: "描いた 1 枚の画像をファイルのまま書き戻す（no＝何枚目か）。text_check に、画像の中の字を読み直した結果を入れる（台帳の見出し・中身と違えば描き直してから書き戻す）。版が 1 つ上がり、その枚は drawn になる。戻り値: { ok, slide, summary, next_to_draw }",
    inputSchema: { deck_id: z.string().uuid(), no: z.number().int().min(1), file: OpenAIFile, text_check: z.string().max(2000).optional() },
    _meta: { "openai/fileParams": ["file"] },
  }, async (a: { deck_id: string; no: number; file: { download_url: string; mime_type?: string }; text_check?: string }) => {
    const d = await loadDeck(env, a.deck_id);
    const s = d.slides.find(x => x.no === a.no);
    if (!s) return ok({ ok: false, error: `${a.no} 枚目は台本にありません` });
    if (!/^https:\/\//.test(a.file.download_url || "")) return ok({ ok: false, error: "https の住所ではありません" });
    const res = await fetch(a.file.download_url);
    if (!res.ok) return ok({ ok: false, error: `画像を読めません（${res.status}）` });
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 12 * 1024 * 1024) return ok({ ok: false, error: "12MB を超えています" });
    const type = (a.file.mime_type || res.headers.get("content-type") || "image/png").split(";")[0];
    const ext = type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : "png";
    const v = (s.image?.v || 0) + 1, file = `${String(a.no).padStart(3, "0")}-v${v}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    await env.BACKUP_BUCKET.put(`slides/${d.id}/${file}`, buf, { httpMetadata: { contentType: type } });
    s.image = { file, url: `${ORIGIN}${IMG_PATH}${d.id}/${file}`, v, at: nowIso(), ...(a.text_check ? { text_check: a.text_check } : {}) };
    s.state = "drawn"; delete s.feedback;
    if (d.status === "plan_ok") d.status = "drawing";
    d.log = [...d.log, `${nowIso()} ${a.no} 枚目 v${v}`].slice(-50);
    await saveDeck(env, d);
    return ok({ ok: true, slide: s, summary: summary(d), next_to_draw: nextToDraw(d) });
  });
  server.tool("slides__feedback", "1 枚への直しの指示を書く（シアニンの言葉のまま）。その枚は redo になり、次に描く枚の先頭に来る。ok=true はシアニンがその枚に OK を言ったとき（state を ok にする）。戻り値: { ok, slide }",
    { deck_id: z.string().uuid(), no: z.number().int().min(1), text: z.string().max(2000).optional(), ok: z.boolean().optional() },
    async (a) => {
      const d = await loadDeck(env, a.deck_id); const s = d.slides.find(x => x.no === a.no);
      if (!s) return ok({ ok: false, error: `${a.no} 枚目は台本にありません` });
      if (a.ok) { s.state = "ok"; delete s.feedback; } else if (a.text) { s.feedback = a.text; s.state = "redo"; }
      await saveDeck(env, d); return ok({ ok: true, slide: s, summary: summary(d) });
    });
  server.tool("slides__set_status", "デッキの状態を変える（done＝全部の枚が ok になったとき）。戻り値: { ok, deck }",
    { deck_id: z.string().uuid(), status: z.enum(["plan", "plan_ok", "drawing", "done"]) },
    async (a) => { const d = await loadDeck(env, a.deck_id); d.status = a.status; await saveDeck(env, d); return ok({ ok: true, deck: { id: d.id, status: d.status }, summary: summary(d) }); });
}

/** /slides/img/<deck>/<file> を返す（読むだけ・名前は推測できない乱数） */
export async function handleSlideImage(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  const m = new URL(request.url).pathname.slice(IMG_PATH.length).match(/^([0-9a-f-]{36})\/(\d{3}-v\d+-[0-9a-f]{8}\.(png|jpg|webp))$/);
  if (!m) return new Response("Not Found", { status: 404 });
  const obj = await env.BACKUP_BUCKET.get(`slides/${m[1]}/${m[2]}`);
  if (!obj) return new Response("Not Found", { status: 404 });
  return new Response(obj.body, { headers: { "Content-Type": obj.httpMetadata?.contentType || "image/png", "Cache-Control": "public, max-age=31536000, immutable" } });
}
