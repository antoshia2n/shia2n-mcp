import test from "node:test";
import assert from "node:assert/strict";
import { buildRows, kindOf, median, nextPick, ratios, prevMonthOf } from "../src/notekoryaku-core.ts";

const art = (k: string, day: string, likes: number, extra: Record<string, unknown> = {}) => ({ key: k, title: k, published_at: `${day}T10:00:00+09:00`, likes, views: likes * 10, comments: 0, ...extra });

test("kindOf：値段→有料・メンシプ→メンシプ・ほか無料", () => {
  assert.equal(kindOf(art("a", "2026-01-01", 1, { price: 500, membership: true })), "paid");
  assert.equal(kindOf(art("a", "2026-01-01", 1, { membership: true })), "member");
  assert.equal(kindOf(art("a", "2026-01-01", 1)), "free");
});

test("ratios：前後 5 本の真ん中で割る・端は片側だけ・真ん中 0 は 1 で割る", () => {
  assert.equal(median([3, 1, 2]), 2); assert.equal(median([1, 2, 3, 4]), 2.5);
  const xs = Array.from({ length: 11 }, (_, i) => art(`n${i}`, `2026-01-${String(i + 1).padStart(2, "0")}`, i === 5 ? 30 : 10));
  const r = ratios(xs);
  assert.deepEqual(r.get("n5"), { r: 3, base: 10, n: 10 });
  assert.equal(r.get("n0")?.n, 5);
  assert.equal(ratios([art("a", "2026-01-01", 2), art("b", "2026-01-02", 0)]).get("a")?.r, 2);
});

test("nextPick：1.2 倍以上で new・Naoki が決めた sent / skip は残す・範囲の外は触らない", () => {
  assert.deepEqual(nextPick(null, { r: 1.2, base: 5, n: 10 }, true, "2026-12-02"), { r: 1.2, base: 5, n: 10, at: "2026-12-02", st: "new" });
  assert.equal(nextPick(null, { r: 1.19, base: 5, n: 10 }, true, "d"), null);
  const sent = { r: 2, base: 5, n: 10, at: "x", st: "sent" as const };
  assert.equal(nextPick(sent, { r: 1.0, base: 6, n: 10 }, true, "d")?.st, "sent");
  assert.equal(nextPick(sent, { r: 1.0, base: 6, n: 10 }, false, "d"), sent);
  assert.equal(nextPick({ ...sent, st: "new" }, { r: 1.0, base: 6, n: 10 }, true, "d"), null);
});

test("buildRows：日ごとの累計を足し、前の回の分を残す・範囲が月なら他の月の印は残す", () => {
  const xs = [art("a", "2026-10-05", 10), art("b", "2026-11-03", 30), art("c", "2026-11-20", 10)];
  const olds = [{ note_key: "a", snaps: { "2026-11-02": { v: 50, l: 5, c: 0 } }, pick: { r: 9, base: 1, n: 2, at: "2026-11-02", st: "skip" as const }, sort: 3 }];
  const { rows, added } = buildRows("u1", xs, olds, "2026-12-02", "2026-11");
  assert.equal(added, 2);
  const a = rows.find(r => r.note_key === "a")!;
  assert.deepEqual(Object.keys(a.snaps).sort(), ["2026-11-02", "2026-12-02"]);
  assert.equal(a.pick?.r, 9); assert.equal(a.sort, 3); assert.equal(a.month, "2026-10");
  assert.equal(rows.find(r => r.note_key === "b")!.pick?.st, "new");
  assert.equal(rows.find(r => r.note_key === "b")!.url, "https://note.com/shia2n/n/b");
  assert.ok(rows.every(r => Object.keys(r).length === Object.keys(rows[0]).length));
  assert.equal(prevMonthOf("2026-01-02"), "2025-12");
});
