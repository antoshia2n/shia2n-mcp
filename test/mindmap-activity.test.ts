// v1.43.0：思考整理くんの日ごとの枝の数。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { reduceRows, diffSnaps, countDays, datesBetween, nextDate } from "../src/mindmap-activity.js";

const ME = "uid-naoki";
const map = (id: string, nodes: Record<string, Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  ({ id, user_id: ME, title: "26年戦略思考整理", is_template: false, root: "r", nodes: { r: { id: "r", text: "26年戦略思考整理" }, ...nodes }, ...extra });

test("縮める：自分の行だけ・テンプレは外す・名前の枝は数えない", () => {
  const s = reduceRows([
    map("m1", { a: { text: "A" } }),
    map("m2", { a: { text: "A" } }, { user_id: "someone" }),
    map("m3", { a: { text: "A" } }, { is_template: true }),
  ], ME);
  assert.deepEqual([...s.keys()], ["m1"]);
  assert.deepEqual([...s.get("m1")!.nodes.keys()], ["a"]);
});

test("比べる：足した・直した（文字・メモ・チェック・リンク）・消した。位置や色だけの変化は数えない", () => {
  const a = reduceRows([map("m1", { a: { text: "A" }, b: { text: "B" }, c: { text: "C" }, d: { text: "D", color: "b1" } })], ME);
  const b = reduceRows([map("m1", { a: { text: "A2" }, b: { text: "B", memo: "メモ" }, d: { text: "D", color: "b3", collapsed: true }, e: { text: "E" }, f: { text: "F", check: "todo" } })], ME);
  assert.deepEqual(diffSnaps(a, b), [{ id: "m1", title: "26年戦略思考整理", added: 2, edited: 2, removed: 1, created: false, deleted: false }]);
});

test("比べる：新しいマップは全部の枝を足した、消えたマップは全部を消した。変わらないマップは出さない", () => {
  const a = reduceRows([map("old", { x: { text: "X" } }), map("same", { y: { text: "Y" } })], ME);
  const b = reduceRows([map("same", { y: { text: "Y" } }), map("new", { p: { text: "P" }, q: { text: "Q" } }, { title: "新しい" })], ME);
  const d = diffSnaps(a, b);
  assert.deepEqual(d.map(x => [x.id, x.added, x.removed, x.created, x.deleted]), [["new", 2, 0, true, false], ["old", 0, 1, false, true]]);
});

test("日ごと：その日の朝と次の日の朝の控えを比べる。今日は今の中身。控えが無い日は数えずに理由を返す", () => {
  const s = (t: string) => reduceRows([map("m1", { a: { text: t } })], ME);
  const snaps = new Map([["2026-10-18", s("1")], ["2026-10-19", s("2")], ["2026-10-21", s("3")], ["2026-10-25", s("3")]]);
  const at = new Map([["2026-10-18", "2026-10-18 05:10"], ["2026-10-19", "2026-10-19 05:12"]]);
  const live = reduceRows([map("m1", { a: { text: "4" }, b: { text: "new" } })], ME);
  const r = countDays(["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-25"], "2026-10-25", snaps, at, live, "2026-10-25 19:40");
  assert.deepEqual(r[0], { day: "2026-10-18", from: "2026-10-18 05:10", to: "2026-10-19 05:12", maps: [{ id: "m1", title: "26年戦略思考整理", added: 0, edited: 1, removed: 0, created: false, deleted: false }] });
  assert.deepEqual(r[1], { day: "2026-10-19", missing: "2026-10-20 の朝の控えが無い" });
  assert.deepEqual(r[2], { day: "2026-10-20", missing: "2026-10-20 の朝の控えが無い" });
  assert.equal("missing" in r[3], false);
  if (!("missing" in r[3])) { assert.equal(r[3].to, "2026-10-25 19:40（今の中身）"); assert.deepEqual([r[3].maps[0].added, r[3].maps[0].edited], [1, 1]); }
});

test("日付の並び", () => {
  assert.deepEqual(datesBetween("2026-10-30", "2026-11-02"), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  assert.equal(nextDate("2026-12-31"), "2027-01-01");
});
