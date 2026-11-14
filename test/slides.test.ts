// v1.94.0：スライドの台帳。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { applyPlan, nextToDraw, summary, parseDeck, handleSlideImage, SKILL, anchorImages, withBranchImages, resolveLayout, layoutStatus, exportPlan, templateOf, refIdsOf, swipeImageOf, okMaterialUrl, type Deck, type LayoutItem } from "../src/slides.js";
import { toOutline, imagesOf, splitLink } from "../src/mindmap-core.js";

const base = (): Deck => ({ v: 1, id: "11111111-2222-3333-4444-555555555555", title: "t", map_id: "m", map_url: "u",
  tone: { name: "シアニン標準", rules: "", anchors: [] }, status: "plan", slides: [], created_at: "a", updated_at: "a", log: [] });

test("台本を入れると 1 から番号が振られ、まだ描いていない枚になる", () => {
  const d = applyPlan(base(), [{ role: "表紙", title: "オンラインビジネスの攻略手順", body: "", visual: "", node_ids: [], materials: [] }, { role: "本題", title: "攻略の 8 段", body: "a", visual: "", node_ids: ["n1"], materials: [] }], false);
  assert.deepEqual(d.slides.map(s => [s.no, s.role, s.state]), [[1, "表紙", "plan"], [2, "本題", "plan"]]);
  assert.equal(d.status, "plan");
});

test("見出しと中身が同じ枚は、台本を入れ直しても画像が残る。変わった枚は描き直しに戻る", () => {
  let d = applyPlan(base(), [{ role: "表紙", title: "A", body: "x", visual: "", node_ids: [], materials: [] }, { role: "本題", title: "B", body: "y", visual: "", node_ids: [], materials: [] }], true);
  d.slides[0].image = { file: "001-v1-aaaaaaaa.png", url: "u1", v: 1, at: "t" }; d.slides[0].state = "drawn";
  d.slides[1].image = { file: "002-v1-bbbbbbbb.png", url: "u2", v: 1, at: "t" }; d.slides[1].state = "drawn";
  d = applyPlan(d, [{ role: "表紙", title: "A", body: "x", visual: "", node_ids: [], materials: [] }, { role: "本題", title: "B2", body: "y", visual: "", node_ids: [], materials: [] }], true);
  assert.equal(d.slides[0].image?.v, 1); assert.equal(d.slides[0].state, "drawn");
  assert.equal(d.slides[1].image, undefined); assert.equal(d.slides[1].state, "plan");
  assert.equal(d.status, "plan_ok");
});

test("次に描く枚は 直し → まだ描いていない の順で 5 枚まで", () => {
  const d = applyPlan(base(), Array.from({ length: 8 }, (_, i) => ({ role: "本題" as const, title: `s${i + 1}`, body: "", visual: "", node_ids: [], materials: [] })), true);
  d.slides[0].state = "drawn"; d.slides[6].state = "redo";
  assert.deepEqual(nextToDraw(d), [7, 2, 3, 4, 5]);
  assert.deepEqual(summary(d), { total: 8, plan: 6, drawn: 1, redo: 1, ok: 0 });
});

test("台帳の形が違えば止める・無ければ null", () => {
  assert.equal(parseDeck(null), null);
  assert.throws(() => parseDeck({ v: 2, id: "x", slides: [] }));
});

test("スキルに、実物の素材は描き直さない・最初に台帳を読む が入っている", () => {
  assert.match(SKILL, /描き直し・生成し直し.*不可/);
  assert.match(SKILL, /いつも最初に slides__get/);
});

test("画像の住所は決まった形だけ通す", async () => {
  const env = { BACKUP_BUCKET: { get: async (k: string) => k === "slides/11111111-2222-3333-4444-555555555555/001-v1-aaaaaaaa.png" ? { body: "img", httpMetadata: { contentType: "image/png" } } : null } } as any;
  const okRes = await handleSlideImage(new Request("https://x/slides/img/11111111-2222-3333-4444-555555555555/001-v1-aaaaaaaa.png"), env);
  assert.equal(okRes.status, 200);
  assert.equal((await handleSlideImage(new Request("https://x/slides/img/../../backup/x.json"), env)).status, 404);
  assert.equal((await handleSlideImage(new Request("https://x/slides/img/11111111-2222-3333-4444-555555555555/001-v1-aaaaaaaa.png", { method: "POST" }), env)).status, 405);
});

