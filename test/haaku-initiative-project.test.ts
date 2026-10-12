// v1.12.0：取り組みの版に taskmasterProjectId（TaskMaster のプロジェクトの組）。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { parseChanges, neededKeys, writeKeys } from "../src/haaku-ai-changes.js";
import { buildManagementChangePlan } from "../src/haaku-ai-model.js";
import { buildInitiativesView } from "../src/haaku-initiatives.js";

const at = "2026-10-12T08:00:00.000Z";
const make = (items: unknown[]) => parseChanges(JSON.stringify(items));
const P = (id: string, title: string, status = "active") => ({ id, title, status, endDate: null });
// 2026-10-12 の TaskMaster の実物から 8 組（id と名前）と、試しの止めたプロジェクト 1 つ
const PROJECTS = [
  P("ca19f6b2-2927-4516-aac0-21f876b9c0a5", "経営"),
  P("63d412a7-3647-4a56-88d7-0db9d95f60c0", "シアラボ｜運営"),
  P("1f21e617-32a2-40f2-99a0-c75542d63712", "案件｜るーみん"),
  P("45d1029f-72e5-4b68-a5b4-ac72375dad0a", "案件｜おかぜり"),
  P("f0cd7ac7-8547-4142-afbf-d9c01bfcdfa8", "X集客"),
  P("5969da4d-e2a0-44cc-bd98-86f55cd92b84", "メンシプ集客"),
  P("5307b601-aadd-4c64-a31e-203c4142e3d2", "バズ記事2期"),
  P("8ddc35a2-5d41-4d77-81ed-bbd8d300653e", "シアラボ｜集客"),
  P("done-project-0001", "終わった案件", "completed"),
];
const PAIRS: [string, string][] = [
  ["04", "ca19f6b2-2927-4516-aac0-21f876b9c0a5"], ["05", "63d412a7-3647-4a56-88d7-0db9d95f60c0"],
  ["06", "1f21e617-32a2-40f2-99a0-c75542d63712"], ["07", "45d1029f-72e5-4b68-a5b4-ac72375dad0a"],
  ["08", "f0cd7ac7-8547-4142-afbf-d9c01bfcdfa8"], ["09", "5969da4d-e2a0-44cc-bd98-86f55cd92b84"],
  ["10", "5307b601-aadd-4c64-a31e-203c4142e3d2"], ["11", "8ddc35a2-5d41-4d77-81ed-bbd8d300653e"],
];
// いまの実物と同じく、版 1 で taskmasterProjectId の欄が無い取り組み 13 件
const initiatives = () => ({
  schemaVersion: 1,
  records: Array.from({ length: 13 }, (_, i) => String(i + 1).padStart(2, "0")).map(no => ({
    id: "initiative_" + no, initiativeNo: no, revisions: [{
      id: "ai_revision_init-" + no + "-0000", number: 1, savedAt: "2026-10-11T12:16:16.734Z",
      requestId: "init-" + no + "-0000", source: "approved_mcp_change", reason: "初回記録",
      name: "取り組み" + no, stage: "構築する", overview: "", ideals: [], conditions: [], kpis: [],
      approaches: [], plans: [], obstacles: [], progress: "", linkedMilestoneIds: [], linkedKpiIds: [],
    }],
  })),
});
const store = (extra: Record<string, unknown> = {}) => ({
  os_roadmap_v1: { version: 1, milestones: [], phases: [] },
  os_initiatives_v1: initiatives(), os_kpis: [], projects: PROJECTS, ...extra,
});
const op = (no: string, rid: string, data: Record<string, unknown>) =>
  ({ kind: "initiative", request_id: rid, data: { initiativeNo: no, ...data } });
const last = (doc: any, no: string) => doc.records.find((r: any) => r.initiativeNo === no).revisions.at(-1);

