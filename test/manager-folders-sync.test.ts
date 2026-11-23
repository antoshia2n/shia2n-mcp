// v1.149.0：マネージャーくんの TaskMaster の写し（syncFromTaskmaster）が、結んだタスクだけを id で読むこと。
// 走らせ方：esbuild で束ねてから node --test（fetch は差し替える・鍵はこの場で作る）
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { syncFromTaskmaster } from "../src/manager-folders.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const env: any = {
  SUPABASE_URL: "https://sb.example", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_x",
  NAOKI_UID: "U1", FIREBASE_SA_EMAIL: "sa@example.iam", FIREBASE_SA_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const fs = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).map(([k, v]) =>
  [k, typeof v === "boolean" ? { booleanValue: v } : v === null ? { nullValue: null } : { stringValue: String(v) }]));

test("結んだタスクだけを読み、完了・消えたものは作業も完了、期日の変わったものだけ写す", async () => {
  const calls: { url: string; method: string; body?: any }[] = [];
  const works = [
    { id: 1, tm_task_id: "a", tm_deadline: "2026-11-30", tm_priority: "high" },   // 変わらず
    { id: 2, tm_task_id: "b", tm_deadline: "2026-11-30", tm_priority: "medium" }, // 期日が変わった
    { id: 3, tm_task_id: "c", tm_deadline: null, tm_priority: "medium" },        // TaskMaster で完了
    { id: 4, tm_task_id: "d", tm_deadline: null, tm_priority: "medium" },        // TaskMaster から消えた
  ];
  const DOC = (id: string) => `projects/p/databases/d/documents/users/U1/tm_tasks/${id}`;
  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    const method = init.method || "GET"; let body: any; try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = init.body; }
    calls.push({ url, method, body });
    const json = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.includes("oauth2")) return json({ access_token: "T" });
    if (url.startsWith("https://sb.example/rest/v1/mk_works?select=")) return json(works);
    if (url.startsWith("https://sb.example/rest/v1/mk_works?id=eq.")) return json([{ id: 1 }]);
    if (url.endsWith(":batchGet")) return json([
      { found: { name: DOC("a"), fields: fs({ deadline: "2026-11-30", priority: "high", projectId: "P1", completed: false, archived: false }) } },
      { found: { name: DOC("b"), fields: fs({ deadline: "2026-12-05", priority: "medium", projectId: "P1", completed: false, archived: false }) } },
      { found: { name: DOC("c"), fields: fs({ deadline: null, priority: "medium", completed: true, archived: false }) } },
      { missing: DOC("d") },
    ]);
    if (url.includes("/app_data/projects")) return json({ name: "x", fields: { value: { arrayValue: { values: [{ mapValue: { fields: fs({ id: "P1", title: "計画", status: "active" }) } }] } } } });
    throw new Error("想定外の呼び出し：" + method + " " + url);
  };
  const r = await syncFromTaskmaster(env);
  assert.deepEqual(r, { updated: 1, done: 2 });
  // 読んだのは id の 4 件だけ（未完了の全部を読む問い合わせ runQuery は呼ばない）
  const gets = calls.filter((c) => c.url.endsWith(":batchGet"));
  assert.equal(gets.length, 1);
  assert.equal(gets[0].body.documents.length, 4);
  assert.equal(calls.some((c) => c.url.includes(":runQuery")), false);
  const patches = calls.filter((c) => c.method === "PATCH");
  assert.deepEqual(patches.map((c) => c.url.match(/id=eq\.(\d+)/)![1]).sort(), ["2", "3", "4"]);
  const p2 = patches.find((c) => c.url.includes("id=eq.2"))!.body;
  assert.equal(p2.tm_deadline, "2026-12-05");
  assert.equal(p2.tm_project_name, "計画");
  assert.equal(patches.find((c) => c.url.includes("id=eq.3"))!.body.state, "済み");
});

test("写すものが無ければプロジェクトの文書も読まない", async () => {
  const calls: string[] = [];
  (globalThis as any).fetch = async (url: string) => {
    calls.push(url);
    const json = (j: unknown) => new Response(JSON.stringify(j), { status: 200 });
    if (url.includes("oauth2")) return json({ access_token: "T" });
    if (url.startsWith("https://sb.example/rest/v1/mk_works?select=")) return json([{ id: 1, tm_task_id: "a", tm_deadline: null, tm_priority: "medium" }]);
    if (url.endsWith(":batchGet")) return json([{ found: { name: "x/tm_tasks/a", fields: fs({ completed: false, archived: false }) } }]);
    throw new Error("想定外の呼び出し：" + url);
  };
  assert.deepEqual(await syncFromTaskmaster(env), { updated: 0, done: 0 });
  assert.equal(calls.some((u) => u.includes("/app_data/projects")), false);
});
