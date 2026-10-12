// v1.13.0：マスの期限を、結んだ TaskMaster のタスクへ写す。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { planDeadlineSync, dayOf, parseSyncStore, syncTaskDeadlines, type TaskNow, type SyncStore } from "../src/haaku-deadline-sync.js";

const at = "2026-10-13T00:00:00.000Z";
const T = (deadline: unknown, o: Partial<TaskNow> = {}): TaskNow =>
  ({ exists: true, deadline, hasDeadline: deadline !== undefined, completed: false, archived: false, updateTime: "u1", ...o });
const empty = (): SyncStore => ({ schemaVersion: 1, copies: {} });
const plan = (links: [string, string][], dues: [string, string][], tasks: [string, TaskNow][], store = empty()) =>
  planDeadlineSync({ links: links.map(([taskId, milestoneId]) => ({ taskId, milestoneId })), dues: new Map(dues), tasks: new Map(tasks), store, at });

test("決まり 1：空のタスクにマスの期限を写す。空の形（null・空文字・欄なし）を覚えておく", () => {
  const p = plan([["t1", "m"], ["t2", "m"], ["t3", "m"]], [["m", "2026-10-18"]], [["t1", T(null)], ["t2", T("")], ["t3", T(undefined)]]);
  assert.deepEqual(p.writes.map(w => [w.taskId, w.value]), [["t1", "2026-10-18"], ["t2", "2026-10-18"], ["t3", "2026-10-18"]]);
  assert.equal(p.next.copies.t1.before, null);
  assert.equal(p.next.copies.t2.before, "");
  assert.equal(p.next.copies.t3.beforeMissing, true);
  assert.equal(p.counts.copied, 3);
});

test("決まり 1：前回写した日のままなら、マスの期限が動いたら付いていく。同じなら書かない", () => {
  const store: SyncStore = { schemaVersion: 1, copies: { t1: { milestoneId: "m", date: "2026-10-18", before: null, at } } };
  const moved = plan([["t1", "m"]], [["m", "2026-10-25"]], [["t1", T("2026-10-18")]], store);
  assert.deepEqual(moved.writes.map(w => [w.from, w.to]), [["2026-10-18", "2026-10-25"]]);
  assert.equal(moved.next.copies.t1.date, "2026-10-25");
  assert.equal(moved.next.copies.t1.before, null, "写す前の形は最初のものを持ち続ける");
  const same = plan([["t1", "m"]], [["m", "2026-10-18"]], [["t1", T("2026-10-18")]], store);
  assert.equal(same.writes.length, 0);
  assert.equal(same.counts.unchanged, 1);
});

test("決まり 2：前回写した日と違う日が入っていたら Naoki の日。上書きせず、写した記録も消す", () => {
  // 記録なし（はじめから Naoki が入れた日・hwkv1fk の形）
  const fresh = plan([["hwkv1fk", "m"]], [["m", "2026-10-18"]], [["hwkv1fk", T("2026-10-13")]]);
  assert.equal(fresh.writes.length, 0);
  assert.deepEqual(fresh.naoki.map(n => [n.taskId, n.deadline, n.due]), [["hwkv1fk", "2026-10-13", "2026-10-18"]]);
  // 記録あり（写したあと Naoki が別の日に直した）
  const store: SyncStore = { schemaVersion: 1, copies: { t1: { milestoneId: "m", date: "2026-10-18", before: null, at } } };
  const edited = plan([["t1", "m"]], [["m", "2026-10-25"]], [["t1", T("2026-10-20")]], store);
  assert.equal(edited.writes.length, 0);
  assert.equal(edited.next.copies.t1, undefined);
  // 以後も Naoki の日のまま（マスがまた動いても写さない）
  const later = plan([["t1", "m"]], [["m", "2026-10-30"]], [["t1", T("2026-10-20")]], edited.next);
  assert.equal(later.writes.length, 0);
});

