import test from "node:test";
import assert from "node:assert/strict";
import { enoughOlder, nextAccount, picksOf, skiEmpty, skiOf, targetMonths } from "../src/notekoryaku-core.ts";

const a = (k: string, day: string, likes: number, extra: Record<string, unknown> = {}) => ({ key: k, title: k, published_at: `${day}T12:00:00+09:00`, likes, views: null, comments: 0, ...extra });

test("skiOf：その月の公開分を種類ごとに [本数, スキ]", () => {
  const xs = [a("a", "2026-10-01", 5), a("b", "2026-10-31", 7, { price: 300 }), a("c", "2026-10-15", 2, { membership: true }), a("d", "2026-11-01", 9)];
  assert.deepEqual(skiOf(xs, "2026-10"), { f: [1, 5], p: [1, 7], m: [1, 2] });
  assert.equal(skiEmpty({ f: [0, 0], p: [0, 0], m: [0, 0] }), true);
  assert.equal(skiEmpty({}), true);
  assert.equal(skiEmpty({ m: [8, 230] }), false);
});

test("targetMonths：初回の遡りと、2 日からの前の月", () => {
  assert.deepEqual(targetMonths("2026-11-10"), ["2026-08", "2026-09", "2026-10"]);
  assert.deepEqual(targetMonths("2026-12-01"), ["2026-08", "2026-09", "2026-10"]);
  assert.deepEqual(targetMonths("2026-12-02"), ["2026-08", "2026-09", "2026-10", "2026-11"]);
  assert.deepEqual(targetMonths("2027-01-02"), ["2026-08", "2026-09", "2026-10", "2026-12"]);
});

test("nextAccount：済んでいない月がある最初の相手", () => {
  assert.deepEqual(nextAccount(["x", "y"], { "2026-10": ["x"] }, ["2026-10"]), { account: "y", months: ["2026-10"] });
  assert.equal(nextAccount(["x"], { "2026-10": ["x"] }, ["2026-10"]), null);
});

test("picksOf と enoughOlder", () => {
  const xs = Array.from({ length: 11 }, (_, i) => a(`n${i}`, `2026-10-${String(i + 10).padStart(2, "0")}`, i === 5 ? 30 : 10));
  const ps = picksOf("acc", "acc", xs, ["2026-10"], "2026-11-10");
  assert.equal(ps.length, 1); assert.equal(ps[0].url, "https://note.com/acc/n/n5"); assert.equal(ps[0].r, 3);
  assert.equal(enoughOlder(xs, xs[10].published_at, "2026-11"), true);
  assert.equal(enoughOlder(xs, xs[10].published_at, "2026-10"), false);
});