test("見本の画像：このデッキの見本の枚と、前のデッキから引き継いだ見本を返す（v1.96.0）", () => {
  const d = applyPlan(base(), [{ role: "表紙", title: "A", body: "", visual: "", node_ids: [], materials: [] }, { role: "図解", title: "B", body: "", visual: "", node_ids: [], materials: [] }], true);
  d.slides[1].image = { file: "002-v1-bbbbbbbb.png", url: "u2", v: 1, at: "t" };
  d.tone.anchors = [2, 1];
  d.tone.refs = [{ url: "old35", note: "前のデッキ「x」35枚目" }];
  assert.deepEqual(anchorImages(d), [{ no: 2, title: "B", url: "u2" }, { url: "old35", note: "前のデッキ「x」35枚目" }]);
  assert.match(SKILL, /anchor_images/);
  assert.match(SKILL, /実際のフォント/);
  assert.match(SKILL, /tone_from/);
});

test("枝の画像：get_map に住所とスライドの指示が出て、台本の素材へ自動で入る（v1.97.0）", () => {
  const S = "https://x.supabase.co";
  const nodes: any = {
    r: { id: "r", text: "中心", children: ["a", "b"], parent: null },
    a: { id: "a", text: "実績", children: ["a1"], parent: "r", img: { path: "u/1.png" }, slide: { type: "比較", design: "左右に並べる" } },
    a1: { id: "a1", text: "スクショ", children: [], parent: "a", img: { path: "u/2.png" } },
    b: { id: "b", text: "別の枚", children: ["b1"], parent: "r" },
    b1: { id: "b1", text: "b の子", children: [], parent: "b", img: { path: "../evil.png" } },
  };
  const out = toOutline("r", nodes, undefined, S);
  assert.match(out, /- 実績 \(画像 https:\/\/x\.supabase\.co\/storage\/v1\/object\/public\/mindmap\/u\/1\.png\) \{a\}/);
  assert.match(out, /スライドの指示: 種類 比較 ／ デザイン 左右に並べる/);
  assert.match(out, /b の子 \(画像\) \{b1\}/); // 形が変な住所は出さない
  assert.deepEqual(imagesOf("r", nodes, S).map(x => x.node_id), ["a", "a1"]);
  assert.equal(splitLink(`- 実績 (画像 ${S}/storage/v1/object/public/mindmap/u/1.png) {a}`.slice(2)).text, "実績");
  const plan = withBranchImages([{ node_ids: ["a"], materials: [] }, { node_ids: ["a1"] }, { node_ids: ["b"] }], nodes, S);
  assert.equal(plan[0].materials!.length, 1); // a1 は 2 枚目のもの
  assert.match(plan[1].materials![0].url, /u\/2\.png$/);
  assert.equal(plan[2].materials!.length, 0);
  const again = withBranchImages(plan, nodes, S);
  assert.equal(again[0].materials!.length, 1); // 同じ住所は足さない
});