test("決まり 3：マスの期限が空になったら、写した日のままのものだけ写す前の形へ戻す", () => {
  const store: SyncStore = { schemaVersion: 1, copies: {
    a: { milestoneId: "m", date: "2026-10-18", before: null, at },
    b: { milestoneId: "m", date: "2026-10-18", before: "", at },
    c: { milestoneId: "m", date: "2026-10-18", before: null, beforeMissing: true, at },
    d: { milestoneId: "m", date: "2026-10-18", before: null, at },
  } };
  const p = plan([["a", "m"], ["b", "m"], ["c", "m"], ["d", "m"]], [["m", ""]],
    [["a", T("2026-10-18")], ["b", T("2026-10-18")], ["c", T("2026-10-18")], ["d", T("2026-10-20")]], store);
  assert.deepEqual(p.writes.map(w => [w.taskId, w.kind, w.value, w.remove]), [
    ["a", "clear", null, false], ["b", "clear", "", false], ["c", "clear", null, true]]);
  assert.equal(p.next.copies.d, undefined, "Naoki が直した d は触らず、記録だけ消す");
  assert.equal(p.counts.cleared, 3);
});

test("決まり 4：結びを外したら期限は触らず、写した記録だけ消す。付け替えは新しいマスの期限を写す", () => {
  const store: SyncStore = { schemaVersion: 1, copies: {
    gone: { milestoneId: "m", date: "2026-10-18", before: null, at },
    moved: { milestoneId: "m", date: "2026-10-18", before: null, at },
  } };
  const p = plan([["moved", "m2"]], [["m", "2026-10-18"], ["m2", "2026-10-31"]], [["gone", T("2026-10-18")], ["moved", T("2026-10-18")]], store);
  assert.deepEqual(p.writes.map(w => [w.taskId, w.to]), [["moved", "2026-10-31"]]);
  assert.equal(p.next.copies.gone, undefined);
  assert.equal(p.next.copies.moved.milestoneId, "m2");
});

test("写さない：完了・アーカイブ・消えたタスク・見つからないマス", () => {
  const p = plan([["done", "m"], ["arc", "m"], ["lost", "m"], ["orphan", "nope"]], [["m", "2026-10-18"]],
    [["done", T(null, { completed: true })], ["arc", T(null, { archived: true })], ["lost", T(undefined, { exists: false })], ["orphan", T(null)]]);
  assert.equal(p.writes.length, 0);
  assert.equal(p.counts.closed, 2);
  assert.equal(p.counts.missing, 2);
});

test("今日の実物（2026-10-13 07:4x の get_home と taskmaster__list_tasks）：13 件に 10/18・5 件に 10/31・hwkv1fk は 10/13 のまま", () => {
  const m18 = ["milestone_step-20261011-09-design", "milestone_ms-20261012-1001-design", "milestone_ms-20261012-0001-haaku"];
  const ids: [string, string][] = [
    ...["84e22f73", "5fa8d407", "f65ee71b", "d740f8fa", "9303517c", "f0ad6991"].map(t => [t, m18[0]] as [string, string]),
    ...["60a4cd6f", "c6fcbca4", "46b7153b", "e584501a", "e16477d5"].map(t => [t, m18[1]] as [string, string]),
    ...["0e664c76", "88abd2ff"].map(t => [t, m18[2]] as [string, string]),
    ...["a319e0ef", "fe6a563e", "a51239b7", "436c8fd9", "5e1dc11b"].map(t => [t, "milestone_mv3fvc0y_znc734m"] as [string, string]),
    ["hwkv1fk", "milestone_ms-20261012-0002-contents"],
  ];
  const dues: [string, string][] = [...m18.map(m => [m, "2026-10-18"] as [string, string]),
    ["milestone_mv3fvc0y_znc734m", "2026-10-31"], ["milestone_ms-20261012-0002-contents", "2026-10-18"]];
  const tasks: [string, TaskNow][] = ids.map(([t]) => [t, T(t === "hwkv1fk" ? "2026-10-13" : null)]);
  const p = plan(ids, dues, tasks);
  const to = (d: string) => p.writes.filter(w => w.to === d).length;
  assert.equal(to("2026-10-18"), 13);
  assert.equal(to("2026-10-31"), 5);
  assert.equal(p.writes.some(w => w.taskId === "hwkv1fk"), false);
  assert.equal(p.counts.naoki, 1);
});

