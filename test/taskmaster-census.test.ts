// v1.9.1：TaskMaster の数え方。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { summarizeTasks } from "../src/taskmaster-census.js";

test("完了の印・終わった日・月ごとの数を数え、題名は返さない", () => {
  const s = summarizeTasks([
    { id: "a", title: "秘密", status: "done", completed: true, doneAt: "2026-10-03" },
    { id: "b", title: "x", status: "done", completed: true, doneAt: "" },
    { id: "c", title: "y", status: "todo", completed: false },
    { id: "d", title: "z", status: "todo", completed: false, archived: true },
    { id: "e", status: "done", completed: true, doneAt: "2026-09-30" },
  ]);
  assert.equal(s.total, 5);
  assert.equal(s.completed_true, 3);
  assert.equal(s.open_not_archived, 1);
  assert.equal(s.completed_with_doneAt, 2);
  assert.equal(s.completed_without_doneAt, 1);
  assert.equal(s.doneAt_first, "2026-09-30");
  assert.deepEqual(s.completed_by_month, { "2026-09": 1, "2026-10": 1 });
  assert.deepEqual(s.doneAt_shapes, ["9999-99-99"]);
  assert.equal(JSON.stringify(s).includes("秘密"), false);
});
