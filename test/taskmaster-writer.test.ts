// v1.71.0：マーケくんのチャットから TaskMaster にタスクを足す口の引数の確かめ。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { checkAddArgs, toAddTaskInput } from "../src/taskmaster-writer-core.js";
import { buildNewTask, newTaskDocFields } from "../src/taskmaster.js";

const URL = "https://lab.shia2n.jp/admin#chat/3f2a1b4c-0000-4000-8000-000000000001/1234";

test("題・期限・元のメッセージの住所を通し、TaskMaster の 1 件の形にそろえる", () => {
  const c = checkAddArgs({ title: " 佐藤さんに返す：目標の相談 ", deadline: "2026-11-08", link_url: URL, link_title: "チャット：佐藤さん" });
  assert.equal(c.ok, true);
  const a = (c as any).args;
  assert.deepEqual(a, { title: "佐藤さんに返す：目標の相談", deadline: "2026-11-08", link: { title: "チャット：佐藤さん", url: URL } });
  const t = newTaskDocFields(buildNewTask(toAddTaskInput(a), new Date("2026-11-07T00:00:00Z")));
  assert.equal(t.title, "佐藤さんに返す：目標の相談"); assert.equal(t.deadline, "2026-11-08"); assert.equal(t.projectId, null);
  assert.deepEqual(t.links, [{ title: "チャット：佐藤さん", url: URL }]);
});

test("期限とリンクは省ける。省いたらリンクの欄は空", () => {
  const c = checkAddArgs({ title: "返す" });
  assert.deepEqual((c as any).args, { title: "返す", deadline: null, link: null });
  assert.deepEqual(newTaskDocFields(buildNewTask(toAddTaskInput((c as any).args))).links, []);
});

test("形の違う引数は理由をつけて断る（TaskMaster に書く前に止める）", () => {
  assert.equal((checkAddArgs({ title: "" }) as any).error, "need_title");
  assert.equal((checkAddArgs(null) as any).error, "need_title");
  assert.equal((checkAddArgs({ title: "x".repeat(301) }) as any).error, "title_too_long");
  assert.equal((checkAddArgs({ title: "a", deadline: "2026-02-30" }) as any).error, "bad_deadline");
  assert.equal((checkAddArgs({ title: "a", link_url: "https://evil.example/admin#chat/x" }) as any).error, "bad_link_url");
  assert.equal((checkAddArgs({ title: "a", link_url: "javascript:alert(1)" }) as any).error, "bad_link_url");
});