test("日付の読み方と記録の形", () => {
  assert.equal(dayOf("2026-10-18"), "2026-10-18");
  assert.equal(dayOf("2026-10-18T09:00:00"), "2026-10-18");
  assert.equal(dayOf(null), "");
  assert.equal(dayOf(""), "");
  assert.deepEqual(parseSyncStore(null), { schemaVersion: 1, copies: {} });
  assert.throws(() => parseSyncStore({ schemaVersion: 2, copies: {} }), /読めません/);
});

// ── 外に触る部分：偽の Firestore で、読む量・書く順・書く欄を確かめる ──
test("書く順：写した記録を先に入れ、タスクには deadline の 1 欄だけを版つきで書く。見るだけなら何も書かない", async () => {
  const uid = "uid1";
  const calls: { method: string; url: string; body?: any }[] = [];
  const docs: Record<string, any> = {
    "app_data/tm_layout": { fields: { value: { mapValue: { fields: { version: { integerValue: "2" } } } } }, updateTime: "L" },
    "app_data/os_roadmap_v1": { updateTime: "R", fields: { value: { mapValue: { fields: {
      version: { integerValue: "1" }, milestones: { arrayValue: { values: [{ mapValue: { fields: {
        id: { stringValue: "m" }, title: { stringValue: "マス" }, status: { stringValue: "todo" }, dueDate: { stringValue: "2026-10-18" } } } }] } } } } } } },
    "app_data/os_task_links_v1": { updateTime: "K", fields: { value: { mapValue: { fields: {
      schemaVersion: { integerValue: "1" }, history: { arrayValue: {} },
      links: { arrayValue: { values: [{ mapValue: { fields: { taskId: { stringValue: "t1" }, milestoneId: { stringValue: "m" }, at: { stringValue: at } } } }] } } } } } } },
  };
  let syncVersion = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input); const method = init.method ?? "GET";
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined });
    const path = decodeURIComponent(url.split("/documents/")[1] ?? "").split("?")[0].replace("users/" + uid + "/", "");
    if (url.endsWith(":batchGet")) return new Response(JSON.stringify([{ found: { name: "x/tm_tasks/t1", updateTime: "T1",
      fields: { deadline: { nullValue: null }, completed: { booleanValue: false }, archived: { booleanValue: false }, title: { stringValue: "タスク" } } } }]));
    if (method === "GET" && path === "app_data/os_task_deadline_sync_v1") {
      if (!syncVersion) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ updateTime: "S" + syncVersion, fields: { value: calls.filter(c => c.url.includes("os_task_deadline_sync_v1") && c.method === "PATCH").at(-1)!.body.fields.value } }));
    }
    if (method === "GET") return docs[path] ? new Response(JSON.stringify(docs[path])) : new Response("{}", { status: 404 });
    if (method === "PATCH" && path === "app_data/os_task_deadline_sync_v1") { syncVersion++; return new Response("{}"); }
    if (method === "PATCH") return new Response("{}");
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  try {
    const dry = await syncTaskDeadlines({ token: "tok", uid }, { dryRun: true, at });
    assert.equal(dry.dry_run, true);
    assert.equal(calls.filter(c => c.method === "PATCH").length, 0, "見るだけでは書かない");
    assert.deepEqual((dry as any).writes, [{ task_id: "t1", kind: "copy", from: null, to: "2026-10-18", milestone_id: "m" }]);
    calls.length = 0;
    const res = await syncTaskDeadlines({ token: "tok", uid }, { at });
    assert.equal((res as any).counts.copied, 1);
    const patches = calls.filter(c => c.method === "PATCH");
    assert.equal(patches.length, 2);
    assert.match(patches[0].url, /os_task_deadline_sync_v1\?updateMask\.fieldPaths=value&currentDocument\.exists=false/, "先に写した記録");
    assert.match(patches[1].url, /tm_tasks\/t1\?updateMask\.fieldPaths=deadline&currentDocument\.updateTime=T1$/, "タスクは deadline の 1 欄・読んだ版つき");
    assert.deepEqual(Object.keys(patches[1].body.fields), ["deadline"]);
    assert.equal(patches[1].body.fields.deadline.stringValue, "2026-10-18");
    assert.equal(calls.filter(c => c.url.includes("tm_tasks?")).length, 0, "タスクを全部読む呼び出しはしない");
  } finally { globalThis.fetch = orig; }
});
