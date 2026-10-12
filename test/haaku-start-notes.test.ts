// v1.14.0：マスの着手日を結んだタスクへ写す・AI からマスの notes と links を書く。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { planStartSync, planDeadlineSync, groupWrites, parseSyncStore, syncTaskDeadlines, type TaskNow, type SyncStore } from "../src/haaku-deadline-sync.js";
import { parseHaakuRoadmap, buildHaakuManagementOverview } from "../src/haaku-plan-summary.js";
import { parseChanges } from "../src/haaku-ai-changes.js";
import { buildManagementChangePlan, parseMilestoneLinks } from "../src/haaku-ai-model.js";

const at = "2026-10-13T00:00:00.000Z";
const T = (startDate: unknown, o: Partial<TaskNow> = {}): TaskNow =>
  ({ exists: true, deadline: null, hasDeadline: true, startDate, hasStartDate: startDate !== undefined, completed: false, archived: false, updateTime: "u1", ...o });
const empty = (): SyncStore => ({ schemaVersion: 1, copies: {} });
const sp = (links: [string, string][], starts: [string, string][], tasks: [string, TaskNow][], store = empty()) =>
  planStartSync({ links: links.map(([taskId, milestoneId]) => ({ taskId, milestoneId })), starts: new Map(starts), tasks: new Map(tasks), store, at });

// ── 着手日の 4 つの決まり（期限と同じ） ──
test("着手日・決まり 1：空のタスクに写す。前回写した日のままなら付いていく。同じなら書かない", () => {
  const p = sp([["t1", "m"], ["t2", "m"]], [["m", "2026-10-14"]], [["t1", T(undefined)], ["t2", T("")]]);
  assert.deepEqual(p.writes.map(w => [w.taskId, w.field, w.value]), [["t1", "startDate", "2026-10-14"], ["t2", "startDate", "2026-10-14"]]);
  assert.equal(p.starts.t1.beforeMissing, true, "欄が無かった形を覚える");
  assert.equal(p.starts.t2.before, "");
  const store: SyncStore = { schemaVersion: 1, copies: {}, starts: p.starts };
  const moved = sp([["t1", "m"]], [["m", "2026-10-16"]], [["t1", T("2026-10-14")]], store);
  assert.deepEqual(moved.writes.map(w => [w.from, w.to]), [["2026-10-14", "2026-10-16"]]);
  const same = sp([["t1", "m"]], [["m", "2026-10-14"]], [["t1", T("2026-10-14")]], store);
  assert.equal(same.writes.length, 0);
  assert.equal(same.counts.unchanged, 1);
});

test("着手日・決まり 2・3・4：Naoki の日は上書きしない／マスの着手日が空になったら写した日だけ戻す／外したら記録だけ消す", () => {
  const store: SyncStore = { schemaVersion: 1, copies: {}, starts: {
    a: { milestoneId: "m", date: "2026-10-14", before: null, beforeMissing: true, at },
    b: { milestoneId: "m", date: "2026-10-14", before: null, at },
    gone: { milestoneId: "m", date: "2026-10-14", before: null, at },
  } };
  const p = sp([["a", "m"], ["b", "m"], ["n", "m2"]], [["m", ""], ["m2", "2026-10-20"]],
    [["a", T("2026-10-14")], ["b", T("2026-10-15")], ["n", T("2026-10-11")], ["gone", T("2026-10-14")]], store);
  assert.deepEqual(p.writes.map(w => [w.taskId, w.kind, w.remove]), [["a", "clear", true]], "a は欄ごと消す。b は Naoki が直したので触らない");
  assert.equal(p.starts.b, undefined);
  assert.equal(p.starts.gone, undefined, "外したタスクは記録だけ消す");
  assert.deepEqual(p.naoki.map(x => [x.taskId, x.startDate, x.start]), [["n", "2026-10-11", "2026-10-20"]]);
});

test("期限と着手日は別々に照らす：期限が Naoki の日でも、着手日は写す。1 タスクへの書き込みは 1 回にまとめる", () => {
  const links = [{ taskId: "t", milestoneId: "m" }];
  const tasks = new Map([["t", T(undefined, { deadline: "2026-10-13" })]]);
  const d = planDeadlineSync({ links, dues: new Map([["m", "2026-10-18"]]), tasks, store: empty(), at });
  const s = planStartSync({ links, starts: new Map([["m", "2026-10-14"]]), tasks, store: empty(), at });
  assert.equal(d.writes.length, 0);
  assert.equal(d.counts.naoki, 1);
  assert.equal(s.writes.length, 1);
  const both = groupWrites([
    { taskId: "x", field: "startDate", kind: "copy", from: "", to: "2026-10-14", value: "2026-10-14", remove: false, milestoneId: "m" },
    { taskId: "x", field: "deadline", kind: "copy", from: "", to: "2026-10-18", value: "2026-10-18", remove: false, milestoneId: "m" },
    { taskId: "y", field: "startDate", kind: "copy", from: "", to: "2026-10-14", value: "2026-10-14", remove: false, milestoneId: "m" },
  ]);
  assert.deepEqual(both.map(g => [g.taskId, g.writes.map(w => w.field)]), [["x", ["deadline", "startDate"]], ["y", ["startDate"]]]);
});

