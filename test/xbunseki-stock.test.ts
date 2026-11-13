import test from "node:test";
import assert from "node:assert/strict";
import { xbStockOf, xbStockRow, layerIdOf } from "../src/xbunseki-core.ts";

test("足す行：評価 C・今日・フォルダとリンクは src の sk・同じ文は足さない・層は名前でも id でも", () => {
  const have = [{ id: "h1", kind: "hy", body: "引用は散らす", archived: false }];
  const r = xbStockRow({ kind: "ノウハウ", text: " 第1位型は冒頭で言い切る ", folder: "投稿の型", layer: "投稿のスタイル", map_url: "https://mindmap.shia2n.jp/m/x", links: [{ url: "https://x.com/a/status/1", title: "お手本" }, { url: "javascript:x" }] }, "u", "2026-11-13", have)!;
  assert.equal(r.kind, "kn"); assert.equal(r.body, "第1位型は冒頭で言い切る"); assert.equal(r.grade, "C"); assert.equal(r.layer, "pstyle"); assert.equal(r.from_month, "2026-11");
  assert.deepEqual(r.src[0].sk.grades, [{ g: "C", at: "2026-11-13" }]); assert.equal(r.src[0].sk.folder, "投稿の型"); assert.equal(r.src[0].sk.links.length, 2);
  assert.equal(xbStockRow({ kind: "仮説", text: "引用は散らす" }, "u", "2026-11-13", have), null);
  assert.equal(xbStockRow({ kind: "その他", text: "x" }, "u", "2026-11-13", have), null);
  assert.equal(layerIdOf("ostyle"), "ostyle"); assert.equal(layerIdOf(undefined), "ocont");
});

test("一覧：評価順・評価の変化・ここまで通用・出どころ・使っている立ち回り・フォルダで絞る", () => {
  const items = [
    { id: "a", kind: "hy", layer: "ostyle", body: "引用は散らす", grade: "B", created_at: "2026-10-23T00:00", links: ["s"], src: [{ week_id: "w1", account: "ushi_butyo" }, { sk: { folder: "引用", grades: [{ g: "C", at: "2026-10-23" }, { g: "A", at: "2026-11-01" }, { g: "B", at: "2026-11-10" }], links: [] } }] },
    { id: "b", kind: "kn", layer: "pstyle", body: "第1位型", grade: "S", created_at: "2026-11-13T00:00", links: [], src: [] },
    { id: "s", kind: "st", body: "引用はランダムに回す", archived: false },
  ];
  const L = xbStockOf(items, [{ id: "w1", label: "11月1週" }], [{ handle: "ushi_butyo", name: "うし部長" }]);
  assert.equal(L[0].文, "第1位型"); assert.equal(L[0].フォルダ, "未分類");
  assert.equal(L[1].ここまで通用, "2026-11-10 に A→B"); assert.deepEqual(L[1].出どころ, ["うし部長（11月1週の分析）"]); assert.deepEqual(L[1].使っている立ち回り, ["引用はランダムに回す"]); assert.equal(L[1].層, "運用のスタイル");
  assert.equal(xbStockOf(items, [], [], "kn").length, 1); assert.equal(xbStockOf(items, [], [], undefined, "引用").length, 1);
});
