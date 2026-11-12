import test from "node:test";
import assert from "node:assert/strict";
import { actsSummary, currentWeekLabel, featOf, inMonth, itemsFor, layersOf, mergeMetrics, normItems, pickWeek, weekDays } from "../src/xbunseki-core.ts";

const weeks = [
  { id: "a", month: "2026-09", label: "9月3週", sort: 2026093 },
  { id: "b", month: "2026-10", label: "10月4週", sort: 2026104 },
  { id: "c", month: "2025-10", label: "10月4週", sort: 2025104 },
];

test("今週の名前は日本時間で数える", () => {
  // 2026-10-23 01:00 JST（= 10-22 16:00 UTC）
  assert.deepEqual(currentWeekLabel(new Date("2026-10-22T16:00:00Z")), { month: "2026-10", label: "10月4週" });
  assert.deepEqual(currentWeekLabel(new Date("2026-10-31T15:30:00Z")), { month: "2026-11", label: "11月1週" });
});

test("週の指定：省略・名前・月つき・id・今週", () => {
  assert.equal(pickWeek(weeks)?.id, "b");
  assert.equal(pickWeek(weeks, "10月4週")?.id, "b"); // 同じ名前は新しい方
  assert.equal(pickWeek(weeks, "2025-10 10月4週")?.id, "c");
  assert.equal(pickWeek(weeks, "a")?.id, "a");
  assert.equal(pickWeek(weeks, "今週", new Date("2026-10-23T03:00:00Z"))?.id, "b");
  assert.equal(pickWeek(weeks, "8月1週"), null);
});

test("数字の写しは渡した欄だけ・カンマを外す・数でないものは捨てる", () => {
  const r = mergeMetrics({ imp: 30000, fol: 9000 }, { imp: "35,000", kiji: 12, qt: "なし", fol: undefined });
  assert.deepEqual(r.next, { imp: 35000, fol: 9000, kiji: 12 });
  assert.deepEqual(r.changed, ["imp", "kiji"]);
});

test("層は空を除いて名前で出す・打ち手の月", () => {
  assert.deepEqual(layersOf({ goal: "メンシプへ", ocont: " ", pcont: "仕事" }), { "アカウントの目的・意図": "メンシプへ", "投稿の内容": "仕事" });
  assert.equal(inMonth({ from_month: "2026-09", until_month: null }, "2026-10"), true);
  assert.equal(inMonth({ from_month: "2026-09", until_month: "2026-09" }, "2026-10"), false);
});

test("行動：週の日・項目の引き継ぎ・まとめ", () => {
  assert.deepEqual(weekDays("2026-10", "10月4週"), ["2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28"]);
  assert.deepEqual(weekDays("2026-10", "10月5週"), ["2026-10-29", "2026-10-30", "2026-10-31"]);
  assert.deepEqual(normItems({ quote: 10 })?.[0], { k: "quote", l: "他人の引用", goal: 10, hy: "" }); // 前の形
  const ws = [{ sort: 1, act_goals: { quote: 10 } }, { sort: 2, act_goals: {} }, { sort: 3, act_goals: { items: [{ k: "a1", l: "記事", goal: 2, hy: "h1" }] } }];
  assert.equal(itemsFor(ws, ws[1])[0].goal, 10);
  assert.deepEqual(itemsFor(ws, ws[2]), [{ k: "a1", l: "記事", goal: 2, hy: "h1" }]);
  assert.equal(itemsFor([], { sort: 1 }).length, 3);
  const rows = [{ day: "2026-10-22", kind: "a1", account: "ushi", n: 4 }, { day: "2026-10-23", kind: "a1", account: "", n: 2 }, { day: "2026-10-23", kind: "reply", account: "", n: 5 }, { day: "2026-10-20", kind: "a1", account: "ushi", n: 9 }];
  const s = actsSummary(rows, weekDays("2026-10", "10月4週"), [{ k: "a1", l: "記事", goal: 2, hy: "h1" }], "2026-10-23", h => h === "ushi" ? "うし部長" : h, id => id === "h1" ? "記事で伸ばす" : "");
  assert.equal(s.項目[0].この回, 6);
  assert.equal(s.項目[0].達成, "150%");
  assert.equal(s.項目[0].確かめる仮説, "記事で伸ばす");
  assert.deepEqual(s.項目[0].日ごと, { "2026-10-22": 4, "2026-10-23": 2 });
  assert.equal(s.項目[1].項目, "リプ"); // 項目に無い記録も落とさない
  assert.equal(s.項目[1].この回の項目にない, true);
  assert.deepEqual(s.相手ごと, [{ 相手: "うし部長", "@": "ushi", 記事: 4 }, { 相手: "相手なし", 記事: 2, リプ: 5 }]);
});

test("施策の特徴：メモがあればそのまま、無ければ層ごとに書いた分を並べる", () => {
  assert.equal(featOf({ memo: "記事で伸ばす→メンシプへ", ly: { ocont: "記事で伸ばす" } }), "記事で伸ばす→メンシプへ");
  assert.equal(featOf({ memo: "", ly: { goal: "メンシプ誘導", ostyle: "横長図解をテスト" } }), "アカウントの目的・意図：メンシプ誘導\n運用のスタイル：横長図解をテスト");
  assert.equal(featOf({ memo: "  ", ly: {} }), "");
  assert.equal(featOf(null), "");
});

import { movesOf } from "../src/xbunseki-core.ts";
test("打ち手ごとの材料：状態・本数・仮説・お手本・評価・今週の投稿", () => {
  const items = [
    { id: "s1", kind: "st", layer: "ocont", body: "記事を毎日", from_month: "2026-11", links: ["h1"], src: [{ per: { n: 1, u: "日", pt: "x_article" } }, { ref: { id: "r", title: "お手本", shu: "記事", url: "https://n", shot: "https://img" } }] },
    { id: "s2", kind: "st", layer: "pstyle", body: "引用を散らす", from_month: "2026-11", src: [{ state: "wait" }] },
    { id: "s3", kind: "st", layer: "pstyle", body: "やめた", from_month: "2026-10", until_month: "2026-10", archived: true, src: [] },
    { id: "g", kind: "st", layer: "goal", body: "目的", from_month: "2026-11", src: [] },
    { id: "h1", kind: "hy", layer: "ocont", body: "記事で信頼", from_month: "2026-11", src: [] },
  ];
  const week = { id: "w", month: "2026-11", label: "11月2週" };
  const posts = [{ title: "A", post_type: "x_article", status: "published", datetime: "2026-11-09T18:02" }, { title: "B", post_type: "x_article", status: "reserved", datetime: "2026-11-15T18:02" }, { title: "C", post_type: "x_post", status: "published", datetime: "2026-11-10T07:02" }];
  const r = movesOf(items, "2026-11", week, { ev: { w: { s1: 4 } } }, posts);
  assert.deepEqual(r.map(x => [x.id, x.状態]), [["s1", "今週オン"], ["s2", "控え"]]);
  assert.equal(r[0].本数, "1 本／日・X記事"); assert.deepEqual(r[0].仮説, ["記事で信頼"]); assert.equal(r[0].お手本[0].画像, "https://img");
  assert.equal(r[0].今週の評価, "良い"); assert.deepEqual(r[0].今週出した投稿.map((o: any) => o.題), ["A"]); assert.deepEqual(r[1].今週出した投稿, []);
});
