import { test } from "node:test";
import assert from "node:assert/strict";
import { subStats, subView, applySubEst, newSubs } from "../src/taskmaster-subs.js";
import { nextRepeatTask, withTemplate, buildNewTask } from "../src/taskmaster.js";

const t = (subtasks: unknown[]) => ({ id: "t", title: "x", subtasks });

test("進捗率は画面と同じ：全部に見積もりがあれば時間で、空があれば件数で", () => {
  assert.deepEqual(subStats(t([{ title: "a", done: true, est: 30 }, { title: "b", done: false, est: 90 }])),
    { n: 2, done: 1, pct: 25, by: "time", est_total: 120, est_left: 90, missing: 0 });
  const c = subStats(t([{ title: "a", done: true, est: 30 }, { title: "b" }]))!;
  assert.equal(c.by, "count"); assert.equal(c.pct, 50); assert.equal(c.missing, 1);
  assert.equal(subStats(t([])), null);
});

test("見せる形：id が無い古い形は #番号・文字だけも読む", () => {
  const v = subView(t(["文字だけ", { text: "b", completed: true, est: "15", memo: "m" }]));
  assert.deepEqual(v, [{ id: "#1", title: "文字だけ", done: false }, { id: "#2", title: "b", done: true, est: 15, memo: "m" }]);
});

test("見積もりを id・名前・#番号で入れる／0 で消す", () => {
  const src = t([{ id: "a1", title: "構成", done: false }, { id: "b2", title: "図解", done: false, est: 10 }, "通し"]);
  const r = applySubEst(src, [{ subtask: "a1", minutes: 30 }, { subtask: " 図解 ", minutes: 0 }, { subtask: "#3", minutes: 45 }]);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.subtasks[0].est, 30);
  assert.equal("est" in r.subtasks[1], false);
  assert.equal(r.subtasks[2].est, 45);
  assert.equal(r.subtasks[2].title, "通し");
  assert.equal((src.subtasks[0] as any).est, undefined); // 元は変えない
});

test("決まらないものが 1 つでもあれば何も変えない", () => {
  const src = t([{ id: "a", title: "同じ" }, { id: "b", title: "同じ" }]);
  const r = applySubEst(src, [{ subtask: "a", minutes: 30 }, { subtask: "同じ", minutes: 10 }, { subtask: "無い", minutes: 5 }]);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.detail.length, 2);
});

test("add_task のサブタスク：名前の空は捨て、minutes は見積もりに", () => {
  let n = 0;
  assert.deepEqual(newSubs([{ title: " 読む ", minutes: 30 }, { title: "" }, "書く"], () => "s" + ++n),
    [{ id: "s1", title: "読む", done: false, est: 30 }, { id: "s2", title: "書く", done: false }]);
});

test("テンプレと繰り返しの次の回に見積もりを持ち越し、メモは持ち越さない", () => {
  const w = withTemplate(buildNewTask({ title: "n" }), { id: "tp", subtasks: [{ title: "a", est: 20 }, "b"] }, { title: "n" });
  assert.equal((w.subtasks as any[])[0].est, 20);
  assert.equal("est" in (w.subtasks as any[])[1], false);
  const rep = { id: "r", title: "x", repeat: "daily", deadline: "2026-11-12", status: "done", subtasks: [{ id: "s", title: "a", done: true, est: 30, memo: "この回" }] };
  const nx = nextRepeatTask(rep, "2026-11-12")!;
  const s0 = (nx.subtasks as any[])[0];
  assert.equal(s0.est, 30); assert.equal(s0.done, false); assert.equal("memo" in s0, false);
});