test("記録の形：starts は省いてよい（1.13.0 の記録のまま読める）。形が違えば止める", () => {
  assert.deepEqual(parseSyncStore({ schemaVersion: 1, copies: {} }), { schemaVersion: 1, copies: {}, updatedAt: undefined });
  assert.equal(Object.keys(parseSyncStore({ schemaVersion: 1, copies: {}, starts: {} }).starts!).length, 0);
  assert.throws(() => parseSyncStore({ schemaVersion: 1, copies: {}, starts: [] }), /starts/);
});

// ── 読む側：画面が書く新しい欄で、ロードマップ全体を止めない ──
test("読む：startDate・notes・links を読む。読めない着手日・形の違うリンクは印だけ立ててほかは読む", () => {
  const road = parseHaakuRoadmap({ version: 1, milestones: [
    { id: "a", title: "A", status: "todo", dueDate: "2026-10-18", startDate: "2026-10-14", notes: "メモ", links: [{ title: "資料", url: "https://example.com/a" }] },
    { id: "b", title: "B", status: "todo", startDate: "10/14", links: [{ label: "x", href: "y" }, { url: "https://example.com/b" }] },
    { id: "c", title: "C", status: "todo" },
  ] })!;
  const [a, b, c] = road.milestones;
  assert.deepEqual([a.startDate, a.startDateBad, a.notes, a.links], ["2026-10-14", false, "メモ", [{ title: "資料", url: "https://example.com/a" }]]);
  assert.deepEqual([b.startDate, b.startDateBad, b.linksBad, b.links], ["", true, 1, [{ title: "", url: "https://example.com/b" }]]);
  assert.deepEqual([c.startDate, c.startDateBad, c.notes, c.links, c.linksBad], ["", false, "", [], 0]);
  const view = buildHaakuManagementOverview(road, null, "2026-10-13") as any;
  const row = JSON.stringify(view);
  assert.match(row, /"start_date":"2026-10-14"/);
  assert.match(row, /"notes":"メモ"/);
});

// ── AI から notes と links を書く ──
const make = (items: unknown[]) => parseChanges(JSON.stringify(items));
const M = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: "成果" + id, criterion: "合格", status: "todo", dueDate: "2026-10-18", dependsOn: "", ...extra });
const roadmap = (milestones: unknown[]) => ({ version: 1, northStar: "", milestones, phases: [] });
const write = (data: Record<string, string>, ms = [M("milestone_aaaa")]) =>
  buildManagementChangePlan(make([{ kind: "milestone", request_id: "note-20261013-0001", data: { id: "milestone_aaaa", ...data } }]),
    { os_roadmap_v1: roadmap(ms) }, at);
const after = (plan: any) => plan.next.os_roadmap_v1.milestones[0];

test("AI が書く：notes と links を書ける。渡さなければ今の値のまま。空で消せる", () => {
  const p = write({ notes: "  決めたこと  ", links: JSON.stringify([{ title: "議事録", url: "https://example.com/m" }]) });
  assert.equal(after(p).notes, "決めたこと");
  assert.deepEqual(after(p).links, [{ title: "議事録", url: "https://example.com/m" }]);
  const keep = write({ title: "新しい名前" }, [M("milestone_aaaa", { notes: "前のメモ", links: [{ title: "前", url: "https://example.com/p" }], startDate: "2026-10-14" })]);
  assert.equal(after(keep).notes, "前のメモ");
  assert.deepEqual(after(keep).links, [{ title: "前", url: "https://example.com/p" }]);
  assert.equal(after(keep).startDate, "2026-10-14", "画面が書いた着手日を消さない");
  const cleared = write({ notes: "", links: "[]" }, [M("milestone_aaaa", { notes: "x", links: [{ title: "", url: "https://example.com/p" }] })]);
  assert.equal(after(cleared).notes, "");
  assert.deepEqual(after(cleared).links, []);
  assert.throws(() => write({ notes: "x" }, [M("milestone_aaaa", { notes: "x" })]), /変わっていません/);
});

