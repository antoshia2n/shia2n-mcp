// v1.92.0：TaskMaster のリマインド。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { pickReminders, buildRemindMail, slotOf, jstSlot } from "../src/task-remind.js";
import { buildNewTask } from "../src/taskmaster.js";

const today = "2026-11-14";

test("着手日が今日のものだけ・済みとアーカイブは出さない", () => {
  const p = pickReminders([
    { id: "a", title: "構成を作る", remindStart: true, startDate: "2026-11-14" },
    { id: "b", title: "明日から", remindStart: true, startDate: "2026-11-15" },
    { id: "c", title: "済み", remindStart: true, startDate: "2026-11-14", completed: true },
    { id: "d", title: "しまった", remindStart: true, startDate: "2026-11-14", archived: true },
  ], [], today);
  assert.deepEqual(p.starts.map(r => r.id), ["a"]);
});

test("期限切れは昨日以前のものを、遅れの大きい順に（今日が期限のものは出さない）", () => {
  const p = pickReminders([], [
    { id: "x", title: "告知", remindOverdue: true, deadline: "2026-11-13" },
    { id: "y", title: "スライド", remindOverdue: true, deadline: "2026-11-10" },
    { id: "z", title: "今日まで", remindOverdue: true, deadline: "2026-11-14" },
    { id: "w", title: "済み", remindOverdue: true, deadline: "2026-11-01", status: "done" },
    { id: "v", title: "期限なし", remindOverdue: true, deadline: null },
  ], today);
  assert.deepEqual(p.overdue.map(r => [r.id, r.late]), [["y", 4], ["x", 1]]);
});

test("メールの中身・知らせるものが無ければ null", () => {
  const m = buildRemindMail({ starts: [{ id: "a", title: "構成を作る", day: today, late: 0 }], overdue: [{ id: "y", title: "スライド", day: "2026-11-10", late: 4 }] }, today);
  assert.ok(m);
  assert.equal(m!.subject, "TaskMaster のリマインド：今日から 1 件・期限切れ 1 件");
  assert.match(m!.text, /・スライド（11\/10（火）が期限・4 日過ぎ）/);
  assert.match(m!.text, /https:\/\/taskmaster\.shia2n\.jp\/\?task=a/);
  assert.equal(buildRemindMail({ starts: [], overdue: [] }, today), null);
});

test("add_task の中身にリマインドを渡せる（true のときだけ欄を持つ）", () => {
  assert.equal(buildNewTask({ title: "t", remindOverdue: true }).remindOverdue, true);
  assert.equal("remindStart" in buildNewTask({ title: "t" }), false);
});

// v1.93.0：時刻
test("時刻を 30 分の枠にそろえる・日本時間の今の枠", () => {
  assert.equal(slotOf("7:00"), "07:00");
  assert.equal(slotOf("21:45"), "21:30");
  assert.equal(slotOf("25:00"), null);
  assert.equal(slotOf(undefined), null);
  assert.equal(jstSlot(new Date("2026-11-13T22:00:30Z")), "07:00");
  assert.equal(jstSlot(new Date("2026-11-13T12:31:00Z")), "21:30");
});
test("着手は選んだ時刻の枠だけ（空なら 7:00）・期限切れは 7:00 の枠だけ", () => {
  const st = [
    { id: "a", title: "空", remindStart: true, startDate: today },
    { id: "b", title: "21 時", remindStart: true, startDate: today, remindAt: "21:00" },
  ];
  const od = [{ id: "y", title: "遅れ", remindOverdue: true, deadline: "2026-11-10" }];
  const at7 = pickReminders(st, od, today, "07:00");
  assert.deepEqual([at7.starts.map(r => r.id), at7.overdue.map(r => r.id)], [["a"], ["y"]]);
  const at21 = pickReminders(st, od, today, "21:00");
  assert.deepEqual([at21.starts.map(r => r.id), at21.overdue.length], [["b"], 0]);
  assert.equal(buildNewTask({ title: "t", remindAt: "21:00" }).remindAt, "21:00");
  assert.equal("remindAt" in buildNewTask({ title: "t", remindAt: "21:15" }), false);
});
