// v1.11.0：前のマスを複数（dependsOnIds）と、承認つきの削除（milestone_delete）。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { depsOf, ancestorsOf } from "../src/haaku-deps.js";
import { computeHome, findBlocker, stepRows } from "../src/haaku-home.js";
import { parseChanges, neededKeys } from "../src/haaku-ai-changes.js";
import { buildManagementChangePlan } from "../src/haaku-ai-model.js";
import { managementWriteAudit } from "../src/haaku-ai-audit.js";

const at = "2026-10-12T03:00:00.000Z";
const S = (id: string, deps: string[] = [], status = "todo", dueDate = "") =>
  ({ id, title: "マス" + id, status, dueDate, dependsOn: deps[0] ?? "", dependsOnIds: deps });
const T = (id: string, completed = false, deadline = "") => ({ id, title: "タスク" + id, completed, archived: false, deadline, priority: "" });
const M = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: "成果" + id, criterion: "合格", status: "todo", dueDate: "", dependsOn: "", ...extra });
const make = (items: unknown[]) => parseChanges(JSON.stringify(items));
const roadmap = (milestones: unknown[], extra: Record<string, unknown> = {}) =>
  ({ version: 1, northStar: "", milestones, phases: [], ...extra });
const initiatives = (rows: { no: string; mids: string[] }[]) => ({
  schemaVersion: 1,
  records: rows.map(r => ({ id: "initiative_" + r.no, initiativeNo: r.no, revisions: [{
    id: "ai_revision_init-" + r.no + "-0000", number: 1, savedAt: "2026-10-11T00:00:00.000Z",
    requestId: "init-" + r.no + "-0000", source: "approved_mcp_change", reason: "初回記録",
    name: "取り組み" + r.no, stage: "構築する", overview: "", ideals: [], conditions: [], kpis: [],
    approaches: [], plans: [], obstacles: [], progress: "", linkedMilestoneIds: r.mids, linkedKpiIds: [],
  }] })),
});

test("読み方：配列が正。古い欄だけなら 1 つ。古い欄が配列に無ければ先頭に足して食い違いを立てる", () => {
  assert.deepEqual(depsOf({ dependsOn: "A" }), { ids: ["A"], mismatch: false });
  assert.deepEqual(depsOf({ dependsOn: "" }), { ids: [], mismatch: false });
  assert.deepEqual(depsOf({ dependsOn: "A", dependsOnIds: ["A", "B"] }), { ids: ["A", "B"], mismatch: false });
  assert.deepEqual(depsOf({ dependsOn: "C", dependsOnIds: ["A", "B"] }), { ids: ["C", "A", "B"], mismatch: true });
});

test("たどり：分かれて合流しても 1 マス 1 回。循環は断る", () => {
  const g = new Map([["D", ["B", "C"]], ["B", ["A"]], ["C", ["A"]], ["A", []]]);
  assert.deepEqual(ancestorsOf(g, "D"), ["B", "C", "A"]);
  assert.throws(() => ancestorsOf(new Map([["A", ["B"]], ["B", ["C"]], ["C", ["A"]]]), "A"), /循環/);
});

test("ホーム：前が全部 100％ のときだけ動ける。1 つでも未完了なら待ち", () => {
  const steps = [S("A", [], "done"), S("B"), S("C", ["A", "B"])];
  const r1 = Object.fromEntries(stepRows(steps, [], []).map(x => [x.id, x]));
  assert.equal(r1.C.state, "待ち");
  assert.deepEqual(r1.C.depends_on_ids, ["A", "B"]);
  assert.equal(r1.C.depends_on, "A");
  const r2 = Object.fromEntries(stepRows([S("A", [], "done"), S("B", [], "done"), S("C", ["A", "B"])], [], []).map(x => [x.id, x]));
  assert.equal(r2.C.state, "動ける");
});

test("ホーム：後ろを止めている数は、複数の前から届いても 1 マスを二重に数えない", () => {
  // A → B, A → C, B と C → D。A が止めているのは B・C・D の 3 つ（D を 2 回数えない）
  const steps = [S("A"), S("B", ["A"]), S("C", ["A"]), S("D", ["B", "C"])];
  assert.deepEqual(findBlocker(steps), { id: "A", blocks: 3 });
});