test("AI が書く：links の形・https・件数・同じ url を断る。期限を着手日より前にする変更も断る", () => {
  assert.throws(() => parseMilestoneLinks("[{\"title\":\"a\",\"url\":\"http://example.com\"}]"), /https/);
  assert.throws(() => parseMilestoneLinks("[{\"label\":\"a\",\"url\":\"https://example.com\"}]"), /title, url/);
  assert.throws(() => parseMilestoneLinks("{\"url\":\"https://example.com\"}"), /配列/);
  assert.throws(() => parseMilestoneLinks("not json"), /JSON/);
  assert.throws(() => parseMilestoneLinks(JSON.stringify(Array.from({ length: 21 }, (_, i) => ({ url: "https://example.com/" + i })))), /20 件/);
  assert.throws(() => parseMilestoneLinks(JSON.stringify([{ url: "https://example.com" }, { url: "https://example.com" }])), /同じ url/);
  assert.deepEqual(parseMilestoneLinks(JSON.stringify([{ url: "https://example.com" }])), [{ title: "", url: "https://example.com" }]);
  assert.throws(() => write({ notes: "x".repeat(5001) }), /5000/);
  const withStart = [M("milestone_aaaa", { startDate: "2026-10-14" })];
  assert.throws(() => write({ dueDate: "2026-10-13" }, withStart), /着手日/);
  assert.equal(after(write({ dueDate: "2026-10-14" }, withStart)).dueDate, "2026-10-14", "同じ日は通す");
  assert.equal(after(write({ notes: "メモ" }, [M("milestone_aaaa", { startDate: "2026-10-20" })])).notes, "メモ", "期限に触らない変更は止めない");
});

// ── 外に触る部分：偽の Firestore で、1 タスク 1 回・2 欄の書き方と記録を確かめる ──
test("書く：期限と着手日を 1 回の書き込みにまとめ、記録には starts を足す。読めない着手日のマスには触らない", async () => {
  const uid = "uid1";
  const calls: { method: string; url: string; body?: any }[] = [];
  const ms = (id: string, f: Record<string, any>) => ({ mapValue: { fields: { id: { stringValue: id }, title: { stringValue: id }, status: { stringValue: "todo" }, ...f } } });
  const link = (t: string, m: string) => ({ mapValue: { fields: { taskId: { stringValue: t }, milestoneId: { stringValue: m }, at: { stringValue: at } } } });
  const docs: Record<string, any> = {
    "app_data/tm_layout": { fields: { value: { mapValue: { fields: { version: { integerValue: "2" } } } } }, updateTime: "L" },
    "app_data/os_roadmap_v1": { updateTime: "R", fields: { value: { mapValue: { fields: { version: { integerValue: "1" }, milestones: { arrayValue: { values: [
      ms("m", { dueDate: { stringValue: "2026-10-18" }, startDate: { stringValue: "2026-10-14" } }),
      ms("bad", { dueDate: { stringValue: "2026-10-31" }, startDate: { stringValue: "あした" } }),
    ] } } } } } } },
    "app_data/os_task_links_v1": { updateTime: "K", fields: { value: { mapValue: { fields: {
      schemaVersion: { integerValue: "1" }, history: { arrayValue: {} }, links: { arrayValue: { values: [link("t1", "m"), link("t2", "bad")] } } } } } } },
  };
  const task = (id: string, f: Record<string, any>) => ({ found: { name: "x/tm_tasks/" + id, updateTime: "U" + id,
    fields: { completed: { booleanValue: false }, archived: { booleanValue: false }, title: { stringValue: id }, ...f } } });
  let syncVersion = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input); const method = init.method ?? "GET";
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined });
    const path = decodeURIComponent(url.split("/documents/")[1] ?? "").split("?")[0].replace("users/" + uid + "/", "");
    if (url.endsWith(":batchGet")) return new Response(JSON.stringify([
      task("t1", { deadline: { nullValue: null } }),
      task("t2", { deadline: { nullValue: null }, startDate: { stringValue: "" } }),
    ]));
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
    const dry: any = await syncTaskDeadlines({ token: "tok", uid }, { dryRun: true, at });
    assert.deepEqual(dry.start_writes, [{ task_id: "t1", kind: "copy", from: null, to: "2026-10-14", milestone_id: "m" }]);
    assert.deepEqual(dry.unreadable_start_milestones, ["bad"]);
    assert.match(dry.detail, /／着手日：写した 1・.*・日付が読めないマス 1$/);
    assert.equal(calls.filter(c => c.method === "PATCH").length, 0, "見るだけでは書かない");
    calls.length = 0;
    const res: any = await syncTaskDeadlines({ token: "tok", uid }, { at });
    assert.equal(res.counts.copied, 2);
    assert.equal(res.start_counts.copied, 1);
    const patches = calls.filter(c => c.method === "PATCH");
    assert.equal(patches.length, 3, "記録 1 回・t1 に 1 回・t2 に 1 回");
    assert.match(patches[0].url, /os_task_deadline_sync_v1/);
    const rec = patches[0].body.fields.value.mapValue.fields;
    assert.ok(rec.starts.mapValue.fields.t1, "着手日の記録は starts に入る");
    const t1 = patches.find(p => p.url.includes("tm_tasks/t1"))!;
    assert.match(t1.url, /\?updateMask\.fieldPaths=deadline&updateMask\.fieldPaths=startDate&currentDocument\.updateTime=Ut1$/);
    assert.deepEqual(Object.keys(t1.body.fields).sort(), ["deadline", "startDate"]);
    const t2 = patches.find(p => p.url.includes("tm_tasks/t2"))!;
    assert.match(t2.url, /\?updateMask\.fieldPaths=deadline&currentDocument/, "読めない着手日のマスでは startDate を書かない");
  } finally { globalThis.fetch = orig; }
});

