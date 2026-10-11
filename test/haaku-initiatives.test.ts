// v1.9.0：haAku の取り組み。走らせ方：esbuild で束ねてから node --test（ほかの haaku の試験と同じ）
import test from "node:test";
import assert from "node:assert/strict";
import { parseChanges, neededKeys, writeKeys } from "../src/haaku-ai-changes.js";
import { buildManagementChangePlan, verifyPlannedValues } from "../src/haaku-ai-model.js";
import { buildInitiativesView } from "../src/haaku-initiatives.js";
import { managementWriteAudit } from "../src/haaku-ai-audit.js";
import { previewManagementChanges, applyManagementChanges } from "../src/haaku-ai-store.js";
import { toFVal, fromVal } from "../src/taskmaster.js";
import { approvalDocName } from "../src/haaku-approval-record.js";

const at = "2026-10-11T10:00:00.000Z";
const make = (items: unknown[]) => parseChanges(JSON.stringify(items));
const kpis = [{ id: "kpi_imp_0001", title: "インプ（月間）", unit: "万インプ", monthlyTarget: 3000 }];
const milestone = { kind: "milestone", request_id: "mile-init-00001", data: {
  title: "メンシプ導線を完成", criterion: "登録をテスト済み", status: "doing" } };
const MID = "milestone_mile-init-00001";
const first = { kind: "initiative", request_id: "init-create-00001", data: {
  initiativeNo: "01", name: "発信の土台を整える", stage: "整える", overview: "毎日出せる形を作る",
  ideals: JSON.stringify([{ text: "毎朝 1 本出せる", theme: "習慣" }, "迷わず書ける"]),
  conditions: JSON.stringify([]), kpis: JSON.stringify([{ text: "月 3000 万インプ" }]),
  approaches: JSON.stringify([{ text: "型を 3 つに絞る", theme: "型" }]),
  plans: JSON.stringify([{ text: "10 月中に型を決める" }]), obstacles: JSON.stringify([]),
  progress: "", linkedMilestoneIds: JSON.stringify([MID]), linkedKpiIds: JSON.stringify(["kpi_imp_0001"]),
} };
const empty = () => ({ os_roadmap_v1: null, os_initiatives_v1: null, os_kpis: kpis } as Record<string, unknown>);

test("取り組みを新規で作れて、同じ束で作ったマイルストーンと既にある KPI を結べる", () => {
  const ops = make([milestone, first]);
  assert.deepEqual(neededKeys(ops), ["os_initiatives_v1", "os_kpis", "os_roadmap_v1"]);
  assert.deepEqual(writeKeys(ops), ["os_initiatives_v1", "os_roadmap_v1"], "KPI の文書は書かない");
  const plan = buildManagementChangePlan(ops, empty(), at);
  const doc = plan.next.os_initiatives_v1 as any;
  assert.equal(doc.records.length, 1);
  assert.equal(doc.records[0].id, "initiative_01");
  const rev = doc.records[0].revisions[0];
  assert.equal(rev.number, 1);
  assert.equal(rev.reason, "初回記録");
  assert.deepEqual(rev.ideals, [{ text: "毎朝 1 本出せる", theme: "習慣" }, { text: "迷わず書ける", theme: "" }]);
  assert.deepEqual(rev.linkedMilestoneIds, [MID]);
  const step = plan.steps[1];
  assert.equal(step.kind, "initiative");
  assert.equal(step.action, "create");
  assert.equal(step.title, "01 発信の土台を整える");
  assert.equal(step.after.ideals, "・［習慣］毎朝 1 本出せる\n・迷わず書ける", "承認の画面では 1 行ずつの文字で見せる");
  assert.equal(step.after.linkedKpiIds, "インプ（月間）（kpi_imp_0001）");
  verifyPlannedValues(plan.next, plan);
});

test("改訂で版が 2 になり、省いた欄は前の版のまま。理由が無い・中身が同じなら断る", () => {
  const base = buildManagementChangePlan(make([milestone, first]), empty(), at).next;
  const upd = { kind: "initiative", request_id: "init-update-00001", data: {
    initiativeNo: "01", progress: "型を 2 つまで決めた", reason: "10/11 の壁打ちで進み具合を足した" } };
  const plan = buildManagementChangePlan(make([upd]), base, "2026-10-12T00:00:00.000Z");
  const revs = (plan.next.os_initiatives_v1 as any).records[0].revisions;
  assert.equal(revs.length, 2);
  assert.equal(revs[1].number, 2);
  assert.equal(revs[1].name, "発信の土台を整える");
  assert.deepEqual(revs[1].ideals, revs[0].ideals);
  assert.equal(plan.steps[0].action, "update");
  assert.deepEqual(Object.keys(plan.steps[0].before ?? {}).includes("progress"), true);
  assert.throws(() => buildManagementChangePlan(make([{ ...upd, data: { initiativeNo: "01", progress: "x" } }]), base, at), /理由/);
  assert.throws(() => buildManagementChangePlan(make([{ ...upd, data: { initiativeNo: "01", reason: "同じ" } }]), base, at), /変わっていません/);
});

