// v1.90.0：セミナーの回から TaskMaster へ。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { planSeminarTasks, decideMove, parseStore, addDays, jstToday, seminarKeys, taskTitle, type Store } from "../src/seminar-tasks.js";
import type { TaskNow } from "../src/taskmaster-by-id.js";

const empty = (): Store => ({ v: 1, posts: {} });
const T = (deadline: unknown, o: Partial<TaskNow> = {}): TaskNow =>
  ({ exists: true, deadline, hasDeadline: deadline != null, completed: false, archived: false, updateTime: "u", ...o });

test("日付の足し引きと日本時間の今日", () => {
  assert.equal(addDays("2026-11-18", -3), "2026-11-15");
  assert.equal(addDays("2026-12-01", -1), "2026-11-30");
  assert.equal(jstToday(new Date("2026-11-13T15:30:00Z")), "2026-11-14");
});

test("新しい回は 3 つ入れる（構成 3 日前・告知 2 日前・スライド前日）", () => {
  const p = planSeminarTasks([{ id: "11", title: "11/18｜アプリの使い方", date: "2026-11-18" }], empty());
  assert.deepEqual(p.adds.map(a => [a.step, a.deadline]), [["構成", "2026-11-15"], ["告知", "2026-11-16"], ["スライド", "2026-11-17"]]);
  assert.equal(p.adds[0].title, "セミナー｜構成｜11/18｜アプリの使い方");
  assert.equal(p.adds[0].url, "https://content-os.shia2n.jp/?post=11");
  assert.equal(p.moves.length, 0);
});

test("入れたことのある回は入れ直さず、開催日が動いた分だけ動かす。消されていたものは触らない", () => {
  const s: Store = { v: 1, posts: { "11": {
    構成: { taskId: "a", deadline: "2026-11-15" }, 告知: { taskId: "b", deadline: "2026-11-16" }, スライド: { taskId: "c", deadline: "2026-11-17", gone: true },
  } } };
  const same = planSeminarTasks([{ id: "11", title: "x", date: "2026-11-18" }], s);
  assert.equal(same.adds.length + same.moves.length, 0);
  const moved = planSeminarTasks([{ id: "11", title: "x", date: "2026-11-25" }], s);
  assert.equal(moved.adds.length, 0);
  assert.deepEqual(moved.moves.map(m => [m.taskId, m.from, m.to]), [["a", "2026-11-15", "2026-11-22"], ["b", "2026-11-16", "2026-11-23"]]);
});

test("動かすのは、前に写した日のままのタスクだけ", () => {
  const m = { postId: "11", step: "構成" as const, taskId: "a", from: "2026-11-15", to: "2026-11-22" };
  assert.equal(decideMove(m, T("2026-11-15")), "move");
  assert.equal(decideMove(m, T("2026-11-14")), "naoki");
  assert.equal(decideMove(m, T("2026-11-15", { completed: true })), "closed");
  assert.equal(decideMove(m, T("2026-11-15", { archived: true })), "closed");
  assert.equal(decideMove(m, T(null, { exists: false })), "gone");
  assert.equal(decideMove(m, undefined), "gone");
});

test("記録の形が違えば止める・空なら空から", () => {
  assert.deepEqual(parseStore(null), empty());
  assert.throws(() => parseStore({ v: 2, posts: {} }));
  assert.throws(() => parseStore("x"));
});

test("「セミナー」の種類の鍵を名前で探す・題の無い回", () => {
  assert.deepEqual(seminarKeys([{ custom_post_types: [{ key: "custom_a", label: "動画" }, { key: "custom_s", label: " セミナー " }] }, { custom_post_types: null }]), ["custom_s"]);
  assert.equal(taskTitle("告知", ""), "セミナー｜告知｜（題なし）");
});
