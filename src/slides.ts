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
import { imgUrlOf, type MNodes } from "./mindmap-core.js";
import { readMapNodes } from "./tools-mindmap.js";

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
  /** v1.98.0（便4a）：Google スライドへ書き出すための配置表（字は入力欄・面と線は図形・絵は字の無い画像） */
  layout?: { v: number; at: string; image_v: number; items: LayoutItem[] };
};
/** 1920×1080 の座標。字は実際のフォントで組む（Google スライドでは Noto Sans JP） */
export type TextRun = { text: string; color?: string; weight?: number };
export type LayoutItem =
  | { type: "text"; x: number; y: number; w: number; h: number; text?: string; runs?: TextRun[]; size: number; weight?: number; color?: string; align?: "left" | "center" | "right"; valign?: "top" | "middle" | "bottom"; line?: number }
  | { type: "rect"; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; stroke_w?: number }
  | { type: "line"; x: number; y: number; w: number; h: number; color?: string; stroke_w?: number; arrow?: boolean }
  | { type: "image"; x: number; y: number; w: number; h: number; src: string; url?: string };
export type Deck = {
  v: 1; id: string; title: string; map_id: string; map_url: string;
  tone: { name: string; rules: string; anchors: number[]; refs?: { url: string; note?: string }[] };
  status: "plan" | "plan_ok" | "drawing" | "done";
  slides: Slide[]; created_at: string; updated_at: string; log: string[];
};

/** スライド制作スキル（GPT が毎回読む手順）。直すときはここだけ
 * v2（2026-11-14 v1.96.0）：GPT と Naoki が「オンラインビジネスの攻略手順」で 24・35 枚目を仕上げたやり方（Naoki「初めて90点以上」「これを求めた」）を、デッキをまたいで使える手順にした。
 * 見た目（色・字・絵の作り）はデッキの tone.rules、作り方（具体化・組み方・確かめ方・直し方）はここ、と分ける */
