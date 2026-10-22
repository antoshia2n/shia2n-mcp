import { test } from "node:test";
import assert from "node:assert/strict";
import { nextRepeatDate, nextRepeatTask, buildNewTask } from "../src/taskmaster.js";

test("繰り返しの次の日（taskmaster の nextRepeatDate と同じ・2026-10-22）", () => {
  assert.equal(nextRepeatDate("2026-10-24", "weekly"), "2026-10-31");
  assert.equal(nextRepeatDate("2026-10-23", "weekday"), "2026-10-26"); // 金 → 月
  assert.equal(nextRepeatDate("2026-10-31", "monthly"), "2026-12-01");
  assert.equal(nextRepeatDate("2026-10-24", "daily"), "2026-10-25");
  assert.equal(nextRepeatDate("2026-10-24", ""), null);
});

test("済みにした繰り返しタスクの次の回", () => {
  const t = { id: "a", title: "応援速報", repeat: "weekly", deadline: "2026-10-24", status: "done", completed: true, doneAt: "2026-10-24", completedAt: "x", order: 3, subtasks: [{ t: "集計", done: true }], projectId: "p" };
  const n = nextRepeatTask(t, "2026-10-24")!;
  assert.notEqual(n.id, "a");
  assert.equal(n.deadline, "2026-10-31");
  assert.equal(n.status, "todo");
  assert.equal(n.completed, false);
  assert.equal(n.doneAt, "");
  assert.equal((n.subtasks as any[])[0].done, false);
  assert.equal(n.projectId, "p");
  assert.equal(nextRepeatTask({ ...t, repeat: "" }, "2026-10-24"), null);
});

test("add_task の repeat は入れたときだけ欄を持つ", () => {
  assert.equal(buildNewTask({ title: "x", repeat: "weekly" }).repeat, "weekly");
  assert.equal("repeat" in buildNewTask({ title: "x" }), false);
});
