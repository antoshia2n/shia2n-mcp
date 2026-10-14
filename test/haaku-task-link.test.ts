// v1.17.0：TaskMaster の画面からマイルストーンに結ぶ。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { applyLinkChanges, linkTasks, readLinkOptions, type LinksStore } from "../src/haaku-home-store.js";
import { parseLinkBody, handleHaakuTaskLinks, TASKMASTER_ORIGIN } from "../src/haaku-task-link-http.js";
import { toFVal } from "../src/taskmaster.js";

const empty = (): LinksStore => ({ schemaVersion: 1, links: [], history: [] });

test("記録の行：TaskMaster から結ぶと by: taskmaster が付く。道具からは今までどおり付かない", () => {
  const known = new Set(["t1"]), steps = new Set(["A", "B"]);
  const a = applyLinkChanges(empty(), [{ taskId: "t1", milestoneId: "A" }], "x1", known, steps, "taskmaster");
  assert.deepEqual(a.store.history, [{ at: "x1", taskId: "t1", from: null, to: "A", by: "taskmaster" }]);
  const b = applyLinkChanges(a.store, [{ taskId: "t1", milestoneId: null }], "x2", known, steps);
  assert.deepEqual(b.store.history.at(-1), { at: "x2", taskId: "t1", from: "A", to: null });
  assert.equal(b.store.links.length, 0, "外したら結びは消え、記録は残る");
  assert.equal(b.store.history.length, 2);
});

test("POST の中身：task_id と milestone_id の 2 つだけ。null で外す。ほかの形は断る", () => {
  assert.deepEqual(parseLinkBody('{"task_id":"t1","milestone_id":"A"}'), { taskId: "t1", milestoneId: "A" });
  assert.deepEqual(parseLinkBody('{"task_id":"t1","milestone_id":null}'), { taskId: "t1", milestoneId: null });
  assert.throws(() => parseLinkBody('{"task_id":"t1"}'), /invalid_body/);
  assert.throws(() => parseLinkBody('{"task_id":"t1","milestone_id":"A","x":1}'), /invalid_body/);
  assert.throws(() => parseLinkBody('{"task_id":"","milestone_id":"A"}'), /invalid_task_id/);
  assert.throws(() => parseLinkBody('{"task_id":"t1","milestone_id":""}'), /invalid_milestone_id/);
  assert.throws(() => parseLinkBody("[1]"), /invalid_body/);
  assert.throws(() => parseLinkBody("{"), /invalid_json/);
  assert.throws(() => parseLinkBody("x".repeat(1025)), /body_too_large/);
});

test("受け口の守り：TaskMaster の住所以外は 403、ログインの札が無ければ 401", async () => {
  const env = { NAOKI_UID: "uid1" } as any;
  const r1 = await handleHaakuTaskLinks(new Request("https://w/haaku/task-links", { headers: { Origin: "https://evil.example" } }), env);
  assert.equal(r1.status, 403);
  const r0 = await handleHaakuTaskLinks(new Request("https://w/haaku/task-links"), env);
  assert.equal(r0.status, 403, "Origin が無い呼び出しも断る");
  const pre = await handleHaakuTaskLinks(new Request("https://w/haaku/task-links", { method: "OPTIONS", headers: { Origin: TASKMASTER_ORIGIN } }), env);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("Access-Control-Allow-Origin"), TASKMASTER_ORIGIN);
  const r2 = await handleHaakuTaskLinks(new Request("https://w/haaku/task-links", { headers: { Origin: TASKMASTER_ORIGIN } }), env);
  assert.equal(r2.status, 401);
  assert.equal(r2.headers.get("Access-Control-Allow-Origin"), TASKMASTER_ORIGIN, "失敗でも画面が理由を読めるように");
  const r3 = await handleHaakuTaskLinks(new Request("https://w/haaku/task-links", { method: "PUT", headers: { Origin: TASKMASTER_ORIGIN } }), env);
  assert.equal(r3.status, 405);
});

