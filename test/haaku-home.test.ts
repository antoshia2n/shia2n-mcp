// v1.10.0：haAku のホームの計算と結び。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { computeHome, findBlocker, stepRows } from "../src/haaku-home.js";
import { applyLinkChanges, parseLinksStore } from "../src/haaku-home-store.js";

const S = (id: string, dependsOn = "", status = "todo", dueDate = "") => ({ id, title: "マス" + id, status, dueDate, dependsOn });
const T = (id: string, completed = false, deadline = "", archived = false) => ({ id, title: "タスク" + id, completed, archived, deadline, priority: "" });

test("詰まり：分岐があっても、後ろの未完了を一番多く止めているマス", () => {
  const steps = [S("A"), S("B", "A"), S("C", "A"), S("D", "C"), S("E")];
  assert.deepEqual(findBlocker(steps), { id: "A", blocks: 3 });
});

test("詰まり：同数なら期限が近い方・期限なしは後ろ", () => {
  const steps = [S("X", "", "todo", ""), S("Y", "X"), S("Z", "", "todo", "2026-10-20"), S("W", "Z")];
  assert.equal(findBlocker(steps)!.id, "Z");
});

test("詰まり：100％ のマスは数えない。前のマスが循環していたら断る", () => {
  assert.deepEqual(findBlocker([S("A", "", "done"), S("B", "A"), S("C", "B")]), { id: "B", blocks: 1 });
  assert.throws(() => findBlocker([S("A", "B"), S("B", "A")]), /循環/);
});

test("次はこれ：詰まりの道の上で動けるマスの、期限が近い未完了タスク。無ければ「タスクが結ばれていない」", () => {
  const steps = [S("A", "", "done"), S("B", "A"), S("C", "B"), S("D", "C")];
  const tasks = [T("t1", false, "2026-10-20"), T("t2", false, "2026-10-15"), T("t3", true, "2026-10-01"), T("t4", false, "")];
  const links = [{ taskId: "t1", milestoneId: "B" }, { taskId: "t2", milestoneId: "B" }, { taskId: "t3", milestoneId: "B" }, { taskId: "t4", milestoneId: "C" }];
  const home = computeHome({ steps, tasks, links, initiatives: [], kpis: [], today: "2026-10-12" });
  assert.equal(home.blocker!.id, "B");
  assert.deepEqual((home.next as any).task.id, "t2");
  assert.equal((home.next as any).step.id, "B");
  const none = computeHome({ steps, tasks, links: [], initiatives: [], kpis: [], today: "2026-10-12" });
  assert.equal((none.next as any).state, "no_tasks");
  assert.equal((none.next as any).note, "タスクが結ばれていない");
});

test("行動の率：0 件なら空（0％ と書かない）。完了÷全部。アーカイブして未完了は数えない。状態の決め方", () => {
  const steps = [S("A", "", "done"), S("B", "A"), S("C", "B"), S("D")];
  const tasks = [T("t1", true), T("t2", false), T("t3", false, "", true)];
  const rows = stepRows(steps, tasks, [{ taskId: "t1", milestoneId: "B" }, { taskId: "t2", milestoneId: "B" }, { taskId: "t3", milestoneId: "B" }]);
  const r = Object.fromEntries(rows.map(x => [x.id, x]));
  assert.equal(r.B.action_pct, 50);
  assert.equal(r.B.tasks_total, 2);
  assert.equal(r.D.action_pct, null);
  assert.equal(r.A.state, "100%");
  assert.equal(r.B.state, "進行中");
  assert.equal(r.C.state, "待ち");
  assert.equal(r.D.state, "動ける");
});

test("取り組み：行動 100％・成果 100％ 未満なら「打ち手を足す」。KPI が無ければ空と明示", () => {
  const steps = [S("A")];
  const tasks = [T("t1", true)];
  const links = [{ taskId: "t1", milestoneId: "A" }];
  const kpis = [{ id: "k1", title: "インプ", unit: "万", monthlyTarget: 100, monthlyActual: 40, pct: 40 }, { id: "k2", title: "x", unit: "", monthlyTarget: 10, monthlyActual: 20, pct: 200 }];
  const home = computeHome({ steps, tasks, links, kpis, today: "2026-10-12",
    initiatives: [{ no: "01", name: "一", linkedMilestoneIds: ["A"], linkedKpiIds: ["k1", "k2"] }, { no: "02", name: "二", linkedMilestoneIds: ["A"], linkedKpiIds: [] }] });
  assert.equal(home.initiatives[0].action_pct, 100);
  assert.equal(home.initiatives[0].outcome_pct, 70, "1 本ずつ 100 で頭打ちにして平均（40 と 100）");
  assert.equal(home.initiatives[0].signal, "打ち手を足す");
  assert.equal(home.initiatives[1].outcome_pct, null);
  assert.equal(home.initiatives[1].outcome_note, "KPI が結ばれていない");
});

test("期限の数：来週の月〜日と、今日までの期限で残っている数", () => {
  const tasks = [T("a", false, "2026-10-13"), T("b", false, "2026-10-19"), T("c", false, "2026-10-20"), T("d", false, "2026-10-11"), T("e", true, "2026-10-14"), T("f", false, "2026-10-12T09:00:00")];
  const home = computeHome({ steps: [], tasks, links: [], initiatives: [], kpis: [], today: "2026-10-12" });
  assert.deepEqual(home.deadlines.next_week, { from: "2026-10-19", to: "2026-10-25", count: 2 });
  assert.equal(home.deadlines.due_by_today_open, 2);
  assert.equal((home.next as any).state, "all_done");
});

test("結び：結ぶ・付け替える・外す。外したものも記録に残る。知らないタスクとステップは断る", () => {
  const tasks = new Set(["t1", "t2"]), steps = new Set(["A", "B"]);
  let s = parseLinksStore(null);
  let r = applyLinkChanges(s, [{ taskId: "t1", milestoneId: "A" }, { taskId: "t2", milestoneId: "A" }], "2026-10-12T00:00:00Z", tasks, steps);
  s = r.store;
  r = applyLinkChanges(s, [{ taskId: "t1", milestoneId: "B" }, { taskId: "t2", milestoneId: null }], "2026-10-12T01:00:00Z", tasks, steps);
  assert.deepEqual(r.store.links.map(l => [l.taskId, l.milestoneId]), [["t1", "B"]]);
  assert.equal(r.store.history.length, 4);
  assert.deepEqual(r.store.history[3], { at: "2026-10-12T01:00:00Z", taskId: "t2", from: "A", to: null });
  const same = applyLinkChanges(r.store, [{ taskId: "t1", milestoneId: "B" }], "x", tasks, steps);
  assert.equal(same.results[0].changed, false);
  assert.throws(() => applyLinkChanges(s, [{ taskId: "t9", milestoneId: "A" }], "x", tasks, steps), /タスクがありません/);
  assert.throws(() => applyLinkChanges(s, [{ taskId: "t1", milestoneId: "Z" }], "x", tasks, steps), /ステップ/);
  assert.throws(() => parseLinksStore({ schemaVersion: 1, links: [{ taskId: "a", milestoneId: "A" }, { taskId: "a", milestoneId: "B" }], history: [] }), /重複/);
});
