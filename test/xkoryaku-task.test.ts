// v1.50.0：X攻略くんの画面から TaskMaster へタスクを送る受け口。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { handleXkoryakuTasks, parseIds, parseSendBody, XKORYAKU_ORIGIN, XKORYAKU_TASKS_PATH } from "../src/xkoryaku-task-http.js";

test("送る中身：題・プロジェクト・期限の 3 つだけ。空の題・形の違う期限・ほかの欄は断る", () => {
  assert.deepEqual(parseSendBody(JSON.stringify({ title: "  第1位型を3本  ", projectId: "p1", deadline: "2026-11-01" })),
    { title: "第1位型を3本", projectId: "p1", deadline: "2026-11-01" });
  assert.deepEqual(parseSendBody(JSON.stringify({ title: "下書き" })), { title: "下書き", projectId: null, deadline: null });
  assert.throws(() => parseSendBody(JSON.stringify({ title: " " })), /invalid_title/);
  assert.throws(() => parseSendBody(JSON.stringify({ title: "a", deadline: "11/1" })), /invalid_deadline/);
  assert.throws(() => parseSendBody(JSON.stringify({ title: "a", projectId: "" })), /invalid_project/);
  assert.throws(() => parseSendBody(JSON.stringify({ title: "a", status: "done" })), /invalid_body/);
  assert.throws(() => parseSendBody("[1]"), /invalid_body/);
  assert.throws(() => parseSendBody("{"), /invalid_json/);
});

test("見るタスクの id：空と重複は落とす。50 件を超えたら断る", () => {
  assert.deepEqual(parseIds("a, b,,a"), ["a", "b"]);
  assert.deepEqual(parseIds(null), []);
  assert.throws(() => parseIds(Array.from({ length: 51 }, (_, i) => "t" + i).join(",")), /too_many_ids/);
});

test("守り：X攻略くん以外の住所は断る。札が無ければ 401。前もっての問い合わせは X攻略くんの住所にだけ答える", async () => {
  const env = { NAOKI_UID: "u1" } as any;
  const url = "https://shia2n-mcp.example" + XKORYAKU_TASKS_PATH;
  const other = await handleXkoryakuTasks(new Request(url, { headers: { Origin: "https://taskmaster.shia2n.jp" } }), env);
  assert.equal(other.status, 403);
  const none = await handleXkoryakuTasks(new Request(url, { headers: { Origin: XKORYAKU_ORIGIN } }), env);
  assert.equal(none.status, 401);
  assert.equal(none.headers.get("Access-Control-Allow-Origin"), XKORYAKU_ORIGIN);
  const pre = await handleXkoryakuTasks(new Request(url, { method: "OPTIONS", headers: { Origin: XKORYAKU_ORIGIN } }), env);
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("Access-Control-Allow-Headers") || "", /Authorization/);
  const bad = await handleXkoryakuTasks(new Request(url, { headers: { Origin: XKORYAKU_ORIGIN, Authorization: "Bearer a.b.c" } }), env);
  assert.equal(bad.status, 403);
});
