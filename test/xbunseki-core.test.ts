import test from "node:test";
import assert from "node:assert/strict";
import { currentWeekLabel, inMonth, layersOf, mergeMetrics, pickWeek } from "../src/xbunseki-core.ts";

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