test("ホーム：次はこれ は詰まりの前へたどれるマスのうち、前が全部 100％ のマスから選ぶ", () => {
  // D の前は B と C。B は 100％・C は未完了で前の A も未完了 → 動けるのは A だけ
  const steps = [S("A"), S("B", [], "done"), S("C", ["A"]), S("D", ["B", "C"]), S("E", ["D"])];
  const home = computeHome({ steps, tasks: [T("t1")], links: [{ taskId: "t1", milestoneId: "A" }], initiatives: [], kpis: [], today: "2026-10-12" });
  assert.equal(home.blocker!.id, "A");
  assert.equal((home.next as any).step.id, "A");
  assert.equal((home.next as any).task.id, "t1");
  // 古い形（dependsOnIds なし）の呼び出しも同じに動く
  const legacy = [{ id: "X", title: "x", status: "todo", dueDate: "", dependsOn: "" }, { id: "Y", title: "y", status: "todo", dueDate: "", dependsOn: "X" }];
  assert.deepEqual(findBlocker(legacy), { id: "X", blocks: 1 });
});

test("書く：前を配列で書ける。dependsOn には 1 つ目が入る。存在しない ID・循環・同じ ID の重複は断る", () => {
  const store = { os_roadmap_v1: roadmap([M("milestone_aaaa"), M("milestone_bbbb"), M("milestone_cccc", { dependsOn: "milestone_aaaa" })]) };
  const plan = buildManagementChangePlan(make([{ kind: "milestone", request_id: "deps-20261012-0001",
    data: { id: "milestone_cccc", dependsOnIds: JSON.stringify(["milestone_aaaa", "milestone_bbbb"]) } }]), store, at);
  const c = (plan.next.os_roadmap_v1 as any).milestones.find((m: any) => m.id === "milestone_cccc");
  assert.deepEqual(c.dependsOnIds, ["milestone_aaaa", "milestone_bbbb"]);
  assert.equal(c.dependsOn, "milestone_aaaa");
  assert.deepEqual(plan.changed, ["os_roadmap_v1"]);
  const bad = (ids: string[], re: RegExp) => assert.throws(() => buildManagementChangePlan(make([{ kind: "milestone",
    request_id: "deps-20261012-0002", data: { id: "milestone_cccc", dependsOnIds: JSON.stringify(ids) } }]), store, at), re);
  bad(["milestone_zzzz"], /存在しません/);
  bad(["milestone_aaaa", "milestone_aaaa"], /重複/);
  bad(["milestone_cccc"], /循環/);
  // A の前に C を置くと A ← C ← A になる
  assert.throws(() => buildManagementChangePlan(make([{ kind: "milestone", request_id: "deps-20261012-0003",
    data: { id: "milestone_aaaa", dependsOnIds: JSON.stringify(["milestone_bbbb", "milestone_cccc"]) } }]), store, at), /循環/);
  // 配列と古い欄の 1 つ目が食い違えば断る
  assert.throws(() => buildManagementChangePlan(make([{ kind: "milestone", request_id: "deps-20261012-0004",
    data: { id: "milestone_cccc", dependsOn: "milestone_bbbb", dependsOnIds: JSON.stringify(["milestone_aaaa"]) } }]), store, at), /1 つ目/);
  // 前が 1 つでも未達成なら達成にできない
  const done = { os_roadmap_v1: roadmap([M("milestone_aaaa", { status: "done", evidence: "済" }), M("milestone_bbbb"),
    M("milestone_cccc", { dependsOn: "milestone_aaaa", dependsOnIds: ["milestone_aaaa", "milestone_bbbb"] })]) };
  assert.throws(() => buildManagementChangePlan(make([{ kind: "milestone", request_id: "deps-20261012-0005",
    data: { id: "milestone_cccc", status: "done", evidence: "確認" } }]), done, at), /未達成/);
});