test("番号・段階・結ぶ先・一覧の形がおかしければ何も書かずに断る", () => {
  const bad = (data: Record<string, string>) => () =>
    buildManagementChangePlan(make([milestone, { ...first, data: { ...first.data, ...data } }]), empty(), at);
  assert.throws(bad({ initiativeNo: "1" }), /2 桁/);
  assert.throws(bad({ stage: "準備する" }), /段階/);
  assert.throws(bad({ linkedMilestoneIds: JSON.stringify(["milestone_nothing"]) }), /マイルストーンが見つかりません/);
  assert.throws(bad({ linkedKpiIds: JSON.stringify(["kpi_nothing"]) }), /KPI が見つかりません/);
  assert.throws(bad({ ideals: "毎朝出す" }), /JSON/);
  assert.throws(bad({ ideals: JSON.stringify([{ text: "" }]) }), /空/);
  assert.throws(bad({ ideals: JSON.stringify([{ text: "a", owner: "x" }]) }), /text, theme/);
  assert.throws(() => make([{ ...first, data: { ...first.data, unknown: "x" } }]), /許可されていない/);
});

test("読む道具：現在の版・過去の版と理由・逆引きを返す。未登録は not_configured", () => {
  const base = buildManagementChangePlan(make([milestone, first]), empty(), at).next;
  const upd = { kind: "initiative", request_id: "init-update-00002", data: {
    initiativeNo: "01", progress: "半分", reason: "進み具合" } };
  const next = buildManagementChangePlan(make([upd]), base, at).next;
  const milestones = (next.os_roadmap_v1 as any).milestones;
  const view = buildInitiativesView(next.os_initiatives_v1, milestones, kpis, { includeHistory: true }) as any;
  assert.equal(view.count, 1);
  assert.equal(view.total_versions, 2);
  assert.equal(view.initiatives[0].version, 2);
  assert.equal(view.initiatives[0].last_reason, "進み具合");
  assert.equal(view.initiatives[0].linked_milestones[0].status, "doing");
  assert.equal(view.initiatives[0].history[1].reason, "初回記録");
  assert.deepEqual(view.milestone_links, { [MID]: ["01"] });
  assert.deepEqual(view.kpi_links, { kpi_imp_0001: ["01"] });
  assert.equal((buildInitiativesView(null, [], []) as any).state, "not_configured");
  assert.throws(() => buildInitiativesView(next.os_initiatives_v1, milestones, kpis, { initiativeNo: "02" }), /登録されていません/);
  const audit = managementWriteAudit(next) as any;
  assert.equal(audit.counts.initiatives, 2);
});

// 保存の流れ（プレビュー → 承認 → 書き込み → 読み直し）を、Firestore の代わりの入れ物で通す
test("プレビューは書かず、承認のあと取り組みの文書だけを足して読み直しが一致する（KPI の文書は書かない）", async () => {
  const uid = "test-uid-2026", NOW = Date.parse(at);
  const APPROVAL = "11111111-1111-4111-8111-111111111111";
  const docs = new Map<string, { value: unknown; version: string }>();
  docs.set("os_kpis", { value: kpis, version: "2026-10-11T09:00:00.000Z" });
  docs.set("os_roadmap_v1", { value: { version: 1, milestones: [{ id: MID, title: "導線", status: "doing" }], phases: [] }, version: "2026-10-11T09:00:00.000Z" });
  const keyFor = (p: string) => p.includes("/haaku_approvals/") ? "approval" : p.split("/app_data/").pop()!;
  let n = 1;
  const http = (async (req: RequestInfo | URL, opts?: RequestInit) => {
    const url = String(req), method = opts?.method || "GET";
    if (url.endsWith(":beginTransaction")) return Response.json({ transaction: "tx" });
    if (url.endsWith(":rollback")) return Response.json({});
    if (url.endsWith(":commit")) {
      const body = JSON.parse(String(opts?.body));
      for (const w of body.writes) docs.set(keyFor(String(w.update.name)), { value: fromVal(w.update.fields.value), version: "2026-10-11T11:00:0" + (n++) + "Z" });
      return Response.json({ commitTime: "2026-10-11T11:00:00Z", writeResults: body.writes.map(() => ({})) });
    }
    void method;
    const key = keyFor(new URL(url).pathname);
    const d = docs.get(key);
    if (!d) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ name: key === "approval" ? approvalDocName(uid, APPROVAL) : "x/" + key, updateTime: d.version, fields: { value: toFVal(d.value) } });
  }) as typeof fetch;
  const ops = make([{ ...first, data: { ...first.data, linkedMilestoneIds: JSON.stringify([MID]) } }]);
  const p = await previewManagementChanges(http, "t", uid, ops, NOW);
  assert.equal(p.writes_performed, 0);
  assert.deepEqual(p.affected_docs, ["os_initiatives_v1"]);
  assert.equal(p.changes[0].kind, "initiative");
  assert.equal((p.changes[0].changes as any).name.after, "発信の土台を整える");
  assert.equal(docs.has("os_initiatives_v1"), false);
  docs.set("approval", { value: { uid, previewId: p.preview_id, issuedAt: at, expiresAt: p.expires_at,
    status: "approved", approvedUid: uid, approvedAt: at, changes: [], affectedDocs: [] }, version: "2026-10-11T09:30:00.000Z" });
  const r = await applyManagementChanges(http, "t", uid, ops, p.preview_id, APPROVAL, NOW + 1000);
  assert.equal(r.state, "verified");
  assert.deepEqual(r.verified, ["os_initiatives_v1"]);
  assert.equal((docs.get("os_initiatives_v1")!.value as any).records[0].revisions[0].number, 1);
  assert.equal(docs.get("os_kpis")!.version, "2026-10-11T09:00:00.000Z", "KPI の文書は書いていない");
});