export const SKILL = `【スライド制作スキル v2.3（シアニン式スライドデザイン）】
目的：思考整理くんのマップの内容を、受講者が「何を見て・どう考え・次に何をするか」までわかる、具体的でリッチな図解のスライドにする。中身を考えるのはシアニン、意図を補って図解に組み、描くのはあなた。
■ 進め方
0. いつも最初に slides__get で台帳を読む。続きは台帳の status・各枚の state・next_to_draw から始める。会話の記憶や引き継ぎの資料より台帳を正とし、シアニンの最新の指示をいちばん上に置く
1. 台本（status=plan）：mindmap__get_map でマップと、枝に付いた関連マップ・リンクを読む。1枚に持ち帰る結論は1つ。見出しは結論の形で短く（全角18字まで）。本文は主要メッセージ3行まで（補助のラベル・具体例・注釈は読みやすさを保てば足してよい）。役割は 表紙・章・本題・図解・実績・まとめ。素材（materials）とnode_idsは消さない。枝に貼った画像は、put_plan のときにその枚（node_ids の枝とその下の枝）の素材へ自動で入る（get_map の「画像」と各行の (画像 住所) でも見える）。枝の「スライドの指示」（種類・参考・デザイン）は台本と絵の指示に反映する。参考にスワイプくんの住所（id 入り）があれば、その画像も put_plan のときに素材へ自動で入る。シアニンが「◯枚目にスワイプくんの△△を入れて」と言ったら slides__find_material で探して候補を見せ、選ばれたものを slides__add_material で入れてから描き直す。参考にした画像のデザインは、決まりだけを取り出して使い、そのまま写さない。一覧を見せて OK をもらったら slides__put_plan の plan_ok=true
2. 見本：返り値の anchor_images（見本の画像）を毎回実際に開いて見てから描く。見本が無いデッキは、表紙と本題を1枚ずつ描いて見せ、シアニンが「これ」と言った枚を slides__set_tone の anchors に入れる。見た目を決めたら、色は色番号まで・書体と太さ・字の大きさ・線・余白・絵の作り・使わないものを rules に具体的に書く。前のデッキの見た目を引き継ぐときは slides__start の tone_from
3. 1枚を組む手順（具体化がいちばん大事）
 a. その枚の枝と関連資料を読む（短い台本だけを材料にしない）
 b.「受講者に何を見て、どう考え、何をしてほしいか」を1文で決める
 c. 合う具体物を選ぶ：実物に近い画面への注釈、同じ軸での採点比較、工程、判断の分岐、直す前と後、記録の例。文章＋飾りのアイコンだけで終わらせない。すべてを表や3列にせず、意図に合う形を選ぶ
 d. 観察した事実／解釈・仮説／次に試すこと、を見た目で分ける。その1枚に要る範囲だけ
 e. 原文の事実と、説明のための仮の例を分ける。仮の点数・架空の画面には「説明用の例」「イメージ」と書く。数字や点の差だけで原因を言い切らない。確かめていない実績は作らない
 f. 情報を増やしても、結論＞説明＞補助の強弱、余白、読む順（左→右・上→下）を保つ。視線が最後に着く場所を決める
4. 組み方：字・表・数字・棒・矢印は、できるだけ実際のフォント（rules の書体）でベクターに組む（PDF）。生成画像はイラスト・画面のモックなど要る部分だけに使う。字を画像生成に任せると崩れる
5. 描く：横長16:9（1920×1080）。1回5枚まで。描いたら PDF と台帳に置く PNG の両方を、仕上がったものから描き出して目で確かめ、slides__put_image で1枚ずつ書き戻す。続けて同じ1枚を slides__put_layout で配置表として書き戻す（Google スライドで字を直せる形にするため）：字は text（字・位置・大きさ・太さ・色。1字も変えない。色違いの語は runs）、薄い面と枠は rect、見出しの下の線や矢印は line、イラストと画面のモックは字の無い絵として files で渡し image の src を art:1… にする（絵の中に字を入れない。ボタンの字なども text で上に重ねる）、素材は material:1…。PNG と同じ見た目になる座標で組む。PNG を描き直したら配置表も入れ直す（slides__get の layout.stale に出る）
6. 字の読み直し：描き出した画像の字・数字を読み直し、台帳と1字でも違えば、または字化け・切れ・重なりがあれば、その枚を作り直す。確かめた中身を text_check に書く
7. 素材（materials の画像・実績のスクショ・数字の画像など）は、住所を開いて実物を見てから、その画像そのものを置く。切り抜き・拡大縮小・枠付け・横に注釈は可。描き直し・生成し直し・色や字の書き換え・読めない大きさへの縮小は不可。素材の数字や名前を本文で言い換えない。text_check に「素材○枚をそのまま配置」と書く
8. 見出しや中身を変えたら、画像だけでなく slides__put_plan で台帳も直す（node_ids と素材は残す）
■ 直し
9. 「◯枚目を…」は slides__feedback に書き、その枚だけ描き直す。見た目についての指示がその1枚だけで終わらないもの（色・絵の作り・密度など）は、rules と見本も直し、描き終えた枚をそろえ直す対象にする
10. 音声でまとめて直すとき：文字起こしの原文を残したまま、枚ごとの直し・全体の決まり・残すもの・OK・対象があいまいなもの に分ける。番号とタイトルの両方で照らし合わせる（話した順とデッキの番号を混ぜない）。対象がはっきりしたものは slides__feedback、全体の決まりは slides__set_tone。あいまいなものだけまとめて聞き、はっきりしたものは先に進める。数字・名前・否定を推測で直さない。「このままで」と言われた枚だけ ok=true にし、好意的な感想を他の枚の OK に広げない。終わったら「番号／変えたこと／残したもの／保留」を短く返す
11. 全部の枚が ok になったら slides__set_status で done にする。Google スライドが要るときは slides__export_gslides（配置表の無い枚は画像1枚で出るので、先に layout.missing を埋める）
見た目（rules）はデッキごと。同じデッキの中では変えず、変えるときは見本ごと変えて描き終えた枚をそろえ直す。`;

export const newId = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

export function parseDeck(v: unknown): Deck | null {
  if (!v || typeof v !== "object") return null;
  const d = v as Deck;
  if (d.v !== 1 || typeof d.id !== "string" || !Array.isArray(d.slides)) throw new Error("台帳の形が読めません。止めました");
  return d;
}