test("消す：承認の流れで消し、消す前の中身を記録に残し、取り組みから外して版を 1 つ上げる", () => {
  const store = {
    os_roadmap_v1: roadmap([M("milestone_keep"), M("milestone_gone", { title: "テスト用" })]),
    os_initiatives_v1: initiatives([{ no: "09", mids: ["milestone_keep", "milestone_gone"] }, { no: "10", mids: ["milestone_keep"] }]),
    os_kpis: null, os_task_links_v1: { schemaVersion: 1, links: [], history: [] }, os_strategy_records_v1: null,
  };
  const ops = make([{ kind: "milestone_delete", request_id: "del-20261012-0001", data: { id: "milestone_gone", reason: "テスト用のため" } }]);
  assert.deepEqual(neededKeys(ops), ["os_initiatives_v1", "os_kpis", "os_roadmap_v1", "os_strategy_records_v1", "os_task_links_v1"]);
  const plan = buildManagementChangePlan(ops, store, at);
  const road = plan.next.os_roadmap_v1 as any;
  assert.deepEqual(road.milestones.map((m: any) => m.id), ["milestone_keep"]);
  const log = road.aiChanges.at(-1);
  assert.equal(log.action, "delete");
  assert.equal(log.before.title, "テスト用");
  assert.equal(log.after.reason, "テスト用のため");
  const ini = (plan.next.os_initiatives_v1 as any).records;
  assert.equal(ini[0].revisions.length, 2, "結んでいた 09 は版が 1 つ上がる");
  assert.deepEqual(ini[0].revisions[1].linkedMilestoneIds, ["milestone_keep"]);
  assert.match(ini[0].revisions[1].reason, /milestone_gone/);
  assert.equal(ini[1].revisions.length, 1, "結んでいない 10 は版を上げない");
  assert.deepEqual(plan.changed, ["os_initiatives_v1", "os_roadmap_v1"]);
  assert.deepEqual(plan.steps.map(s => s.kind + ":" + s.action), ["milestone:delete", "initiative:update"]);
  // 書き込みの記録に、消したものの名前が出る
  const audit = managementWriteAudit(plan.next as any);
  assert.equal(audit.latest.find(x => x.request_id === "del-20261012-0001" && x.kind === "milestone_delete")!.title, "テスト用");
});

test("消す：取り組みが結んでいなければ、取り組みの文書は書かない", () => {
  const store = { os_roadmap_v1: roadmap([M("milestone_gone")]), os_initiatives_v1: initiatives([{ no: "01", mids: [] }]),
    os_kpis: null, os_task_links_v1: null, os_strategy_records_v1: null };
  const plan = buildManagementChangePlan(make([{ kind: "milestone_delete", request_id: "del-20261012-0002",
    data: { id: "milestone_gone", reason: "要らない" } }]), store, at);
  assert.deepEqual(plan.changed, ["os_roadmap_v1"]);
});

test("消す：ほかの前になっている・タスクが結ばれている・戦略が参照している・重点・理由なし・無い ID は断る", () => {
  const base = { os_initiatives_v1: null, os_kpis: null, os_task_links_v1: null, os_strategy_records_v1: null };
  const del = (id: string, reason = "理由") => make([{ kind: "milestone_delete", request_id: "del-20261012-0003", data: { id, reason } }]);
  // 新しい欄の 2 つ目で前になっている場合も断る
  assert.throws(() => buildManagementChangePlan(del("milestone_bbbb"), { ...base,
    os_roadmap_v1: roadmap([M("milestone_aaaa"), M("milestone_bbbb"),
      M("milestone_cccc", { dependsOn: "milestone_aaaa", dependsOnIds: ["milestone_aaaa", "milestone_bbbb"] })]) }, at), /前になっている/);
  assert.throws(() => buildManagementChangePlan(del("milestone_aaaa"), { ...base, os_roadmap_v1: roadmap([M("milestone_aaaa")]),
    os_task_links_v1: { schemaVersion: 1, links: [{ taskId: "t1", milestoneId: "milestone_aaaa", at }], history: [] } }, at), /タスクが 1 件/);
  assert.throws(() => buildManagementChangePlan(del("milestone_aaaa"), { ...base, os_roadmap_v1: roadmap([M("milestone_aaaa")]),
    os_strategy_records_v1: { schemaVersion: 1, records: [{ id: "strategy_x", revisions: [{ milestoneId: "milestone_aaaa" }] }] } }, at), /戦略/);
  assert.throws(() => buildManagementChangePlan(del("milestone_aaaa"), { ...base,
    os_roadmap_v1: roadmap([M("milestone_aaaa")], { focusMilestoneId: "milestone_aaaa" }) }, at), /重点/);
  assert.throws(() => buildManagementChangePlan(del("milestone_aaaa", ""), { ...base, os_roadmap_v1: roadmap([M("milestone_aaaa")]) }, at), /理由/);
  assert.throws(() => buildManagementChangePlan(del("milestone_zzzz"), { ...base, os_roadmap_v1: roadmap([M("milestone_aaaa")]) }, at), /見つかりません/);
  // 消す種類に許していない欄は受けない
  assert.throws(() => make([{ kind: "milestone_delete", request_id: "del-20261012-0004", data: { id: "milestone_aaaa", title: "x" } }]), /許可されていない/);
});