test("統括の束（8 組）がそのまま通り、版が 1 つ上がって理由が付く。ほかの欄は前の版のまま", () => {
  const ops = make(PAIRS.map(([no, pid]) => op(no, "tk-20261012-proj-" + no, {
    taskmasterProjectId: pid, reason: "2026-10-12 Naoki 確定・設定の画面から取り組みの版へ移す" })));
  assert.deepEqual(neededKeys(ops), ["os_initiatives_v1", "os_kpis", "os_roadmap_v1", "projects"]);
  assert.deepEqual(writeKeys(ops), ["os_initiatives_v1"]);
  const plan = buildManagementChangePlan(ops, store(), at);
  assert.deepEqual(plan.changed, ["os_initiatives_v1"], "TaskMaster のプロジェクト一覧は書かない");
  const doc = plan.next.os_initiatives_v1 as any;
  for (const [no, pid] of PAIRS) {
    const rev = last(doc, no);
    assert.equal(rev.number, 2);
    assert.equal(rev.taskmasterProjectId, pid);
    assert.match(rev.reason, /Naoki 確定/);
    assert.equal(rev.name, "取り組み" + no);
  }
  assert.equal(last(doc, "01").number, 1, "束に入っていない取り組みは版を上げない");
  // 承認の画面に出る前後は「名前（id）」
  const step = plan.steps.find(s => s.id === "initiative_04")!;
  assert.equal(step.before!.taskmasterProjectId, "");
  assert.equal(step.after.taskmasterProjectId, "経営（ca19f6b2-2927-4516-aac0-21f876b9c0a5）");
});

test("読む道具：taskmaster_project_id と名前を返す。見つからない id は名前 null。組なしは両方 null", () => {
  const plan = buildManagementChangePlan(make([op("04", "tk-20261012-proj-04", {
    taskmasterProjectId: PAIRS[0][1], reason: "組を付ける" })]), store(), at);
  const view = buildInitiativesView(plan.next.os_initiatives_v1, [], [], { includeHistory: true }, PROJECTS) as any;
  const i04 = view.initiatives.find((x: any) => x.initiative_no === "04");
  assert.equal(i04.taskmaster_project_id, PAIRS[0][1]);
  assert.equal(i04.taskmaster_project_name, "経営");
  assert.equal(i04.history[0].taskmasterProjectId, PAIRS[0][1]);
  assert.equal(i04.history[1].taskmasterProjectId, null, "前の版は欄が無いので null");
  assert.deepEqual(view.project_links, { [PAIRS[0][1]]: ["04"] });
  const i01 = view.initiatives.find((x: any) => x.initiative_no === "01");
  assert.equal(i01.taskmaster_project_id, null);
  assert.equal(i01.taskmaster_project_name, null);
  const lost = buildInitiativesView(plan.next.os_initiatives_v1, [], [], {}, []) as any;
  assert.equal(lost.initiatives.find((x: any) => x.initiative_no === "04").taskmaster_project_name, null);
});

test("断る：TaskMaster に無い id・進行中でない・ほかの取り組みと重なる・形が不正", () => {
  const one = (data: Record<string, unknown>) => () =>
    buildManagementChangePlan(make([op("04", "tk-20261012-bad-0001", { reason: "試し", ...data })]), store(), at);
  assert.throws(one({ taskmasterProjectId: "no-such-project" }), /TaskMaster に無い/);
  assert.throws(one({ taskmasterProjectId: "done-project-0001" }), /進行中でない/);
  assert.throws(one({ taskmasterProjectId: "bad id!" }), /形が不正/);
  assert.throws(() => buildManagementChangePlan(make([
    op("04", "tk-20261012-dup-0001", { taskmasterProjectId: PAIRS[0][1], reason: "試し" }),
    op("05", "tk-20261012-dup-0002", { taskmasterProjectId: PAIRS[0][1], reason: "試し" }),
  ]), store(), at), /1 つの取り組みにだけ.*経営.*04・05/);
  // 既に付いている取り組みがあれば、別の取り組みに同じものを付けると断る
  const first = buildManagementChangePlan(make([op("04", "tk-20261012-dup-0003", {
    taskmasterProjectId: PAIRS[0][1], reason: "試し" })]), store(), at).next;
  assert.throws(() => buildManagementChangePlan(make([op("05", "tk-20261012-dup-0004", {
    taskmasterProjectId: PAIRS[0][1], reason: "試し" })]), { ...store(), os_initiatives_v1: first.os_initiatives_v1 }, at), /04・05/);
  // プロジェクト一覧の文書が無ければ付けられない
  assert.throws(() => buildManagementChangePlan(make([op("04", "tk-20261012-bad-0002", {
    taskmasterProjectId: PAIRS[0][1], reason: "試し" })]), store({ projects: null }), at), /読めません/);
});

