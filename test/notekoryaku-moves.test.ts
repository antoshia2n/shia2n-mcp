import test from "node:test";
import assert from "node:assert/strict";
import { monthMondays, nkMovesOf, nkGoalsOf } from "../src/notekoryaku-core.ts";

const items = [
  { id: "h1", kind: "hy", body: "ノウハウが強い" },
  { id: "s1", kind: "st", layer: "pcont", body: "メンシプ記事を月 4 本", plan_month: "2026-11", links: ["h1"], src: [{ ref: { title: "人気記事", author: "限界読書", url: "https://note.com/x" } }], state: "" },
  { id: "s2", kind: "st", layer: "route", body: "X から note へ", memo: "X", plan_month: "2026-10", state: "wait" },
  { id: "s3", kind: "st", layer: "ocont", body: "単品 500 円", plan_month: "2026-12", state: "" },
  { id: "s4", kind: "st", layer: "ocont", body: "しまった", plan_month: "2026-10", archived: true },
];
const ladder = { shape: { "2026-11": { "2:m": { t: "水曜の記事", s: "s1" }, "3:m": { t: "水曜の記事", s: "s1" }, "2:r": { t: "X 長文", s: "s2" } } }, ev: { "2026-10": { s2: 2 } },
  goals: [{ from: 20, t: "メンシプ 50 人", ms: [{ t: "入口 4 本", st: "ok" }, { t: "", st: "todo" }, { t: "有料 1 本", st: "try", type: "res" }] }] };
const posts = [{ post_type: "membership", status: "reserved", datetime: "2026-11-12T12:32", title: "図解の下書き" }, { post_type: "note", status: "published", datetime: "2026-11-10T08:00", title: "無料" }, { post_type: "membership", status: "draft", datetime: "2026-11-18T12:32", title: "下書き" }];

test("月の月曜（11 月は 2・9・16・23・30）", () => {
  assert.deepEqual(monthMondays("2026-11"), ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"]);
});
test("打ち手：今月使っているもの・列・状態・仮説・お手本・先月の評価", () => {
  const m = nkMovesOf(items, "2026-11", ladder, posts, "2026-11-20");
  assert.deepEqual(m.map(x => x.id), ["s1", "s2"]);
  assert.equal(m[0].列, "記事"); assert.equal(m[0].状態, "今月オン"); assert.deepEqual(m[0].仮説, ["ノウハウが強い"]); assert.equal(m[0].お手本[0].投稿者, "限界読書");
  assert.equal(m[1].列, "集客ルート"); assert.equal(m[1].ルート, "X"); assert.equal(m[1].状態, "控え"); assert.equal(m[1].先月の評価, "悪い");
});
test("予定と実績：その週に同じ種類の予約か公開（下書きは数えない・集客は数えない）", () => {
  const [a, b] = nkMovesOf(items, "2026-11", ladder, posts, "2026-11-20");
  assert.equal(a.月の型のマス[0].出した記事[0].題, "図解の下書き");
  assert.equal(a.月の型のマス[1].出した記事.length, 0);
  assert.equal(a.予定と実績, "1 / 2（今日までに始まった週のマス・全 2）");
  assert.equal(b.月の型のマス[0].数え方, "集客は数えない");
  assert.equal(b.予定と実績, undefined);
});
test("ロードマップ：書いたマイルストーンだけ・レベル付き", () => {
  const g = nkGoalsOf(ladder);
  assert.equal(g[0].レベル, "Lv20〜30");
  assert.deepEqual(g[0].マイルストーン.map((m: any) => [m.Lv, m.状態, m.種類]), [[21, "できた", "行動"], [23, "試し中", "成果"]]);
});
