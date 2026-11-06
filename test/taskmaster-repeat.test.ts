import { test } from "node:test";
import assert from "node:assert/strict";
import { nextRepeatDate, nextRepeatTask, nextRepeatDates, buildNewTask } from "../src/taskmaster.js";

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

test("次の回の名前は元の名前＋日付で決まり、2 回作っても同じ（2026-11-07）", () => {
  const t = { id: "k", title: "家事", repeat: "daily", deadline: "2026-11-07", status: "done" };
  assert.equal(nextRepeatTask(t, "2026-11-07")!.id, "k__r2026-11-08");
  assert.equal(nextRepeatTask(t, "2026-11-07")!.id, nextRepeatTask(t, "2026-11-07")!.id);
  const n = nextRepeatTask(t, "2026-11-07")!;
  assert.equal(nextRepeatTask({ ...n, status: "done" }, "2026-11-08")!.id, "k__r2026-11-09");
});

test("画面と同じ日付の決まり：遅れて終えた回は今日より後へ・着手日も進む", () => {
  assert.deepEqual(nextRepeatDates({ repeat: "daily", startDate: "2026-10-20", deadline: "2026-10-20" }, "2026-10-29"),
    { deadline: "2026-10-30", startDate: "2026-10-30" });
  assert.deepEqual(nextRepeatDates({ repeat: "weekly", startDate: "2026-10-27", deadline: "2026-10-30" }, "2026-10-29"),
    { deadline: "2026-11-06", startDate: "2026-11-03" });
  assert.deepEqual(nextRepeatDates({ repeat: "weekly", startDate: "2026-10-26" }, "2026-10-29"), { deadline: "", startDate: "2026-11-02" });
});