test("間に触られて書けなかったタスクは、記録を前に戻す（次の回に Naoki の日と取り違えない）", async () => {
  const uid = "uid1";
  const calls: { method: string; url: string; body?: any }[] = [];
  const prev = { milestoneId: { stringValue: "m" }, date: { stringValue: "2026-10-18" }, before: { nullValue: null }, at: { stringValue: at } };
  const docs: Record<string, any> = {
    "app_data/tm_layout": { fields: { value: { mapValue: { fields: { version: { integerValue: "2" } } } } }, updateTime: "L" },
    "app_data/os_roadmap_v1": { updateTime: "R", fields: { value: { mapValue: { fields: { version: { integerValue: "1" }, milestones: { arrayValue: { values: [
      { mapValue: { fields: { id: { stringValue: "m" }, title: { stringValue: "m" }, status: { stringValue: "todo" }, dueDate: { stringValue: "2026-10-25" } } } },
    ] } } } } } } },
    "app_data/os_task_links_v1": { updateTime: "K", fields: { value: { mapValue: { fields: {
      schemaVersion: { integerValue: "1" }, history: { arrayValue: {} }, links: { arrayValue: { values: [
        { mapValue: { fields: { taskId: { stringValue: "t1" }, milestoneId: { stringValue: "m" }, at: { stringValue: at } } } }] } } } } } } },
    "app_data/os_task_deadline_sync_v1": { updateTime: "S0", fields: { value: { mapValue: { fields: {
      schemaVersion: { integerValue: "1" }, copies: { mapValue: { fields: { t1: { mapValue: { fields: prev } } } } } } } } } },
  };
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input); const method = init.method ?? "GET";
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined });
    const path = decodeURIComponent(url.split("/documents/")[1] ?? "").split("?")[0].replace("users/" + uid + "/", "");
    if (url.endsWith(":batchGet")) return new Response(JSON.stringify([{ found: { name: "x/tm_tasks/t1", updateTime: "U1",
      fields: { deadline: { stringValue: "2026-10-18" }, completed: { booleanValue: false }, archived: { booleanValue: false } } } }]));
    if (method === "GET") return docs[path] ? new Response(JSON.stringify(docs[path])) : new Response("{}", { status: 404 });
    if (method === "PATCH" && path.startsWith("tm_tasks/")) return new Response("{\"error\":{\"status\":\"FAILED_PRECONDITION\"}}", { status: 400 });
    if (method === "PATCH") return new Response("{}");
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  try {
    const res: any = await syncTaskDeadlines({ token: "tok", uid }, { at: "2026-10-13T01:00:00.000Z" });
    assert.equal(res.conflicts, 1);
    assert.equal(res.counts.copied, 0);
    const recs = calls.filter(c => c.method === "PATCH" && c.url.includes("os_task_deadline_sync_v1"));
    assert.equal(recs.length, 2, "① で新しい日を入れ、③ で前に戻す");
    assert.equal(recs[0].body.fields.value.mapValue.fields.copies.mapValue.fields.t1.mapValue.fields.date.stringValue, "2026-10-25");
    assert.equal(recs[1].body.fields.value.mapValue.fields.copies.mapValue.fields.t1.mapValue.fields.date.stringValue, "2026-10-18");
  } finally { globalThis.fetch = orig; }
});