test("同じ束の中の付け替え（04 から外して 05 に付ける）は、当て終えた形で確かめるので通る", () => {
  const first = buildManagementChangePlan(make([op("04", "tk-20261012-move-0001", {
    taskmasterProjectId: PAIRS[0][1], reason: "付ける" })]), store(), at).next;
  const s = { ...store(), os_initiatives_v1: first.os_initiatives_v1 };
  // 付ける側を先に書いても通る（順番に依らない）
  const plan = buildManagementChangePlan(make([
    op("05", "tk-20261012-move-0002", { taskmasterProjectId: PAIRS[0][1], reason: "付け替え" }),
    op("04", "tk-20261012-move-0003", { taskmasterProjectId: null, reason: "付け替え" }),
  ]), s, at);
  const doc = plan.next.os_initiatives_v1 as any;
  assert.equal(last(doc, "04").taskmasterProjectId, "");
  assert.equal(last(doc, "05").taskmasterProjectId, PAIRS[0][1]);
});

test("外す（null・空文字）は確かめずに通り、一覧の文書も読まない。中身が同じなら断る", () => {
  const first = buildManagementChangePlan(make([op("04", "tk-20261012-off-0001", {
    taskmasterProjectId: PAIRS[0][1], reason: "付ける" })]), store(), at).next;
  const offOps = make([op("04", "tk-20261012-off-0002", { taskmasterProjectId: "", reason: "外す" })]);
  assert.ok(!neededKeys(offOps).includes("projects"));
  const off = buildManagementChangePlan(offOps, { ...store({ projects: undefined }), os_initiatives_v1: first.os_initiatives_v1 }, at);
  assert.equal(last(off.next.os_initiatives_v1, "04").taskmasterProjectId, "");
  // 欄が無い版に空を書くのは変化なし
  assert.throws(() => buildManagementChangePlan(make([op("01", "tk-20261012-off-0003", {
    taskmasterProjectId: null, reason: "空のまま" })]), store(), at), /変わっていません/);
  // 同じ id をもう一度付けるのも変化なし
  assert.throws(() => buildManagementChangePlan(make([op("04", "tk-20261012-off-0004", {
    taskmasterProjectId: PAIRS[0][1], reason: "同じ" })]), { ...store(), os_initiatives_v1: first.os_initiatives_v1 }, at), /変わっていません/);
});

test("指定しなければ前の版の値を引き継ぐ（ほかの欄だけ変える改訂）", () => {
  const first = buildManagementChangePlan(make([op("09", "tk-20261012-keep-0001", {
    taskmasterProjectId: PAIRS[5][1], reason: "付ける" })]), store(), at).next;
  const ops = make([op("09", "tk-20261012-keep-0002", { progress: "10%", reason: "進捗" })]);
  assert.ok(!neededKeys(ops).includes("projects"), "付けない変更では一覧を読まない");
  const plan = buildManagementChangePlan(ops, { ...store({ projects: undefined }), os_initiatives_v1: first.os_initiatives_v1 }, at);
  const rev = last(plan.next.os_initiatives_v1, "09");
  assert.equal(rev.progress, "10%");
  assert.equal(rev.taskmasterProjectId, PAIRS[5][1]);
});

test("取り組み以外の種類は taskmasterProjectId を受けない。null はこの欄にだけ許す", () => {
  assert.throws(() => make([{ kind: "milestone", request_id: "tk-20261012-x-0001", data: { taskmasterProjectId: "a" } }]), /許可されていない/);
  assert.throws(() => make([op("04", "tk-20261012-x-0002", { name: null })]), /許可されていない/);
});