test("配置表：src を住所に直し、はみ出しと空の字を止める・書き出しの準備（v1.98.0）", () => {
  const items: LayoutItem[] = [
    { type: "rect", x: 0, y: 0, w: 1920, h: 1080, fill: "#FFFFFF" },
    { type: "text", x: 96, y: 60, w: 1200, h: 110, text: "ガワ・仕組み・スキルをそろえる", size: 84, weight: 700, color: "#192731" },
    { type: "line", x: 96, y: 180, w: 540, h: 1, color: "#BDCCD5", stroke_w: 5 },
    { type: "image", x: 120, y: 400, w: 500, h: 400, src: "art:1" },
    { type: "image", x: 700, y: 400, w: 500, h: 400, src: "material:1" },
    { type: "text", x: 96, y: 300, w: 400, h: 60, runs: [{ text: "ガワ：", color: "#0875B1" }, { text: "LP" }], size: 44 },
  ];
  const r = resolveLayout(items, ["https://w/art1.png"], [{ url: "https://s/m1.png" }]);
  assert.deepEqual(r.errors, []);
  assert.equal((r.items[3] as any).url, "https://w/art1.png");
  assert.equal((r.items[4] as any).url, "https://s/m1.png");
  const bad = resolveLayout([{ type: "image", x: 0, y: 0, w: 10, h: 10, src: "art:2" }, { type: "text", x: 1900, y: 0, w: 200, h: 10, size: 20 }], [], []);
  assert.equal(bad.errors.length, 3);
  const t = templateOf(r.items);
  assert.equal(t.filter(i => i.type === "image").length, 0);
  assert.deepEqual(t.filter(i => i.type === "text").map(i => (i as any).text), ["見出しを入れる"]); // 44px の本文は 84px の 0.6 倍未満なので外す
  assert.deepEqual(templateOf([{ type: "text", x: 0, y: 0, w: 10, h: 10, text: "見", size: 80 }, { type: "text", x: 0, y: 0, w: 10, h: 10, text: "分類", size: 64 }, { type: "text", x: 0, y: 0, w: 10, h: 10, text: "本文", size: 44 }]).map(i => (i as any).text), ["見出しを入れる", "小見出しを入れる"]);

  const d = applyPlan(base(), [1, 2, 3].map(n => ({ role: "本題" as const, title: `s${n}`, body: "", visual: "", node_ids: [], materials: [] })), true);
  d.slides[0].image = { file: "001-v2-aaaaaaaa.png", url: "u1", v: 2, at: "t" }; d.slides[0].layout = { v: 1, at: "t", image_v: 2, items: r.items };
  d.slides[1].image = { file: "002-v2-bbbbbbbb.png", url: "u2", v: 2, at: "t" }; d.slides[1].layout = { v: 1, at: "t", image_v: 1, items: r.items };
  d.slides[2].image = { file: "003-v1-cccccccc.png", url: "u3", v: 1, at: "t" }; d.slides[2].state = "ok";
  assert.deepEqual(layoutStatus(d), { with_layout: [1], stale: [2], missing: [3] });
  const ex = exportPlan(d);
  assert.deepEqual(ex.map(e => [e.no, e.editable]), [[1, true], [2, false], [3, false]]);
  assert.equal((ex[2].items[0] as any).url, "u3");
  assert.deepEqual(exportPlan(d, true).map(e => e.no), [3]);
});

test("素材：枝の参考のスワイプくん・画像の取り出し・受ける住所（v1.99.0）", () => {
  const S = "https://x.supabase.co";
  const id = "16baee35-5935-4f9e-8001-8fff58b294da";
  const nodes: any = {
    r: { id: "r", text: "中心", children: ["a"], parent: null },
    a: { id: "a", text: "LP の例", children: [], parent: "r", slide: { ref: `https://swipe.shia2n.jp/?id=${id.toUpperCase()} を参考` } },
  };
  assert.deepEqual(refIdsOf(nodes), [id]);
  const sw = new Map([[id, { id, title: "LP の見本", image: `${S}/storage/v1/object/public/swipe-files/shots/1.png` }]]);
  const plan = withBranchImages([{ node_ids: ["a"], materials: [] }], nodes, S, sw);
  assert.equal(plan[0].materials![0].url, `${S}/storage/v1/object/public/swipe-files/shots/1.png`);
  assert.match(plan[0].materials![0].note!, /スワイプくん「LP の見本」/);
  assert.equal(swipeImageOf({ props: { shot: "https://a/b.png" } }), "https://a/b.png");
  assert.equal(swipeImageOf({ props: {}, file_url: "https://a/c.pdf" }), null);
  assert.equal(swipeImageOf({ file_url: "https://a/c.JPG" }), "https://a/c.JPG");
  assert.equal(okMaterialUrl(`${S}/storage/v1/object/public/mindmap/x.png`, S), true);
  assert.equal(okMaterialUrl("https://shia2n-mcp.gameister1.workers.dev/slides/img/a/b.png", S), true);
  assert.equal(okMaterialUrl("https://example.com/x.png", S), false);
});