// ── 偽の Firestore：結ぶときにタスクを全部読まないこと・選び欄の中身 ──
function fakeFirestore(uid: string, docs: Record<string, unknown>, foundTasks: string[]) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const versions: Record<string, number> = {};
  const fdoc = (path: string) => ({ updateTime: "V" + (versions[path] ?? 0), fields: { value: toFVal(docs[path]) } });
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input); const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    if (url.endsWith(":batchGet")) {
      return new Response(JSON.stringify((body.documents as string[]).map(name => {
        const id = decodeURIComponent(name.split("/").pop()!);
        return foundTasks.includes(id)
          ? { found: { name, updateTime: "T", fields: { completed: { booleanValue: false }, archived: { booleanValue: false } } } }
          : { missing: name };
      })));
    }
    const path = decodeURIComponent(url.split("/documents/")[1] ?? "").split("?")[0].replace("users/" + uid + "/", "");
    if (method === "GET") return path in docs ? new Response(JSON.stringify(fdoc(path))) : new Response("{}", { status: 404 });
    if (method === "PATCH") {
      docs[path] = fromFValLoose(body.fields.value);
      versions[path] = (versions[path] ?? 0) + 1;
      return new Response("{}");
    }
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
// 試験の中だけで使う、Firestore の値 → JS の値（書いたものを次の読みで返すため）
function fromFValLoose(v: any): unknown {
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(fromFValLoose);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, fromFValLoose(x)]));
  return undefined;
}

const roadmap = { version: 1, milestones: [
  { id: "A", title: "設計を決める", status: "todo", dueDate: "2026-10-18" },
  { id: "B", title: "終わったマス", status: "done", dueDate: "2026-10-01" },
] };

test("結ぶ：名指しのタスクだけを id で読む（全部は読まない）。無いタスクは断る。記録に by が残る", async () => {
  const uid = "uid1";
  const docs: Record<string, unknown> = {
    "app_data/tm_layout": { version: 2 },
    "app_data/os_roadmap_v1": roadmap,
    "app_data/os_task_links_v1": { schemaVersion: 1, links: [], history: [] },
  };
  const fs = fakeFirestore(uid, docs, ["t1"]);
  try {
    const r = await linkTasks({ token: "tok", uid }, [{ taskId: "t1", milestoneId: "A" }], "2026-10-14T09:00:00.000Z", "taskmaster");
    assert.deepEqual(r.results, [{ task_id: "t1", from: null, to: "A", changed: true }]);
    assert.equal(r.links_total, 1);
    assert.equal(fs.calls.filter(c => c.url.includes("tm_tasks?pageSize")).length, 0, "タスクの一覧は読まない");
    const batch = fs.calls.filter(c => c.url.endsWith(":batchGet"));
    assert.equal(batch.length, 1);
    assert.equal(batch[0].body.documents.length, 1, "読むのは名指しの 1 件だけ");
    assert.deepEqual((docs["app_data/os_task_links_v1"] as any).history, [{ at: "2026-10-14T09:00:00.000Z", taskId: "t1", from: null, to: "A", by: "taskmaster" }]);
    await assert.rejects(linkTasks({ token: "tok", uid }, [{ taskId: "t9", milestoneId: "A" }]), /タスクがありません/);
  } finally { fs.restore(); }
});

test("選び欄の中身：結び・マイルストーン（完了も）・取り組みとプロジェクトの組。タスクは読まない", async () => {
  const uid = "uid1";
  const docs: Record<string, unknown> = {
    "app_data/os_roadmap_v1": roadmap,
    "app_data/os_task_links_v1": { schemaVersion: 1, links: [{ taskId: "t1", milestoneId: "A", at: "x" }], history: [] },
    "app_data/os_initiatives_v1": { schemaVersion: 1, records: [
      { id: "initiative_10", initiativeNo: "10", revisions: [{ name: "古い名前" }, { name: "バズ記事2期構築", taskmasterProjectId: "p10", linkedMilestoneIds: ["A"] }] },
      { id: "initiative_12", initiativeNo: "12", revisions: [{ name: "組なし", linkedMilestoneIds: [] }] },
    ] },
  };
  const fs = fakeFirestore(uid, docs, []);
  try {
    const o = await readLinkOptions({ token: "tok", uid });
    assert.deepEqual(o.links, [{ task_id: "t1", milestone_id: "A" }]);
    assert.deepEqual(o.milestones.map(m => [m.id, m.status, m.due_date]), [["A", "todo", "2026-10-18"], ["B", "done", "2026-10-01"]]);
    assert.deepEqual(o.initiatives, [
      { no: "10", name: "バズ記事2期構築", project_id: "p10", milestone_ids: ["A"] },
      { no: "12", name: "組なし", project_id: "", milestone_ids: [] },
    ]);
    assert.equal(fs.calls.length, 3, "読むのは 3 文書だけ");
    assert.equal(fs.calls.filter(c => c.url.includes("tm_tasks")).length, 0);
  } finally { fs.restore(); }
});