/** 台本を入れる。番号は 1 から振り直す。描いた画像は、同じ番号で見出しが同じなら残す */
/** v1.98.0（便4a）：配置表の画像の src（art:N＝今回渡した字の無い絵の N 枚目・material:N＝その枚の素材の N 番目・https の住所）を住所に直す。直せないものは理由を返す */
export function resolveLayout(items: LayoutItem[], art: string[], materials: { url: string }[]): { items: LayoutItem[]; errors: string[] } {
  const errors: string[] = [];
  const out = items.map((it, i) => {
    if (it.type !== "image") return it;
    let url: string | undefined;
    const m = it.src.match(/^(art|material):(\d+)$/);
    if (m) url = m[1] === "art" ? art[+m[2] - 1] : materials[+m[2] - 1]?.url;
    else if (/^https:\/\//.test(it.src)) url = it.src;
    if (!url) errors.push(`${i + 1} 番目の画像 ${it.src} が見つかりません`);
    return { ...it, url };
  });
  for (const [i, it] of items.entries()) {
    if (it.type === "text" && !(it.text || (it.runs && it.runs.length))) errors.push(`${i + 1} 番目の字が空です`);
    if (it.x < -10 || it.y < -10 || it.x + it.w > 1930 || it.y + it.h > 1090) errors.push(`${i + 1} 番目が 1920×1080 の外にはみ出しています`);
  }
  return { items: out, errors };
}

/** v1.97.0（便2）：台本の各枚に、node_ids の枝とその下の枝に貼った画像を素材として足す。
 * 下の枝が別の枚の node_ids に入っているときは、その枚のものとして数える（同じ画像を2枚に入れない）。すでにある住所は足さない。1枚6つまで */
/** v1.99.0（便5a）：枝の「スライドの指示」の参考（ref）に書かれたスワイプくんの id（住所の中の uuid）を集める */
export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
export function refIdsOf(nodes: MNodes): string[] {
  const out = new Set<string>();
  for (const n of Object.values(nodes || {})) for (const m of String(n.slide?.ref || "").match(UUID_RE) || []) out.add(m.toLowerCase());
  return [...out];
}
export type SwipeHit = { id: string; title: string; image: string; url?: string };

export function withBranchImages<T extends { node_ids?: string[]; materials?: { url: string; note?: string }[] }>(plan: T[], nodes: MNodes, supabaseUrl: string | undefined, swipes: Map<string, SwipeHit> = new Map()): T[] {
  const owner = new Map<string, number>();
  plan.forEach((p, i) => (p.node_ids || []).forEach(id => { if (!owner.has(id)) owner.set(id, i); }));
  return plan.map((p, i) => {
    const mats = [...(p.materials || [])];
    const seen = new Set(mats.map(m => m.url));
    const walk = (id: string, top: boolean) => {
      const n = nodes[id]; if (!n) return;
      if (!top && owner.has(id) && owner.get(id) !== i) return;
      const u = imgUrlOf(n, supabaseUrl);
      if (u && !seen.has(u) && mats.length < 6) { seen.add(u); mats.push({ url: u, note: `枝「${(n.text || "（名前なし）").trim().slice(0, 60)}」の画像（実物・描き直さない）` }); }
      for (const ref of String(n.slide?.ref || "").match(UUID_RE) || []) {
        const sw = swipes.get(ref.toLowerCase());
        if (sw && !seen.has(sw.image) && mats.length < 6) { seen.add(sw.image); mats.push({ url: sw.image, note: `スワイプくん「${sw.title.slice(0, 60)}」（枝の参考から・実物・描き直さない）` }); }
      }
      for (const c of n.children || []) walk(c, false);
    };
    for (const id of p.node_ids || []) walk(id, true);
    return { ...p, materials: mats };
  });
}

/** スワイプくんの 1 件の画像（スクショ props.shot か、画像のファイル file_url） */
export function swipeImageOf(row: { props?: unknown; file_url?: string | null }): string | null {
  const shot = row.props && typeof row.props === "object" ? (row.props as { shot?: unknown }).shot : null;
  if (typeof shot === "string" && /^https:\/\//.test(shot)) return shot;
  const f = row.file_url || "";
  return /^https:\/\/.+\.(png|jpe?g|webp|gif)(\?|$)/i.test(f) ? f : null;
}
const SWIPE_OWNER = "VrMwzeSceqWeXVQOrm8kpu4uVR33";
const SW_SELECT = "id,title,source_url,source_type,labels,excerpt,props,file_url";
function sbHead(env: Env) {
  return { apikey: env.SUPABASE_SERVICE_ROLE_KEY, ...(/^eyJ/.test(String(env.SUPABASE_SERVICE_ROLE_KEY || "")) ? { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } : {}) };
}
type SwRow = { id: string; title?: string; source_url?: string; source_type?: string; labels?: string[]; excerpt?: string; props?: unknown; file_url?: string | null };
async function swipeRows(env: Env, query: string): Promise<SwRow[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/sw_swipes?select=${SW_SELECT}&user_id=eq.${SWIPE_OWNER}&${query}`, { headers: sbHead(env) });
  if (!res.ok) throw new Error(`スワイプくんを読めません（${res.status}）`);
  return (await res.json()) as SwRow[];
}
export async function swipesByIds(env: Env, ids: string[]): Promise<Map<string, SwipeHit>> {
  const m = new Map<string, SwipeHit>();
  if (!ids.length) return m;
  for (const r of await swipeRows(env, `id=in.(${ids.slice(0, 50).join(",")})`)) {
    const image = swipeImageOf(r); if (image) m.set(r.id, { id: r.id, title: r.title || "（題なし）", image, url: r.source_url });
  }
  return m;
}
/** 素材の住所として受けるのは、仕組みの置き場（Supabase の公開の置き場と /slides/img/）だけ（よそのサイトの画像を素材にしない） */
export function okMaterialUrl(url: string, supabaseUrl: string | undefined): boolean {
  if (!/^https:\/\//.test(url)) return false;
  const sb = String(supabaseUrl || "").replace(/\/+$/, "");
  return (!!sb && url.startsWith(`${sb}/storage/v1/object/public/`)) || url.startsWith(`${ORIGIN}${IMG_PATH}`);
}

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
  return { ...deck, slides, status: ok ? (deck.status === "drawing" || deck.status === "done" ? deck.status : "plan_ok") : "plan", updated_at: nowIso(), log: [...deck.log, `${nowIso()} 台本 ${slides.length} 枚${ok ? "（OK）" : ""}`].slice(-50) };
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

/** v1.98.0：書き出しの準備（配置表のある枚・古い枚＝PNG を描き直したのに配置表がそのまま・無い枚） */
export function layoutStatus(deck: Deck) {
  const drawn = deck.slides.filter(s => s.image);
  return {
    with_layout: drawn.filter(s => s.layout && s.layout.image_v === s.image!.v).map(s => s.no),
    stale: drawn.filter(s => s.layout && s.layout.image_v !== s.image!.v).map(s => s.no),
    missing: drawn.filter(s => !s.layout).map(s => s.no),
  };
}

/** 書き出す 1 枚の中身。配置表が無い・古い枚は、描いた PNG を 1 枚の画像として置く（字は直せない） */
export type ExportSlide = { no: number; title: string; editable: boolean; items: LayoutItem[] };
export function exportPlan(deck: Deck, onlyOk = false): ExportSlide[] {
  return deck.slides.filter(s => s.image && (!onlyOk || s.state === "ok")).map(s => {
    const fresh = s.layout && s.layout.image_v === s.image!.v;
    return fresh
      ? { no: s.no, title: s.title, editable: true, items: s.layout!.items }
      : { no: s.no, title: s.title, editable: false, items: [{ type: "image" as const, x: 0, y: 0, w: 1920, h: 1080, src: "png", url: s.image!.url }] };
  });
}

/** ひな形：見本の枚の配置表から、面と線だけ残し、字は見出し（いちばん大きい字）と小見出し（見出しの 0.6 倍以上の字）だけを「見出しを入れる」「小見出しを入れる」に置き換える。
 * 本文・注釈・ページ番号・絵は外す（v1.98.1：全部の字を残すと「テキストを入れる」が 30〜40 個並び、使えなかったため） */
export function templateOf(items: LayoutItem[]): LayoutItem[] {
  const texts = items.filter((i): i is Extract<LayoutItem, { type: "text" }> => i.type === "text");
  const top = texts.reduce((m, t) => (t.size > m ? t.size : m), 0);
  let headDone = false;
  const out: LayoutItem[] = [];
  for (const i of items) {
    if (i.type === "image") continue;
    if (i.type !== "text") { out.push(i); continue; }
    const head = !headDone && i.size === top;
    if (head) { headDone = true; const { runs: _r, ...rest } = i; out.push({ ...rest, text: "見出しを入れる" }); continue; }
    if (i.size >= top * 0.6) { const { runs: _r, ...rest } = i; out.push({ ...rest, text: "小見出しを入れる" }); }
  }
  return out;
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
/** 見本の画像（このデッキの見本の枚＋前のデッキから引き継いだ見本）。GPT は描く前に毎回これを開く */
export function anchorImages(d: Deck): { no?: number; title?: string; url: string; note?: string }[] {
  const own = d.tone.anchors.map(n => d.slides.find(s => s.no === n)).filter((s): s is Slide => !!s?.image).map(s => ({ no: s.no, title: s.title, url: s.image!.url }));
  return [...own, ...(d.tone.refs || [])];
}
const view = (d: Deck) => ({ ok: true, deck: d, summary: summary(d), next_to_draw: nextToDraw(d), anchor_images: anchorImages(d), layout: layoutStatus(d), skill: SKILL });

const MaterialZ = z.object({ url: z.string().url(), note: z.string().max(200).optional() });
const PlanZ = z.object({
  role: z.enum(ROLES), title: z.string().min(1).max(60), body: z.string().max(600).optional(),
  visual: z.string().max(600).optional().describe("絵の指示（何を描くか・図解の形）"),
  node_ids: z.array(z.string().max(64)).max(20).optional().describe("もとになった枝の {id}"),
  materials: z.array(MaterialZ).max(6).optional().describe("実物の素材（描き直さない）"),
});
const OpenAIFile = z.object({ download_url: z.string(), file_id: z.string(), mime_type: z.string().optional(), file_name: z.string().optional() });

const Hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const Box = { x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() };
const LayoutItemZ = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), ...Box, text: z.string().max(1000).optional(), runs: z.array(z.object({ text: z.string().max(1000), color: Hex.optional(), weight: z.number().int().min(100).max(900).optional() })).max(30).optional(),
    size: z.number().min(8).max(300).describe("字の大きさ（1920×1080 の px）"), weight: z.number().int().min(100).max(900).optional(), color: Hex.optional(),
    align: z.enum(["left", "center", "right"]).optional(), valign: z.enum(["top", "middle", "bottom"]).optional(), line: z.number().min(0.8).max(3).optional().describe("行の高さ（字の大きさの倍）") }),
  z.object({ type: z.literal("rect"), ...Box, fill: Hex.optional(), stroke: Hex.optional(), stroke_w: z.number().min(0).max(40).optional() }),
  z.object({ type: z.literal("line"), ...Box, color: Hex.optional(), stroke_w: z.number().min(0.5).max(40).optional(), arrow: z.boolean().optional() }).describe("左上 (x,y) から右下 (x+w,y+h) へ。横線は h を 1、縦線は w を 1"),
  z.object({ type: z.literal("image"), ...Box, src: z.string().max(500).describe("art:N（今回渡した字の無い絵）・material:N（その枚の素材）・https の住所") }),
]);

export const SLIDE_TOOLS = ["slides__find_material", "slides__add_material", "slides__start", "slides__list", "slides__get", "slides__put_plan", "slides__set_tone", "slides__put_image", "slides__put_layout", "slides__feedback", "slides__set_status", "slides__export_gslides"] as const;

export function registerSlideTools(server: McpServer, env: Env): void {
  server.tool("slides__start",
    "思考整理くんのマップからスライドの台帳（1 デッキ）を作る。map_id はマップの id か住所。前のデッキの見た目を引き継ぐときは tone_from に前のデッキの id。作ったら同じ返り値の skill（スライド制作スキル）の手順どおりに進める。戻り値: { ok, deck, summary, next_to_draw, skill }",
    { map_id: z.string().min(1).max(300), title: z.string().min(1).max(120), tone_name: z.string().max(60).optional(), tone_rules: z.string().max(8000).optional().describe("色・字・余白・飾りの決まり"),
      tone_from: z.string().uuid().optional().describe("見た目を引き継ぐ前のデッキの id（決まりと見本の画像を写す）") },
    async (a) => {
      const id = newId(), at = nowIso();
      const src = a.tone_from ? await loadDeck(env, a.tone_from) : null;
      const m = a.map_id.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      const d: Deck = { v: 1, id, title: a.title, map_id: m ? m[0] : a.map_id, map_url: m ? `https://mindmap.shia2n.jp/m/${m[0]}` : a.map_id,
        tone: { name: a.tone_name || src?.tone.name || "シアニン標準", rules: a.tone_rules || src?.tone.rules || "", anchors: [],
          ...(src ? { refs: anchorImages(src).map(x => ({ url: x.url, note: `前のデッキ「${src.title}」${x.no ? `${x.no}枚目` : ""}${x.title ? `「${x.title}」` : x.note ? `（${x.note}）` : ""}`.slice(0, 200) })) } : {}) },
        status: "plan", slides: [], created_at: at, updated_at: at, log: [`${at} 作った`] };
      await saveDeck(env, d);
      return ok(view(d));
    });
  server.tool("slides__list", "スライドの台帳の一覧（新しい順）。続きをするデッキを探すときに使う。戻り値: { ok, decks: [{ id, title, at }] }", {},
    async () => ok({ ok: true, decks: ((await env.OAUTH_KV.get(INDEX_KEY, "json")) as unknown[]) || [] }));
  server.tool("slides__get", "スライドの台帳を読む（いつも最初に呼ぶ）。どこまでできたか（summary・各枚の state）、次に描く枚（next_to_draw）、見本の画像（anchor_images・描く前に毎回開いて見る）、スライド制作スキル（skill）が返る。戻り値: { ok, deck, summary, next_to_draw, anchor_images, skill }",
    { deck_id: z.string().uuid() }, async (a) => ok(view(await loadDeck(env, a.deck_id))));
  server.tool("slides__put_plan", "台本（全部の枚）を書く。並びの順が番号になる（1 から）。node_ids の枝とその下の枝に貼った画像は、その枚の素材（materials）へ自動で入る。見出しと中身が変わっていない枚の画像は残る。plan_ok=true はシアニンが台本に OK を言ったときだけ。戻り値: { ok, deck, summary }",
    { deck_id: z.string().uuid(), slides: z.array(PlanZ).min(1).max(200), plan_ok: z.boolean().optional() },
    async (a) => {
      const deck = await loadDeck(env, a.deck_id);
      let plan = a.slides as Omit<Slide, "state" | "no" | "image">[];
      const map = /^[\w-]{1,64}$/.test(deck.map_id) ? await readMapNodes(env, deck.map_id).catch(() => null) : null; // 読めなくても台本は入れる
      if (map) plan = withBranchImages(plan, map.nodes, env.SUPABASE_URL, await swipesByIds(env, refIdsOf(map.nodes)).catch(() => new Map()));
      const d = applyPlan(deck, plan, !!a.plan_ok); await saveDeck(env, d); return ok(view(d));
    });
  server.tool("slides__set_tone", "トーンの型を決める。anchors＝見本にする枚の番号（シアニンが「これ」と言った枚・1〜3 枚・入れると前のデッキから引き継いだ見本は外れる）。rules＝色（色番号まで）・字・線・余白・絵の作り・使わないもの。見本を変えたら描き終えた枚をそろえ直す。戻り値: { ok, deck }",
    { deck_id: z.string().uuid(), anchors: z.array(z.number().int().min(1)).max(3).optional(), rules: z.string().max(8000).optional(), name: z.string().max(60).optional() },
    async (a) => {
      const d = await loadDeck(env, a.deck_id);
      if (a.anchors) { const bad = a.anchors.filter(n => !d.slides.find(s => s.no === n)?.image); if (bad.length) return ok({ ok: false, error: `${bad.join("・")} 枚目はまだ描いていないので見本にできません` }); d.tone.anchors = a.anchors; delete d.tone.refs; }
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
  (server as any).registerTool("slides__put_layout", {
    description: "描いた 1 枚を、Google スライドへ書き出せる形（配置表）で書き戻す（v1.98.0）。put_image で入れた PNG と同じ見た目を、items（1920×1080 の座標）で表す：text＝字（実際のフォント・字は1字も変えない）、rect＝薄い面・枠、line＝線・矢印、image＝字の無い絵（files で渡し art:1 のように指す）や素材（material:1）。描く順＝重なる順（先が下）。PNG を描き直したら配置表も入れ直す。戻り値: { ok, slide: { no, layout }, errors }",
    inputSchema: { deck_id: z.string().uuid(), no: z.number().int().min(1), items: z.array(LayoutItemZ).min(1).max(150), files: z.array(OpenAIFile).max(6).optional().describe("字の無い絵（イラスト・画面のモック）。art:1 から順") },
    _meta: { "openai/fileParams": ["files"] },
  }, async (a: { deck_id: string; no: number; items: LayoutItem[]; files?: { download_url: string; mime_type?: string }[] }) => {
    const d = await loadDeck(env, a.deck_id);
    const s = d.slides.find(x => x.no === a.no);
    if (!s) return ok({ ok: false, error: `${a.no} 枚目は台本にありません` });
    const v = (s.layout?.v || 0) + 1, art: string[] = [];
    for (const [i, f] of (a.files || []).entries()) {
      if (!/^https:\/\//.test(f.download_url || "")) return ok({ ok: false, error: `${i + 1} 枚目の絵が https の住所ではありません` });
      const res = await fetch(f.download_url);
      if (!res.ok) return ok({ ok: false, error: `${i + 1} 枚目の絵を読めません（${res.status}）` });
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 12 * 1024 * 1024) return ok({ ok: false, error: `${i + 1} 枚目の絵が 12MB を超えています` });
      const type = (f.mime_type || res.headers.get("content-type") || "image/png").split(";")[0];
      const ext = type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : "png";
      const file = `${String(a.no).padStart(3, "0")}-v${v}-${crypto.randomUUID().slice(0, 8)}-a${i + 1}.${ext}`;
      await env.BACKUP_BUCKET.put(`slides/${d.id}/${file}`, buf, { httpMetadata: { contentType: type } });
      art.push(`${ORIGIN}${IMG_PATH}${d.id}/${file}`);
    }
    const r = resolveLayout(a.items, art, s.materials);
    if (r.errors.length) return ok({ ok: false, errors: r.errors });
    s.layout = { v, at: nowIso(), image_v: s.image?.v || 0, items: r.items };
    d.log = [...d.log, `${nowIso()} ${a.no} 枚目 配置表 v${v}`].slice(-50);
    await saveDeck(env, d);
    return ok({ ok: true, slide: { no: s.no, layout: { v, image_v: s.layout.image_v, items: r.items.length } }, errors: [] });
  });
  server.tool("slides__find_material",
    "スライドに入れる素材の画像を探す（v1.99.0）。いま探せるのはスワイプくん（参考のポスト・note・LP などのスクショ）。q は題・抜粋・本文の言葉（空なら新しい順）。label でラベルを含むものに絞れる。画像のある件だけ返す。選んだら slides__add_material でその枚に入れる。マーケくんの実績の棚・メディアの棚はまだ探せない（載せてよい範囲の確かめが要るため）。戻り値: { ok, count, items: [{ source, id, title, image, source_url, labels }] }",
    { q: z.string().max(100).optional(), label: z.string().max(40).optional(), limit: z.number().int().min(1).max(30).optional() },
    async (a) => {
      const clean = (v: string) => v.replace(/[,()*%\\]/g, " ").trim();
      const parts: string[] = [];
      const q = clean(a.q || "");
      if (q) { const w = encodeURIComponent(`*${q}*`); parts.push(`or=(title.ilike.${w},excerpt.ilike.${w},body.ilike.${w})`); }
      if (a.label) parts.push(`labels=cs.${encodeURIComponent(`{"${clean(a.label)}"}`)}`);
      parts.push(`order=created_at.desc`, `limit=${Math.min(100, (a.limit || 10) * 3)}`);
      const rows = await swipeRows(env, parts.join("&"));
      const items = rows.map(r => ({ r, image: swipeImageOf(r) })).filter(x => x.image).slice(0, a.limit || 10)
        .map(({ r, image }) => ({ source: "swipe", id: r.id, title: r.title || "（題なし）", image, source_url: r.source_url || null, labels: r.labels || [] }));
      return ok({ ok: true, count: items.length, items });
    });
  server.tool("slides__add_material",
    "1 枚の素材（materials）に画像を足す（v1.99.0）。swipe_id（slides__find_material の id）か url（仕組みの置き場の画像の住所だけ）を渡す。note に何の画像か・どう使うかを 1 行。同じ住所は足さない。1 枚 6 つまで。remove=true でその住所を外す。足したら、その枚を描き直す（素材は描き直さずにそのまま置く）。戻り値: { ok, slide: { no, materials } }",
    { deck_id: z.string().uuid(), no: z.number().int().min(1), swipe_id: z.string().uuid().optional(), url: z.string().url().optional(), note: z.string().max(200).optional(), remove: z.boolean().optional() },
    async (a) => {
      const d = await loadDeck(env, a.deck_id);
      const s = d.slides.find(x => x.no === a.no);
      if (!s) return ok({ ok: false, error: `${a.no} 枚目は台本にありません` });
      let url = a.url, note = a.note;
      if (a.swipe_id) {
        const sw = (await swipesByIds(env, [a.swipe_id.toLowerCase()])).get(a.swipe_id.toLowerCase());
        if (!sw) return ok({ ok: false, error: "そのスワイプは見つからないか、画像がありません" });
        url = sw.image; note = note || `スワイプくん「${sw.title.slice(0, 60)}」（実物・描き直さない）`;
      }
      if (!url) return ok({ ok: false, error: "swipe_id か url を渡してください" });
      if (a.remove) { s.materials = s.materials.filter(m => m.url !== url); }
      else {
        if (!okMaterialUrl(url, env.SUPABASE_URL)) return ok({ ok: false, error: "仕組みの置き場（スワイプくん・思考整理くん・スライドの画像）の住所だけ素材にできます" });
        if (s.materials.some(m => m.url === url)) return ok({ ok: true, slide: { no: s.no, materials: s.materials }, note: "もう入っています" });
        if (s.materials.length >= 6) return ok({ ok: false, error: "素材は 1 枚 6 つまでです" });
        s.materials = [...s.materials, { url, ...(note ? { note } : {}) }];
      }
      d.log = [...d.log, `${nowIso()} ${a.no} 枚目 素材${a.remove ? "を外した" : "を足した"}`].slice(-50);
      await saveDeck(env, d);
      return ok({ ok: true, slide: { no: s.no, materials: s.materials } });
    });
  server.tool("slides__feedback", "1 枚への直しの指示を書く（シアニンの言葉のまま）。その枚は redo になり、次に描く枚の先頭に来る。ok=true はシアニンがその枚に OK を言ったとき（state を ok にする）。戻り値: { ok, slide }",
    { deck_id: z.string().uuid(), no: z.number().int().min(1), text: z.string().max(2000).optional(), ok: z.boolean().optional() },
    async (a) => {
      const d = await loadDeck(env, a.deck_id); const s = d.slides.find(x => x.no === a.no);
      if (!s) return ok({ ok: false, error: `${a.no} 枚目は台本にありません` });
      if (a.ok) { s.state = "ok"; delete s.feedback; } else if (a.text) { s.feedback = a.text; s.state = "redo"; }
      await saveDeck(env, d); return ok({ ok: true, slide: s, summary: summary(d) });
    });
  server.tool("slides__export_gslides",
    "デッキを Google スライドに書き出す（Naoki のドライブ「スライド」フォルダ）。配置表（put_layout）のある枚は字・面・線を直せる形で、無い枚と配置表が古い枚は描いた PNG を 1 枚の画像として置く。最後に見本の枚から作ったひな形（見出し・テキストの入力欄と面・線だけ）を足す。only_ok=true で OK の枚だけ。書き出すたびに新しいファイルを作る（前のファイルは消さない）。戻り値: { ok, url, slides, editable, image_only, templates }",
    { deck_id: z.string().uuid(), only_ok: z.boolean().optional(), templates: z.boolean().optional().describe("ひな形を足す（既定 true）") },
    async (a) => {
      const d = await loadDeck(env, a.deck_id);
      const plan = exportPlan(d, !!a.only_ok);
      if (!plan.length) return ok({ ok: false, error: "書き出す枚がありません（描いた枚が無い）" });
      const tmpls = a.templates === false ? [] : d.tone.anchors.map(n => d.slides.find(s => s.no === n)).filter((s): s is Slide => !!s?.layout).map(s => ({ title: `ひな形（${s.no}枚目の形）`, items: templateOf(s.layout!.items) }));
      if (!env.ZOOM_ARCHIVE?.createSlidesDeck) return ok({ ok: false, error: "zoom-to-youtube への結び（createSlidesDeck）がありません。zoom-to-youtube を先に本番へ出してください" });
      const out = await env.ZOOM_ARCHIVE.createSlidesDeck({ title: `${d.title}（${new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ")}）`, slides: plan.map(p => ({ items: p.items })), templates: tmpls.map(t => ({ items: t.items })) }) as { ok?: boolean; url?: string; error?: string };
      if (!out?.ok) return ok({ ok: false, error: out?.error || "書き出しに失敗しました" });
      d.log = [...d.log, `${nowIso()} Google スライドへ書き出し ${plan.length} 枚`].slice(-50); await saveDeck(env, d);
      return ok({ ok: true, url: out.url, slides: plan.length, editable: plan.filter(p => p.editable).map(p => p.no), image_only: plan.filter(p => !p.editable).map(p => p.no), templates: tmpls.length });
    });
  server.tool("slides__set_status", "デッキの状態を変える（done＝全部の枚が ok になったとき）。戻り値: { ok, deck }",
    { deck_id: z.string().uuid(), status: z.enum(["plan", "plan_ok", "drawing", "done"]) },
    async (a) => { const d = await loadDeck(env, a.deck_id); d.status = a.status; await saveDeck(env, d); return ok({ ok: true, deck: { id: d.id, status: d.status }, summary: summary(d) }); });
}

/** /slides/img/<deck>/<file> を返す（読むだけ・名前は推測できない乱数） */
export async function handleSlideImage(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  const m = new URL(request.url).pathname.slice(IMG_PATH.length).match(/^([0-9a-f-]{36})\/(\d{3}-v\d+-[0-9a-f]{8}(?:-a\d)?\.(png|jpg|webp))$/);
  if (!m) return new Response("Not Found", { status: 404 });
  const obj = await env.BACKUP_BUCKET.get(`slides/${m[1]}/${m[2]}`);
  if (!obj) return new Response("Not Found", { status: 404 });
  return new Response(obj.body, { headers: { "Content-Type": obj.httpMetadata?.contentType || "image/png", "Cache-Control": "public, max-age=31536000, immutable" } });
}
