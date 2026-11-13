import test from "node:test";
import assert from "node:assert/strict";
import { nkStockOf, nkStockRow, nkMovesOf } from "../src/notekoryaku-core.ts";

test("ストックへ足す行：評価 C・今日・マップとリンク・同じ文は足さない", () => {
  const have = [{ id: "h1", kind: "hy", body: "まず1000名", archived: false }];
  const r = nkStockRow({ kind: "ノウハウ", text: " 保存版は検証と手順 ", folder: "note", map_url: "https://mindmap.shia2n.jp/m/AAAAAAAA-bbbb-cccc-dddd-eeeeeeeeeeee", links: [{ url: "https://note.com/x/n/1", title: "記事" }] }, "u", "2026-11-13", have, { "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee": "マップ" })!;
  assert.equal(r.kind, "kn"); assert.equal(r.body, "保存版は検証と手順"); assert.equal(r.grade, "C"); assert.deepEqual(r.grades, [{ g: "C", at: "2026-11-13" }]);
  assert.equal(r.folder, "note"); assert.deepEqual(r.src[0], { map: { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", t: "マップ" } }); assert.equal(r.src[1].link.t, "記事");
  assert.equal(nkStockRow({ kind: "仮説", text: "まず1000名" }, "u", "2026-11-13", have, {}), null);
  assert.equal(nkStockRow({ kind: "その他", text: "x" }, "u", "2026-11-13", have, {}), null);
});

test("ストックの一覧：評価順・評価の変化・ここまで通用・使っている立ち回り", () => {
  const items = [
    { id: "a", kind: "hy", body: "A の仮説", grade: "B", grades: [{ g: "C", at: "2026-11-01" }, { g: "A", at: "2026-11-05" }, { g: "B", at: "2026-11-10" }], folder: "", created_at: "2026-11-01T00:00", src: [{ month_id: "m1", account: "kun1aki" }] },
    { id: "b", kind: "kn", body: "S のノウハウ", grade: "S", grades: [], folder: "note", created_at: "2026-11-02T00:00", src: [] },
    { id: "s", kind: "st", body: "立ち回り", links: ["a"], archived: false },
  ];
  const L = nkStockOf(items, [{ handle: "kun1aki", name: "やまだくにあき" }], [{ id: "m1", month: "2026-11" }]);
  assert.equal(L[0].文, "S のノウハウ"); assert.equal(L[1].ここまで通用, "2026-11-10 に A→B"); assert.deepEqual(L[1].出どころ, ["やまだくにあき（2026-11 の分析）"]); assert.deepEqual(L[1].使っている立ち回り, ["立ち回り"]);
  assert.equal(nkStockOf(items, [], [], "kn").length, 1); assert.equal(nkStockOf(items, [], [], undefined, "note").length, 1);
});

test("立ち回りの根拠：仮説とノウハウを評価つきで返す", () => {
  const items = [{ id: "s", kind: "st", layer: "pcont", body: "x", plan_month: "2026-11", links: ["h", "k"], src: [] }, { id: "h", kind: "hy", body: "仮説1", grade: "B" }, { id: "k", kind: "kn", body: "ノウハウ1", grade: "" }];
  const m = nkMovesOf(items, "2026-11", null, [], "2026-11-13")[0];
  assert.deepEqual(m.根拠, [{ 種類: "仮説", 評価: "B", 文: "仮説1" }, { 種類: "ノウハウ", 評価: "なし", 文: "ノウハウ1" }]); assert.deepEqual(m.仮説, ["仮説1"]);
});
