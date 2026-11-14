// v1.94.0：スライドの台帳。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { applyPlan, nextToDraw, summary, parseDeck, handleSlideImage, SKILL, anchorImages, type Deck } from "../src/slides.js";

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
  assert.match(SKILL, /実物の素材.*絶対に描き直さない/);
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
